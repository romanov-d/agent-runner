import { PaidError, type JobCost } from './logic.ts';

/**
 * Доступ к моделям за одним интерфейсом.
 *
 * Вызывающий код не знает, кто отвечает: провайдер определяется именем модели.
 * Смена провайдера правится здесь, а не по всему проекту.
 */

export type ToolSpec = {
  name: string;
  description: string;
  input: Record<string, unknown>;
};

export type ModelMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'tool'; name: string; content: string };

export type ModelReply = {
  /** Текст ответа, если модель закончила. */
  text?: string;
  /** Запрос на вызов инструмента, если модель хочет действовать. */
  call?: { name: string; args: Record<string, unknown> };
  cost: JobCost;
};

export interface ModelProvider {
  readonly name: string;
  complete(input: {
    system: string;
    messages: ModelMessage[];
    tools: ToolSpec[];
    signal?: AbortSignal;
  }): Promise<ModelReply>;
}

/** Цены за миллион токенов. Держим рядом с кодом, чтобы расход считался, а не угадывался. */
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 1, out: 5 },
};

export function costOf(model: string, inTok: number, outTok: number): JobCost {
  const p = PRICE_PER_MTOK[model] ?? { in: 0, out: 0 };
  const usd = (inTok * p.in + outTok * p.out) / 1_000_000;
  return { usd: Number(usd.toFixed(6)), in_tokens: inTok, out_tokens: outTok };
}

/**
 * Детерминированная заглушка вместо настоящей модели.
 *
 * Нужна, чтобы тесты и CI не зависели от сети, ключей и денег, а поведение
 * раннера проверялось само по себе. Сценарий задаётся списком ответов.
 */
export class FakeModel implements ModelProvider {
  readonly name = 'fake';
  private readonly script: ModelReply[];
  private i = 0;

  constructor(script: ModelReply[]) {
    this.script = script;
  }

  async complete(): Promise<ModelReply> {
    const reply = this.script[this.i++];
    if (!reply) throw new Error('FakeModel: сценарий кончился, а раннер просит ещё ответ');
    return reply;
  }

  /** Сколько раз модель вызывали. Удобно проверять в тестах. */
  get calls(): number {
    return this.i;
  }
}

/**
 * Заглушка, которая отвечает, а потом ломается на разборе.
 * Воспроизводит реальный случай: токены списаны, результат непригоден.
 */
export class PaidThenBrokenModel implements ModelProvider {
  readonly name = 'fake-paid-broken';
  private readonly cost: JobCost;

  constructor(cost: JobCost = { usd: 0.01 }) {
    this.cost = cost;
  }

  async complete(): Promise<ModelReply> {
    throw new PaidError('модель ответила, разбор ответа упал', this.cost);
  }
}
