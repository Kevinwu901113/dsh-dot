#!/usr/bin/env node
// Bench 2.2 worker: hosts ONE persona's dot memory (the real src/memory/memory.js + recall.js +
// store.js) for the Python adapter (bench/bench22/dsh_dot.py). JSON lines on stdin → one JSON line
// per command on stdout; logs go to stderr.
//
// Same approach as bench/chat-memory-benchmark.mjs (the 1.0 adapter): a fake clock at each turn's
// logical time; every turn replayed as the session events memory.js listens to; the plugin's own
// 60-second maintenance timer fired at every minute where it can act (the diary at dailyAt);
// consolidation every consolidateEveryLines lines and handoff past handoffTokens happen inside the
// plugin. Differences for 2.2:
//   - every model call goes to the Bench 2.2 gateway (OPENAI_BASE_URL) with its accounting headers:
//     the plugin's own calls (ctx.llm.stream) as chat completions on the gateway's flash model, the
//     recall models as local:<name> on /embeddings and /rerank (the plugin's recallEmbedder hook,
//     same models, prefixes and score as recall.js's local backend; served by local-models.mjs).
//   - the exam returns the memory text instead of answering: the evaluator answers.
//   - snapshot / restore of the dot home for the natural board's mark() / rewind().
//
// commands: {cmd:'init', ...} {cmd:'ingest', turns:[{turn,time,user,assistant}], run, system}
//           {cmd:'retrieve', question, now, cutoff, run, system} {cmd:'mark'} {cmd:'rewind', token}
//           {cmd:'status'} {cmd:'exit'}
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export const WORKER_VERSION = '2.2.0';
const RealDate = Date;
let clockMs = RealDate.now();
class LogicalDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(clockMs); else super(...a); }
  static now() { return clockMs; }
}
const setClock = (ms) => { clockMs = ms; };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const log = (...a) => process.stderr.write(`${a.join(' ')}\n`);
const contentText = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join(''));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const rows = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// The answer-side text around the memory (no persona content: the same for every history).
const SYSTEM = [
  '你是 dot，他的聊天伙伴。下面是你记得的事和你们最近几轮的聊天。',
  '像平时一样直接回他。只依据你记得的事和聊天内容回答；记不清、没有依据的就照实说不确定，不要编。',
].join('\n');

let M = null; // modules
let cfg = null; // init options
let fatal = null; // a gateway refusal that must stop the run (ceiling, cap, upstream gone)
const acct = { run: '', system: '', phase: 'ingest' };
const usage = { chat: { calls: 0, errors: 0, in: 0, out: 0 }, embed: { calls: 0, skipped: 0, tokens: 0 }, rerank: { calls: 0, skipped: 0, tokens: 0 } };
let inflight = 0;

async function gateway(route, body, tag = '') {
  const url = `${cfg.gateway.replace(/\/+$/, '')}${route}`;
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer evaluator-gateway', 'X-Bench-Run': acct.run, 'X-Bench-System': acct.system, 'X-Bench-Phase': acct.phase, 'X-Bench-Tag': tag }, body: JSON.stringify(body), signal: AbortSignal.timeout(600000) });
    } catch (err) { last = `${err.name}: ${err.message}`; await sleep(2000 * (attempt + 1)); continue; }
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    last = `HTTP ${res.status}: ${text.slice(0, 300)}`;
    // ceiling / spend cap / a refused upstream (no balance, bad key): the run stops here
    if (res.status === 403 || res.status === 402 || res.status === 400 || res.status === 404) break;
    if (res.status === 502 && /upstream failed|HTTP 40[0-9]/.test(text)) break; // the gateway already retried upstream
    await sleep(2000 * (attempt + 1));
  }
  fatal ??= last.includes('RUN_COST_CEILING') ? `RUN_COST_CEILING ${last}` : `gateway ${route}: ${last}`;
  throw new Error(fatal);
}

// ── ctx.llm for memory.js: the gateway's flash, non-thinking ──
function fakeReply(text) {
  const said = [...text.matchAll(/^\[[\d-]+ \d{2}:\d{2}\] 他：(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  if (/写今天的日记|日记/.test(text.slice(0, 400))) return '今天和他聊了几句。';
  const last = said.at(-1) ?? '';
  return JSON.stringify({ owner: last ? [{ action: 'add', content: `他说过：${clip(last, 40)}` }] : [], self: [], people: [], same: [], open: said.slice(-1).map((s) => ({ action: 'add', content: clip(s, 50), due: null })) });
}
async function chat(text, maxTokens) {
  usage.chat.calls++;
  if (cfg.fake) { const out = fakeReply(text); usage.chat.in += Math.ceil(text.length / 1.5); usage.chat.out += Math.ceil(out.length / 1.5); return { text: out, finish: 'stop', in: Math.ceil(text.length / 1.5), out: Math.ceil(out.length / 1.5) }; }
  const j = await gateway('/chat/completions', { model: cfg.chatModel, messages: [{ role: 'user', content: text }], max_tokens: maxTokens, thinking: { type: 'disabled' } }, 'memory');
  const u = j.usage ?? {};
  usage.chat.in += Number(u.prompt_tokens ?? 0); usage.chat.out += Number(u.completion_tokens ?? 0);
  return { text: String(j.choices?.[0]?.message?.content ?? ''), finish: j.choices?.[0]?.finish_reason ?? '', in: Number(u.prompt_tokens ?? 0), out: Number(u.completion_tokens ?? 0) };
}
const llm = {
  stream(opts) {
    return (async function* () {
      inflight++;
      try {
        let r;
        try { r = await chat((opts.messages ?? []).map((m) => contentText(m.content)).join('\n'), Math.min(opts.maxTokens ?? 8192, cfg.maxTokensCap)); } catch (err) {
          usage.chat.errors++;
          yield { type: 'finish', reason: { kind: 'error', failure: { message: err.message } } };
          return;
        }
        yield { type: 'text-delta', text: r.text };
        yield { type: 'usage', usage: { inputTokens: r.in, cacheReadTokens: 0, outputTokens: r.out } };
        yield { type: 'finish', reason: { kind: r.finish === 'length' ? 'length' : 'stop' } };
      } finally { inflight--; }
    })();
  },
};

// ── the recall models behind the gateway (recall.js's recallEmbedder hook) ──
// While history is replayed, memory.js also runs recall for every replayed message of his (the turns
// she would have been shown before replying). That reply already exists and the result is cleared
// at turn/end unseen, so those queries are answered without a model (a unit vector, no reranker)
// instead of being paid for. Indexing (passages) and every exam query use the real models.
let dim = 384;
function makeEmbedder(_backend, spec) {
  const s = M.SPECS[spec.model] ?? { query: '', passage: '' };
  return {
    async embed(texts, role = 'passage') {
      if (role === 'query' && acct.phase === 'ingest') { usage.embed.skipped++; const v = new Float32Array(dim); v[0] = 1; return texts.map(() => v); }
      usage.embed.calls++;
      const j = await gateway('/embeddings', { model: `local:${spec.model}`, input: texts.map((t) => (s[role] ?? '') + t) }, role);
      usage.embed.tokens += Number(j.usage?.prompt_tokens ?? 0);
      const out = [...j.data].sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
      if (out[0]) dim = out[0].length;
      return out;
    },
    rerank: spec.rerank && spec.rerank !== 'none' ? async (query, docs, topN) => {
      if (acct.phase === 'ingest') { usage.rerank.skipped++; return null; }
      usage.rerank.calls++;
      const j = await gateway('/rerank', { model: `local:${spec.rerank}`, query, documents: docs, top_n: topN }, 'rerank');
      usage.rerank.tokens += Number(j.usage?.prompt_tokens ?? 0);
      return j.results.map((r) => ({ index: r.index, score: r.relevance_score }));
    } : null,
  };
}

// ── one persona's dot: the plugin applied to a ctx that stands in for dsh (as in the 1.0 adapter) ──
function hostFor(state) {
  const listeners = [], contexts = new Map(), services = {}, timers = [];
  const tokens = state.sessionTokens;
  services.dshDot = { session: () => state.session, setSession: (id) => { state.session = id; }, isErrand: () => false, isIm: () => false, freeze: () => () => {} };
  services.sessionController = {
    create: async () => { state.sessions++; const id = `s${state.sessions}`; tokens[id] = cfg.sessionBaseTokens; return { sessionId: id }; },
    rename: async () => ({}),
    resolveAgent: async (id) => ({ agent: { session: { id }, inject: (m) => { tokens[id] = (tokens[id] ?? cfg.sessionBaseTokens) + M.estimateTokens(contentText(m.content)); } } }),
  };
  services.workspaceRegistry = { archiveSession: async () => {} };
  services.agents = { get: (id) => ({ session: { id } }) };
  services.tokenMeter = { measure: (s) => ({ totalTokens: tokens[s?.id] ?? 0 }) };
  const logger = () => ({ info: (m) => { if (/consolidation failed|handoff|recall:/.test(m)) log(`  [memory] ${m}`); }, warn: (m) => log(`  [memory] warn: ${m}`), error: (m) => log(`  [memory] error: ${m}`) });
  const ctx = {
    logger,
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); },
    effect(fn, label = '') {
      const st = globalThis.setTimeout, si = globalThis.setInterval;
      const take = (kind) => (cb, ms) => { const t = { label, kind, cb, ms, unref() { return t; }, ref() { return t; } }; timers.push(t); return t; };
      globalThis.setTimeout = take('timeout'); globalThis.setInterval = take('interval');
      try { fn(); } finally { globalThis.setTimeout = st; globalThis.setInterval = si; }
    },
    get: (n) => services[n],
    provide(n, v) { services[n] = v; },
    inject(_deps, fn) { fn({ systemPrompt: { context: (c) => { contexts.set(c.name, c); }, section: () => () => {} }, tools: { register: () => () => {} }, effect: (f) => f(), on: () => () => {} }); },
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'gateway', model: cfg.chatModel }) },
  };
  M.apply(ctx, { home: cfg.home, recallEmbedder: makeEmbedder });
  const emit = (id, type, data, extra = {}) => { for (const fn of listeners) fn({ id, header: { cwd: cfg.home } }, { type, data, ...extra }); };
  const tick = timers.find((t) => t.kind === 'interval' && /daily diary/.test(t.label));
  if (!tick) throw new Error('dsh-dot/memory maintenance timer not found (memory.js changed?)');
  return { contexts, emit, tick: tick.cb, api: services.dotMemory };
}

let state = null, host = null;
const freshState = () => ({ turnsDone: 0, clock: 0, session: 's1', sessions: 1, sessionTokens: { s1: 0 }, maxSessionTokens: 0, tries: {}, window: [], times: {} });

async function quiesce() {
  for (let pass = 0; pass < 2; pass++) {
    let idle = 0;
    while (idle < 5) { await new Promise((r) => { setImmediate(r); }); if (inflight === 0) idle++; else { idle = 0; await sleep(25); } }
    await host.api.recall.sync();
  }
  if (fatal) throw new Error(fatal);
}

// The plugin's 60-second timer, fired at every minute before `until` where it can act (the diary from
// dailyAt on; a failed one is tried again a minute later, at most 4 times per day here).
const minute = (ms) => Math.ceil(ms / 60000) * 60000;
async function maintain(until, inclusive) {
  const [dailyH, dailyM] = String(cfg.dailyAt ?? '').split(':').map(Number);
  if (!Number.isFinite(dailyH)) return; // diary switched off by the settings
  const before = (t) => (inclusive ? t <= until : t < until);
  const lastDiary = () => { try { return JSON.parse(readFileSync(join(cfg.home, 'memory', 'memory.json'), 'utf8')).lastDiary ?? null; } catch { return null; } };
  for (;;) {
    const next = minute(clockMs + 1);
    const d = new LogicalDate(clockMs);
    const at = (days) => new RealDate(d.getFullYear(), d.getMonth(), d.getDate() + days, dailyH, dailyM).getTime();
    const today = M.dayLabel(d).slice(0, 10);
    let daily = lastDiary() === today ? at(1) : Math.max(next, at(0));
    if (M.dayLabel(new LogicalDate(daily)).slice(0, 10) !== M.dayLabel(new LogicalDate(at(0))).slice(0, 10)) daily = at(1);
    const key = `daily:${M.dayLabel(new LogicalDate(daily)).slice(0, 10)}`;
    if ((state.tries[key] ?? 0) >= 4 || !before(daily)) return;
    state.tries = { [key]: (state.tries[key] ?? 0) + 1 };
    setClock(daily);
    host.tick();
    await quiesce();
  }
}

const SESSION_GROWTH = (h) => M.estimateTokens(`[${M.stamp(h.at, h.at)}] ${h.user}`) + M.estimateTokens(h.assistant) + 8;
async function ingestOne(t) {
  const h = { turn: t.turn, at: Math.max(RealDate.parse(t.time), clockMs), user: String(t.user ?? ''), assistant: String(t.assistant ?? '') };
  acct.phase = 'ingest';
  await maintain(h.at, false);
  setClock(h.at);
  const id = state.session;
  host.emit(id, 'turn/start', {});
  host.emit(id, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: M.prompt('dot.owner-words', { stamp: M.stamp(h.at, h.at), text: h.user, busy: '' }) }] }, { surfaceOp: 'append' });
  await host.api.recall.pending(id); // the replayed wake's own recall (no model; see makeEmbedder)
  host.emit(id, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: h.assistant }] } });
  setClock(h.at + 1);
  state.sessionTokens[id] = (state.sessionTokens[id] ?? cfg.sessionBaseTokens) + SESSION_GROWTH(h);
  state.maxSessionTokens = Math.max(state.maxSessionTokens, state.sessionTokens[state.session]);
  host.emit(id, 'turn/end', {});
  await quiesce();
  state.turnsDone++;
  (state.times[h.at] ??= []).push(h.turn);
  state.window.push(h); if (state.window.length > cfg.window) state.window.shift();
}

async function retrieve({ question, now: nowIso, cutoff }) {
  if (cutoff != null && cutoff !== state.turnsDone) throw new Error(`adapter holds ${state.turnsDone} turns but the visible cutoff is ${cutoff}`);
  const now = RealDate.parse(nowIso);
  acct.phase = 'ingest'; // time-driven maintenance due by now (the diary) is write-side work
  await maintain(now, true);
  setClock(Math.max(now, clockMs));
  acct.phase = 'retrieve';
  const examId = `exam:${RealDate.now()}:${Math.random()}`;
  const c = { agent: { session: { id: examId, header: { cwd: cfg.home } } } };
  const memoryText = host.contexts.get('dot:memory')?.text(c) ?? '';
  const r = await host.api.recall.prepare(examId, question);
  const recallText = host.contexts.get('dot:recall')?.text(c) ?? '';
  host.api.recall.clear(examId);
  acct.phase = 'ingest';
  if (fatal) throw new Error(fatal);
  const nowLine = M.nowText(clockMs, host.api.lastSaidAt(clockMs + 1));
  const win = state.window.map((h) => `${M.prompt('dot.owner-words', { stamp: M.stamp(h.at, clockMs), text: h.user, busy: '' }).trim()}\n我：${h.assistant}`);
  const prompt = [SYSTEM, nowLine, memoryText, recallText, win.length ? `【最近的聊天】（[时间] 后面是他说的，"我："后面是你回的）\n${win.join('\n')}` : ''].filter(Boolean).join('\n\n');
  const hitTurns = (r?.hits ?? []).flatMap((x) => state.times[x.at] ?? []);
  const used = [...new Set([...hitTurns, ...state.window.map((h) => h.turn)])].sort((a, b) => a - b);
  return { prompt, used_turns: used, meta: { recall_hits: r?.hits?.length ?? 0, recall_mode: r?.mode ?? '', recall_turns: [...new Set(hitTurns)].sort((a, b) => a - b), recall_candidates: r?.candidates?.length ?? 0, memory_chars: memoryText.length, recall_chars: recallText.length, window: win.length, sessions: state.sessions } };
}

// ── natural board: mark / rewind by snapshot of the dot home + the worker's state ──
const snapDir = (token) => `${cfg.home}.mark-${token}`;
function mark() {
  state.clock = clockMs;
  const dir = snapDir(state.turnsDone);
  rmSync(dir, { recursive: true, force: true });
  cpSync(cfg.home, dir, { recursive: true });
  writeFileSync(join(dir, 'bench-state.json'), JSON.stringify(state));
  return state.turnsDone;
}
function rewind(token) {
  const dir = snapDir(token);
  if (!existsSync(dir)) throw new Error(`no mark ${token}`);
  rmSync(cfg.home, { recursive: true, force: true });
  cpSync(dir, cfg.home, { recursive: true });
  state = JSON.parse(readFileSync(join(cfg.home, 'bench-state.json'), 'utf8'));
  rmSync(join(cfg.home, 'bench-state.json'), { force: true });
  setClock(state.clock);
  host = hostFor(state); // a fresh plugin instance reads memory.json, transcript and recall index from disk
  return state.turnsDone;
}

function consolidations() {
  const c = { lines: 0, daily: 0, handoff: 0, chunks: 0 };
  try { for (const r of rows(join(cfg.home, 'memory', 'calls.jsonl'))) { const [base, more] = String(r.reason).split('+'); if (more) c.chunks++; else c[base] = (c[base] ?? 0) + 1; } } catch { /* none yet */ }
  let handoffs = 0; try { handoffs = rows(join(cfg.home, 'memory', 'handoffs.jsonl')).length; } catch { /* none */ }
  return { ...c, handoffs };
}

async function init(o) {
  cfg = { window: 6, sessionBaseTokens: 10000, maxTokensCap: 8192, chatModel: 'deepseek-v4.1-flash', fake: false, memory: {}, ...o };
  process.env.TZ = cfg.tz || 'Asia/Shanghai';
  // An isolated DSH_HOME: only the bench's own settings. recallWindowTurns = the window shown.
  mkdirSync(cfg.dshHome, { recursive: true });
  writeFileSync(join(cfg.dshHome, 'dsh-memory.json'), JSON.stringify({ recall: { backend: 'local' } }, null, 2));
  const memory = { recallWindowTurns: cfg.window, ...cfg.memory };
  writeFileSync(join(cfg.dshHome, 'dsh-dot.json'), JSON.stringify({ memory }, null, 2));
  process.env.DSH_HOME = cfg.dshHome;
  globalThis.Date = LogicalDate;
  const mem = await import('../../src/memory/memory.js');
  const store = await import('../../src/memory/store.js');
  const rec = await import('../../src/memory/recall.js');
  const core = await import('../../src/dot/core.js');
  const clock = await import('../../src/clock.js');
  const prompts = await import('../../src/prompts.js');
  M = { apply: mem.apply, defaults: mem.defaults, dayLabel: mem.dayLabel, estimateTokens: store.estimateTokens, SPECS: rec.SPECS, nowText: core.nowText, stamp: clock.stamp, prompt: prompts.prompt };
  cfg.dailyAt = cfg.memory.dailyAt ?? M.defaults.dailyAt;
  rmSync(cfg.home, { recursive: true, force: true }); mkdirSync(cfg.home, { recursive: true });
  state = freshState();
  state.sessionTokens.s1 = cfg.sessionBaseTokens;
  host = hostFor(state);
  const ok = await host.api.recall.warm();
  return { ok, recall: host.api.recall.status(), defaults: { consolidateEveryLines: M.defaults.consolidateEveryLines, dailyAt: M.defaults.dailyAt, handoffTokens: M.defaults.handoffTokens, recallTopK: M.defaults.recallTopK, recallMaxTokens: M.defaults.recallMaxTokens, recallCandidates: M.defaults.recallCandidates }, memorySettings: memory };
}

const handlers = {
  init,
  async ingest(o) {
    acct.run = o.run ?? acct.run; acct.system = o.system ?? acct.system;
    if (state.turnsDone === 0 && o.turns?.length) setClock(RealDate.parse(o.turns[0].time) - 60000);
    for (const t of o.turns ?? []) await ingestOne(t);
    return { turnsDone: state.turnsDone };
  },
  async retrieve(o) { acct.run = o.run ?? acct.run; acct.system = o.system ?? acct.system; return retrieve(o); },
  async mark() { await quiesce(); return { token: mark() }; },
  async rewind(o) { await quiesce(); return { token: rewind(o.token) }; },
  async status() { return { turnsDone: state?.turnsDone ?? 0, usage, consolidations: cfg ? consolidations() : null, sessions: state?.sessions, maxSessionTokens: state?.maxSessionTokens, memory: host?.api.status(), recall: host?.api.recall.status() }; },
};

const rl = createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  queue = queue.then(async () => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.cmd === 'exit') { process.stdout.write(`${JSON.stringify({ ok: true })}\n`); process.exit(0); }
    try {
      if (fatal && msg.cmd !== 'status') throw new Error(fatal);
      const result = await handlers[msg.cmd](msg);
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.stack ?? err).slice(0, 1500), fatal: Boolean(fatal) })}\n`);
    }
  });
});
rl.on('close', () => { void queue.then(() => process.exit(0)); });
