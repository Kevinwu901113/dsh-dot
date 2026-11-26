// dsh-dot/hands: what is under way is found by the hands' session it is done in, or by its id — not as "the" thing.
// What the code keeps on a thing (keptOf) goes with it; a thing given after another begins with its own state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHands } from '../src/dot/hands.js';
import { createLedger } from '../src/dot/ledger.js';
import { writeFileSync } from 'node:fs';
import { apply, ownerSource } from '../src/dot/core.js';
import { hookTable } from './hooks.js';

function harness(opts = {}) {
  const listeners = new Set(), sent = [], cancelled = [], kv = new Map(), done = [];
  let n = 0;
  const agents = new Map();
  const dir = join(mkdtempSync(join(tmpdir(), 'hands-')), 'hands');
  const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) };
  const ledger = createLedger({ store });
  const hands = createHands({
    dir, ledger,
    create: async () => { const id = `h${++n}`; agents.set(id, { followup: (m) => sent.push([id, m]), cancel: (c) => cancelled.push([id, c.reason]) }); return id; },
    agentFor: async (id) => agents.get(id) ?? null,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    message: (text) => text, textOf: (c) => c,
    store, done: () => 'MISSING',
    onDone: (r, j) => done.push([r, j]), ...opts,
  });
  const emit = (id, type, data) => { for (const fn of [...listeners]) fn({ id }, { type, data }); };
  return { hands, ledger, sent, emit, done };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('hands, by session: thingOf finds the thing done in that session, thingById by its id, things lists what is under way', async () => {
  const h = harness();
  assert.deepEqual([h.hands.thingOf('h1'), h.hands.thingById('t1'), h.hands.things()], [null, null, []], 'nothing under way');
  h.hands.start({ device: 'phone', task: '打开相册', forHim: true });
  // under way at once, its session a moment later: by id it is there, by a session not yet
  assert.equal(h.hands.thingById('t1').task, '打开相册');
  assert.equal(h.hands.thingOf('h1'), null);
  await tick();
  assert.deepEqual(h.hands.thingOf('h1'), h.hands.doing(), 'the same view as doing()');
  assert.deepEqual([h.hands.thingOf('h1').id, h.hands.thingOf('h1').session, h.hands.thingOf('h1').forHim], ['t1', 'h1', true]);
  assert.deepEqual(h.hands.thingById('t1'), h.hands.thingOf('h1'));
  assert.deepEqual(h.hands.things().map((t) => [t.id, t.session]), [['t1', 'h1']]);
  assert.equal(h.hands.thingOf('h2'), null, 'another session has nothing under way');
  assert.equal(h.hands.thingOf(undefined), null);
  // a second, in another place: under way beside it, found by its id at once and by its own session once made
  assert.equal(h.hands.start({ device: 'computer', task: '再做一件' }).status, 'started');
  assert.equal(h.hands.thingById('t2').task, '再做一件');
  await tick();
  assert.deepEqual(h.hands.things().map((t) => [t.id, t.session, t.device]), [['t1', 'h1', 'phone'], ['t2', 'h2', 'computer']]);
  assert.deepEqual([h.hands.on('phone').id, h.hands.on('computer').id, h.hands.on('web')], ['t1', 't2', null], 'a place names the one there');
  h.hands.finish({ summary: '开了' }, { session: 'h1' });
  await tick();
  // the session of a thing that is over is still hers (isHands), but nothing is under way in it
  assert.ok(h.hands.isHands('h1'));
  assert.equal(h.hands.thingOf('h1'), null);
  assert.equal(h.hands.thingById('t1'), null);
  assert.deepEqual([h.hands.thingOf('h2')?.id, h.hands.thingById('t2')?.session], ['t2', 'h2']);
});

test('hands, by session: a call that names a session acts on that session\'s thing only — a late one from a session that is over acts on nothing', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '第一件' }); await tick();
  h.hands.start({ device: 'web', task: '第二件 喝咖啡的猫' }); await tick();
  h.hands.finish({ summary: '好了' }, { session: 'h1' }); await tick();
  assert.equal(h.hands.thingOf('h2').id, 't2');
  const late = { session: 'h1' }, mine = { session: 'h2' };
  assert.equal(h.hands.ask('还要吗？', {}, late), false);
  assert.equal(h.hands.asked(mine), false);
  assert.equal(h.hands.thingOf('h2').question, '', 'its question is its own');
  assert.equal(h.hands.has('喝咖啡的猫', late), false);
  assert.equal(h.hands.has('喝咖啡的猫', mine), true);
  h.hands.note('own-words', late);
  assert.deepEqual(h.hands.add('再存一张', late), { status: 'idle' });
  assert.equal(h.hands.fail({ cause: 'same-error', error: 'x' }, late), false);
  assert.equal(h.hands.finish({ summary: '假的' }, late), false);
  assert.ok(h.hands.busy() && h.hands.thingOf('h2'), 'still under way');
  // by its id, the same
  assert.deepEqual(h.hands.add('再存一张', { thing: 't2' }), { status: 'added', id: 't2' });
  assert.ok(h.hands.has('再存一张', { thing: 't2' }));
  assert.equal(h.hands.ask('存哪张？', {}, { thing: 't2' }), true);
  assert.equal(h.hands.asked({ session: 'h2' }), true);
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } });
  const [r] = h.done.at(-1);
  assert.deepEqual([r.outcome, r.question, r.notes], ['stuck', '存哪张？', []], 'the late note did not land on it');
});

test('hands, kept on the thing: what the code keeps on one thing does not reach the next; a thing given after it begins with its own state', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '第一件' }); await tick();
  const k1 = h.hands.keptOf('t1');
  assert.deepEqual(k1, {}, 'made with the thing');
  k1.actedAt = 123; k1.errorRun = { type: 'timeout', n: 2 }; k1.reached = true;
  assert.equal(h.hands.keptOf('t1'), k1, 'the same object while it is under way');
  h.emit('h1', 'tool/call'); h.emit('h1', 'tool/result', { message: { content: '屏幕上的字 甲乙丙' } });
  h.hands.note('reply-check', { session: 'h1' });
  h.hands.ask('选哪个？', {}, { session: 'h1' });
  // the phone is held: a second there does not begin (nothing is kept for it)
  assert.equal(h.hands.start({ device: 'phone', task: '第二件' }).status, 'busy');
  assert.equal(h.hands.keptOf('t2'), null, 'not under way');
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } }); // ends stuck on its question
  assert.equal(h.done[0][0].outcome, 'stuck');
  assert.equal(h.hands.keptOf('t1'), null, 'gone with it');
  assert.equal(h.hands.start({ device: 'phone', task: '第二件' }).status, 'started', 'given again, once the phone is free');
  await tick();
  // its own state, nothing of the first's
  const t2 = h.hands.thingOf('h2');
  assert.deepEqual([t2.id, t2.task, t2.question, t2.steps, t2.said], ['t2', '第二件', '', 0, '']);
  assert.deepEqual(h.hands.keptOf('t2'), {}, 'nothing kept on the first is on it');
  assert.equal(h.hands.asked({ session: 'h2' }), false);
  assert.equal(h.hands.has('甲乙丙', { session: 'h2' }), false, 'what the first was shown is not its');
  assert.equal(h.hands.has('第二件', { session: 'h2' }), true);
  h.hands.finish({ summary: '好' }, { session: 'h2' });
  assert.deepEqual(h.done[1][0].notes, [], 'the first one\'s notes stayed with it');
  assert.deepEqual(h.done[0][0].notes, ['reply-check']);
});

test('hands, stop: everything by default; with a thing\'s id that one only — the others go on', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '一' }); await tick();
  h.hands.start({ device: 'web', task: '二' });
  h.hands.start({ device: 'computer', task: '三' });
  assert.equal(h.hands.stop({ by: 'her', thing: 't2' }), true, 'one of three');
  assert.deepEqual(h.ledger.unfinished().map((e) => e.id), ['t1', 't3']);
  assert.equal(h.hands.stop({ by: 'her', thing: 't1' }), true);
  await tick();
  assert.equal(h.hands.doing().id, 't3');
  assert.equal(h.hands.stop({ thing: 't9' }), false);
  assert.equal(h.hands.stop({ by: 'him', cause: 'command' }), true);
  assert.deepEqual([h.hands.busy(), h.hands.stop()], [false, false]);
  assert.deepEqual(h.done.map(([r, j]) => [j.id, r.outcome, r.by]), [['t2', 'stopped', 'her'], ['t1', 'stopped', 'her'], ['t3', 'stopped', 'him']]);
});

// The same, wired into the host (core.js): each hook of a hands session asks for that session's thing.
const text = (m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
function coreHarness(cfg = {}) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  writeFileSync(join(dsh, 'dsh-dot-state.json'), '{}');
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const { hooks, add: addHook } = hookTable();
  const listeners = [], effects = [], audit = [], tools = {}, archived = [], qqSent = [], agents = new Map(), llmCalls = [], replies = [], herSaid = [];
  let command, n = 0;
  const made = new Map(); // session id → what it was made with ({ cwd, agentPreset }), as dsh keeps it on the session
  const agentOf = (id) => { if (!agents.has(id)) agents.set(id, { session: { id, header: { cwd: made.get(id)?.cwd ?? (id.startsWith('h') ? join(dsh, 'dsh-dot-hands') : home), agentPreset: made.get(id)?.agentPreset } }, got: [], cancels: [], selected: [], model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: agents.get(id).selected.at(-1)?.reasoningEffort ?? 'off' }), select: (sel) => { agents.get(id).selected.push(sel); } }, noted: [], inject(m) { this.noted.push(m); }, followup(m) { this.got.push(m); }, cancel(c) { this.cancels.push(c.reason); } }); return agents.get(id); };
  const services = {
    tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
    commands: { register: (c) => { command = c; return () => {}; } },
    sessionController: { create: async (req = {}) => { const sessionId = `h${++n}`; made.set(sessionId, req); return { sessionId }; }, rename: async () => ({}), resolveAgent: async (id) => ({ agent: agentOf(id) }) },
    agents: { get: (id) => agents.get(id) },
    workspaceRegistry: { archiveSession: async (id) => { archived.push(id); } },
    llm: {
      resolveCallConfig: async (c) => { if (c.reasoningEffort === 'nope') throw Object.assign(new Error('no'), { code: 'UNSUPPORTED_REASONING_EFFORT' }); return c; },
      stream: (o) => (async function* () { llmCalls.push(o); yield { type: 'text-delta', text: replies.shift() ?? '好' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }) },
    dshInterlude: { cardText: () => '# 你是 小点\n话不多。', checks: () => [] },
    dotMemory: { recent: () => [{ who: 'owner', text: '在干嘛呀' }], herSaid: (x) => herSaid.push(x) },
    dshQq: { connected: true, owner: '20002', onMessage: (fn) => { services.qqMessage = fn; return () => {}; }, onTyping: () => () => {}, stickerList: () => [{ id: '31d44003ce', note: '开心猫' }], send: async (to, t, images) => { qqSent.push([to, t, images]); return { sent: 1, said: String(t).split('\n').filter(Boolean), images: images ?? [] }; } },
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
  apply(ctx, { home, budgetPollSeconds: 0, notifyBatchMs: 5, ownerQuietMs: 5, ownerMaxWaitMs: 30, awakeHours: '00:00-24:00', ackHoldMs: 0, ...cfg });
  const emit = (id, type, data) => { const a = agentOf(id); for (const fn of [...listeners]) fn(a.session, { type, data }); };
  emit('s1', 'turn/start', { turn: 1 }); emit('s1', 'turn/end', { turn: 1 }); // her conversation
  const pre = (id, name, input = {}) => hooks['tools/pre-execute']({ name, input, agent: agentOf(id) }, async () => 'ran');
  const shown = (name, v) => tools[name].output.render({}, v)[0].text;
  return { ctx, home, made, services, tools, hooks, emit, pre, shown, audit, archived, qqSent, agentOf, llmCalls, replies, herSaid, command: (arg) => command.handler({ rawInput: arg }), stop: () => { for (const d of effects) if (typeof d === 'function') d(); } };
}
const as = (h, id) => ({ agent: h.agentOf(id) }); // what the host passes a tool as its second argument

test('wired, kept on the thing: when its hands last did something is its own — a notification seen during one thing is not "already here" for the next', async () => {
  const h = coreHarness({ waitPollMs: 10, waitMaxMs: 200 });
  h.services.dshPhone = { isReady: true, get lastScreen() { return { items: [], at: Date.now() }; }, screenItems: async () => [], foreground: async () => 'com.example/.Main', onNotification: () => () => {} };
  const click = (id) => h.hooks['tools/post-execute']({ name: 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', input: {}, agent: h.agentOf(id) }, { content: [{ type: 'text', text: 'ok' }] }, async () => ({}));
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '帮我登录一下' }] });
  await h.tools.hands.execute({ device: 'phone', do: '登录' }); await tick();
  await click('h1'); await tick(5);
  h.services.qqMessage({ kind: 'private', userId: '30003', who: '小明', text: '验证通过了', at: new Date().toISOString() });
  assert.equal((await h.tools.wait_for.execute({ notification: '验证通过', seconds: 0.05 }, as(h, 'h1'))).status, 'met', 'after its own last action: here already');
  assert.deepEqual(await h.tools.done.execute({ summary: '登录了', reached: true }, as(h, 'h1')), { status: 'done' });
  await h.tools.hands.execute({ device: 'phone', do: '再看一眼' }); await tick();
  // the next thing has done nothing yet: what came before it began is not what it waits for
  assert.equal((await h.tools.wait_for.execute({ notification: '验证通过', seconds: 0.05 }, as(h, 'h2'))).status, 'timeout');
  await click('h2'); await tick(5);
  h.services.qqMessage({ kind: 'private', userId: '30003', who: '小明', text: '验证通过了 again', at: new Date().toISOString() });
  assert.equal((await h.tools.wait_for.execute({ notification: '验证通过', seconds: 0.05 }, as(h, 'h2'))).status, 'met');
  h.stop();
});

test('wired, by session: her hands\' own tools act on the thing of the session that calls them — a late call from a session whose thing is over does nothing', async () => {
  const h = coreHarness({ waitPollMs: 10, waitMaxMs: 200 });
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '查两件事' }] });
  await h.tools.hands.execute({ device: 'web', do: '查第一件' }); await tick();
  assert.equal((await h.tools.hands.execute({ device: 'computer', do: '查第二件' })).status, 'started');
  assert.deepEqual(await h.tools.done.execute({ summary: '查到了', reached: true }, as(h, 'h1')), { status: 'done' });
  await tick();
  const ended = () => h.audit.filter((a) => a.event === 'hands-thing').map((a) => [a.thing, a.outcome]);
  assert.deepEqual(ended(), [['t1', 'done']]);
  // h1's thing is over; t2 is under way in h2
  assert.deepEqual(await h.tools.ask_her.execute({ question: '还查吗？' }, as(h, 'h1')), { status: 'idle' });
  assert.deepEqual(await h.tools.wait_for.execute({ seconds: 0.02 }, as(h, 'h1')), { status: 'idle' });
  assert.deepEqual(await h.tools.done.execute({ summary: '假的', reached: true }, as(h, 'h1')), { status: 'idle' });
  assert.equal(await h.pre('h2', 'web_search', { query: 'x' }), 'ran', 'not taken for asked');
  assert.deepEqual(ended(), [['t1', 'done']], 'nothing of h1\'s reached t2');
  assert.deepEqual(await h.tools.done.execute({ summary: '第二件也查到了', reached: true }, as(h, 'h2')), { status: 'done' });
  assert.deepEqual(ended(), [['t1', 'done'], ['t2', 'done']]);
  h.stop();
});

test('wired, a thing given after another begins with its own counts: the same error and the same screen of the one before are not its', async () => {
  const h = coreHarness();
  const post = (id, name, result) => h.hooks['tools/post-execute']({ name, callId: `c${Math.random()}`, input: {}, agent: h.agentOf(id) }, result, async () => ({ kind: 'accept' }));
  const failed = { isError: true, content: [{ type: 'text', text: 'Error: Navigation failed net::ERR_CONNECTION_CLOSED at https://x.example/' }] };
  const look = (id, t) => post(id, 'mcp__dot-phone__mobile_list_elements_on_screen', { content: [{ type: 'text', text: t }] });
  const said = (d) => (d?.additionalContexts ?? []).map((m) => text(m)).join('\n');
  const NAV = 'mcp__dot-vm__browser_navigate';
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '开两个站' }] });
  await h.tools.hands.execute({ device: 'computer', do: '打开 B 站' }); await tick();
  assert.equal((await h.tools.hands.execute({ device: 'computer', do: '打开知乎' })).status, 'busy');
  await post('h1', NAV, failed); await post('h1', NAV, failed);
  await look('h1', 'A');
  await h.tools.done.execute({ summary: '打不开', reached: false }, as(h, 'h1')); await tick();
  assert.equal((await h.tools.hands.execute({ device: 'computer', do: '打开知乎' })).status, 'started', 'the computer is free now');
  await tick();
  // t2 now, in h2: its first error is its first, its first look is its first
  assert.equal(said(await post('h2', NAV, failed)), '');
  assert.equal(said(await post('h2', NAV, failed)), '', 'two of its own: the one before had two as well');
  assert.match(said(await post('h2', NAV, failed)), /同一个错已经连着出了 3 次/, 'counted from its own first');
  assert.equal(said(await look('h2', 'A')), '', 'not the same screen as the last thing\'s look');
  assert.deepEqual(h.audit.filter((a) => a.event === 'same-error-nudge').map((a) => a.thing), ['t2']);
  assert.equal(h.audit.filter((a) => a.event === 'same-screen').length, 0);
  h.stop();
});
