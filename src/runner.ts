import { addCost, PermanentError, type JobCost } from './logic.ts';
import type { ModelMessage, ModelProvider } from './model.ts';
import { ApprovalRequired, type AgentProfile, type Tool, type ToolRegistry } from './tools.ts';

/**
 * Раннер агента: цикл "модель думает - вызывает инструмент - получает результат".
 *
 * Очередь решает, что исполнять и когда. Раннер исполняет: собирает контекст,
 * выдаёт инструменты по правам, крутит шаги, пишет журнал, считает деньги
 * и останавливается по лимитам. Эти две вещи разделены намеренно: очередь
 * переживает перезапуск процесса, раннер - нет.
 */

export type StepSink = (step: {
  seq: number;
  kind: 'model' | 'tool' | 'note' | 'error';
  name?: string;
  detail?: unknown;
  cost?: JobCost;
  ms?: number;
}) => Promise<void>;

export type RunInput = {
  system: string;
  task: string;
  /** Память агента: что он знает о проекте до начала работы. */
  memory?: string;
  profile: AgentProfile;
  model: ModelProvider;
  tools: ToolRegistry;
  onStep: StepSink;
  /** Пульс: вернул false - задачу у нас отняли, надо прекращать. */
  alive?: () => Promise<boolean>;
  approve?: (tool: Tool, args: Record<string, unknown>) => Promise<boolean>;
  limits?: { maxSteps?: number; maxUsd?: number; timeoutMs?: number };
};

export type RunResult = {
  text: string;
  steps: number;
  cost: JobCost;
};

export class LimitReached extends PermanentError {}
export class Abandoned extends Error {
  constructor() {
    super('задачу отняли: пульс не подтверждён');
    this.name = 'Abandoned';
  }
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const maxSteps = input.limits?.maxSteps ?? 12;
  const maxUsd = input.limits?.maxUsd ?? 1;
  const timeoutMs = input.limits?.timeoutMs ?? 120_000;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  // Контекст собирается здесь, а не в промпте обработчика: так видно,
  // что именно уходит в модель, и это одно место для правки.
  const messages: ModelMessage[] = [];
  if (input.memory) messages.push({ role: 'user', content: `Что уже известно:\n${input.memory}` });
  messages.push({ role: 'user', content: input.task });

  let cost: JobCost = {};
  let seq = 0;

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (input.alive && !(await input.alive())) throw new Abandoned();

      const started = Date.now();
      const reply = await input.model.complete({
        system: input.system,
        messages,
        tools: input.tools.specsFor(input.profile),
        signal: ac.signal,
      });
      cost = addCost(cost, reply.cost);
      await input.onStep({
        seq: seq++,
        kind: 'model',
        name: input.model.name,
        detail: { call: reply.call?.name ?? null, textLen: reply.text?.length ?? 0 },
        cost: reply.cost,
        ms: Date.now() - started,
      });

      if ((cost.usd ?? 0) > maxUsd) {
        throw new LimitReached(`потрачено ${cost.usd} при лимите ${maxUsd}`);
      }

      if (!reply.call) {
        return { text: reply.text ?? '', steps: seq, cost };
      }

      const toolStarted = Date.now();
      try {
        const out = await input.tools.call(input.profile, reply.call.name, reply.call.args, {
          approve: input.approve,
        });
        await input.onStep({
          seq: seq++,
          kind: 'tool',
          name: reply.call.name,
          detail: { args: reply.call.args, out },
          ms: Date.now() - toolStarted,
        });
        messages.push({ role: 'tool', name: reply.call.name, content: JSON.stringify(out) });
      } catch (err) {
        if (err instanceof ApprovalRequired) throw err; // наверх: решает человек
        // Отказ инструмента - это не падение задачи. Модель должна узнать
        // причину и выбрать другой путь, иначе мы теряем уже потраченное.
        await input.onStep({
          seq: seq++,
          kind: 'error',
          name: reply.call.name,
          detail: { message: (err as Error).message },
          ms: Date.now() - toolStarted,
        });
        messages.push({
          role: 'tool',
          name: reply.call.name,
          content: JSON.stringify({ error: (err as Error).message }),
        });
      }
    }
    throw new LimitReached(`достигнут предел шагов: ${maxSteps}`);
  } finally {
    clearTimeout(timer);
  }
}
