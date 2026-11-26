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
