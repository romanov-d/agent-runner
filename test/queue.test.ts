import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbAvailable, resetDb, closeDb } from './helpers.ts';
import { claim, complete, enqueue, fail, getJob, heartbeat, release, requeueStale, snooze, cancel, retry, expireOverdue, addJobCost } from '../src/queue.ts';
import { PaidError, PermanentError } from '../src/logic.ts';
import { query } from '../src/db.ts';

const online = await dbAvailable();
const opts = { skip: online ? false : 'нет базы: подними docker compose up db' };

describe('очередь', opts, () => {
  before(async () => { await resetDb(); });
  after(async () => { await closeDb(); });

  test('захват переводит задачу в работу и тратит попытку', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'ping' });
    const got = await claim('w1');
    assert.equal(got?.id, job.id);
    assert.equal(got?.status, 'running');
    assert.equal(got?.attempts, 1);
    assert.equal(got?.locked_by, 'w1');
  });

  test('вторая попытка захвата возвращает пусто, задачу уже взяли', async () => {
    await resetDb();
    await enqueue({ kind: 'ping' });
    assert.ok(await claim('w1'));
    assert.equal(await claim('w2'), null);
  });

  test('порядок выдачи: сначала приоритет, потом время', async () => {
    await resetDb();
    await enqueue({ kind: 'ping', payload: { n: 1 }, priority: 100 });
    await enqueue({ kind: 'ping', payload: { n: 2 }, priority: 10 });
    const first = await claim('w1');
    assert.equal((first?.payload as { n: number }).n, 2);
  });

  test('задачу с будущим run_after не берём', async () => {
    await resetDb();
    await enqueue({ kind: 'ping', runAfter: new Date(Date.now() + 60_000) });
    assert.equal(await claim('w1'), null);
  });

  test('повторная постановка с тем же ключом не создаёт дубль', async () => {
    await resetDb();
    const a = await enqueue({ kind: 'ping', idempotencyKey: 'daily-2026-01-01' });
    const b = await enqueue({ kind: 'ping', idempotencyKey: 'daily-2026-01-01' });
    assert.equal(a.id, b.id);
    const rows = await query<{ c: string }>('SELECT count(*)::text AS c FROM jobs');
    assert.equal(rows[0]?.c, '1');
  });

  test('чужую задачу трогать нельзя', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'ping' });
    await claim('w1');
    assert.equal(await heartbeat(job.id, 'w2'), false);
    assert.equal(await complete(job.id, 'w2'), false);
    assert.equal(await release(job.id, 'w2'), false);
    assert.equal(await fail(job.id, 'w2', new Error('x')), null);
  });

  test('ошибка с остатком попыток возвращает в очередь с паузой', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'flaky', maxAttempts: 3 });
    await claim('w1');
    const d = await fail(job.id, 'w1', new Error('сеть'), { backoff: { baseMs: 1_000 } });
    assert.equal(d?.status, 'queued');
    const after = await getJob(job.id);
    assert.equal(after?.status, 'queued');
    assert.ok(after!.run_after.getTime() > Date.now());
  });

  test('попытки кончились - задача падает окончательно', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'flaky', maxAttempts: 1 });
    await claim('w1');
    const d = await fail(job.id, 'w1', new Error('сеть'));
    assert.equal(d?.status, 'failed');
    assert.ok((await getJob(job.id))?.finished_at);
  });

  test('неповторяемая ошибка валит с первой попытки', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'ping', maxAttempts: 5 });
    await claim('w1');
    const d = await fail(job.id, 'w1', new PermanentError('нет прав'));
    assert.equal(d?.status, 'failed');
  });

  test('расход записывается, даже если модель ответила, а разбор упал', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'agent', maxAttempts: 3 });
    await claim('w1');
    await fail(job.id, 'w1', new PaidError('разбор упал', { usd: 0.01 }));
    assert.equal((await getJob(job.id))?.cost.usd, 0.01);
  });

  test('расход копится по попыткам, а не затирается', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'agent', maxAttempts: 5 });
    await claim('w1');
    await fail(job.id, 'w1', new PaidError('раз', { usd: 0.01 }));
    await query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [job.id]);
    await claim('w1');
    await fail(job.id, 'w1', new PaidError('два', { usd: 0.02 }));
    assert.equal(Number((await getJob(job.id))?.cost.usd), 0.03);
  });

  test('возврат в очередь не тратит попытку, отсрочка тоже', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'sleep' });
    await claim('w1');
    await release(job.id, 'w1');
    assert.equal((await getJob(job.id))?.attempts, 0);

    await claim('w2');
    await snooze(job.id, 'w2', new Date(Date.now() + 5_000));
    const after = await getJob(job.id);
    assert.equal(after?.attempts, 0);
    assert.equal(after?.status, 'queued');
  });

  test('брошенную задачу сторож возвращает, а при исчерпанных попытках хоронит', async () => {
    await resetDb();
    const alive = await enqueue({ kind: 'ping', maxAttempts: 3 });
    const doomed = await enqueue({ kind: 'ping', maxAttempts: 1 });
    await claim('w1');
    await claim('w1');
    await query(`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE status = 'running'`);

    const res = await requeueStale(60_000);
    assert.equal(res.requeued, 1);
    assert.equal(res.failed, 1);
    assert.equal((await getJob(alive.id))?.status, 'queued');
    assert.equal((await getJob(doomed.id))?.status, 'failed');
  });

  test('просроченную по дедлайну не берём и закрываем', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'ping', deadline: new Date(Date.now() + 300) });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await claim('w1'), null);
    assert.equal(await expireOverdue(), 1);
    assert.equal((await getJob(job.id))?.status, 'failed');
  });

  test('отмена и повтор работают только из подходящих состояний', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'ping' });
    assert.equal(await retry(job.id), false); // ещё в очереди - нечего повторять
    assert.equal(await cancel(job.id), true);
    assert.equal(await cancel(job.id), false); // уже отменена
    assert.equal(await retry(job.id), true);
    assert.equal((await getJob(job.id))?.attempts, 0);
  });

  test('завершение пишет результат и снимает владельца', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'ping' });
    await claim('w1');
    await addJobCost(job.id, { usd: 0.005 });
    assert.equal(await complete(job.id, 'w1', { result: { pong: true }, cost: { usd: 0.005 } }), true);
    const after = await getJob(job.id);
    assert.equal(after?.status, 'done');
    assert.equal(after?.progress, 100);
    assert.equal(after?.locked_by, null);
    assert.deepEqual(after?.result, { pong: true });
  });
});
