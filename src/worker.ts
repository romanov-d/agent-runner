import { hostname } from 'node:os';
import { claim, complete, fail, heartbeat, release, requeueStale, expireOverdue, addJobCost, type Job } from './queue.ts';
import { handlers } from './handlers.ts';
import { closeDb } from './db.ts';
import { ApprovalRequired } from './tools.ts';

/**
 * Воркер: берёт задачи из очереди и исполняет их.
 *
 * Параллельность сделана слотами, а не пулом промисов: каждый слот - это
 * независимый цикл, который держит ровно одну задачу. Так видно, сколько
 * задач в работе, и остановка умеет дождаться именно их.
 */

export const WORKER_ID = process.env.WORKER_ID || `${hostname()}-${process.pid}`;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 4);
// Воркер можно ограничить видами задач или агентами: так держат отдельные
// пулы под тяжёлое и лёгкое, не разводя для этого отдельные очереди.
const KINDS = (process.env.KINDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const AGENTS = (process.env.AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const IDLE_MS = 500;
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 15_000);
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 20_000);
// База паузы перед повтором. Выносится в окружение, чтобы в демо и тестах
// не ждать полминуты, а в проде не торопить лежащего провайдера.
const BACKOFF = { baseMs: Number(process.env.BACKOFF_BASE_MS ?? 30_000), jitter: 0.2 };

let stopping = false;
const inFlight = new Map<string, Job>();

async function runOne(job: Job): Promise<void> {
  inFlight.set(job.id, job);

  // Пульс отдельным таймером: обработчик может работать минутами, и всё это
  // время очередь должна видеть, что задача жива.
  let owned = true;
  const beat = setInterval(() => {
    void heartbeat(job.id, WORKER_ID).then((ok) => {
      if (!ok) owned = false;
    });
  }, HEARTBEAT_MS);

  try {
    const handler = handlers[job.kind];
    if (!handler) throw new Error(`нет обработчика для вида ${job.kind}`);

    const out = await handler({ job, alive: async () => owned && (await heartbeat(job.id, WORKER_ID)) });

    if (out.cost) await addJobCost(job.id, out.cost);
    const ok = await complete(job.id, WORKER_ID, { result: out.result, cost: out.cost ?? {} });
    if (!ok) console.warn(`задача ${job.id} завершена, но строка уже не наша`);
  } catch (err) {
    if (err instanceof ApprovalRequired) {
      // Необратимое действие без подтверждения - это не сбой. Задача ждёт
      // человека, попытку за это тратить незачем.
      await fail(job.id, WORKER_ID, err, { backoff: BACKOFF });
      console.log(`задача ${job.id} ждёт подтверждения на ${err.tool}`);
    } else {
      const decision = await fail(job.id, WORKER_ID, err, { backoff: BACKOFF });
      console.warn(`задача ${job.id} упала: ${(err as Error).message} -> ${decision?.status}`);
    }
  } finally {
    clearInterval(beat);
    inFlight.delete(job.id);
  }
}

async function slot(n: number): Promise<void> {
  while (!stopping) {
    let job: Job | null = null;
    try {
      job = await claim(WORKER_ID, { kinds: KINDS, agents: AGENTS });
    } catch (err) {
      console.error(`слот ${n}: не смог взять задачу`, err);
      await sleep(2_000);
      continue;
    }
    if (!job) {
      await sleep(IDLE_MS);
      continue;
    }
    await runOne(job);
  }
}

/** Сторож: возвращает брошенные задачи и закрывает просроченные. */
async function janitor(): Promise<void> {
  while (!stopping) {
    try {
      const { requeued, failed } = await requeueStale();
      const expired = await expireOverdue();
      if (requeued || failed || expired) {
        console.log(`сторож: вернул ${requeued}, похоронил ${failed}, просрочено ${expired}`);
      }
    } catch (err) {
      console.error('сторож споткнулся', err);
    }
    await sleep(30_000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Остановка по сигналу.
 *
 * Новые задачи не берём, текущим даём доработать до крайнего срока, остаток
 * возвращаем в очередь через release - без траты попытки, потому что они
 * не виноваты в том, что процесс уходит.
 */
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: новые задачи не беру, в работе ${inFlight.size}`);

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (inFlight.size > 0 && Date.now() < deadline) await sleep(250);

  if (inFlight.size > 0) {
    console.log(`не успели ${inFlight.size}, возвращаю в очередь`);
    for (const id of [...inFlight.keys()]) {
      await release(id, WORKER_ID).catch(() => {});
    }
  }
  await closeDb();
  process.exit(0);
}

export async function startWorker(): Promise<void> {
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  const filter = [KINDS.length ? `виды ${KINDS.join()}` : '', AGENTS.length ? `агенты ${AGENTS.join()}` : '']
    .filter(Boolean).join(', ');
  console.log(`воркер ${WORKER_ID}, слотов ${CONCURRENCY}${filter ? ', ' + filter : ''}`);
  void janitor();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => slot(i + 1)));
}

if (import.meta.filename === process.argv[1]) {
  await startWorker();
}
