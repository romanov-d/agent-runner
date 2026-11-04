import { FakeModel, type ModelProvider } from './model.ts';
import { runAgent } from './runner.ts';
import { appendStep, type Job } from './queue.ts';
import { demoTools, type AgentProfile } from './tools.ts';
import type { JobCost } from './logic.ts';

/**
 * Обработчики задач: что именно делать с задачей каждого вида.
 *
 * Два вида по смыслу: script - обычный код без модели, agent - запуск агента.
 * Очередь и раннер про это ничего не знают, им всё равно, что внутри.
 */

export type HandlerContext = {
  job: Job;
  /** Пульс. false - задачу отняли, пора прекращать. */
  alive: () => Promise<boolean>;
};

export type HandlerResult = { result?: Record<string, unknown>; cost?: JobCost };
export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

const PROFILES: Record<string, AgentProfile> = {
  // Аналитик читает, но ничего не меняет.
  analyst: { name: 'analyst', allow: ['kv_get'], canWrite: false },
  // Редактор может писать, но не может снести всё разом.
  editor: { name: 'editor', allow: ['kv_get', 'kv_set'], canWrite: true },
  // Администратору доступно и необратимое - но только через подтверждение.
  admin: { name: 'admin', allow: ['kv_get', 'kv_set', 'kv_drop_all'], canWrite: true },
};

/** Модель по умолчанию - заглушка: демо и тесты не должны требовать ключей. */
function modelFor(job: Job): ModelProvider {
  const script = (job.payload.script as never) ?? [
    { call: { name: 'kv_get', args: { key: 'greeting' } }, cost: { usd: 0.0004 } },
    { text: 'готово', cost: { usd: 0.0002 } },
  ];
  return new FakeModel(script);
}

export const handlers: Record<string, Handler> = {
  /** Задача без модели: просто код по расписанию. */
  async ping() {
    return { result: { pong: true, at: new Date().toISOString() } };
  },

  /** Задача, которая падает заданное число раз - для проверки повторов. */
  async flaky(ctx) {
    const failUntil = Number(ctx.job.payload.failUntil ?? 2);
    if (ctx.job.attempts <= failUntil) throw new Error(`падение попытки ${ctx.job.attempts}`);
    return { result: { ok: true, onAttempt: ctx.job.attempts } };
  },

  /** Задача, которая просто ждёт: для проверки пульса и остановки. */
  async sleep(ctx) {
    const ms = Number(ctx.job.payload.ms ?? 1_000);
    await new Promise((r) => setTimeout(r, ms));
    return { result: { sleptMs: ms } };
  },

  /** Запуск агента. */
  async agent(ctx) {
    const profile = PROFILES[ctx.job.agent] ?? PROFILES.analyst!;
    const tools = demoTools(new Map([['greeting', 'привет']]));
    let seq = 0;

    const out = await runAgent({
      system: 'Ты рабочий агент. Отвечай коротко и по делу.',
      task: String(ctx.job.payload.task ?? 'Скажи, что лежит по ключу greeting'),
      memory: ctx.job.payload.memory as string | undefined,
      profile,
      model: modelFor(ctx.job),
      tools,
      alive: ctx.alive,
      onStep: async (s) => {
        await appendStep({
          jobId: ctx.job.id,
          attempt: ctx.job.attempts,
          seq: seq++,
          kind: s.kind,
          name: s.name,
          detail: s.detail,
          cost: s.cost,
          ms: s.ms,
        });
      },
      limits: { maxSteps: 8, maxUsd: 0.5, timeoutMs: 60_000 },
    });

    return { result: { text: out.text, steps: out.steps }, cost: out.cost };
  },
};
