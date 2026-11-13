// One gate in front of every model request in this dsh, so her life in the background does not use
// up the requests-per-minute budget the owner's conversation needs (users hit
// `429 rate_limit_rpm_exceeded` in a normal chat). Built on dsh-llm's `llm/stream` waterfall, which
// every model call goes through — the agent loop's steps and direct `ctx.llm.stream(...)` alike.
// After LangChain's InMemoryRateLimiter (a bucket in front of model calls), LiteLLM's request
// priorities and cooldowns, promptfoo's scheduler (AIMD per provider, honour retry-after) and the
// OpenAI SDKs' backoff with jitter — at the scale of one person's desktop: no dependency, process memory only.
//
// Which requests are ours in the background (only these are ever paced; anything unknown is foreground):
//
//   request                                        where                         class
//   ─────────────────────────────────────────────  ────────────────────────────  ──────────
//   interlude round, its continuity refresh,        interlude/core.js (marked)    background
//     the weekly growth review
//   memory consolidation, diary                     memory/memory.js complete()   background
//   QQ group scoring (groupPolicy 'score')          qq/qq.js (marked)             background
//   howto reflection after a phone run              dot/core.js reflectOnce()     background
//   her errand session (current and retired):       dot/core.js isErrand          background
//     non-conversation app notifications, phone
//     checks, interlude look / play / try / free
//     time (dshDot.task)
//   interlude without dsh-dot: interlude.vmSession  interlude/core.js             background
//     (a session set aside for looks / plays /
//     tries), and a look / try / free-time session
//     that is not her conversation
//   her conversation (lastSession): the owner's     —                             foreground
//     dsh / IM chat, QQ messages (private and
//     group) and conversation-app notifications
//     (QQ, WeChat) — these wake her there
//   a phone check or look when there is no errand  —                             foreground
//     (it falls back to her conversation)
//   anything else (other plugins, sessions we do   —                             foreground
//     not know, compaction, titles)
//
// What the gate does, per provider (a limit on one provider never slows another):
//   - counts every request started in the last 60 s (both classes);
//   - a background request starts only when the window holds fewer than `backgroundRpm` requests,
//     at least 60 s / cap after the previous background one (bucket refill: no bursts), one at a
//     time, and not while a foreground request is in flight or within `foregroundQuietSeconds` after
//     one ended (the owner's turn has several steps);
//   - a RATE_LIMIT finish (any class) starts a cooldown for background requests — at least the 60 s
//     window of the hit, doubling with jitter on repeated hits (≤ 10 min), or the provider's
//     retry-after — and halves the background cap (≥ 1); after 3 min without a 429 the cap grows
//     back by 1 a minute (AIMD);
//   - a background request never waits longer than `maxBackgroundWaitSeconds` (below dot's
//     turnStallMs, so an errand step is never taken for a stalled turn), and stops waiting at once
//     when its signal aborts (the adapter then ends it with dsh's own aborted finish);
//   - `holdRetries`: see holdFor() — the one case a foreground request is touched;
//   - nothing in here may break a model call: any error in the bookkeeping lets the request through.
import { sectionOf } from './settings.js';

export const defaults = {
  backgroundRpm: 20,          // see DEFAULT_RPM_WHY; 0 = no pacing at all (the gate only counts)
  foregroundQuietSeconds: 15, // background waits this long after her conversation's last request ended
  maxBackgroundWaitSeconds: 180, // a background request never waits longer (dot's turnStallMs is 300)
  holdRetries: true,          // hold dsh's fast retry of a rate-limited request until the window has room
  retryHoldMaxSeconds: 30,    // …but never longer than this
};
// Why 20: one background request every 3 s at most. The measured burst (one "like a post" act) was
// dozens of requests in under a minute; 20 leaves most of a typical entry-tier RPM limit (tens per
// minute) to the owner, while a single errand loop, whose steps already take seconds each (tools,
// the phone), barely slows down. Below that, AIMD halves the cap on the first 429 anyway.

const WINDOW_MS = 60000;
const RETRY_WINDOW_MS = 12000;   // dsh's retry waits ≤ 10 s (+10% jitter) after a failure: a start this soon is a retry
const COOLDOWN_MAX_MS = 600000;
const RECOVER_AFTER_MS = 180000; // no 429 for this long: the cap grows again, repeated-hit count resets
const RAISE_EVERY_MS = 60000;
const JITTER = 0.25;

// Hand-built requests the plugin makes for background work. A WeakSet of the options objects:
// the waterfall hands every listener the very object passed to ctx.llm.stream.
const BACKGROUND = new WeakSet();
/** Mark one hand-built request as background work; returns the same options object. */
export function background(options) {
  try { if (options && typeof options === 'object') BACKGROUND.add(options); } catch { /* never in the way */ }
  return options;
}

const num = (v, d, min = 0) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
function normalize(c = {}) {
  return {
    backgroundRpm: Math.floor(num(c.backgroundRpm, defaults.backgroundRpm)),
    quietMs: num(c.foregroundQuietSeconds, defaults.foregroundQuietSeconds) * 1000,
    maxWaitMs: num(c.maxBackgroundWaitSeconds, defaults.maxBackgroundWaitSeconds) * 1000,
    holdRetries: c.holdRetries === undefined ? defaults.holdRetries : c.holdRetries !== false,
    retryHoldMaxMs: num(c.retryHoldMaxSeconds, defaults.retryHoldMaxSeconds) * 1000,
  };
}

/**
 * The gate's logic, clock-injectable. `config`: the `llm` settings section; `now`/`setTimer`/
 * `clearTimer`/`random` for tests; `logger` ({ info, debug }); `audit(event, data)`.
 */
export function createGate({ config = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random, logger = {}, audit = () => {} } = {}) {
  const cfg = normalize(config);
  const pacing = cfg.backgroundRpm > 0;
  const providers = new Map();
  const sessionTests = new Map(); // name → (sessionId) => boolean
  const limits = new Map(); // provider \0 session → { at, retryAfterMs, inWindow }: its last RATE_LIMIT
  const debug = (m) => { try { logger.debug?.(m); } catch { /* ignore */ } };
  const info = (m) => { try { logger.info?.(m); } catch { /* ignore */ } };
  const note = (event, data) => { try { audit(event, data); } catch { /* ignore */ } };
  const timer = (fn, ms) => { const h = setTimer(fn, Math.max(0, ms)); h?.unref?.(); return h; };
  const stamp = (t) => new Date(t).toTimeString().slice(0, 8);

  const P = (name) => {
    let p = providers.get(name);
    if (!p) {
      p = { name, starts: [], bgStarts: [], fgInFlight: 0, fgLastEnd: -Infinity, lastBgStart: -Infinity, cap: cfg.backgroundRpm, raiseAt: Infinity, hits: 0, lastHitAt: -Infinity, coolingUntil: 0, coolTimer: null, queue: [], timer: null, timerAt: Infinity, delayed: 0, rateLimited: 0, heldRetries: 0 };
      providers.set(name, p);
    }
    return p;
  };

  function refresh(p, t) {
    while (p.starts.length && p.starts[0] <= t - WINDOW_MS) p.starts.shift();
    while (p.bgStarts.length && p.bgStarts[0] <= t - WINDOW_MS) p.bgStarts.shift();
    while (p.cap < cfg.backgroundRpm && t >= p.raiseAt) { p.cap++; p.raiseAt += RAISE_EVERY_MS; } // additive increase
    if (p.cap >= cfg.backgroundRpm) p.raiseAt = Infinity;
    if (p.hits && t - p.lastHitAt >= RECOVER_AFTER_MS) p.hits = 0;
    if (p.coolingUntil && t >= p.coolingUntil) {
      p.coolingUntil = 0;
      info(`${p.name}: cooldown over, background requests resume (cap ${p.cap}/min)`);
      note('cooldown-end', { provider: p.name, cap: p.cap });
    }
  }

  /** The earliest time the head of the background queue may start (Infinity: wait for an event). */
  function readyAt(p, t) {
    if (p.fgInFlight > 0) return Infinity;
    let at = Math.max(t, p.fgLastEnd + cfg.quietMs, p.coolingUntil, p.lastBgStart + WINDOW_MS / p.cap);
    if (p.starts.length >= p.cap) at = Math.max(at, p.starts[p.starts.length - p.cap] + WINDOW_MS);
    return at;
  }

  /** Count one request as started now. */
  function start(rec, t) {
    const p = rec.p;
    rec.started = true; rec.startedAt = t;
    p.starts.push(t);
    if (rec.cls === 'foreground') p.fgInFlight++;
    else { p.bgStarts.push(t); p.lastBgStart = t; }
  }

  function admit(p, w, t) {
    p.queue.splice(p.queue.indexOf(w), 1);
    w.off();
    start(w.rec, t);
    if (t > w.since) p.delayed++;
    w.resolve();
  }

  function pump(p) {
    try {
      const t = now();
      refresh(p, t);
      for (const w of [...p.queue]) if (t >= w.deadline) admit(p, w, t); // the bound outranks every rule
      if (p.queue.length && readyAt(p, t) <= t) admit(p, p.queue[0], t); // one at a time
      schedule(p, t);
    } catch (err) {
      debug(`llm gate: pump failed (${err.message}); releasing ${p.queue.length} waiting`);
      for (const w of p.queue.splice(0)) { try { w.off(); } catch { /* ignore */ } w.resolve(); }
    }
  }

  function schedule(p, t) {
    if (!p.queue.length) { if (p.timer) clearTimer(p.timer); p.timer = null; p.timerAt = Infinity; return; }
    const next = Math.min(readyAt(p, t), ...p.queue.map((w) => w.deadline));
    if (next === p.timerAt && p.timer) return;
    if (p.timer) clearTimer(p.timer);
    p.timerAt = next;
    p.timer = Number.isFinite(next) ? timer(() => { p.timer = null; p.timerAt = Infinity; pump(p); }, next - t) : null;
  }

  /** Wait until `until` (or the signal aborts); resolves either way. */
  const sleep = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) { resolve(); return; }
    let h = null;
    const done = () => { if (h) clearTimer(h); signal?.removeEventListener?.('abort', done); resolve(); };
    h = timer(done, ms);
    signal?.addEventListener?.('abort', done, { once: true });
  });

  /**
   * dsh's own retry after a RATE_LIMIT (500 ms, 1 s, 2 s … ≤ 10 s) lands inside the same 60 s window
   * and is refused again. A foreground request of the same session and provider starting within
   * RETRY_WINDOW_MS of that finish is taken for the retry and held until the provider's retry-after,
   * else until enough of the last minute's requests have aged out: the hit came at the L-th request
   * in the window, so the limit is taken as L - 1 and the retry waits for the window to hold fewer.
   * A rough estimate, and always capped at retryHoldMaxSeconds (and the request's own abort).
   */
  function holdFor(p, rec, t) {
    if (!cfg.holdRetries || !rec.session) return 0;
    const l = limits.get(`${p.name}\0${rec.session}`);
    if (!l || t - l.at > RETRY_WINDOW_MS) return 0;
    let until;
    if (l.retryAfterMs > 0) until = l.at + l.retryAfterMs;
    else {
      const allowed = Math.max(1, l.inWindow - 1);
      const i = p.starts.length - allowed;
      until = i >= 0 ? p.starts[i] + WINDOW_MS : 0;
    }
    return Math.max(0, Math.min(until, t + cfg.retryHoldMaxMs) - t);
  }

  function classify(options) {
    if (BACKGROUND.has(options)) return 'background';
    const id = options?.sessionId;
    if (id) {
      for (const test of sessionTests.values()) {
        try { if (test(String(id))) return 'background'; } catch (err) { debug(`llm gate: session test failed (${err.message})`); }
      }
    }
    return 'foreground';
  }

  /** Book one request in: { rec, wait } (wait: a promise, or null when it may start now). */
  function begin(options) {
    const t = now();
    const p = P(String(options?.provider ?? '?'));
    refresh(p, t);
    const rec = { p, cls: classify(options), session: options?.sessionId ? String(options.sessionId) : '', started: false, startedAt: -Infinity, signal: options?.signal };
    // An already aborted request is not counted: the adapter ends it at once without a provider call.
    if (rec.signal?.aborted) return { rec, wait: null };
    if (rec.cls === 'foreground') {
      const hold = holdFor(p, rec, t);
      if (!hold) { start(rec, t); return { rec, wait: null }; }
      p.heldRetries++;
      debug(`llm gate: holding a retry in ${rec.session} on ${p.name} for ${Math.round(hold / 1000)} s`);
      return { rec, wait: sleep(hold, rec.signal).then(() => { if (!rec.signal?.aborted) { const s = now(); refresh(p, s); start(rec, s); } }) };
    }
    if (!pacing) { start(rec, t); return { rec, wait: null }; }
    const wait = new Promise((resolve) => {
      const w = { rec, since: t, deadline: t + cfg.maxWaitMs, resolve, off: () => {} };
      if (rec.signal?.addEventListener) {
        const onAbort = () => { const i = p.queue.indexOf(w); if (i < 0) return; p.queue.splice(i, 1); resolve(); pump(p); };
        rec.signal.addEventListener('abort', onAbort, { once: true });
        w.off = () => rec.signal.removeEventListener?.('abort', onAbort);
      }
      p.queue.push(w);
    });
    pump(p);
    return { rec, wait };
  }

  function hit(p, rec, failure, t) {
    p.rateLimited++;
    const retryAfterMs = Number(failure?.providerRetryAfterMs) > 0 ? Number(failure.providerRetryAfterMs) : 0;
    if (rec.session) limits.set(`${p.name}\0${rec.session}`, { at: t, retryAfterMs, inWindow: p.starts.length });
    if (!pacing) return;
    // Requests already in flight when the last hit came (a burst refused together) are the same hit:
    // only one that started after it counts as a repeat (halves the cap again, doubles the cooldown).
    const repeat = rec.startedAt > p.lastHitAt;
    if (repeat) {
      p.hits++; p.lastHitAt = t;
      p.cap = Math.max(1, Math.floor(p.cap / 2)); // multiplicative decrease
      p.raiseAt = t + RECOVER_AFTER_MS;
    }
    const backoff = repeat ? Math.min(COOLDOWN_MAX_MS, WINDOW_MS * 2 ** (p.hits - 1) * (1 + JITTER * random())) : WINDOW_MS;
    const until = t + Math.min(COOLDOWN_MAX_MS, Math.max(backoff, retryAfterMs));
    if (until <= p.coolingUntil) return;
    const was = p.coolingUntil;
    p.coolingUntil = until;
    if (p.coolTimer) clearTimer(p.coolTimer);
    p.coolTimer = timer(() => { p.coolTimer = null; pump(p); }, until - t);
    if (!was) {
      info(`${p.name}: rate limited (${rec.cls}${rec.session ? ` in ${rec.session}` : ''}); background requests wait until ${stamp(until)}, cap ${p.cap}/min`);
      note('cooldown-start', { provider: p.name, until: new Date(until).toISOString(), cap: p.cap, hits: p.hits, retryAfterMs: retryAfterMs || undefined, class: rec.cls });
    }
  }

  /** The request ended: `reason` is its finish chunk's reason, or null (stopped early, thrown). */
  function finish(rec, reason) {
    const p = rec.p, t = now();
    refresh(p, t);
    if (rec.cls === 'foreground' && rec.started) { p.fgInFlight = Math.max(0, p.fgInFlight - 1); p.fgLastEnd = t; }
    rec.started = false;
    if (reason?.kind === 'error' && reason.failure?.code === 'RATE_LIMIT') hit(p, rec, reason.failure, t);
    else if (rec.session && reason) limits.delete(`${p.name}\0${rec.session}`);
    pump(p);
  }

  /** Pass the chunks through unchanged, noting the terminal finish (or that the stream ended without one). */
  async function* observe(source, rec) {
    let done = false;
    const end = (reason) => { if (done) return; done = true; try { finish(rec, reason); } catch (err) { debug(`llm gate: finish failed (${err.message})`); } };
    try {
      for await (const chunk of source) {
        if (chunk?.type === 'finish') end(chunk.reason ?? null);
        yield chunk;
      }
    } finally { end(null); }
  }

  return {
    config: cfg,
    /** The `llm/stream` listener body: delays (when it must) and observes one request. */
    wrap(options, next) {
      let booked;
      try { booked = begin(options); } catch (err) { debug(`llm gate: ${err.message}; request let through`); return next(); }
      const { rec, wait } = booked;
      if (!wait) {
        let source;
        try { source = next(); } catch (err) { try { finish(rec, null); } catch { /* ignore */ } throw err; }
        return observe(source, rec);
      }
      return (async function* gated() {
        try { await wait; } catch (err) { debug(`llm gate: wait failed (${err.message})`); }
        let source;
        try { source = next(); } catch (err) { try { finish(rec, null); } catch { /* ignore */ } throw err; }
        yield* observe(source, rec);
      })();
    },
    classify,
    /** Register which sessions are background (a predicate on the session id); returns the remover. */
    backgroundSessions(name, test) {
      sessionTests.set(name, test);
      return () => { if (sessionTests.get(name) === test) sessionTests.delete(name); };
    },
    /** Per provider: requests in the last minute, background cap, cooldown, waiting, totals. */
    status() {
      const t = now();
      return {
        pacing, backgroundRpm: cfg.backgroundRpm, quietSeconds: cfg.quietMs / 1000, maxWaitSeconds: cfg.maxWaitMs / 1000, holdRetries: cfg.holdRetries,
        providers: [...providers.values()].map((p) => {
          try { refresh(p, t); } catch { /* status only */ }
          return { provider: p.name, lastMinute: p.starts.length, backgroundLastMinute: p.bgStarts.length, cap: p.cap, coolingUntil: p.coolingUntil || null, waiting: p.queue.length, foregroundInFlight: p.fgInFlight, delayed: p.delayed, rateLimited: p.rateLimited, heldRetries: p.heldRetries };
        }),
      };
    },
    /** Let everything waiting go and drop the timers (dispose). */
    stop() {
      for (const p of providers.values()) {
        for (const w of p.queue.splice(0)) { try { w.off(); } catch { /* ignore */ } w.resolve(); }
        if (p.timer) clearTimer(p.timer);
        if (p.coolTimer) clearTimer(p.coolTimer);
        p.timer = p.coolTimer = null; p.timerAt = Infinity;
      }
    },
  };
}

/** One line for /dot. */
export function statusLine(st) {
  if (!st) return 'model requests: gate not installed';
  const head = st.pacing ? `background ≤${st.backgroundRpm}/min, waits ${st.quietSeconds} s after yours, ≤${st.maxWaitSeconds} s` : 'pacing off (llm.backgroundRpm 0)';
  const per = st.providers.map((p) => `${p.provider} ${p.lastMinute}/min (bg cap ${p.cap}${p.coolingUntil ? `, cooling until ${new Date(p.coolingUntil).toTimeString().slice(0, 8)}` : ''}${p.waiting ? `, ${p.waiting} waiting` : ''}, ${p.delayed} delayed, ${p.rateLimited}×429${p.heldRetries ? `, ${p.heldRetries} retries held` : ''})`);
  return `model requests: ${per.join(' · ') || 'none yet'} — ${head}`;
}

// One gate per dsh (per Cordis root), whichever components are on. Each component that makes model
// calls installs it; the listener lives on one of their contexts and moves to another if that one is
// disposed, so turning one component off never takes the gate away from the others.
const installs = new WeakMap();
const rootOf = (ctx) => { try { return ctx?.root ?? ctx; } catch { return ctx; } };

/** The gate installed for this dsh, if any (the dot page's status). */
export function gateFor(ctx) { return installs.get(rootOf(ctx))?.gate; }

/**
 * Install the gate once per dsh (idempotent) and, with `backgroundSessions`, register which of this
 * component's sessions are background for as long as the component lives. Returns the gate, or null
 * when it could not be installed (the plugin then works exactly as before).
 */
export function installLlmGate(ctx, { name = 'dsh-dot', backgroundSessions = null, deps = {} } = {}) {
  try {
    const root = rootOf(ctx);
    let inst = installs.get(root);
    if (!inst) {
      const logger = (() => { try { return ctx.logger?.('dsh-dot/llm-gate') ?? {}; } catch { return {}; } })();
      inst = { holders: new Set(), owner: null, off: null, gate: null };
      const audit = (event, data) => {
        const c = inst.owner ?? ctx;
        const a = (() => { try { return c.get?.('dshComputer')?.audit ?? c.get?.('dshPhone')?.audit; } catch { return undefined; } })();
        a?.({ kind: 'llm-gate', event, ...data });
      };
      inst.gate = createGate({ config: deps.config ?? sectionOf('llm', (m) => logger.warn?.(m)), logger, audit, ...deps });
      installs.set(root, inst);
    }
    const { gate } = inst;
    const attach = () => {
      if (inst.owner) return;
      for (const h of inst.holders) {
        try {
          // `global`: dsh-llm dispatches with the LlmRuntime as `this`; never filtered out by scope.
          inst.off = h.on('llm/stream', (options, next) => gate.wrap(options, next), { global: true });
          inst.owner = h;
          return;
        } catch { /* try the next holder */ }
      }
    };
    const setup = () => {
      inst.holders.add(ctx);
      const removeTest = backgroundSessions ? gate.backgroundSessions(name, backgroundSessions) : () => {};
      attach();
      return () => {
        removeTest();
        inst.holders.delete(ctx);
        if (inst.owner === ctx) { try { inst.off?.(); } catch { /* disposed with its fiber anyway */ } inst.owner = null; inst.off = null; attach(); }
        if (!inst.holders.size) { gate.stop(); installs.delete(root); }
      };
    };
    if (typeof ctx.effect === 'function') ctx.effect(setup, `${name}: llm request gate`);
    else setup();
    return gate;
  } catch (err) {
    try { ctx?.logger?.('dsh-dot/llm-gate')?.debug?.(`llm gate not installed: ${err.message}`); } catch { /* ignore */ }
    return null;
  }
}
