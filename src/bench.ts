import { closeDb, query } from './db.ts';
import { migrate } from './migrate.ts';
import { claim, complete, enqueue } from './queue.ts';

/**
 * Сколько задач в секунду держит очередь.
 *
 * Меряется именно очередь: обработчик пустой, вся работа - захват и закрытие.
 * Число зависит от машины и базы, поэтому его печатаем вместе с условиями.
 */
const JOBS = Number(process.env.BENCH_JOBS ?? 2_000);
const WORKERS = Number(process.env.BENCH_WORKERS ?? 8);

await migrate();
await query('TRUNCATE jobs, job_steps RESTART IDENTITY CASCADE');

const fillStart = Date.now();
for (let i = 0; i < JOBS; i++) await enqueue({ kind: 'ping', payload: { i } });
const fillMs = Date.now() - fillStart;

const start = Date.now();
let done = 0;
await Promise.all(
  Array.from({ length: WORKERS }, async (_, w) => {
    const id = `bench${w}`;
    for (;;) {
      const job = await claim(id);
      if (!job) break;
      await complete(job.id, id, { result: {} });
      done++;
    }
  }),
);
const ms = Date.now() - start;

console.log(`постановка: ${JOBS} задач за ${fillMs} мс (${Math.round((JOBS / fillMs) * 1000)}/с)`);
console.log(`разбор:     ${done} задач за ${ms} мс (${Math.round((done / ms) * 1000)}/с), воркеров ${WORKERS}`);
console.log(`одна задача: ${(ms / done).toFixed(2)} мс на полный цикл захват-закрытие`);
await closeDb();
