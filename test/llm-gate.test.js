import test from 'node:test';
import assert from 'node:assert/strict';
import { background, createGate, gateFor, installLlmGate, statusLine } from '../src/llm-gate.js';
import { statusOf } from '../src/page/api.js';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** A fake clock: timers run only when the test advances time. */
function clock(start = 1_000_000) {
  let t = start;
  const timers = new Set();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.add(h); return h; },
    clearTimer: (h) => { timers.delete(h); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at; timers.delete(due); due.fn();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

const gateWith = (c, config = {}, extra = {}) => createGate({ config, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0, ...extra });

/** One request through the gate; `release(reason)` ends its stream (a stream that stays open = in flight). */
function request(gate, options) {
  let release;
  const ended = new Promise((r) => { release = r; });
  const r = { started: false, done: false, chunks: [], release: (reason = { kind: 'stop' }) => release(reason) };
  const next = () => {
    r.started = true;
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'x' };
      yield { type: 'finish', reason: await ended };
    })();
  };
  r.promise = (async () => { for await (const c of gate.wrap(options, next)) r.chunks.push(c); r.done = true; })();
  return r;
}
const RATE_LIMIT = (extra = {}) => ({ kind: 'error', failure: { message: 'rate limit reached for RPM', code: 'RATE_LIMIT', status: 429, ...extra } });
const prov = (gate, name = 'p') => gate.status().providers.find((p) => p.provider === name);

test('classification: marked calls and registered sessions are background, everything else foreground', () => {
  const c = clock(), gate = gateWith(c);
  const marked = background({ provider: 'p', model: 'm' });
  assert.equal(gate.classify(marked), 'background');
  assert.equal(gate.classify({ provider: 'p', model: 'm' }), 'foreground'); // a look-alike object is not marked
  const off = gate.backgroundSessions('dot', (id) => id === 'errand-1');
  gate.backgroundSessions('broken', () => { throw new Error('boom'); });
  assert.equal(gate.classify({ provider: 'p', sessionId: 'errand-1' }), 'background');
  assert.equal(gate.classify({ provider: 'p', sessionId: 'her-chat' }), 'foreground');
  assert.equal(gate.classify({ provider: 'p' }), 'foreground');
  off();
  assert.equal(gate.classify({ provider: 'p', sessionId: 'errand-1' }), 'foreground');
  assert.equal(background(null), null);
});

test('a background burst is paced: one at a time, 60 s / cap apart', async () => {
  const c = clock(), gate = gateWith(c, { backgroundRpm: 20, foregroundQuietSeconds: 15 });
  const rs = Array.from({ length: 5 }, () => request(gate, background({ provider: 'p', model: 'm' })));
  await flush();
  assert.deepEqual(rs.map((r) => r.started), [true, false, false, false, false]);
  rs[0].release();
  await c.advance(2999);
  assert.equal(rs.filter((r) => r.started).length, 1);
  await c.advance(1);
  assert.equal(rs.filter((r) => r.started).length, 2);
  await c.advance(9000);
  assert.equal(rs.filter((r) => r.started).length, 5);
  for (const r of rs) r.release();
  await Promise.all(rs.map((r) => r.promise));
  const p = prov(gate);
  assert.equal(p.lastMinute, 5);
  assert.equal(p.delayed, 4);
  assert.equal(p.waiting, 0);
  // the window holds the cap: a sixth one waits for the oldest of the last minute to age out
  const g2 = gateWith(c, { backgroundRpm: 2, foregroundQuietSeconds: 0 });
  const a = request(g2, { provider: 'p', sessionId: 'f' }); a.release(); await a.promise; // foreground counts too
  const b = request(g2, background({ provider: 'p' })); await flush(); assert.ok(b.started); b.release();
  const d = request(g2, background({ provider: 'p' }));
  await c.advance(59_999); assert.ok(!d.started);
  await c.advance(1); assert.ok(d.started); d.release(); await d.promise;
});

test('backgroundRpm 0: no pacing at all', async () => {
  const c = clock(), gate = gateWith(c, { backgroundRpm: 0 });
  const fg = request(gate, { provider: 'p' });
  const rs = Array.from({ length: 3 }, () => request(gate, background({ provider: 'p' })));
  await flush();
  assert.ok(rs.every((r) => r.started));
  for (const r of [fg, ...rs]) r.release();
  await Promise.all(rs.map((r) => r.promise));
  assert.equal(gate.status().pacing, false);
});

test('foreground in flight and its quiet period hold background back; the bound releases it', async () => {
  const c = clock(), gate = gateWith(c, { foregroundQuietSeconds: 15, maxBackgroundWaitSeconds: 180 });
  gate.backgroundSessions('dot', (id) => id === 'errand');
  const fg = request(gate, { provider: 'p', sessionId: 'her-chat' });
  const bg = request(gate, { provider: 'p', sessionId: 'errand' });
  await flush();
  assert.ok(fg.started); assert.ok(!bg.started);
  await c.advance(60_000);
  assert.ok(!bg.started, 'waits while his request is in flight');
  fg.release(); await fg.promise;
  await c.advance(14_999);
  assert.ok(!bg.started, 'and through the quiet period');
  await c.advance(1);
  assert.ok(bg.started);
  bg.release(); await bg.promise;
  // a foreground stream that never ends: the background one goes after maxBackgroundWaitSeconds
  const stuck = request(gate, { provider: 'p', sessionId: 'her-chat' });
  const late = request(gate, background({ provider: 'p' }));
  await c.advance(179_999); assert.ok(!late.started);
  await c.advance(1); assert.ok(late.started);
  late.release(); stuck.release(); await Promise.all([late.promise, stuck.promise]);
  assert.equal(prov(gate).foregroundInFlight, 0);
});

test('a waiting background request stops waiting at once when its signal aborts', async () => {
  const c = clock(), gate = gateWith(c);
  const fg = request(gate, { provider: 'p' });
  const ac = new AbortController();
  const bg = request(gate, background({ provider: 'p', signal: ac.signal }));
  await flush();
  assert.ok(!bg.started);
  ac.abort();
  await flush();
  assert.ok(bg.started, 'handed to the adapter, which ends it with dsh\'s aborted finish');
  bg.release({ kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } });
  await bg.promise;
  assert.equal(prov(gate).waiting, 0);
  assert.equal(prov(gate).lastMinute, 1, 'the aborted one is not counted');
  fg.release(); await fg.promise;
});

test('429: cooldown for background, cap halved, additive recovery; retry-after honoured', async () => {
  const c = clock(), events = [];
  const gate = gateWith(c, { backgroundRpm: 20, foregroundQuietSeconds: 0 }, { audit: (e, d) => events.push({ e, ...d }) });
  const a = request(gate, background({ provider: 'p' }));
  await flush(); a.release(RATE_LIMIT()); await a.promise;
  let p = prov(gate);
  assert.equal(p.rateLimited, 1);
  assert.equal(p.cap, 10);
  assert.equal(p.coolingUntil, c.now() + 60_000); // random() = 0: no jitter
  assert.deepEqual(events.map((x) => x.e), ['cooldown-start']);
  // foreground is never held by the cooldown; background is
  const fg = request(gate, { provider: 'p' }); await flush(); assert.ok(fg.started); fg.release(); await fg.promise;
  const b = request(gate, background({ provider: 'p' }));
  await c.advance(59_999); assert.ok(!b.started);
  await c.advance(1); assert.ok(b.started);
  assert.deepEqual(events.map((x) => x.e), ['cooldown-start', 'cooldown-end']);
  // a repeat (started after the last hit): halved again, the cooldown doubles
  b.release(RATE_LIMIT()); await b.promise;
  p = prov(gate);
  assert.equal(p.cap, 5);
  assert.equal(p.coolingUntil, c.now() + 120_000);
  // three minutes without a 429: +1 a minute
  await c.advance(179_999); assert.equal(prov(gate).cap, 5);
  await c.advance(1); assert.equal(prov(gate).cap, 6);
  await c.advance(60_000); assert.equal(prov(gate).cap, 7);
  await c.advance(30 * 60_000); assert.equal(prov(gate).cap, 20);
  // the provider's retry-after (longer than the backoff) sets the cooldown
  const d = request(gate, background({ provider: 'p' }));
  await flush(); d.release(RATE_LIMIT({ providerRetryAfterMs: 300_000 })); await d.promise;
  assert.equal(prov(gate).coolingUntil, c.now() + 300_000);
  // a burst refused together is one hit, not three
  const g2 = gateWith(c, { backgroundRpm: 20 });
  const fgs = [1, 2, 3].map(() => request(g2, { provider: 'p' }));
  await flush();
  for (const r of fgs) r.release(RATE_LIMIT());
  await Promise.all(fgs.map((r) => r.promise));
  assert.equal(prov(g2).cap, 10);
  assert.equal(prov(g2).rateLimited, 3);
  assert.equal(prov(g2).coolingUntil, c.now() + 60_000);
});

test('holdRetries: dsh\'s fast retry of a rate-limited request waits for room, bounded', async () => {
  const c = clock(), gate = gateWith(c, { retryHoldMaxSeconds: 30 });
  const first = request(gate, { provider: 'p', sessionId: 's1' });
  await flush(); first.release(RATE_LIMIT({ providerRetryAfterMs: 5000 })); await first.promise;
  await c.advance(500);
  const retry = request(gate, { provider: 'p', sessionId: 's1' });
  const other = request(gate, { provider: 'p', sessionId: 's2' }); // another conversation is not a retry
  await flush();
  assert.ok(!retry.started); assert.ok(other.started);
  await c.advance(4499); assert.ok(!retry.started);
  await c.advance(1); assert.ok(retry.started);
  retry.release(); other.release(); await Promise.all([retry.promise, other.promise]);
  assert.equal(prov(gate).heldRetries, 1);

  // no retry-after: until the window holds fewer than at the hit — here far away, so the 30 s cap
  const g2 = gateWith(c, { retryHoldMaxSeconds: 30 });
  for (let i = 0; i < 10; i++) { const r = request(g2, { provider: 'p', sessionId: 'x' }); r.release(); await r.promise; await c.advance(1000); }
  const hitMe = request(g2, { provider: 'p', sessionId: 's1' });
  await flush(); hitMe.release(RATE_LIMIT()); await hitMe.promise;
  // 11 in the window at the hit → room once 2 have aged out: the 2nd oldest (+60 s) is ~51 s away; cap 30 s
  const r2 = request(g2, { provider: 'p', sessionId: 's1' });
  await c.advance(29_999); assert.ok(!r2.started);
  await c.advance(1); assert.ok(r2.started);
  r2.release(); await r2.promise;

  // aborting a held retry lets it go at once
  const g3 = gateWith(c);
  const h = request(g3, { provider: 'p', sessionId: 's1' }); await flush(); h.release(RATE_LIMIT({ providerRetryAfterMs: 20_000 })); await h.promise;
  const ac = new AbortController();
  const r3 = request(g3, { provider: 'p', sessionId: 's1', signal: ac.signal });
  await flush(); assert.ok(!r3.started);
  ac.abort(); await flush(); assert.ok(r3.started);
  r3.release({ kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } }); await r3.promise;

  // off, or later than a retry would come: no hold
  const g4 = gateWith(c, { holdRetries: false });
  const h4 = request(g4, { provider: 'p', sessionId: 's1' }); await flush(); h4.release(RATE_LIMIT({ providerRetryAfterMs: 20_000 })); await h4.promise;
  const r4 = request(g4, { provider: 'p', sessionId: 's1' }); await flush(); assert.ok(r4.started); r4.release(); await r4.promise;
  const g5 = gateWith(c);
  const h5 = request(g5, { provider: 'p', sessionId: 's1' }); await flush(); h5.release(RATE_LIMIT({ providerRetryAfterMs: 20_000 })); await h5.promise;
  await c.advance(13_000);
  const r5 = request(g5, { provider: 'p', sessionId: 's1' }); await flush(); assert.ok(r5.started); r5.release(); await r5.promise;
});

test('providers are isolated', async () => {
  const c = clock(), gate = gateWith(c);
  const a = request(gate, background({ provider: 'a' }));
  await flush(); a.release(RATE_LIMIT()); await a.promise;
  const fgA = request(gate, { provider: 'a' });
  const b = request(gate, background({ provider: 'b' }));
  await flush();
  assert.ok(b.started, 'a cooldown and a request in flight on a do not slow b');
  b.release(); fgA.release(); await Promise.all([b.promise, fgA.promise]);
  assert.ok(prov(gate, 'a').coolingUntil);
  assert.equal(prov(gate, 'b').coolingUntil, null);
  assert.equal(prov(gate, 'b').cap, 20);
});

test('the gate never breaks a call: bookkeeping errors let the request through', async () => {
  const debug = [];
  let broken = false;
  const c = clock();
  const gate = createGate({ now: () => { if (broken) throw new Error('clock gone'); return c.now(); }, setTimer: c.setTimer, clearTimer: c.clearTimer, logger: { debug: (m) => debug.push(m) } });
  gate.backgroundSessions('broken', () => { throw new Error('predicate'); });
  broken = true;
  const r = request(gate, background({ provider: 'p', sessionId: 'x' }));
  await flush();
  assert.ok(r.started);
  r.release(); await r.promise;
  assert.equal(r.chunks.at(-1).type, 'finish');
  assert.ok(debug.some((m) => /clock gone/.test(m)));
  broken = false;
  const r2 = request(gate, { provider: 'p', sessionId: 'x' });
  r2.release(); await r2.promise;
  assert.ok(r2.done);
  assert.ok(debug.some((m) => /predicate/.test(m)));
  // a throwing next() is dsh's own failure: it propagates, and the in-flight count is not left behind
  assert.throws(() => gate.wrap({ provider: 'p' }, () => { throw new Error('middleware'); }), /middleware/);
  assert.equal(prov(gate).foregroundInFlight, 0);
  assert.match(statusLine(gate.status()), /model requests: p /);
  assert.match(statusLine(null), /not installed/);
});

test('wiring: one llm/stream listener per dsh wraps the waterfall, delays, passes the same chunks, sees the finish', async () => {
  const c = clock();
  const root = {};
  const hooks = [];
  // Cordis's waterfall: listeners outermost-first around the final `next`.
  const waterfall = (name, options, inner) => {
    const cbs = hooks.filter((h) => h.name === name).map((h) => h.fn);
    const next = () => (cbs.shift() ?? inner)(options, next);
    return next();
  };
  const makeCtx = () => {
    const disposers = [];
    const ctx = {
      root,
      logger: () => ({ info() {}, debug() {}, warn() {} }),
      get: () => undefined,
      on: (name, fn, opts) => { const h = { name, fn, opts, ctx }; hooks.push(h); return () => { const i = hooks.indexOf(h); if (i >= 0) hooks.splice(i, 1); }; },
      effect(fn) { disposers.push(fn()); },
      dispose() { for (const d of disposers.splice(0)) d(); for (const h of hooks.filter((x) => x.ctx === ctx)) hooks.splice(hooks.indexOf(h), 1); },
    };
    return ctx;
  };
  const deps = { config: { backgroundRpm: 20, foregroundQuietSeconds: 15 }, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, random: () => 0 };
  const dot = makeCtx(), memory = makeCtx();
  const gate = installLlmGate(dot, { name: 'dsh-dot', backgroundSessions: (id) => id === 'errand', deps });
  assert.equal(installLlmGate(memory, { name: 'dsh-dot/memory', deps }), gate, 'idempotent');
  assert.equal(gateFor(memory), gate);
  assert.equal(hooks.filter((h) => h.name === 'llm/stream').length, 1);
  assert.equal(hooks[0].opts.global, true);

  const chunks = [{ type: 'text-delta', index: 0, text: 'hi' }, { type: 'finish', reason: { kind: 'stop' } }];
  let calls = 0;
  const adapter = () => { calls++; return (async function* () { yield* chunks; })(); };
  const collect = async (it) => { const out = []; for await (const ch of it) out.push(ch); return out; };

  // his request (an unknown session) goes at once; the errand's step waits for his quiet period
  const fg = await collect(waterfall('llm/stream', { provider: 'p', model: 'm', sessionId: 'chat' }, adapter));
  assert.deepEqual(fg, chunks);
  assert.ok(fg.every((ch, i) => ch === chunks[i]), 'the very same chunk objects');
  const bgP = collect(waterfall('llm/stream', { provider: 'p', model: 'm', sessionId: 'errand' }, adapter));
  await flush();
  assert.equal(calls, 1, 'the adapter is not reached while it waits');
  await c.advance(15_000);
  const bg = await bgP;
  assert.equal(calls, 2);
  assert.ok(bg.every((ch, i) => ch === chunks[i]));
  assert.equal(prov(gate).lastMinute, 2);

  // a RATE_LIMIT finish seen through the waterfall starts the cooldown
  const limited = () => (async function* () { yield { type: 'finish', reason: RATE_LIMIT() }; })();
  await collect(waterfall('llm/stream', { provider: 'p', model: 'm', sessionId: 'chat' }, limited));
  assert.ok(prov(gate).coolingUntil);
  // the dot page's status lists it (and leaves it out where no component installed one)
  assert.equal(statusOf(memory).llm.state, 'cooling');
  assert.equal(statusOf(memory).llm.providers[0].rateLimited, 1);
  assert.equal('llm' in statusOf({ get: () => undefined }), false);

  // dot turned off: the listener moves to memory's context; memory off too: gone
  dot.dispose();
  assert.equal(hooks.filter((h) => h.name === 'llm/stream').length, 1);
  assert.equal(hooks.find((h) => h.name === 'llm/stream').ctx, memory);
  assert.equal(gate.classify({ provider: 'p', sessionId: 'errand' }), 'foreground', 'dot\'s sessions went with it');
  memory.dispose();
  assert.equal(hooks.length, 0);
  assert.equal(gateFor(memory), undefined);

  // no llm/stream hook at all (older dsh, or a context without `on`): installing is harmless
  assert.ok(installLlmGate({ effect(fn) { fn(); }, logger: () => ({}) }, { deps }));
});
