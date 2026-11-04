import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbAvailable, resetDb, closeDb } from './helpers.ts';
import { claim, complete, enqueue } from '../src/queue.ts';
import { query } from '../src/db.ts';

/**
 * Главный инвариант очереди: задачу выполняет ровно один исполнитель.
 *
 * Проверяется на настоящем Postgres и настоящей параллельности: подделать
 * FOR UPDATE SKIP LOCKED мокой нельзя, а без него этот тест падает сразу.
 */

const online = await dbAvailable();
const opts = { skip: online ? false : 'нет базы: подними docker compose up db' };

describe('конкуренция', opts, () => {
  after(async () => { await closeDb(); });

  test('двадцать воркеров разбирают сто задач, каждая достаётся ровно одному', async () => {
    await resetDb();
    const JOBS = 100;
    const WORKERS = 20;

    for (let i = 0; i < JOBS; i++) await enqueue({ kind: 'ping', payload: { i } });

    // Каждый воркер гребёт, пока очередь не опустеет. Все гребут одновременно.
    const taken: { id: string; worker: string }[] = [];
    await Promise.all(
      Array.from({ length: WORKERS }, async (_, w) => {
        const worker = `w${w}`;
        for (;;) {
          const job = await claim(worker);
          if (!job) break;
          taken.push({ id: job.id, worker });
          await complete(job.id, worker, { result: { ok: true } });
        }
      }),
    );

    assert.equal(taken.length, JOBS, 'взято не столько задач, сколько поставили');

    const unique = new Set(taken.map((t) => t.id));
    assert.equal(unique.size, JOBS, 'одна и та же задача досталась двоим');

    const rows = await query<{ status: string; c: string }>(
      `SELECT status, count(*)::text AS c FROM jobs GROUP BY status`,
    );
    assert.deepEqual(rows, [{ status: 'done', c: String(JOBS) }]);

    // Счётчик попыток ровно единица: никто не брал задачу повторно.
    const extra = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM jobs WHERE attempts <> 1`,
    );
    assert.equal(extra[0]?.c, '0', 'какая-то задача захватывалась больше одного раза');
  });

  test('пустая очередь не отдаёт одну задачу дважды при гонке захвата', async () => {
    await resetDb();
    await enqueue({ kind: 'ping' });

    // Двадцать одновременных захватов на одну задачу: успешным должен быть один.
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(`race${i}`)));
    const got = results.filter(Boolean);
    assert.equal(got.length, 1, `задачу захватили ${got.length} раз вместо одного`);
  });
});
