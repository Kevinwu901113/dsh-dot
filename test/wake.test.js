// What wakes her when nobody writes: her one clock (dot/core.js), the night (dot/sleep.js), her own time
// (interlude/core.js) and the "later" she may leave. Fake clocks throughout.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyDot } from '../src/dot/core.js';
import { hookTable } from './hooks.js';

const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
/** 'HH:00-HH:00' that does not contain now: her usual hours are elsewhere, so she may sleep. */
const notNow = () => { const hh = (d) => `${String(new Date(Date.now() + d * 3600000).getHours()).padStart(2, '0')}:00`; return `${hh(2)}-${hh(4)}`; };

/** dot alone, under a fake host: the services it provides are kept (services.dshDot). */
function dotHarness({ state = {}, config = {} } = {}) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  writeFileSync(join(dsh, 'dsh-dot-state.json'), JSON.stringify({ lastSession: 's1', ...state }));
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const effects = [], audit = [], services = {};
  const { add: addHook } = hookTable();
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    on: (name, fn, opts) => { if (name !== 'session/event') addHook(name, fn, opts); },
    effect(fn) { effects.push(fn()); },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    provide: (n, v) => { services[n] = v; },
    get: (name) => services[name] ?? ({ dshComputer: { audit: (e) => audit.push(e), status: () => ({ state: 'ready' }), onStatus: () => () => {} } }[name]),
  };
  applyDot(ctx, { home, budgetPollSeconds: 3600, ...config });
  const store = () => JSON.parse(readFileSync(join(dsh, 'dsh-dot-state.json'), 'utf8'));
  return { ctx, home, dsh, audit, services, store, stop: () => { for (const d of effects) if (typeof d === 'function') d(); } };
}

test('the night: offered once to each listener when she falls asleep, or at the next tick after a restart while she sleeps; the nightcheck is done once a night', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  try {
    const night = Date.now() - 3600000;
    // dsh restarted while she sleeps, the night's nightcheck not done yet: done at the first tick, and only then.
    const a = dotHarness({ state: { asleepSince: night }, config: { awakeHours: notNow() } });
    const got = []; a.services.dshDot.onSleep((n) => got.push(n));
    assert.deepEqual(got, [], 'nothing before the clock ticks');
    for (let i = 0; i < 4; i++) { mock.timers.tick(30000); await settle(); }
    assert.deepEqual(got, [night], 'once, with the night it is');
    assert.equal(a.audit.filter((e) => e.event === 'nightcheck-night').length, 1);
    assert.equal(a.store().nightcheckNight, night);
    a.stop();
    // Restarted again the same night: the listener is offered it once more (its own record says whether it did it), the nightcheck is not done again.
    const b = dotHarness({ state: { asleepSince: night, nightcheckNight: night }, config: { awakeHours: notNow() } });
    const again = []; b.services.dshDot.onSleep((n) => again.push(n));
    for (let i = 0; i < 4; i++) { mock.timers.tick(30000); await settle(); }
    assert.deepEqual(again, [night]);
    assert.equal(b.audit.filter((e) => e.event === 'nightcheck-night').length, 0, 'not twice a night');
    b.stop();
  } finally { mock.timers.reset(); }
});

test('her clock: one timer; what is put on it (dshDot.onTick) runs on each tick, after her sleep', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  try {
    const realSetInterval = globalThis.setInterval;
    let intervals = 0;
    globalThis.setInterval = (...a) => { intervals++; return realSetInterval(...a); };
    let h;
    try { h = dotHarness({ config: { awakeHours: notNow(), sleepAfterQuietMinutes: 1 } }); } finally { globalThis.setInterval = realSetInterval; }
    assert.equal(intervals, 2, 'her clock and the budget watch');
    const seen = [];
    const off = h.services.dshDot.onTick(() => seen.push(h.services.dshDot.awake()));
    mock.timers.tick(30000); await settle();
    mock.timers.tick(30000); await settle();
    assert.deepEqual(seen, [true, false], 'the tick that put her to sleep runs before what is on the clock');
    off(); mock.timers.tick(30000); await settle();
    assert.equal(seen.length, 2);
    h.stop();
  } finally { mock.timers.reset(); }
});

// ── her own time (interlude/core.js), on a stand-in for dot ──
import { apply as applyInterlude } from '../src/interlude/core.js';

/** The interlude under a fake host, with a stand-in dot whose clock is ticked by hand (tick()). */
function ownHarness({ home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot'), config = {}, dot = {} } = {}) {
  mkdirSync(home, { recursive: true });
  const listeners = [], gates = [], effects = [], audit = [], tasks = [], cancelled = [], steered = [], tools = {};
  let ticker = null;
  const state = { awake: true, quiet: true, handsFor: '', ...dot };
  const dshDot = {
    awakeHours: state.awakeHours ?? '08:00-23:00',
    task: (t) => { tasks.push(t); return 'queued'; },
    awake: () => state.awake, quiet: () => state.quiet,
    onTick: (fn) => { ticker = fn; return () => { ticker = null; }; },
    hers: (id) => id === 's1', retired: () => false, session: () => 's1',
    isHands: (id) => id === 'h1', handsFor: () => state.handsFor,
  };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); if (name === 'tools/pre-execute') gates.push(fn); return () => {}; },
    effect(fn) { effects.push(fn()); },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (n) => ({ dshDot, dshComputer: { audit: (e) => audit.push(e) }, tools: { register: (t) => { tools[t.name] = t; return () => {}; } }, agents: { get: (id) => ({ cancel: () => cancelled.push(id), steer: (m) => steered.push({ id, m }) }) } }[n]),
    llm: { stream: () => (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })() },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  applyInterlude(ctx, { home, canon: { characterName: 'dot', characterProfile: '话少' }, idleMinutes: 10, ...config });
  const emit = (id, type, data, cwd = home) => listeners.forEach((fn) => fn({ id, header: { cwd } }, { type, data, surfaceOp: 'append' }));
  const meta = () => JSON.parse(readFileSync(join(home, 'interlude', 'meta.json'), 'utf8'));
  return {
    home, state, tasks, audit, cancelled, steered, tools, meta,
    tick: () => ticker?.(),
    /** He says something in her conversation (over QQ or at her window: a user message). */
    his: () => emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] }),
    /** A turn of hers (a notification answered, say): her own doing. */
    hers: () => { emit('s1', 'turn/start', { turn: 1 }); emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'phone-notification' }, content: [{ type: 'text', text: '有人' }] }); emit('s1', 'turn/end', { turn: 1 }); },
    step: (id, usage) => emit(id, 'assistant/message', { message: { content: [] }, usage }, id === 'h1' ? '/hands' : home),
    /** The model a session's calls go to, as its request header says. */
    route: (id, config) => emit(id, 'request/header', { header: { config } }, id === 'h1' ? '/hands' : home),
    /** The last queued own time starts in s1 and, when told, is over. */
    start: () => tasks.at(-1).onStart('s1'),
    done: (cost = null) => tasks.at(-1).onDone({ status: 'done', queuedAt: Date.now(), startedAt: Date.now(), doneAt: Date.now(), busyWith: '', report: '', cost }),
    gate: async (sid, name, cwd) => { let out = { kind: 'allow', via: 'next' }; for (const fn of gates) out = await fn({ name, agent: { session: { id: sid, header: { cwd } } } }, async () => out); return out; },
    stop: () => { for (const d of effects) if (typeof d === 'function') d(); },
  };
}
const at = (day, h, m = 0) => { const d = new Date(day); d.setHours(h, m, 0, 0); return d.getTime(); };
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

test('her own time: once after the quiet that follows his last word or the start of her day; not again until he comes back; her own doings do not put it off', () => {
  const day = today();
  mock.timers.enable({ apis: ['Date'], now: at(day, 8, 5) });
  try {
    const h = ownHarness({ config: { freeTimesPerDay: 3 } });
    h.tick();
    assert.equal(h.tasks.length, 0, '08:05: her day began five minutes ago');
    mock.timers.setTime(at(day, 8, 10)); h.tick();
    assert.deepEqual(h.tasks.map((t) => t.kind), ['free'], '08:10: ten quiet minutes since her day began');
    h.start(); h.done();
    // He does not come: every tick until night brings nothing, and says nothing either.
    const audits = h.audit.length;
    for (let m = 11; m < 12 * 60; m += 1) { mock.timers.setTime(at(day, 8, m)); h.tick(); }
    assert.equal(h.tasks.length, 1, 'no new word of his, no second one');
    assert.equal(h.audit.length, audits, 'nothing looked at out loud');
    // He speaks at 20:00; at 20:05 she answers someone else (her own doing): her own time still comes at 20:10.
    mock.timers.setTime(at(day, 20, 0)); h.his();
    mock.timers.setTime(at(day, 20, 5)); h.hers(); h.tick();
    assert.equal(h.tasks.length, 1);
    mock.timers.setTime(at(day, 20, 10)); h.tick();
    assert.equal(h.tasks.length, 2, 'her turn at 20:05 did not put it off');
    h.start(); h.done();
    // Past the day's count (3): held once for that quiet, not looked at again.
    mock.timers.setTime(at(day, 21, 0)); h.his(); mock.timers.setTime(at(day, 21, 10)); h.tick(); h.start(); h.done();
    mock.timers.setTime(at(day, 22, 0)); h.his();
    for (let m = 10; m < 40; m++) { mock.timers.setTime(at(day, 22, m)); h.tick(); }
    assert.equal(h.tasks.length, 3);
    assert.deepEqual(h.audit.filter((e) => e.event === 'free-held').map((e) => e.why), ['daily count used'], 'once');
    h.stop();
  } finally { mock.timers.reset(); }
});

test('her own time: not while she sleeps, is busy or is past her hours; his words at night bring one the next morning, not two', () => {
  const day = today();
  mock.timers.enable({ apis: ['Date'], now: at(day, 8, 30) });
  try {
    const h = ownHarness({ config: { freeTimesPerDay: 5 }, dot: { awake: false } });
    h.tick(); assert.equal(h.tasks.length, 0, 'asleep');
    h.state.awake = true; h.state.quiet = false;
    h.tick(); assert.equal(h.tasks.length, 0, 'something else going on');
    h.state.quiet = true; h.tick();
    assert.equal(h.tasks.length, 1, 'once she is up and nothing else is going on');
    h.start(); h.done();
    // He writes at 22:55; at 23:05 her hours are over. He wakes her at 02:00 and talks: nothing at night.
    mock.timers.setTime(at(day, 22, 55)); h.his();
    mock.timers.setTime(at(day, 23, 5)); h.tick();
    mock.timers.setTime(at(day + 86400000, 2, 0)); h.his();
    for (let m = 10; m < 120; m += 5) { mock.timers.setTime(at(day + 86400000, 2, m)); h.tick(); }
    assert.equal(h.tasks.length, 1, 'past her hours');
    for (let m = 0; m < 60; m += 1) { mock.timers.setTime(at(day + 86400000, 8, m)); h.tick(); }
    assert.equal(h.tasks.length, 2, 'the next morning: one');
    h.stop();
  } finally { mock.timers.reset(); }
});

test('her own time: a day\'s cost has a ceiling the code counts — her steps and her hands\' steps on her thing alike, not a thing of his', async () => {
  const day = today();
  mock.timers.enable({ apis: ['Date'], now: at(day, 9, 0) });
  try {
    const h = ownHarness({ config: { freeTimesPerDay: 10, freeTokenCap: 10000, freeDailyTokens: 15000 } });
    h.tick(); h.start();
    // both sessions' calls go to deepseek-flash (their request headers say so): a cache hit is 0.02 of a token (src/price.js)
    for (const id of ['s1', 'h1']) h.route(id, { provider: 'deepseek-account', model: 'deepseek-flash' });
    h.step('s1', { inputTokens: 3000 });
    h.state.handsFor = 'him'; h.step('h1', { inputTokens: 50000 });
    h.state.handsFor = 'her'; h.step('h1', { inputTokens: 5600, cacheReadTokens: 20000 }); // 5600 + 400 = 6000
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.cancelled, [], '9000 of 10000');
    h.step('h1', { inputTokens: 2000 });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.cancelled, ['s1'], 'her hands\' steps count: stopped');
    assert.equal((await h.gate('h1', 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', '/hands')).kind, 'deny', 'her hands on her thing stop too');
    h.done();
    assert.equal(h.meta().dayFreeTokens, 11000);
    // 4000 left of the day: under the least one would be given, held.
    mock.timers.setTime(at(day, 12, 0)); h.his(); mock.timers.setTime(at(day, 12, 10)); h.tick();
    assert.equal(h.tasks.length, 1);
    assert.deepEqual(h.audit.filter((e) => e.event === 'free-held').map((e) => e.why), ['daily budget used']);
    h.stop();
  } finally { mock.timers.reset(); }
});

test('her own time: across a restart, the quiet and what was used of it are kept — nothing comes twice', () => {
  const day = today();
  mock.timers.enable({ apis: ['Date'], now: at(day, 10, 0) });
  try {
    const a = ownHarness({ config: { freeTimesPerDay: 5 } });
    a.his(); mock.timers.setTime(at(day, 10, 10)); a.tick(); a.start(); a.done();
    assert.equal(a.tasks.length, 1);
    mock.timers.setTime(at(day, 11, 0)); a.his(); // he speaks, then dsh restarts at 11:05
    a.stop();
    mock.timers.setTime(at(day, 11, 5));
    const b = ownHarness({ home: a.home, config: { freeTimesPerDay: 5 } });
    b.tick(); assert.equal(b.tasks.length, 0, 'the quiet he left at 11:00 is not over yet');
    mock.timers.setTime(at(day, 11, 10)); b.tick();
    assert.equal(b.tasks.length, 1, 'it is counted from 11:00, not from the restart');
    b.stop();
    const c = ownHarness({ home: a.home, config: { freeTimesPerDay: 5 } });
    mock.timers.setTime(at(day, 11, 30)); c.tick();
    assert.equal(c.tasks.length, 0, 'used before the restart: not again');
    c.stop();
  } finally { mock.timers.reset(); }
});

test('later: she says when the next one comes, in her own time only — one a stretch, never from a stretch a later brought; whatever comes next uses it up; kept across a restart', async () => {
  const day = today();
  mock.timers.enable({ apis: ['Date'], now: at(day, 9, 0) });
  try {
    const h = ownHarness({ config: { freeTimesPerDay: 5 } });
    const later = (minutes, sid = 's1') => h.tools.later.execute({ minutes }, { agent: { session: { id: sid } } });
    const said = (v) => h.tools.later.output.render({}, v)[0].text;
    assert.equal(said(await later(30)), '现在不是你自己的时间，留不了。');
    h.tick(); h.start(); // 09:00: her day began an hour ago
    assert.equal(said(await later(60 * 15)), '那时已经过了你平时睡下的点，留不了。');
    assert.equal(said(await later(120)), '记下了：11:00 左右再有一段自己的时间。');
    assert.equal(said(await later(90)), '记下了：10:30 左右再有一段自己的时间。', 'one a stretch: the second replaces the first');
    assert.equal(said(await later(1)), '记下了：09:10 左右再有一段自己的时间。', 'never sooner than idleMinutes');
    await later(90);
    h.done();
    // dsh restarts; the later stays.
    h.stop();
    const b = ownHarness({ home: h.home, config: { freeTimesPerDay: 5 } });
    const laterB = (minutes) => b.tools.later.execute({ minutes }, { agent: { session: { id: 's1' } } });
    mock.timers.setTime(at(day, 10, 29)); b.tick();
    assert.equal(b.tasks.length, 0);
    mock.timers.setTime(at(day, 10, 30)); b.tick();
    assert.equal(b.tasks.length, 1, 'the later she left');
    b.start();
    assert.equal(b.tools.later.output.render({}, await laterB(60))[0].text, '这一段是上次留下的「下次」，不能再留。');
    b.done();
    for (let m = 31; m < 24 * 60 - 10 * 60 - 31; m++) { mock.timers.setTime(at(day, 10, m)); b.tick(); }
    assert.equal(b.tasks.length, 1, 'nothing more of its own: no running on');
    // He comes back: the quiet after it brings one, and from that one she may leave a later again.
    b.stop();
    const c = ownHarness({ home: h.home, config: { freeTimesPerDay: 5 } });
    mock.timers.setTime(at(day, 15, 0)); c.his(); mock.timers.setTime(at(day, 15, 10)); c.tick();
    assert.equal(c.tasks.length, 1); c.start();
    assert.equal((await c.tools.later.execute({ minutes: 60 }, { agent: { session: { id: 's1' } } })).status, 'ok');
    c.done();
    // His words come again before it: the next one comes from those, and the later is used up by it.
    mock.timers.setTime(at(day, 15, 30)); c.his(); mock.timers.setTime(at(day, 15, 40)); c.tick(); c.start(); c.done();
    assert.equal(c.tasks.length, 2);
    mock.timers.setTime(at(day, 16, 10)); c.tick();
    assert.equal(c.tasks.length, 2, 'the later went with the one that came before it');
    // A later left late in the day lapses with it.
    mock.timers.setTime(at(day, 20, 0)); c.his(); mock.timers.setTime(at(day, 20, 10)); c.tick(); c.start();
    assert.equal((await c.tools.later.execute({ minutes: 150 }, { agent: { session: { id: 's1' } } })).status, 'ok');
    c.done();
    c.state.quiet = false; mock.timers.setTime(at(day, 22, 41)); c.tick(); // busy then; then her hours are over
    mock.timers.setTime(at(day + 86400000, 8, 1)); c.state.quiet = true; c.tick();
    assert.ok(c.audit.some((e) => e.event === 'free-later-lapsed'));
    assert.equal(c.tasks.length, 3);
    c.stop();
  } finally { mock.timers.reset(); }
});
