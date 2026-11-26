// dsh-dot: one lock a place. Things in different places run at once; a place that is held answers "busy" at once and
// nothing waits in a line; a session that is not her hands (a qq-bridge chat) and her hands share the same lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHands, DIRECT_IDLE_MS } from '../src/dot/hands.js';
import { createLedger } from '../src/dot/ledger.js';
import { apply, ownerSource } from '../src/dot/core.js';
import { hookTable } from './hooks.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function harness(opts = {}) {
  const listeners = new Set(), sent = [], cancelled = [], kv = new Map(opts.kv ?? []), done = [], lanes = [];
  let n = 0, clock = opts.clock;
  const agents = new Map();
  const dir = join(mkdtempSync(join(tmpdir(), 'hands-')), 'hands');
  const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) };
  const ledger = createLedger({ store });
  const hands = createHands({
    dir, ledger,
    create: opts.create ?? (async () => { const id = `h${++n}`; agents.set(id, { followup: (m) => sent.push([id, m]), cancel: opts.cancel ? (c) => opts.cancel(id, c) : (c) => cancelled.push([id, c.reason]), ...(opts.steer ? { steer: opts.steer } : {}) }); return id; }),
    agentFor: async (id) => agents.get(id) ?? null,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    message: (text) => text, textOf: (c) => c,
    store, done: () => 'MISSING',
    onDone: (r, j) => done.push([r, j]), lane: (event, d) => lanes.push([event, d.device, d.session, d.holder]),
    ...(clock ? { now: () => clock.t } : {}),
    ...(opts.maxMs ? { maxMs: opts.maxMs } : {}),
  });
  const emit = (id, type, data) => { for (const fn of [...listeners]) fn({ id }, { type, data }); };
  return { hands, ledger, sent, cancelled, emit, done, lanes, listeners, kv };
}

test('lanes: a thing in each place runs at once — phone, computer, web and host each hold one, and each ends on its own', async () => {
  const h = harness();
  const ids = ['phone', 'computer', 'web', 'host'].map((device) => h.hands.start({ device, task: `在${device}上做一件` }));
  assert.deepEqual(ids.map((r) => r.status), ['started', 'started', 'started', 'started']);
  await tick();
  assert.deepEqual(h.hands.things().map((t) => [t.device, t.session]), [['phone', 'h1'], ['computer', 'h2'], ['web', 'h3'], ['host', 'h4']]);
  assert.deepEqual(h.ledger.unfinished().map((e) => [e.id, e.state]), [['t1', 'running'], ['t2', 'running'], ['t3', 'running'], ['t4', 'running']], 'on the book as under way from the start: no "queued" left');
  assert.equal(h.hands.holder('web').thing.id, 't3');
  h.hands.finish({ summary: '电脑上做完了' }, { session: 'h2' });
  assert.deepEqual([h.hands.on('computer'), h.hands.on('phone').id, h.hands.things().length], [null, 't1', 3], 'the others go on');
  assert.equal(h.hands.start({ device: 'computer', task: '电脑上再做一件' }).status, 'started', 'its place is free at once');
  assert.deepEqual(h.done.map(([r, j]) => [j.id, r.outcome]), [['t2', 'done']]);
});

test('lanes: a second thing for a place that is held is not begun and waits nowhere — what holds it is said at once', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '（在手机上）逛小红书', forHim: false }); await tick();
  const r = h.hands.start({ device: 'phone', task: '（在手机上）查快递', forHim: true });
  assert.deepEqual([r.status, r.device, r.holder.thing.id, r.holder.thing.forHim, r.id], ['busy', 'phone', 't1', false, undefined]);
  assert.deepEqual(h.ledger.recent(5).map((e) => e.id), ['t1'], 'nothing opened for it');
  h.hands.finish({ summary: '逛完了' }, { session: 'h1' }); await tick();
  assert.equal(h.done.length, 1, 'and nothing begins by itself when the phone is free');
  assert.equal(h.hands.busy(), false);
});

test('lanes: a session that is not her hands holds a device while it uses it — her thing there is busy; its turn ending or idling lets go', async () => {
  const clock = { t: 1000 };
  const h = harness({ clock });
  assert.equal(h.hands.hold('phone', 'qqb-p-1', 'mobile_click_on_screen_at_coordinates'), null, 'taken');
  assert.equal(h.hands.hold('phone', 'qqb-p-1', 'mobile_swipe_on_screen'), null, 'its own again');
  assert.equal(h.hands.hold('phone', 'other', 'mobile_take_screenshot').session, 'qqb-p-1', 'another such session is not let on');
  const r = h.hands.start({ device: 'phone', task: '看一眼' });
  assert.deepEqual([r.status, r.holder.session, r.holder.tool], ['busy', 'qqb-p-1', 'mobile_swipe_on_screen']);
  assert.equal(h.hands.start({ device: 'computer', task: '电脑上的' }).status, 'started', 'another place is free');
  h.emit('qqb-p-1', 'turn/end', {});
  assert.equal(h.hands.holder('phone'), null, 'its turn ended: let go');
  assert.equal(h.hands.start({ device: 'phone', task: '看一眼' }).status, 'started');
  assert.equal(h.hands.hold('phone', 'qqb-p-1', 'mobile_take_screenshot').thing.id, 't2', 'her thing there: the session is not let on');
  // idle: left alone DIRECT_IDLE_MS, the device is not held by it any more
  assert.equal(h.hands.hold('web-free', 'qqb-p-2'), null);
  clock.t += DIRECT_IDLE_MS + 1;
  assert.equal(h.hands.holder('web-free'), null);
  assert.deepEqual(h.lanes.map((x) => [x[0], x[1], x[2]]), [['acquired', 'phone', 'qqb-p-1'], ['refused', 'phone', 'other'], ['expired', 'phone', 'qqb-p-1'], ['refused', 'phone', 'qqb-p-1'], ['acquired', 'web-free', 'qqb-p-2'], ['expired', 'web-free', 'qqb-p-2']], 'written for the device\'s own log');
});

test('lanes: a thing holds its place from start to end — its hands\' session running again (told to finish properly) does not let it go', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '存贴图' }); await tick();
  h.emit('h1', 'assistant/message', { message: { content: '存了' } });
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } }); // no done: told once to finish, in a run of its own
  await tick();
  assert.deepEqual(h.sent.at(-1), ['h1', 'MISSING']);
  assert.equal(h.hands.holder('phone').thing.id, 't1', 'between its runs the phone is still its');
  assert.ok(h.hands.hold('phone', 'qqb-p-1', 'mobile_click_on_screen_at_coordinates'), 'nobody else gets on');
  h.hands.finish({ summary: '存好了' }, { session: 'h1' });
  assert.equal(h.hands.holder('phone'), null);
});

test('lanes: what a restart cut off — every thing under way, in every place — is ended as such, each told once', async () => {
  const kv = new Map();
  const book = createLedger({ store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) } });
  for (const [asker, device, task] of [['him', 'phone', '存贴图'], ['her', 'web', '查天气'], ['him', 'computer', '下载文件']]) book.begin(book.open({ asker, device, task }));
  const after = harness({ kv: [...kv] });
  assert.deepEqual(after.hands.interrupted().map((e) => [e.id, e.device, e.asker, e.outcome, e.cause]), [['t1', 'phone', 'him', 'failed', 'restart'], ['t2', 'web', 'her', 'failed', 'restart'], ['t3', 'computer', 'him', 'failed', 'restart']]);
  assert.deepEqual(after.hands.interrupted(), [], 'once');
  assert.equal(after.hands.busy(), false, 'nothing holds any place after a restart');
});

// Wired into the host (core.js).
const text = (m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
function coreHarness(cfg = {}) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  writeFileSync(join(dsh, 'dsh-dot-state.json'), JSON.stringify({ lastSession: 's1' })); // her conversation, one the plugin made
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const { hooks, add: addHook } = hookTable();
  const listeners = [], effects = [], audit = [], phoneAudit = [], tools = {}, agents = new Map(), adb = [];
  let command, n = 0;
  const made = new Map();
  const agentOf = (id) => { if (!agents.has(id)) agents.set(id, { session: { id, header: { cwd: made.get(id)?.cwd ?? (id.startsWith('h') ? join(dsh, 'dsh-dot-hands') : id.startsWith('qqb') ? '/srv/qq-bridge/state/agents' : home), agentPreset: made.get(id)?.agentPreset } }, got: [], cancels: [], selected: [], model: { current: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }), select: (sel) => { agents.get(id).selected.push(sel); } }, noted: [], inject(m) { this.noted.push(m); }, followup(m) { this.got.push(m); }, cancel(c) { this.cancels.push(c.reason); } }); return agents.get(id); };
  const services = {
    tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
    commands: { register: (c) => { command = c; return () => {}; } },
    sessionController: { create: async (req = {}) => { const sessionId = `h${++n}`; made.set(sessionId, req); return { sessionId }; }, rename: async () => ({}), resolveAgent: async (id) => ({ agent: agentOf(id) }) },
    agents: { get: (id) => agents.get(id) },
    workspaceRegistry: { archiveSession: async () => {} },
    llm: { resolveCallConfig: async (c) => c, stream: () => (async function* () { yield { type: 'text-delta', text: '好' }; yield { type: 'finish', reason: { kind: 'stop' } }; })() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: 'low' }) },
    dshInterlude: { cardText: () => '# 你是 小点\n## 怎么说话\n话不多。', checks: () => [] },
    dotMemory: { recent: () => [], herSaid: () => {} },
    dshQq: { connected: true, owner: '20002', onMessage: () => () => {}, onTyping: () => () => {}, stickerList: () => [], send: async (to, t) => ({ sent: 1, said: String(t).split('\n').filter(Boolean), images: [] }) },
    dshComputer: { audit: (e) => audit.push(e), status: () => ({ state: 'ready' }), onStatus: () => () => {} },
    dshPhone: { isReady: true, audit: (e) => phoneAudit.push(e), lastScreen: { items: [], at: Date.now() }, screenItems: async () => [], foreground: async () => 'com.example/.Main', screenshot: async () => null, onNotification: () => () => {}, adbExec: async (a) => { adb.push(a); } },
  };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    on: (name, fn, opts) => { if (name === 'session/event') { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; } addHook(name, fn, opts); return () => {}; },
    effect(fn) { effects.push(fn()); },
    systemPrompt: { context() {}, section() { return () => {}; }, getSectionOrder: () => 0 },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (name) => (name === 'systemPrompt' ? ctx.systemPrompt : services[name]),
    provide: (name, v) => { services[name] = v; },
  };
  apply(ctx, { home, budgetPollSeconds: 0, notifyBatchMs: 5, ownerQuietMs: 5, ownerMaxWaitMs: 30, awakeHours: '00:00-24:00', ackHoldMs: 0, ...cfg });
  const emit = (id, type, data) => { const a = agentOf(id); for (const fn of [...listeners]) fn(a.session, { type, data }); };
  emit('s1', 'turn/start', { turn: 1 }); emit('s1', 'turn/end', { turn: 1 });
  const pre = (id, name, input = {}) => hooks['tools/pre-execute']({ name, input, agent: agentOf(id) }, async () => 'ran');
  const shown = (name, v, a = {}) => tools[name].output.render(a, v)[0].text;
  const his = (turn, words) => { emit('s1', 'turn/start', { turn }); emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: words }] }); };
  return { services, tools, hooks, emit, pre, shown, his, audit, phoneAudit, adb, agentOf, dot: () => services.dshDot, command: (arg) => command.handler({ rawInput: arg }), stop: () => { for (const d of effects) if (typeof d === 'function') d(); } };
}
const as = (h, id) => ({ agent: h.agentOf(id) });

test('wired: two places at once from her conversation; the same place again is busy at once, and said again in that turn it is only "the same answer"', async () => {
  const h = coreHarness();
  h.his(2, '帮我查个快递，再看看手机上的消息');
  assert.equal((await h.tools.hands.execute({ device: 'web', do: '查快递' })).status, 'started');
  assert.equal((await h.tools.hands.execute({ device: 'phone', do: '看看消息' })).status, 'started', 'another place: at once');
  await tick();
  const busy = await h.tools.hands.execute({ device: 'phone', do: '再看看相册' });
  assert.equal(busy.status, 'busy');
  assert.match(h.shown('hands', busy), /^那个地方正在做：（在手机上）看看消息（他要的，刚开始的），这件没开始，也不会排着等。等它做完会叫你；要并进那件就用 add；要先做这件，就带上 device 用 stop 停掉那件再交；或者换个地方交。$/);
  const again = await h.tools.hands.execute({ device: 'phone', do: '再看看相册吧' });
  assert.equal(again.again, true, 'counted by the code, per turn and place');
  assert.equal(h.shown('hands', again), '那个地方还在做刚才说的那件，这件还是没开始。它做完会叫你，这一轮不用再交。');
  assert.equal(h.audit.filter((a) => a.event === 'hands-busy').length, 2);
  h.emit('s1', 'turn/end', { turn: 2 });
  // a new turn counts afresh
  h.his(3, '还有相册');
  assert.equal((await h.tools.hands.execute({ device: 'phone', do: '看相册' })).again, undefined);
  h.stop();
});

test('wired: add and stop name the thing by its place; without one, stop is everything and add is the one there is — or she is told what is where', async () => {
  const h = coreHarness();
  h.his(2, '查天气，顺便在电脑上下个文件');
  await h.tools.hands.execute({ device: 'web', do: '查明天天气' });
  await h.tools.hands.execute({ device: 'computer', do: '下载文件' });
  await tick();
  // add without a place, two under way: which?
  const which = await h.tools.hands.execute({ add: '后天也查' });
  assert.equal(which.status, 'which');
  assert.equal(h.shown('hands', which, { add: '后天也查' }), '在做的有：（查资料，不碰手机和电脑）查明天天气；（在电脑上）下载文件。要补一句或停掉其中一件，device 填那件所在的地方。');
  assert.deepEqual(await h.tools.hands.execute({ device: 'web', add: '后天也查' }), { status: 'added', id: 't1' });
  await tick();
  assert.equal(text(h.agentOf('h1').got.at(-1)), '后天也查', 'into the web one');
  assert.equal(h.agentOf('h2').got.length, 1, 'not the computer one');
  // a place with nothing in it, others under way: which
  assert.equal((await h.tools.hands.execute({ device: 'phone', add: 'x' })).status, 'which');
  assert.equal((await h.tools.hands.execute({ device: 'phone', stop: true })).status, 'which');
  // stop one place: that one only
  assert.deepEqual(await h.tools.hands.execute({ device: 'computer', stop: true }), { status: 'stopped' });
  assert.deepEqual(h.dot().things(5).map((e) => [e.id, e.state, e.outcome ?? '', e.by ?? '']), [['t2', 'ended', 'stopped', 'him'], ['t1', 'running', '', '']]);
  // one under way: add needs no place
  assert.deepEqual(await h.tools.hands.execute({ add: '再看看大后天' }), { status: 'added', id: 't1' });
  // stop without a place: everything
  await h.tools.hands.execute({ device: 'phone', do: '看消息' }); await tick();
  assert.deepEqual(await h.tools.hands.execute({ stop: true }), { status: 'stopped' });
  assert.deepEqual(h.dot().things(5).filter((e) => e.state !== 'ended'), []);
  assert.deepEqual(await h.tools.hands.execute({ stop: true }), { status: 'idle' });
  assert.equal((await h.tools.hands.execute({ add: 'x' })).status, 'idle', 'nothing under way: nothing to add to, as before');
  h.stop();
});

test('wired: a qq-bridge chat and her hands share one lock, on the phone and on the computer', async () => {
  const h = coreHarness();
  const QQB = 'qqb-p-20002-0123456789abcdef0123456789abcdef';
  const CLICK = 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', NAV = 'mcp__dot-vm__browser_navigate';
  // the chat is on the phone: her thing there is busy, her thing on the computer starts
  assert.equal(await h.pre(QQB, CLICK, { x: 1, y: 2 }), 'ran');
  h.his(2, '看看手机');
  const busy = await h.tools.hands.execute({ device: 'phone', do: '看看消息' });
  assert.deepEqual([busy.status, busy.holder.session], ['busy', QQB]);
  assert.equal(h.shown('hands', busy), '那台设备正被别处用着（不是你交的事，在用 mobile_click_on_screen_at_coordinates），这件没开始。过一会再交，或者换个地方交。');
  assert.equal((await h.tools.hands.execute({ device: 'computer', do: '打开网页' })).status, 'started');
  await tick();
  // her thing is on the computer: the chat is refused there, at once
  const refused = await h.pre(QQB, NAV, { url: 'https://example.com' });
  assert.equal(refused.kind, 'deny');
  assert.match(refused.reason, /^电脑正被另一件事占着（在做：（在电脑上）打开网页），稍后再试$/);
  assert.equal(await h.pre('h1', 'mcp__dot-vm__browser_get_text', {}), 'ran', 'her hands, on their own thing\'s place');
  assert.equal(await h.pre('h1', CLICK, {}).then((r) => r.kind), 'deny', 'not on a place another holds');
  // the chat's turn ends: the phone is free, and the next thing of hers holds it
  h.emit(QQB, 'turn/end', {});
  assert.equal((await h.tools.hands.execute({ device: 'phone', do: '看看消息' })).status, 'started');
  await tick();
  const r = await h.pre(QQB, CLICK, {});
  assert.equal(r.kind, 'deny');
  assert.match(r.reason, /^手机正被另一件事占着（在做：（在手机上）看看消息），稍后再试$/);
  assert.equal(await h.pre('h2', 'mcp__dot-phone__mobile_list_elements_on_screen', {}), 'ran', 'its own hands are');
  assert.deepEqual(h.phoneAudit.map((e) => [e.kind, e.event, e.session === QQB]), [['phone-lease', 'acquired', true], ['phone-lease', 'expired', true], ['phone-lease', 'refused', true]], 'the phone\'s lease, in its own log as before');
  assert.deepEqual(h.audit.filter((e) => e.kind === 'computer-lease').map((e) => e.event), ['refused']);
  h.stop();
});

test('wired: the phone goes home only when nothing is on the phone — a thing elsewhere does not hold it', async () => {
  const h = coreHarness({ phoneHomeAfterMs: 40 });
  h.his(2, '看看手机，再查个东西');
  await h.tools.hands.execute({ device: 'phone', do: '看消息' }); await tick();
  await h.tools.hands.execute({ device: 'web', do: '查东西' }); await tick();
  await h.tools.done.execute({ summary: '看了', reached: true }, as(h, 'h1')); await tick(80);
  assert.deepEqual(h.adb, [['shell', 'input', 'keyevent', 'KEYCODE_HOME']], 'home, though the web thing is under way');
  // something on the phone when the time comes: it stays
  await h.tools.hands.execute({ device: 'phone', do: '再看一眼' }); await tick();
  await h.tools.done.execute({ summary: '看了', reached: true }, as(h, 'h3')); await tick();
  await h.pre('qqb-p-1-0123456789abcdef0123456789abcdef', 'mcp__dot-phone__mobile_swipe_on_screen', {});
  await tick(80);
  assert.equal(h.adb.length, 1, 'a qq-bridge chat is on it');
  h.stop();
});

test('wired: her own time waits for what she gave her hands in it — not for a thing of his in another place', async () => {
  const h = coreHarness();
  // his thing on the web, under way all along
  h.his(2, '查快递'); await h.tools.hands.execute({ device: 'web', do: '查快递' }); h.emit('s1', 'turn/end', { turn: 2 }); await tick(80);
  const done = [];
  h.dot().task({ kind: 'free', key: 'k1', text: '自己的时间', source: { kind: 'dsh-interlude', form: 'free' }, onDone: (r) => done.push([r.status, r.report]) });
  await tick(80);
  // (her hands are busy with his thing: her own time does not begin while a thing of hers is under way — herState.hands)
  assert.equal(done.length, 0);
  await h.tools.done.execute({ summary: '快递到了', reached: true }, as(h, 'h1')); await tick();
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'hands-result', for: 'him', thing: 't1' }, content: [{ type: 'text', text: 'r' }] });
  h.emit('s1', 'turn/end', { turn: 3 }); await tick(120);
  // her own time: she gives a thing on the phone; meanwhile he asks for one on the web
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: { kind: 'dsh-interlude', form: 'free' }, content: [{ type: 'text', text: '自己的时间' }] });
  await h.tools.hands.execute({ device: 'phone', do: '逛逛小红书' });
  h.emit('s1', 'turn/end', { turn: 4 }); await tick(30);
  assert.equal(done.length, 0, 'what she gave in it is under way');
  h.his(5, '再查个天气'); await h.tools.hands.execute({ device: 'web', do: '查天气' }); h.emit('s1', 'turn/end', { turn: 5 }); await tick(30);
  await h.tools.done.execute({ summary: '逛完了', reached: true }, as(h, 'h2')); await tick();
  const back = h.agentOf('s1').got.at(-1);
  h.emit('s1', 'turn/start', { turn: 6 }); h.emit('s1', 'user/message', { source: back.source, content: back.content });
  h.emit('s1', 'turn/end', { turn: 6 }); await tick(30);
  assert.ok(h.dot().things(5).some((e) => e.task.includes('查天气') && e.state === 'running'), 'his thing still under way');
  assert.deepEqual(done, [['done', '（在手机上）逛逛小红书：逛完了']], 'her own time is over: its own thing is');
  h.stop();
});

test('wired: the board of things has a limit; past it she is told how many more there are', async () => {
  const h = coreHarness();
  const her = h.agentOf('s1');
  const note = async () => { const d = await h.hooks['agent/pre-step']({ agent: her, messages: [{ role: 'user' }], signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user' }] })); return text(d.messages.at(-1)); };
  // ten things of his that stopped on a question for her: each a line
  for (let i = 0; i < 10; i++) {
    h.his(2 + i, `第${i}件`);
    await h.tools.hands.execute({ device: 'web', do: `查第${i}件` }); await tick();
    await h.tools.ask_her.execute({ question: `第${i}件要查哪个？` }, as(h, `h${i + 1}`));
    h.emit(`h${i + 1}`, 'turn/end', { reason: { kind: 'completed' } });
    h.emit('s1', 'turn/end', { turn: 2 + i }); await tick(20);
  }
  const lines = (await note()).split('\n');
  assert.equal(lines.filter((l) => /^卡住了：.*要定的是：第\d件要查哪个/.test(l)).length, 8);
  assert.ok(lines.includes('还有 2 件没列在这里。'), lines.join('\n'));
  h.stop();
});

test('lanes: a thing cut off mid-run holds its place until the stop has landed — the next one there begins after, not beside it', async () => {
  let land;
  const h = harness({ cancel: (id, c) => new Promise((r) => { land = () => { h.cancelled.push([id, c.reason]); r(); }; }) });
  h.hands.start({ device: 'phone', task: '逛小红书' }); await tick();
  h.hands.stop({ by: 'him', cause: 'command' }); await tick();
  assert.equal(h.hands.on('phone'), null, 'no longer under way');
  assert.equal(h.hands.holder('phone').thing.id, 't1', 'but its place is held while the stop lands');
  let second = null;
  const p = Promise.resolve(h.hands.start({ device: 'phone', task: '查快递' })).then((r) => { second = r; });
  await tick(20);
  assert.equal(second, null, 'waits for the stop');
  land(); await p;
  assert.equal(second.status, 'started');
  assert.deepEqual(h.cancelled.map(([id]) => id), ['h1']);
});

test('lanes: a thing whose session never comes is over when its time is up, and lets its place go; a word added before its session goes with its first message, one that does not reach them is said so', async () => {
  const never = harness({ maxMs: 30, create: () => new Promise(() => {}) });
  never.hands.start({ device: 'web', task: '查一下' });
  await tick(60);
  assert.deepEqual(never.done.map(([r]) => [r.outcome, r.cause]), [['timeout', 'timeout']]);
  assert.equal(never.hands.holder('web'), null);
  const h = harness({ steer: () => { throw new Error('busy'); } });
  h.hands.start({ device: 'web', task: '查天气' });
  assert.deepEqual(await h.hands.add('顺便看看明天'), { status: 'added', id: 't1' }, 'before their session: kept for the first message');
  await tick();
  assert.match(String(h.sent.find(([id]) => id === 'h1')?.[1]), /查天气\n顺便看看明天/);
  const r = await h.hands.add('再看看后天');
  assert.equal(r.status, 'failed'); assert.match(r.why, /没传到手上：busy/);
  assert.deepEqual(h.ledger.get('t1').added, ['顺便看看明天'], 'only what reached them is on the book');
});
