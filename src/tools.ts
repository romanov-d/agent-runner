import { PermanentError } from './logic.ts';

/**
 * Инструменты агента и права на них.
 *
 * Права выданы перехватом вызова, а не фразой в промпте. Инструкцию в промпте
 * можно переспорить другой инструкцией; список разрешённых имён - нельзя.
 */

export type ToolAccess = 'read' | 'write';

export type Tool = {
  name: string;
  description: string;
  access: ToolAccess;
  /** Необратимое действие: требует подтверждения человека. */
  irreversible?: boolean;
  input: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
};

export type AgentProfile = {
  name: string;
  /** Какие инструменты разрешены этому агенту. Всё, чего нет в списке, запрещено. */
  allow: string[];
  /** Разрешена ли запись вообще. Отдельный выключатель поверх списка. */
  canWrite: boolean;
};

export class ToolDenied extends PermanentError {
  constructor(tool: string, reason: string) {
    super(`инструмент ${tool} запрещён: ${reason}`);
  }
}

export class ApprovalRequired extends Error {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  constructor(tool: string, args: Record<string, unknown>) {
    super(`нужно подтверждение человека на ${tool}`);
    this.name = 'ApprovalRequired';
    this.tool = tool;
    this.args = args;
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** Что видит агент: только разрешённое ему, иначе он будет просить недоступное. */
  specsFor(profile: AgentProfile) {
    return [...this.tools.values()]
      .filter((t) => this.permitted(profile, t) === null)
      .map((t) => ({ name: t.name, description: t.description, input: t.input }));
  }

  /** null - можно, строка - причина отказа. */
  permitted(profile: AgentProfile, tool: Tool): string | null {
    if (!profile.allow.includes(tool.name)) return 'не в списке разрешённых';
    if (tool.access === 'write' && !profile.canWrite) return 'агенту запрещена запись';
    return null;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Вызвать инструмент от имени агента.
   *
   * Порядок проверок важен: сначала существование, потом права, потом
   * подтверждение. Иначе по тексту ошибки можно выяснить, какие инструменты
   * существуют, но недоступны.
   */
  async call(
    profile: AgentProfile,
    name: string,
    args: Record<string, unknown>,
    opts: { approve?: (tool: Tool, args: Record<string, unknown>) => Promise<boolean> } = {},
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new PermanentError(`инструмент ${name} не существует`);

    const denied = this.permitted(profile, tool);
    if (denied) throw new ToolDenied(name, denied);

    if (tool.irreversible) {
      const ok = opts.approve ? await opts.approve(tool, args) : false;
      if (!ok) throw new ApprovalRequired(name, args);
    }

    return tool.run(args);
  }
}

/** Демонстрационные инструменты: один на чтение, один на запись, один необратимый. */
export function demoTools(store = new Map<string, string>()): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: 'kv_get',
      description: 'Прочитать значение по ключу',
      access: 'read',
      input: { key: 'string' },
      async run(args) {
        return { value: store.get(String(args.key)) ?? null };
      },
    })
    .register({
      name: 'kv_set',
      description: 'Записать значение по ключу',
      access: 'write',
      input: { key: 'string', value: 'string' },
      async run(args) {
        store.set(String(args.key), String(args.value));
        return { ok: true };
      },
    })
    .register({
      name: 'kv_drop_all',
      description: 'Удалить все значения',
      access: 'write',
      irreversible: true,
      input: {},
      async run() {
        const n = store.size;
        store.clear();
        return { removed: n };
      },
    });
}
