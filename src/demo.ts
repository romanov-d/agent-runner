import { closeDb } from './db.ts';
import { migrate } from './migrate.ts';
import { enqueue, getJob, listSteps } from './queue.ts';
import { query } from './db.ts';

/**
 * Демонстрация: ставит несколько задач, ждёт, пока воркер их разберёт,
 * и печатает итог. Запускать при поднятом воркере.
 */
await migrate();

const jobs = [
  await enqueue({ kind: 'ping', priority: 10 }),
  await enqueue({ kind: 'flaky', payload: { failUntil: 2 }, maxAttempts: 4 }),
  await enqueue({ kind: 'agent', agent: 'analyst', payload: { task: 'что лежит по ключу greeting' } }),
  await enqueue({ kind: 'agent', agent: 'editor', payload: {
    task: 'запиши привет в ключ hello',
    script: [
      { call: { name: 'kv_set', args: { key: 'hello', value: 'привет' } }, cost: { usd: 0.0005 } },
      { text: 'записал', cost: { usd: 0.0003 } },
    ],
  } }),
  // Аналитику запись запрещена: агент получит отказ и объяснит это текстом.
  await enqueue({ kind: 'agent', agent: 'analyst', payload: {
    task: 'попробуй записать что-нибудь',
    script: [
      { call: { name: 'kv_set', args: { key: 'x', value: '1' } }, cost: { usd: 0.0005 } },
      { text: 'записать не дали, у меня только чтение', cost: { usd: 0.0003 } },
    ],
  } }),
];

console.log(`поставлено задач: ${jobs.length}, жду воркер...`);

const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const rows = await query<{ c: string }>(
    `SELECT count(*)::text AS c FROM jobs WHERE status IN ('queued','running')`,
  );
  if (rows[0]?.c === '0') break;
  await new Promise((r) => setTimeout(r, 500));
}

console.log('\nитог:');
for (const j of jobs) {
  const job = await getJob(j.id);
  const steps = await listSteps(j.id);
  const usd = Number(job?.cost.usd ?? 0);
  console.log(
    `  #${job?.id} ${job?.kind.padEnd(6)} ${job?.status.padEnd(9)} ` +
      `попыток ${job?.attempts} шагов ${steps.length} ` +
      `$${usd.toFixed(4)} ${JSON.stringify(job?.result ?? job?.error ?? '')}`,
  );
}

const total = await query<{ usd: string | null }>(
  `SELECT SUM((cost->>'usd')::numeric)::text AS usd FROM jobs`,
);
console.log(`\nвсего потрачено: $${Number(total[0]?.usd ?? 0).toFixed(4)}`);
await closeDb();
