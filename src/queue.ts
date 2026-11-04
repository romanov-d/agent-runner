import type { PoolClient } from 'pg';
import { query, one } from './db.ts';
import {
  addCost,
  clampProgress,
  costOfError,
  decideFailure,
  errorText,
  isRetryable,
  redact,
  DEFAULT_STALE_MS,
  type BackoffOptions,
  type FailureDecision,
  type JobCost,
  type JobStatus,
} from './logic.ts';

export type Job = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  agent: string;
  status: JobStatus;
  priority: number;
  run_after: Date;
  deadline: Date | null;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  idempotency_key: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  cost: JobCost;
  progress: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

export type EnqueueInput = {
  kind: string;
  payload?: Record<string, unknown>;
  agent?: string;
  priority?: number;
  runAfter?: Date;
  deadline?: Date;
  maxAttempts?: number;
  /** Повторная постановка с тем же ключом вернёт существующую задачу. */
  idempotencyKey?: string;
};

/**
 * Поставить задачу.
 *
 * Идемпотентность сделана уникальным индексом и ON CONFLICT, а не проверкой
 * "сначала посмотрим, нет ли такой". Проверка перед вставкой - это гонка:
 * два воркера успевают посмотреть до того, как любой из них вставил.
 */
export async function enqueue(input: EnqueueInput): Promise<Job> {
  const row = await one<Job>(
    `INSERT INTO jobs (kind, payload, agent, priority, run_after, deadline, max_attempts, idempotency_key)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, $8)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET updated_at = jobs.updated_at
     RETURNING *`,
    [
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.agent ?? 'default',
      input.priority ?? 100,
      input.runAfter ?? null,
      input.deadline ?? null,
      Math.max(1, input.maxAttempts ?? 3),
      input.idempotencyKey ?? null,
    ],
  );
  if (!row) throw new Error('enqueue вернул пусто');
  return row;
}

/**
 * Взять следующую готовую задачу. Главный запрос всего проекта.
 *
 * Подзапрос выбирает одну строку с FOR UPDATE SKIP LOCKED: строка блокируется
 * на время запроса, а остальные воркеры её пропускают, вместо того чтобы
 * встать в очередь на блокировке. Внешний UPDATE переводит её в running
 * и ставит владельца. Всё это одна команда, поэтому транзакция не нужна.
 *
 * Условие status = 'queued' во внешнем WHERE - страховка: если строку
 * успели забрать между подзапросом и обновлением, мы просто ничего не обновим
 * и вернём null, а не отберём чужую задачу.
 *
 * attempts увеличивается здесь, а не в обработчике: воркер может умереть
 * до первой строчки обработчика, и попытка должна считаться потраченной.
 */
export async function claim(
  workerId: string,
  opts: { kinds?: string[]; agents?: string[] } = {},
  client?: PoolClient,
): Promise<Job | null> {
  const rows = await query<Job>(
    `UPDATE jobs SET
       status     = 'running',
       locked_by  = $1,
       locked_at  = now(),
       attempts   = jobs.attempts + 1,
       started_at = COALESCE(jobs.started_at, now()),
       updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE status = 'queued'
         AND run_after <= now()
         AND (deadline IS NULL OR deadline > now())
         AND ($2::text[] IS NULL OR kind  = ANY($2))
         AND ($3::text[] IS NULL OR agent = ANY($3))
       ORDER BY priority, run_after, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     AND status = 'queued'
     RETURNING *`,
    [workerId, opts.kinds?.length ? opts.kinds : null, opts.agents?.length ? opts.agents : null],
    client,
  );
  return rows[0] ?? null;
}

/** Условие "задача всё ещё наша и выполняется". Защита от работы с чужой строкой. */
const OWNED = `id = $1 AND locked_by = $2 AND status = 'running'`;

/**
 * Пульс. Возвращает false, если задачу уже отняли: отменили, или её забрал
 * другой воркер после того, как нас сочли зависшими. Обработчик, получив false,
 * должен прекратить работу - результат всё равно никто не примет.
 */
export async function heartbeat(id: string, workerId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE jobs SET locked_at = now() WHERE ${OWNED} RETURNING id`,
    [id, workerId],
  );
  return rows.length > 0;
}

export async function complete(
  id: string,
  workerId: string,
  out: { result?: Record<string, unknown>; cost?: JobCost } = {},
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE jobs SET
       status      = 'done',
       progress    = 100,
       result      = $3,
       cost        = $4::jsonb,
       error       = NULL,
       locked_by   = NULL,
       locked_at   = NULL,
       finished_at = now(),
       updated_at  = now()
     WHERE ${OWNED} RETURNING id`,
    [id, workerId, out.result ? JSON.stringify(out.result) : null, JSON.stringify(out.cost ?? {})],
    // cost складывается в fail/addCost; здесь задача уже закрывается,
    // поэтому пишем итог как есть - вызывающий код передаёт накопленное.
  );
  return rows.length > 0;
}

/**
 * Ошибка попытки: повтор с паузой или окончательный провал.
 *
 * Если модель ответила, а упал разбор, токены уже списаны - такой расход
 * пишется в задачу через PaidError, иначе деньги утекают незаметно.
 */
export async function fail(
  id: string,
  workerId: string,
  err: unknown,
  opts: { now?: Date; backoff?: BackoffOptions } = {},
): Promise<FailureDecision | null> {
  const job = await one<{ attempts: number; max_attempts: number; cost: JobCost }>(
    `SELECT attempts, max_attempts, cost FROM jobs WHERE ${OWNED}`,
    [id, workerId],
  );
  if (!job) return null;

  const decision = decideFailure({
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    retryable: isRetryable(err),
    now: opts.now,
    backoff: opts.backoff,
  });

  const paid = costOfError(err);
  const cost = paid ? addCost(job.cost ?? {}, paid) : (job.cost ?? {});

  await query(
    `UPDATE jobs SET
       status      = $3,
       error       = $4,
       cost        = $5::jsonb,
       locked_by   = NULL,
       locked_at   = NULL,
       run_after   = COALESCE($6, run_after),
       finished_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END,
       updated_at  = now()
     WHERE ${OWNED}`,
    [
      id,
      workerId,
      decision.status,
      errorText(err),
      JSON.stringify(cost),
      decision.status === 'queued' ? decision.runAfter : null,
    ],
  );
  return decision;
}

/**
 * Вернуть задачу в очередь, не тратя попытку.
 *
 * Нужно при корректной остановке воркера: процесс уходит по SIGTERM не по своей
 * вине, и задача не должна за это расплачиваться попыткой.
 */
export async function release(id: string, workerId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE jobs SET
       status     = 'queued',
       locked_by  = NULL,
       locked_at  = NULL,
       run_after  = now(),
       attempts   = GREATEST(attempts - 1, 0),
       updated_at = now()
     WHERE ${OWNED} RETURNING id`,
    [id, workerId],
  );
  return rows.length > 0;
}

/**
 * Отложить до указанного времени, не тратя попытку и освободив слот воркера.
 * Для ожидания внешнего сервиса: держать слот занятым, пока чужой рендер идёт
 * двадцать минут, значит простаивать за свои деньги.
 */
export async function snooze(id: string, workerId: string, runAfter: Date): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE jobs SET
       status     = 'queued',
       locked_by  = NULL,
       locked_at  = NULL,
       run_after  = $3,
       attempts   = GREATEST(attempts - 1, 0),
       updated_at = now()
     WHERE ${OWNED} RETURNING id`,
    [id, workerId, runAfter],
  );
  return rows.length > 0;
}

export async function cancel(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE jobs SET status='cancelled', locked_by=NULL, locked_at=NULL,
            finished_at=now(), updated_at=now()
     WHERE id = $1 AND status IN ('queued','running') RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

export async function retry(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE jobs SET status='queued', attempts=0, progress=0, error=NULL,
            run_after=now(), finished_at=NULL, updated_at=now()
     WHERE id = $1 AND status IN ('failed','cancelled') RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * Вернуть в очередь брошенные задачи: числятся running, а пульса не было
 * дольше staleMs. Если попытки кончились - пометить упавшими, иначе они
 * будут всплывать вечно.
 *
 * Запускается самим воркером по таймеру: отдельный процесс-сторож - это ещё
 * одна вещь, которая может упасть незаметно.
 */
export async function requeueStale(
  staleMs = DEFAULT_STALE_MS,
): Promise<{ requeued: number; failed: number }> {
  const rows = await query<{ status: string }>(
    `UPDATE jobs SET
       status      = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
       error       = CASE WHEN attempts >= max_attempts
                          THEN 'воркер не отвечал, попытки кончились' ELSE error END,
       finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
       locked_by   = NULL,
       locked_at   = NULL,
       run_after   = now(),
       updated_at  = now()
     WHERE status = 'running'
       AND (locked_at IS NULL OR locked_at < now() - make_interval(secs => $1))
     RETURNING status`,
    [staleMs / 1000],
  );
  return {
    requeued: rows.filter((r) => r.status === 'queued').length,
    failed: rows.filter((r) => r.status === 'failed').length,
  };
}

/** Просроченные по дедлайну задачи закрываем, а не держим в очереди. */
export async function expireOverdue(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE jobs SET status='failed', error='дедлайн прошёл', finished_at=now(), updated_at=now()
     WHERE status='queued' AND deadline IS NOT NULL AND deadline <= now()
     RETURNING id`,
  );
  return rows.length;
}

export async function addJobCost(id: string, cost: JobCost): Promise<void> {
  await query(
    `UPDATE jobs SET cost = (
       SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
         SELECT key AS k, SUM(value::numeric) AS v FROM (
           SELECT * FROM jsonb_each_text(COALESCE(jobs.cost, '{}'::jsonb))
           UNION ALL
           SELECT * FROM jsonb_each_text($2::jsonb)
         ) t GROUP BY key
       ) s
     ), updated_at = now() WHERE id = $1`,
    [id, JSON.stringify(cost)],
  );
}

export async function setProgress(id: string, value: number): Promise<void> {
  await query(`UPDATE jobs SET progress=$2, updated_at=now() WHERE id=$1`, [
    id,
    clampProgress(value),
  ]);
}

export type StepInput = {
  jobId: string;
  attempt: number;
  seq: number;
  kind: 'model' | 'tool' | 'note' | 'error';
  name?: string;
  detail?: unknown;
  cost?: JobCost;
  ms?: number;
};

/** Записать шаг агента. Секреты вырезаются до того, как попадут в базу. */
export async function appendStep(s: StepInput): Promise<void> {
  await query(
    `INSERT INTO job_steps (job_id, attempt, seq, kind, name, detail, cost, ms)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      s.jobId,
      s.attempt,
      s.seq,
      s.kind,
      s.name ?? null,
      JSON.stringify(redact(s.detail ?? {})),
      JSON.stringify(s.cost ?? {}),
      s.ms ?? null,
    ],
  );
}

export async function getJob(id: string): Promise<Job | null> {
  return one<Job>(`SELECT * FROM jobs WHERE id = $1`, [id]);
}

export async function listSteps(jobId: string): Promise<unknown[]> {
  return query(`SELECT * FROM job_steps WHERE job_id=$1 ORDER BY attempt, seq`, [jobId]);
}

export async function audit(entry: {
  jobId?: string;
  actor: string;
  action: string;
  target?: string;
  decision: 'allowed' | 'denied' | 'approved';
  reason?: string;
}): Promise<void> {
  await query(
    `INSERT INTO audit_log (job_id, actor, action, target, decision, reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      entry.jobId ?? null,
      entry.actor,
      entry.action,
      entry.target ?? null,
      entry.decision,
      entry.reason ?? null,
    ],
  );
}
