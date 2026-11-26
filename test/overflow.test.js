// Her conversation no longer fits the model (a turn breaks on CONTEXT_WINDOW_EXCEEDED): dsh-dot/memory hands her over,
// and what that turn was given arrives again in the new conversation, once — to him it is as if nothing had happened.
// He is told only when she is not moved (the handoff failed, or the conversation an overflow made overflows too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, ownerSource, PHONE_NOTIFICATION_SOURCE } from '../src/dot/core.js';
import { apply as applyMemory } from '../src/memory/memory.js';
import { hookTable } from './hooks.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const text = (m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const OVERFLOW = { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context window exceeded' } };

/** dot and her memory under a fake host: her agents take followup, steer and inject; s1 is her conversation. */
function harness(cfg = {}) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  writeFileSync(join(dsh, 'dsh-dot-state.json'), JSON.stringify({ lastSession: 's1' }));
  writeFileSync(join(dsh, 'dsh-memory.json'), JSON.stringify({ recall: { backend: 'off' } }));
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const { add: addHook } = hookTable();
  const listeners = [], effects = [], audit = [], archived = [], qqSent = [], agents = new Map(), made = new Map(), tools = {};
  let n = 0;
  const agentOf = (id) => {
    if (!agents.has(id)) agents.set(id, { session: { id, header: { cwd: made.get(id)?.cwd ?? home, agentPreset: made.get(id)?.agentPreset } }, got: [], steered: [], noted: [], cancels: [], followup(m) { this.got.push(m); }, steer(m) { this.steered.push(m); }, inject(m) { this.noted.push(m); }, cancel(c) { this.cancels.push(c.reason); } });
    return agents.get(id);
  };
  const services = {
    tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
    commands: { register: () => () => {} },
    sessionController: { create: async (req = {}) => { const sessionId = `c${++n}`; made.set(sessionId, req); return { sessionId }; }, rename: async () => ({}), resolveAgent: async (id) => ({ agent: agentOf(id) }) },
    agents: { get: (id) => agents.get(id) },
    workspaceRegistry: { archiveSession: async (id) => { archived.push(id); } },
    tokenMeter: { measure: () => ({ totalTokens: 1000 }) },
    llm: { resolveCallConfig: async (c) => c, stream: () => (async function* () { yield { type: 'text-delta', text: '在的' }; yield { type: 'finish', reason: { kind: 'stop' } }; })() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }) },
    dshInterlude: { cardText: () => '# 你是 小点\n话不多。', checks: () => [] },
    dshQq: { connected: true, owner: '20002', onMessage: (fn) => { services.qqMessage = fn; return () => {}; }, onTyping: () => () => {}, send: async (to, t) => { qqSent.push([to, t]); return { sent: 1, said: String(t).split('\n').filter(Boolean), images: [] }; } },
    dshComputer: { audit: (e) => audit.push(e), status: () => ({ state: 'ready' }), onStatus: () => () => {} },
  };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    on: (name, fn, opts) => { if (name === 'session/event') listeners.push(fn); else addHook(name, fn, opts); },
    effect(fn) { effects.push(fn()); },
    systemPrompt: { context() {}, section() { return () => {}; }, getSectionOrder: () => 0 },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (name) => (name === 'systemPrompt' ? ctx.systemPrompt : services[name]),
    provide: (name, v) => { services[name] = v; },
  };
  apply(ctx, { home, budgetPollSeconds: 0, notifyBatchMs: 5, ownerQuietMs: 5, ownerMaxWaitMs: 30, awakeHours: '00:00-24:00', ackHoldMs: 0, failureNoticeMs: 0, ...cfg });
  applyMemory(ctx, { home, handoffTokens: 100000, minTokensBetweenHandoffs: 1000, consolidateEveryLines: 1000 });
  const emit = (id, type, data) => { const a = agentOf(id); for (const fn of [...listeners]) fn(a.session, { type, data }); };
  const dot = services.dshDot;
  // a turn of hers, given what reached her agent (`m`: the message as it went in), ending as `reason` says
  const turn = (id, k, ms, reason = { kind: 'completed' }) => { emit(id, 'turn/start', { turn: k }); for (const m of ms) emit(id, 'user/message', { source: m.source, content: m.content }); emit(id, 'turn/end', { turn: k, reason }); };
  const his = (t) => services.qqMessage({ kind: 'private', userId: '20002', who: '宽', text: t, fromOwner: true, at: new Date().toISOString() });
  const someone = (t) => services.qqMessage({ kind: 'private', userId: '30003', who: '路人', text: t, fromOwner: false, at: new Date().toISOString() });
  const notices = () => qqSent.filter(([, t]) => /^⚠️ dot/.test(t)).map(([, t]) => t);
  const events = (name) => audit.filter((a) => a.event === name);
  turn('s1', 1, [{ source: ownerSource(), content: [{ type: 'text', text: '早上好' }] }]); // something said before, for the lines a handoff carries over
  return { ctx, home, services, tools, dot, emit, turn, his, someone, notices, events, audit, archived, qqSent, agentOf, stop: () => { for (const d of effects) if (typeof d === 'function') d(); } };
}

test('his words woke a turn that no longer fits: handed over, they arrive again in the new conversation and open a turn there; he is not told anything went wrong', async () => {
  const h = harness();
  const s1 = h.agentOf('s1');
  h.his('在吗'); await tick(60);
  assert.equal(s1.got.length, 1);
  assert.match(text(s1.got[0]), /他：在吗$/);
  h.turn('s1', 2, [s1.got[0]], OVERFLOW); await tick(200);
  assert.deepEqual(h.archived, ['s1']);
  const id = h.dot.session(), next = h.agentOf(id);
  assert.notEqual(id, 's1');
  // the new conversation opens with the old one's last lines, without his words: they come again, as they came
  assert.equal(next.noted.length, 1);
  assert.match(text(next.noted[0]), /早上好/);
  assert.doesNotMatch(text(next.noted[0]), /在吗/, 'not read twice');
  assert.equal(next.got.length, 1);
  assert.equal(text(next.got[0]), text(s1.got[0]), 'the same words, the same stamp');
  assert.equal(next.got[0].source.kind, 'user');
  assert.deepEqual(h.notices(), [], 'no "她这一轮出错了"');
  assert.equal(h.events('turn-failed').length, 0);
  assert.deepEqual(h.events('turn-overflowed').map((a) => [a.session, a.held, a.his]), [['s1', 1, true]]);
  assert.deepEqual(h.events('overflow-resent').map((a) => [a.from, a.to, a.count, a.kinds]), [['s1', id, 1, ['his']]]);
  assert.equal(h.events('handoff').at(-1).leftOut, 1);
  // she answers there, as she would have
  h.turn(id, 1, [next.got[0]]); await tick(80);
  assert.deepEqual(h.qqSent.at(-1), ['owner', '在的']);
  assert.equal(h.events('owner-message').length, 2);
  h.stop();
});

test('a notification woke the turn that no longer fits: it wakes her again in the new conversation; nothing is said to him', async () => {
  const h = harness();
  const s1 = h.agentOf('s1');
  h.someone('明天几点到'); await tick(60);
  assert.equal(s1.got.length, 1);
  assert.equal(s1.got[0].source.form, 'phone-notification');
  h.turn('s1', 2, [s1.got[0]], OVERFLOW); await tick(200);
  const id = h.dot.session(), next = h.agentOf(id);
  assert.notEqual(id, 's1');
  assert.equal(next.got.length, 1);
  assert.equal(text(next.got[0]), text(s1.got[0]));
  assert.deepEqual(next.got[0].source, PHONE_NOTIFICATION_SOURCE);
  assert.deepEqual(h.notices(), []);
  assert.equal(h.events('turn-failed').length, 0);
  assert.deepEqual(h.events('overflow-resent').at(-1).kinds, ['person']);
  h.stop();
});

test('her hands came back on a thing of his and the turn that woke no longer fits: the result wakes her again in the new conversation', async () => {
  const h = harness();
  const s1 = h.agentOf('s1');
  h.his('查一下明天天气'); await tick(60);
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: s1.got[0].source, content: s1.got[0].content });
  assert.equal((await h.tools.hands.execute({ device: 'web', do: '查明天天气' })).status, 'started'); await tick();
  h.emit('s1', 'turn/end', { turn: 2, reason: { kind: 'completed' } }); await tick(80);
  await h.tools.done.execute({ summary: '明天晴，二十度', reached: true }); await tick(80);
  const back = s1.got.at(-1);
  assert.equal(back.source.form, 'hands-result');
  h.turn('s1', 3, [back], OVERFLOW); await tick(200);
  const id = h.dot.session(), next = h.agentOf(id);
  assert.notEqual(id, 's1');
  assert.deepEqual(next.got.map((m) => m.source), [back.source]);
  assert.match(text(next.got[0]), /明天晴，二十度/);
  assert.deepEqual(h.notices(), []);
  assert.equal(h.events('turn-failed').length, 0);
  h.stop();
});

test('his words steered into the turn that no longer fits arrive again too, with what woke it — each once', async () => {
  const h = harness();
  const s1 = h.agentOf('s1');
  h.someone('明天几点到'); await tick(60);
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: s1.got[0].source, content: s1.got[0].content });
  h.his('谁啊'); await tick(60);
  assert.equal(s1.steered.length, 1, 'steered into her turn');
  assert.match(text(s1.steered[0]), /他：谁啊\n（这是你这轮进行中他发来的。）$/);
  h.emit('s1', 'user/message', { source: s1.steered[0].source, content: s1.steered[0].content });
  h.emit('s1', 'turn/end', { turn: 2, reason: OVERFLOW }); await tick(200);
  const id = h.dot.session(), next = h.agentOf(id);
  assert.notEqual(id, 's1');
  assert.deepEqual(next.got.map((m) => m.source.kind), ['user', 'dsh-dot'], 'his words first, as they always go');
  assert.match(text(next.got[0]), /他：谁啊$/, 'a message of his that opens a turn, not one steered into one');
  assert.equal(text(next.got[1]), text(s1.got[0]));
  assert.doesNotMatch(text(next.noted[0]), /谁啊/);
  assert.equal(h.events('turn-failed').length, 0);
  assert.deepEqual(h.notices(), []);
  // what came again is not kept for a turn after the one it opens
  h.turn(id, 1, next.got); await tick(80);
  await h.services.dotMemory.handoff(id); await tick(200);
  assert.equal(h.agentOf(h.dot.session()).got.length, 0);
  h.stop();
});

test('a turn that broke any other way is not sent again: he is told as before, and a later handoff carries nothing of it', async () => {
  const h = harness();
  const s1 = h.agentOf('s1');
  h.his('在吗'); await tick(60);
  h.turn('s1', 2, [s1.got[0]], { kind: 'error', error: { code: 'SERVER', message: 'Service Unavailable' } }); await tick(200);
  assert.deepEqual(h.archived, [], 'no handoff');
  assert.deepEqual(h.notices(), ['⚠️ dot：她这一轮出错了，没有回你。\n原因：Service Unavailable']);
  assert.equal(h.events('turn-overflowed').length, 0);
  h.turn('s1', 3, [], { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } }); await tick(50);
  await h.services.dotMemory.handoff('s1'); await tick(200);
  const id = h.dot.session();
  assert.notEqual(id, 's1');
  assert.equal(h.agentOf(id).got.length, 0, 'nothing sent again');
  assert.match(text(h.agentOf(id).noted[0]), /在吗/, 'his words are in the lines carried over, as before');
  assert.equal(h.events('overflow-resent').length, 0);
  h.stop();
});

test('the conversation an overflow made overflows too: nothing is sent a second time, and he is told once what to do', async () => {
  const h = harness();
  const s1 = h.agentOf('s1');
  h.his('在吗'); await tick(60);
  h.turn('s1', 2, [s1.got[0]], OVERFLOW); await tick(200);
  const id = h.dot.session(), next = h.agentOf(id);
  assert.equal(next.got.length, 1);
  h.turn(id, 1, [next.got[0]], OVERFLOW); await tick(200);
  assert.deepEqual(h.archived, ['s1'], 'not handed over again');
  assert.equal(h.dot.session(), id);
  assert.equal(next.got.length, 1, 'not sent again');
  assert.deepEqual(h.notices(), ['⚠️ dot：她换到新对话以后还是装不下，这一轮没有回你。多半是刚才那条太长（或者图太多），也可能是现在用的模型上下文太小。\n在 dsh 里发 /dot memory handoff 再换一个新对话，然后把话说短一点再发；还不行就换一个上下文更大的模型。\n原因：context window exceeded']);
  assert.deepEqual(h.events('turn-failed').map((a) => [a.session, a.outcome, a.overflow]), [[id, 'context', 'again']]);
  assert.deepEqual(h.events('overflow-dropped').map((a) => [a.count, a.why]), [[1, 'again']]);
  await tick(100);
  assert.equal(h.notices().length, 1, 'once');
  h.stop();
});

test('the handoff after an overflow fails: he is told it, and what to do; nothing is sent again', async () => {
  const h = harness();
  const s1 = h.agentOf('s1');
  h.his('在吗'); await tick(60);
  h.services.sessionController.create = async () => { throw new Error('no room for a session'); };
  h.turn('s1', 2, [s1.got[0]], OVERFLOW); await tick(200);
  assert.equal(h.dot.session(), 's1');
  assert.ok(h.events('handoff-failed').length);
  assert.deepEqual(h.notices(), ['⚠️ dot：她的对话太长，模型装不下了，换到新对话也没成，这一轮没有回你。\n在 dsh 里发 /dot memory handoff 让她换个新对话；换好以后，刚才的话请再发一次。\n原因：context window exceeded（换新对话没成：no room for a session）']);
  assert.deepEqual(h.events('turn-failed').map((a) => [a.outcome, a.overflow]), [['context', 'failed']]);
  assert.equal(s1.got.length, 1, 'nothing sent again');
  h.stop();
});
