import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dbAvailable, resetDb, closeDb } from './helpers.ts';
import { enqueue, getJob, requeueStale } from '../src/queue.ts';

/**
 * Что происходит, когда воркер умирает.
 *
 * Тест поднимает настоящий процесс воркера и убивает его двумя способами:
 * насмерть (SIGKILL) и по-человечески (SIGTERM). Разница в том, тратится
 * попытка или нет, и ради этой разницы тест и написан.
 */

const online = await dbAvailable();
const opts = { skip: online ? false : 'нет базы: подними docker compose up db' };

// Порождённые процессы держат цикл событий: если тест упадёт до kill,
// прогон зависнет навсегда. Поэтому помним всех и добиваем в конце.
const spawned: ChildProcess[] = [];

/** Свой агент на каждый тест: чужой воркер не отберёт задачу и не испортит прогон. */
function startWorker(id: string, agent: string): ChildProcess {
  const proc = spawn(
    process.execPath,
    ['--experimental-strip-types', 'src/worker.ts'],
    {
      // Короткие сроки, чтобы тест не ждал двадцать секунд на каждой остановке.
      env: { ...process.env, WORKER_ID: id, CONCURRENCY: '1', SHUTDOWN_GRACE_MS: '1500', HEARTBEAT_MS: '500', AGENTS: agent },
      stdio: 'ignore',
      detached: false,
    },
  );
  spawned.push(proc);
  return proc;
}

/** Дождаться, пока процесс действительно умрёт: kill только посылает сигнал. */
function waitExit(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => proc.once('exit', () => resolve()));
}

async function waitFor(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('не дождались');
}

describe('падение воркера', opts, () => {
  after(async () => {
    for (const p of spawned) {
      if (p.exitCode === null && p.signalCode === null) {
        p.kill('SIGKILL');
        await waitExit(p);
      }
    }
    await closeDb();
  });

  test('убитый насмерть воркер: задача возвращается в очередь, попытка потрачена', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'sleep', agent: 'crash-kill', payload: { ms: 60_000 }, maxAttempts: 3 });

    const proc = startWorker('victim', 'crash-kill');
    await waitFor(async () => (await getJob(job.id))?.status === 'running');

    const taken = await getJob(job.id);
    assert.equal(taken?.attempts, 1, 'попытка должна считаться в момент захвата');

    proc.kill('SIGKILL'); // без шансов прибраться за собой
    await waitExit(proc); // пока процесс жив, он шлёт пульс и задача не считается брошенной

    // Сразу после смерти задача числится в работе: очередь об этом не знает.
    assert.equal((await getJob(job.id))?.status, 'running');

    // Сторож с коротким порогом замечает отсутствие пульса.
    await new Promise((r) => setTimeout(r, 1_200));
    const res = await requeueStale(1_000);
    assert.equal(res.requeued, 1);

    const after = await getJob(job.id);
    assert.equal(after?.status, 'queued');
    assert.equal(after?.locked_by, null);
    assert.equal(after?.attempts, 1, 'попытка за падение тратится, иначе задача зациклится');
  });

  test('остановленный по SIGTERM воркер возвращает задачу, не тратя попытку', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'sleep', agent: 'crash-term', payload: { ms: 60_000 }, maxAttempts: 3 });

    const proc = startWorker('polite', 'crash-term');
    await waitFor(async () => (await getJob(job.id))?.status === 'running');
    assert.equal((await getJob(job.id))?.attempts, 1);

    proc.kill('SIGTERM');
    await waitFor(async () => (await getJob(job.id))?.status === 'queued', 40_000);
    await waitExit(proc);

    const after = await getJob(job.id);
    assert.equal(after?.locked_by, null);
    assert.equal(after?.attempts, 0, 'остановка по сигналу не вина задачи');
  });

  test('после возврата задачу берёт другой воркер и доводит до конца', async () => {
    await resetDb();
    const job = await enqueue({ kind: 'flaky', agent: 'crash-finish', payload: { failUntil: 0 }, maxAttempts: 3 });

    const proc = startWorker('finisher', 'crash-finish');
    await waitFor(async () => (await getJob(job.id))?.status === 'done', 20_000);
    proc.kill('SIGTERM');
    await waitExit(proc);

    const after = await getJob(job.id);
    assert.equal(after?.status, 'done');
    assert.equal((after?.result as { ok: boolean }).ok, true);
  });
});
