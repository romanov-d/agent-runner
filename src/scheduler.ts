import { query, one } from './db.ts';
import { enqueue } from './queue.ts';
import { nextRunAt, shouldPause } from './logic.ts';

/**
 * Расписания. Два вида по смыслу: script - обычный обработчик без модели,
 * agent - запуск агента. Для очереди разницы нет, разница в стоимости ошибки.
 *
 * Три вещи, без которых расписания превращаются в источник инцидентов:
 * защита от наложения, разброс и автопауза.
 */

export type Schedule = {
  id: string;
  name: string;
  kind: string;
  agent: string;
  mode: 'script' | 'agent';
  payload: Record<string, unknown>;
  every_ms: string;
  jitter_ratio: number;
  enabled: boolean;
  fails_in_row: number;
  pause_after: number;
  last_run_at: Date | null;
  next_run_at: Date;
};

export async function upsertSchedule(s: {
  name: string;
  kind: string;
  everyMs: number;
  mode?: 'script' | 'agent';
  agent?: string;
  payload?: Record<string, unknown>;
  jitterRatio?: number;
  pauseAfter?: number;
}): Promise<void> {
  await query(
    `INSERT INTO schedules (name, kind, agent, mode, payload, every_ms, jitter_ratio, pause_after)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
     ON CONFLICT (name) DO UPDATE SET
       kind = EXCLUDED.kind, agent = EXCLUDED.agent, mode = EXCLUDED.mode,
       payload = EXCLUDED.payload, every_ms = EXCLUDED.every_ms,
       jitter_ratio = EXCLUDED.jitter_ratio, pause_after = EXCLUDED.pause_after`,
    [
      s.name,
      s.kind,
      s.agent ?? 'default',
      s.mode ?? 'script',
      JSON.stringify(s.payload ?? {}),
      s.everyMs,
      s.jitterRatio ?? 0.1,
      s.pauseAfter ?? 5,
    ],
  );
}

/**
 * Поставить задачи по сработавшим расписаниям.
 *
 * Защита от наложения сделана ключом идемпотентности, а не проверкой "а не
 * запущено ли уже": ключ содержит имя расписания и момент запуска, поэтому
 * два планировщика, сработавшие одновременно, создадут одну задачу.
 */
export async function tick(now = new Date()): Promise<number> {
  const due = await query<Schedule>(
    `UPDATE schedules SET last_run_at = now()
     WHERE enabled AND next_run_at <= now()
     RETURNING *`,
  );

  for (const s of due) {
    const slot = Math.floor(now.getTime() / Number(s.every_ms));
    await enqueue({
      kind: s.mode === 'agent' ? 'agent' : s.kind,
      agent: s.agent,
      payload: s.payload,
      idempotencyKey: `sched:${s.name}:${slot}`,
    });
    const next = nextRunAt({ everyMs: Number(s.every_ms), jitterRatio: s.jitter_ratio }, now);
    await query(`UPDATE schedules SET next_run_at = $2 WHERE id = $1`, [s.id, next]);
  }
  return due.length;
}

/** Отметить сбой расписания и при серии подряд поставить его на паузу. */
export async function reportFailure(name: string): Promise<boolean> {
  const s = await one<Schedule>(
    `UPDATE schedules SET fails_in_row = fails_in_row + 1 WHERE name = $1 RETURNING *`,
    [name],
  );
  if (!s) return false;
  if (shouldPause({ failsInRow: s.fails_in_row, pauseAfter: s.pause_after })) {
    await query(`UPDATE schedules SET enabled = false WHERE id = $1`, [s.id]);
    return true;
  }
  return false;
}

export async function reportSuccess(name: string): Promise<void> {
  await query(`UPDATE schedules SET fails_in_row = 0 WHERE name = $1`, [name]);
}
