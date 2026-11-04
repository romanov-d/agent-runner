import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, LimitReached, Abandoned } from '../src/runner.ts';
import { FakeModel, type ModelReply } from '../src/model.ts';
import { demoTools, ApprovalRequired, type AgentProfile } from '../src/tools.ts';

/**
 * Раннер проверяется без базы и без сети: модель - заглушка со сценарием,
 * инструменты - в памяти. Проверяем то, за что отвечает именно раннер:
 * права, подтверждения, лимиты и журнал.
 */

const analyst: AgentProfile = { name: 'analyst', allow: ['kv_get'], canWrite: false };
const editor: AgentProfile = { name: 'editor', allow: ['kv_get', 'kv_set'], canWrite: true };
const admin: AgentProfile = { name: 'admin', allow: ['kv_get', 'kv_set', 'kv_drop_all'], canWrite: true };

function collector() {
  const steps: { kind: string; name?: string }[] = [];
  return { steps, onStep: async (s: { kind: string; name?: string }) => { steps.push({ kind: s.kind, name: s.name }); } };
}

function run(profile: AgentProfile, script: ModelReply[], extra: Record<string, unknown> = {}) {
  const sink = collector();
  const store = new Map([['greeting', 'привет']]);
  return {
    sink,
    store,
    promise: runAgent({
      system: 'тест',
      task: 'сделай',
      profile,
      model: new FakeModel(script),
      tools: demoTools(store),
      onStep: sink.onStep,
      ...extra,
    }),
  };
}

describe('раннер агента', () => {
  test('вызывает инструмент и возвращает ответ модели', async () => {
    const r = run(analyst, [
      { call: { name: 'kv_get', args: { key: 'greeting' } }, cost: { usd: 0.001 } },
      { text: 'там привет', cost: { usd: 0.001 } },
    ]);
    const out = await r.promise;
    assert.equal(out.text, 'там привет');
    assert.equal(out.cost.usd, 0.002);
    assert.deepEqual(r.sink.steps.map((s) => s.kind), ['model', 'tool', 'model']);
  });

  test('агент видит только разрешённые ему инструменты', async () => {
    const tools = demoTools();
    assert.deepEqual(tools.specsFor(analyst).map((t) => t.name), ['kv_get']);
    assert.deepEqual(tools.specsFor(editor).map((t) => t.name), ['kv_get', 'kv_set']);
    assert.equal(tools.specsFor(admin).length, 3);
  });

  test('запрет на запись не обходится вызовом напрямую', async () => {
    const r = run(analyst, [
      { call: { name: 'kv_set', args: { key: 'x', value: '1' } }, cost: { usd: 0.001 } },
      { text: 'не смог', cost: { usd: 0.001 } },
    ]);
    const out = await r.promise;
    // Отказ не валит задачу: модель узнаёт причину и идёт дальше.
    assert.equal(out.text, 'не смог');
    assert.ok(r.sink.steps.some((s) => s.kind === 'error' && s.name === 'kv_set'));
    assert.equal(r.store.has('x'), false, 'запись всё-таки прошла');
  });

  test('несуществующий инструмент тоже не валит задачу', async () => {
    const r = run(admin, [
      { call: { name: 'rm_rf', args: {} }, cost: { usd: 0.001 } },
      { text: 'такого нет', cost: { usd: 0.001 } },
    ]);
    assert.equal((await r.promise).text, 'такого нет');
  });

  test('необратимое действие без подтверждения останавливает задачу', async () => {
    const r = run(admin, [{ call: { name: 'kv_drop_all', args: {} }, cost: { usd: 0.001 } }]);
    await assert.rejects(r.promise, (e: Error) => e instanceof ApprovalRequired);
    assert.equal(r.store.size, 1, 'данные удалили без спроса');
  });

  test('с подтверждением необратимое выполняется', async () => {
    const r = run(
      admin,
      [
        { call: { name: 'kv_drop_all', args: {} }, cost: { usd: 0.001 } },
        { text: 'очищено', cost: { usd: 0.001 } },
      ],
      { approve: async () => true },
    );
    assert.equal((await r.promise).text, 'очищено');
    assert.equal(r.store.size, 0);
  });

  test('предел шагов не даёт агенту крутиться вечно', async () => {
    const loop: ModelReply[] = Array.from({ length: 10 }, () => ({
      call: { name: 'kv_get', args: { key: 'greeting' } },
      cost: { usd: 0.0001 },
    }));
    const r = run(analyst, loop, { limits: { maxSteps: 3 } });
    await assert.rejects(r.promise, (e: Error) => e instanceof LimitReached);
  });

  test('предел по деньгам останавливает до того, как счёт вырастет', async () => {
    const r = run(analyst, [{ text: 'дорого', cost: { usd: 5 } }], { limits: { maxUsd: 1 } });
    await assert.rejects(r.promise, (e: Error) => e instanceof LimitReached && /5/.test(e.message));
  });

  test('потеря пульса прекращает работу: результат всё равно не примут', async () => {
    const r = run(analyst, [{ text: 'поздно', cost: { usd: 0.001 } }], { alive: async () => false });
    await assert.rejects(r.promise, (e: Error) => e instanceof Abandoned);
  });
});
