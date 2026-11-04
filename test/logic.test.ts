import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  backoffMs,
  decideFailure,
  isStale,
  isExpired,
  addCost,
  redact,
  nextRunAt,
  shouldPause,
  errorText,
  PermanentError,
  PaidError,
  costOfError,
  isRetryable,
} from '../src/logic.ts';

describe('пауза перед повтором', () => {
  test('удваивается от базы и упирается в потолок', () => {
    assert.equal(backoffMs(1, { baseMs: 1_000, maxMs: 10_000 }), 1_000);
    assert.equal(backoffMs(2, { baseMs: 1_000, maxMs: 10_000 }), 2_000);
    assert.equal(backoffMs(4, { baseMs: 1_000, maxMs: 10_000 }), 8_000);
    assert.equal(backoffMs(9, { baseMs: 1_000, maxMs: 10_000 }), 10_000);
  });

  test('ноль и отрицательные считаются первой попыткой', () => {
    assert.equal(backoffMs(0, { baseMs: 500 }), 500);
    assert.equal(backoffMs(-3, { baseMs: 500 }), 500);
  });

  test('разброс держится в заданных границах', () => {
    const lo = backoffMs(1, { baseMs: 1_000, jitter: 0.2, random: () => 0 });
    const hi = backoffMs(1, { baseMs: 1_000, jitter: 0.2, random: () => 1 });
    assert.equal(lo, 800);
    assert.equal(hi, 1_200);
  });
});

describe('решение после ошибки', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  test('попытки есть - повтор с паузой', () => {
    const d = decideFailure({ attempts: 1, maxAttempts: 3, retryable: true, now, backoff: { baseMs: 1_000 } });
    assert.equal(d.status, 'queued');
    assert.equal(d.status === 'queued' && d.runAfter.getTime(), now.getTime() + 1_000);
  });

  test('попытки кончились - окончательный провал', () => {
    const d = decideFailure({ attempts: 3, maxAttempts: 3, retryable: true, now });
    assert.equal(d.status, 'failed');
  });

  test('неповторяемая ошибка валит с первой попытки', () => {
    const d = decideFailure({ attempts: 1, maxAttempts: 5, retryable: false, now });
    assert.equal(d.status, 'failed');
  });
});

describe('брошенные и просроченные', () => {
  const now = new Date('2026-01-01T00:10:00Z');

  test('running без пульса дольше порога считается брошенной', () => {
    assert.equal(isStale({ status: 'running', lockedAt: new Date('2026-01-01T00:00:00Z') }, now, 60_000), true);
    assert.equal(isStale({ status: 'running', lockedAt: new Date('2026-01-01T00:09:30Z') }, now, 60_000), false);
  });

  test('running без пульса вообще - брошена', () => {
    assert.equal(isStale({ status: 'running', lockedAt: null }, now), true);
  });

  test('не running не брошена, как бы давно её ни трогали', () => {
    assert.equal(isStale({ status: 'queued', lockedAt: null }, now), false);
  });

  test('дедлайн в прошлом - просрочена', () => {
    assert.equal(isExpired({ deadline: new Date('2026-01-01T00:09:00Z') }, now), true);
    assert.equal(isExpired({ deadline: new Date('2026-01-01T00:11:00Z') }, now), false);
    assert.equal(isExpired({ deadline: null }, now), false);
  });
});

describe('ошибки и расход', () => {
  test('расход складывается по ключам', () => {
    assert.deepEqual(addCost({ usd: 1, in_tokens: 10 }, { usd: 0.5, out_tokens: 2 }), {
      usd: 1.5,
      in_tokens: 10,
      out_tokens: 2,
    });
  });

  test('ошибка после оплаты несёт расход с собой', () => {
    const err = new PaidError('разбор упал', { usd: 0.01 });
    assert.deepEqual(costOfError(err), { usd: 0.01 });
    assert.equal(isRetryable(err), true);
  });

  test('обычная ошибка расхода не несёт', () => {
    assert.equal(costOfError(new Error('сеть')), null);
  });

  test('неповторяемая ошибка помечена как таковая', () => {
    assert.equal(isRetryable(new PermanentError('нет прав')), false);
  });

  test('текст ошибки обрезается и не падает на мусоре', () => {
    assert.equal(errorText(new Error('x'.repeat(5_000))).length, 2_000);
    assert.equal(errorText(undefined), 'unknown error');
  });
});

describe('секреты в журнале', () => {
  test('поля с подозрительными именами вырезаются на любой глубине', () => {
    const out = redact({
      ok: 'виден',
      api_key: 'sk-12345',
      nested: { Authorization: 'Bearer x', deep: { password: 'p' } },
      list: [{ token: 't' }],
    }) as Record<string, unknown>;
    assert.equal(out.ok, 'виден');
    assert.equal(out.api_key, '[скрыто]');
    assert.deepEqual(out.nested, { Authorization: '[скрыто]', deep: { password: '[скрыто]' } });
    assert.deepEqual(out.list, [{ token: '[скрыто]' }]);
  });

  test('длинные строки режутся, рекурсия ограничена', () => {
    const long = redact({ text: 'y'.repeat(3_000) }) as { text: string };
    assert.equal(long.text.length, 2_003);
  });
});

describe('расписания', () => {
  test('следующий запуск сдвигается на период с разбросом', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const lo = nextRunAt({ everyMs: 60_000, jitterRatio: 0.1 }, now, () => 0);
    const hi = nextRunAt({ everyMs: 60_000, jitterRatio: 0.1 }, now, () => 1);
    assert.equal(lo.getTime() - now.getTime(), 54_000);
    assert.equal(hi.getTime() - now.getTime(), 66_000);
  });

  test('автопауза срабатывает после заданного числа сбоев подряд', () => {
    assert.equal(shouldPause({ failsInRow: 4, pauseAfter: 5 }), false);
    assert.equal(shouldPause({ failsInRow: 5, pauseAfter: 5 }), true);
  });
});
