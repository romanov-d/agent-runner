/**
 * Чистая логика очереди: ни одного обращения к базе.
 *
 * Всё, что можно решить без ввода-вывода, решается здесь и покрывается
 * обычными тестами без докера и без Postgres. В queue.ts остаётся только SQL.
 */

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Задача без пульса дольше этого срока считается брошенной. */
export const DEFAULT_STALE_MS = 10 * 60_000;

export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  /** Доля разброса: 0.2 даёт +-20% к паузе. */
  jitter?: number;
  random?: () => number;
};

/**
 * Пауза перед повтором после `attempts`-й неудачной попытки (1, 2, ...):
 * base * 2^(attempts-1), не больше max, плюс-минус jitter.
 *
 * Разброс нужен, чтобы сотня задач, упавших из-за одного и того же лежащего
 * провайдера, не пришла к нему повторно в одну и ту же секунду.
 */
export function backoffMs(attempts: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 30_000;
  const max = opts.maxMs ?? 30 * 60_000;
  const jitter = opts.jitter ?? 0;
  const n = Math.max(1, Math.floor(attempts));
  const raw = Math.min(max, base * 2 ** Math.min(n - 1, 30));
  if (!jitter) return raw;
  const r = (opts.random ?? Math.random)() * 2 - 1; // -1..1
  return Math.max(0, Math.round(raw * (1 + jitter * r)));
}

export type FailureDecision = { status: 'queued'; runAfter: Date } | { status: 'failed' };

/**
 * Что делать с задачей после ошибки.
 *
 * `attempts` - сколько попыток уже сделано, включая текущую: счётчик растёт
 * в момент захвата, до того как обработчик начал работу. Иначе упавший
 * воркер не увеличил бы счётчик и задача крутилась бы вечно.
 */
export function decideFailure(input: {
  attempts: number;
  maxAttempts: number;
  retryable: boolean;
  now?: Date;
  backoff?: BackoffOptions;
}): FailureDecision {
  if (!input.retryable || input.attempts >= input.maxAttempts) return { status: 'failed' };
  const now = input.now ?? new Date();
  return { status: 'queued', runAfter: new Date(now.getTime() + backoffMs(input.attempts, input.backoff)) };
}

/** Брошена ли задача: числится running, а пульса не было дольше staleMs. */
export function isStale(
  job: { status: string; lockedAt: Date | null },
  now: Date,
  staleMs = DEFAULT_STALE_MS,
): boolean {
  if (job.status !== 'running') return false;
  if (!job.lockedAt) return true;
  return now.getTime() - job.lockedAt.getTime() > staleMs;
}

/** Просрочена ли задача: дедлайн в прошлом. Такие не берём в работу. */
export function isExpired(job: { deadline: Date | null }, now: Date): boolean {
  return job.deadline !== null && job.deadline.getTime() <= now.getTime();
}

/** Ошибка, которую повторять бессмысленно: неверная постановка, отказ по правам. */
export class PermanentError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/**
 * Ошибка, случившаяся после того, как провайдер уже ответил и списал токены.
 * Расход пишется в задачу, даже если дальше упал разбор ответа.
 */
export class PaidError extends Error {
  readonly cost: JobCost;
  constructor(message: string, cost: JobCost) {
    super(message);
    this.name = 'PaidError';
    this.cost = cost;
  }
}

export type JobCost = Record<string, number>;

export function isRetryable(err: unknown): boolean {
  return !(err instanceof PermanentError);
}

/** Расход, который успел случиться до ошибки. */
export function costOfError(err: unknown): JobCost | null {
  return err instanceof PaidError ? err.cost : null;
}

/** Сложить два набора расходов по ключам. */
export function addCost(a: JobCost, b: JobCost): JobCost {
  const out: JobCost = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** Короткий текст ошибки для поля error. Стек не храним: он шумит и течёт. */
export function errorText(err: unknown, max = 2_000): string {
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  return (msg || 'unknown error').slice(0, max);
}

const SECRET_HINT = /(key|token|secret|password|authorization|cookie)/i;

/**
 * Убрать секреты из того, что уйдёт в журнал шагов.
 *
 * Правило грубое и намеренно такое: режем по имени поля, а не по содержимому.
 * Ложное срабатывание стоит нечитаемой строки в логе, пропуск - утёкшего ключа.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[...]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_HINT.test(k) ? '[скрыто]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2_000) return value.slice(0, 2_000) + '...';
  return value;
}

/**
 * Когда расписанию сработать в следующий раз.
 * Разброс не даёт всем расписаниям с одинаковым периодом слипнуться в одну секунду.
 */
export function nextRunAt(
  s: { everyMs: number; jitterRatio: number },
  now: Date,
  random: () => number = Math.random,
): Date {
  const r = random() * 2 - 1;
  const delta = s.everyMs * (1 + s.jitterRatio * r);
  return new Date(now.getTime() + Math.max(1_000, Math.round(delta)));
}

/** Надо ли поставить расписание на паузу после очередного сбоя. */
export function shouldPause(s: { failsInRow: number; pauseAfter: number }): boolean {
  return s.failsInRow >= s.pauseAfter;
}
