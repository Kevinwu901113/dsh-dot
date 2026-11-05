#!/usr/bin/env node
// Runs dsh-dot's real memory code path (src/memory/memory.js + recall.js + store.js) on
// Ornn8/chat-memory-benchmark (https://github.com/Ornn8/chat-memory-benchmark).
//
//   ingest   each persona gets its own dot home; every history turn is replayed in logical-time order
//            as the session events dot's memory listens to (turn/start, his user/message, her
//            assistant/message, turn/end) with a fake clock at the turn's time. What follows from that
//            is the plugin's own code: transcript lines, consolidation every 20 lines, handoff past
//            handoffTokens, the recall index. Between turns the plugin's own 60-second maintenance
//            timer is fired at every minute where it can act (idle consolidation 30 min after the last
//            line, the daily consolidation + diary at 23:30).
//   exam     at each question's exam time (after the maintenance due by then) a fresh, independent
//            session is assembled: the dot:now line, the dot:memory context the plugin injects, the
//            auto-recall hits for the question (recall.prepare → dot:recall, default filters), and the
//            last WINDOW turns as chat messages. One completion, no tools. The question and the answer
//            never reach the transcript, the memory or the recall index.
//   output   answers.jsonl ({"id","answer"} for grading/grade.py), run.jsonl, meta.json; a checkpoint
//            of each persona's home after every question, so --resume continues after a crash.
//
// node bench/chat-memory-benchmark.mjs --dataset <…/datasets/natural-timegrid-20261101-v2> --out <dir>
//   [--persona P01]… [--resume] [--fake-llm] [--recall local|off] [--window 6] [--max-questions N] [--only ids.txt] [--save-prompts]
// env: DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL (https://api.deepseek.com), DSH_BENCH_MODEL (deepseek-flash),
//      DSH_BENCH_EXTRA_BODY (JSON merged into every request), DSH_BENCH_MAX_TOKENS_CAP (8192),
//      DSH_BENCH_PRICE_RMB ("0.2,2,3": per 1M tokens, input cache hit, input cache miss, output)
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ADAPTER_VERSION = '1.0.0';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── fake clock: Date.now() and new Date() are the logical time; everything else is the real one ──
const RealDate = Date;
let clockMs = RealDate.now();
class LogicalDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(clockMs); else super(...a); }
  static now() { return clockMs; }
}
const setClock = (ms) => { clockMs = ms; };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const rows = (path) => readFileSync(path, 'utf8').replace(/^﻿/, '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const contentText = (c) => (typeof c === 'string' ? c : (Array.isArray(c) ? c : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join(''));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ── model access: OpenAI-compatible chat completions, and the ctx.llm.stream memory.js consumes ──
export function createModel({ fake = false, baseUrl, apiKey, model, extraBody = {}, maxTokensCap = 8192, backoffMs = 2000, log = () => {} }) {
  const usage = { consolidate: { calls: 0, errors: 0, hit: 0, miss: 0, out: 0 }, answer: { calls: 0, errors: 0, hit: 0, miss: 0, out: 0 } };
  let inflight = 0;

  async function http(messages, maxTokens) {
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = JSON.stringify({ model, messages, max_tokens: Math.min(maxTokens, maxTokensCap), stream: false, ...extraBody });
    for (let attempt = 0; ; attempt++) {
      let res, transient = '';
      try {
        res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body, signal: AbortSignal.timeout(300000) });
        if (res.ok) {
          let j;
          try { j = await res.json(); } catch (err) { transient = `unreadable body: ${err.message}`; }
          if (j) {
            // A reply came back: it is the reply. Never asked again for a different one.
            const u = j.usage ?? {};
            const hit = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);
            const miss = u.prompt_cache_miss_tokens != null ? Number(u.prompt_cache_miss_tokens) : Math.max(0, Number(u.prompt_tokens ?? 0) - hit);
            return { text: String(j.choices?.[0]?.message?.content ?? ''), finish: j.choices?.[0]?.finish_reason ?? '', hit, miss, out: Number(u.completion_tokens ?? 0) };
          }
        } else if (res.status === 429 || res.status >= 500) transient = `HTTP ${res.status}`;
        else throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`), { fatal: true });
      } catch (err) {
        if (err.fatal) throw err;
        transient = `${err.name}: ${err.cause?.code ?? ''} ${err.message}`.trim(); // ECONNRESET, fetch failed, timeout
      }
      if (attempt >= 7) throw new Error(`gave up after ${attempt + 1} tries: ${transient}`);
      const wait = Math.min(60000, backoffMs * 2 ** attempt) + Math.floor(Math.random() * backoffMs / 2);
      log(`  model call: ${transient}; retry ${attempt + 1} in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }

  // --fake-llm: deterministic, offline. Consolidation gets valid JSON built from the records it was
  // given; an answer is canned. Token counts are estimated (chars / 1.5) so the run shows the volume.
  function fakeReply(messages, purpose) {
    const all = messages.map((m) => m.content).join('\n');
    const est = (s) => Math.ceil(s.length / 1.5);
    if (purpose === 'answer') {
      const text = '（fake-llm 固定回答）我记得一点，但这是测试用的回答。';
      return { text, finish: 'stop', hit: 0, miss: est(all), out: est(text) };
    }
    const said = [...all.matchAll(/^\[[\d-]+ \d{2}:\d{2}\] 他：(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
    const last = said.at(-1) ?? '';
    const out = {
      owner: last ? [{ action: 'add', content: `他说过：${clip(last, 40)}` }] : [], self: [], people: [], same: [], confirm: [],
      fragments: said.slice(-3).map((s, i) => ({ text: clip(s, 60), kind: 'event', tag: i % 3, mergeWith: null })),
      handoff: { now: '在和他聊天', inFlight: [], promises: [], openQuestions: [] },
      diary: '今天和他聊了几句。',
    };
    const text = JSON.stringify(out);
    return { text, finish: 'stop', hit: 0, miss: est(all), out: est(text) };
  }

  async function complete(messages, { maxTokens, purpose }) {
    const u = usage[purpose];
    u.calls++;
    try {
      const r = fake ? fakeReply(messages, purpose) : await http(messages, maxTokens);
      u.hit += r.hit; u.miss += r.miss; u.out += r.out;
      return r;
    } catch (err) { u.errors++; throw err; }
  }

  const toChat = (messages) => messages.map((m) => ({ role: m.role ?? 'user', content: contentText(m.content) }));
  return {
    usage,
    get inflight() { return inflight; },
    complete,
    /** ctx.llm for memory.js: yields text-delta, usage and finish the way it reads them. */
    llm: {
      stream(opts) {
        return (async function* () {
          inflight++;
          try {
            let r;
            try { r = await complete(toChat(opts.messages ?? []), { maxTokens: opts.maxTokens ?? 8192, purpose: 'consolidate' }); } catch (err) {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: err.message } } };
              return;
            }
            yield { type: 'text-delta', text: r.text };
            yield { type: 'usage', usage: { inputTokens: r.miss, cacheReadTokens: r.hit, outputTokens: r.out } };
            yield { type: 'finish', reason: { kind: r.finish === 'length' ? 'length' : 'stop' } };
          } finally { inflight--; }
        })();
      },
    },
  };
}

// ── one persona's dot: the plugin applied to a ctx that stands in for dsh ──
function hostFor({ apply, home, model, modelName, state, sessionBaseTokens, estimateTokens }) {
  const listeners = [], contexts = new Map(), services = {}, timers = [];
  const sessionTokens = state.sessionTokens; // session → estimated tokens of her conversation
  const notes = [];
  services.dshDot = { session: () => state.session, setSession: (id) => { state.session = id; }, isErrand: () => false, isIm: () => false, freeze: () => () => {} };
  services.sessionController = {
    create: async () => { state.sessions++; const id = `${state.persona}-s${state.sessions}`; sessionTokens[id] = sessionBaseTokens; return { sessionId: id }; },
    rename: async () => ({}),
    resolveAgent: async (id) => ({ agent: { session: { id }, inject: (m) => { notes.push(m); sessionTokens[id] = (sessionTokens[id] ?? sessionBaseTokens) + estimateTokens(contentText(m.content)); } } }),
  };
  services.workspaceRegistry = { archiveSession: async () => {} };
  services.agents = { get: (id) => ({ session: { id } }) };
  services.tokenMeter = { measure: (s) => ({ totalTokens: sessionTokens[s?.id] ?? 0 }) };
  const logger = () => ({ info: (m) => { if (/consolidation failed|handoff|recall:/.test(m)) console.log(`  [memory] ${m}`); }, warn: (m) => console.log(`  [memory] warn: ${m}`), error: (m) => console.log(`  [memory] error: ${m}`) });
  const ctx = {
    logger,
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); },
    // Effects run at once; the timers they start are captured, never fired by the real clock.
    effect(fn, label = '') {
      const st = globalThis.setTimeout, si = globalThis.setInterval;
      const take = (kind) => (cb, ms) => { const t = { label, kind, cb, ms, unref() { return t; }, ref() { return t; } }; timers.push(t); return t; };
      globalThis.setTimeout = take('timeout'); globalThis.setInterval = take('interval');
      try { fn(); } finally { globalThis.setTimeout = st; globalThis.setInterval = si; }
    },
    get: (n) => services[n],
    provide(n, v) { services[n] = v; },
    inject(_deps, fn) { fn({ systemPrompt: { context: (c) => { contexts.set(c.name, c); }, section: () => () => {} }, tools: { register: () => () => {} }, effect: (f) => f(), on: () => () => {} }); },
    llm: model.llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: modelName }) },
  };
  apply(ctx, { home });
  const emit = (id, type, data, extra = {}) => { for (const fn of listeners) fn({ id, header: { cwd: home } }, { type, data, ...extra }); };
  const tick = timers.find((t) => t.kind === 'interval' && /idle consolidation/.test(t.label));
  if (!tick) throw new Error('dsh-dot/memory maintenance timer not found (memory.js changed?)');
  return { services, contexts, emit, tick: tick.cb, notes, api: services.dotMemory };
}

async function main() {
  const { values: o } = parseArgs({
    options: {
      dataset: { type: 'string' }, persona: { type: 'string', multiple: true }, out: { type: 'string' }, resume: { type: 'boolean', default: false },
      'fake-llm': { type: 'boolean', default: false }, recall: { type: 'string', default: 'local' }, window: { type: 'string', default: '6' },
      'max-questions': { type: 'string' }, only: { type: 'string' }, 'save-prompts': { type: 'boolean', default: false }, tz: { type: 'string', default: 'Asia/Shanghai' }, 'session-base-tokens': { type: 'string', default: '10000' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (o.help || !o.dataset || !o.out) {
    console.log('usage: node bench/chat-memory-benchmark.mjs --dataset <dataset dir> --out <dir> [--persona P01]… [--resume] [--fake-llm] [--recall local|off] [--window 6] [--max-questions N]');
    process.exit(o.help ? 0 : 2);
  }
  if (!['local', 'off'].includes(o.recall)) throw new Error('--recall: local or off');
  const WINDOW = Number(o.window);
  const SESSION_BASE = Number(o['session-base-tokens']);
  const maxQ = o['max-questions'] ? Number(o['max-questions']) : Infinity;
  // --only: answer just these question ids (one per line, or JSONL with "id"). History is still replayed
  // in full up to the last of them, so memory is built exactly as in a full run; only the exams are skipped.
  const only = o.only ? new Set(readFileSync(o.only, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith('{') ? JSON.parse(l).id : l))) : null;
  process.env.TZ = o.tz; // the dataset's times are +08:00; daily maintenance runs at 23:30 local
  const out = resolve(o.out);
  const dataset = resolve(o.dataset);

  // ── dataset ──
  const manifestBuf = readFileSync(join(dataset, 'manifest.json'));
  const manifest = JSON.parse(manifestBuf);
  for (const [rel, want] of Object.entries(manifest.file_sha256 ?? {})) {
    if (/^(histories\/|exam-inputs)/.test(rel) && sha256(readFileSync(join(dataset, rel))) !== want) throw new Error(`dataset file changed: ${rel}`);
  }
  // Only the exam inputs and histories are read; review-only/ (answer key) never is.
  const exams = rows(join(dataset, 'exam-inputs.jsonl'));
  const allPersonas = [...new Set(exams.map((e) => e.persona))];
  const personas = o.persona?.length ? o.persona : allPersonas;
  for (const p of personas) if (!allPersonas.includes(p)) throw new Error(`no persona ${p} in this dataset (${allPersonas.join(', ')})`);

  // ── output ──
  if (existsSync(join(out, 'meta.json')) && !o.resume) throw new Error(`${out} already has a run: --resume to continue it, or another --out`);
  mkdirSync(out, { recursive: true });
  const files = { answers: join(out, 'answers.jsonl'), run: join(out, 'run.jsonl'), meta: join(out, 'meta.json'), prompts: join(out, 'prompts.jsonl') };
  const done = new Set(), answered = new Set(), unanswered = new Set();
  if (existsSync(files.answers)) for (const r of rows(files.answers)) { done.add(r.id); answered.add(r.id); }
  if (existsSync(files.run)) for (const r of rows(files.run)) { done.add(r.id); if (r.error && !answered.has(r.id)) unanswered.add(r.id); }

  // ── an isolated DSH_HOME: no settings of the owner's dot leak in; the recall library and model
  // cache are shared with his (so the model is downloaded once), and his mirror is honoured ──
  const realDsh = process.env.DSH_HOME || join(homedir(), '.dsh');
  const benchDsh = join(out, 'dsh-home');
  mkdirSync(benchDsh, { recursive: true });
  const realLib = join(realDsh, 'dsh-dot-recall');
  mkdirSync(realLib, { recursive: true });
  const link = join(benchDsh, 'dsh-dot-recall');
  if (!existsSync(link) && !(() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) symlinkSync(realLib, link, process.platform === 'win32' ? 'junction' : 'dir');
  let savedRecall = {};
  try { savedRecall = JSON.parse(readFileSync(join(realDsh, 'dsh-memory.json'), 'utf8')).recall ?? {}; } catch { /* none */ }
  writeFileSync(join(benchDsh, 'dsh-memory.json'), JSON.stringify({ recall: { backend: o.recall, ...(savedRecall.mirror ? { mirror: savedRecall.mirror } : {}) } }, null, 2));
  process.env.DSH_HOME = benchDsh;

  globalThis.Date = LogicalDate;
  const { apply, defaults, dayLabel } = await import('../src/memory/memory.js');
  const { estimateTokens } = await import('../src/memory/store.js');
  const { nowText } = await import('../src/dot/core.js');
  const { stamp } = await import('../src/clock.js');
  const { prompt } = await import('../src/prompts.js');

  const modelName = process.env.DSH_BENCH_MODEL || 'deepseek-flash';
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  if (!o['fake-llm'] && !process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not set (or use --fake-llm)');
  const extraBody = process.env.DSH_BENCH_EXTRA_BODY ? JSON.parse(process.env.DSH_BENCH_EXTRA_BODY) : {};
  const price = (process.env.DSH_BENCH_PRICE_RMB || '0.2,2,3').split(',').map(Number);
  const model = createModel({ fake: o['fake-llm'], baseUrl, apiKey: process.env.DEEPSEEK_API_KEY, model: modelName, extraBody, maxTokensCap: Number(process.env.DSH_BENCH_MAX_TOKENS_CAP || 8192), log: (m) => console.log(m) });

  let commit = '', dirty = false;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(); dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).trim()); } catch { /* not a checkout */ }
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const oldMeta = existsSync(files.meta) ? JSON.parse(readFileSync(files.meta, 'utf8')) : null;
  const meta = {
    adapter: 'dsh-dot bench/chat-memory-benchmark.mjs', adapterVersion: ADAPTER_VERSION,
    dshDot: { version: pkg.version, commit, srcDirty: dirty },
    dataset: { path: dataset, version: manifest.version, manifest_sha256: sha256(manifestBuf), source_release_manifest_sha256: manifest.source_release_manifest_sha256 ?? null },
    model: o['fake-llm'] ? 'fake-llm' : modelName, baseUrl: o['fake-llm'] ? null : baseUrl, extraBody, thinking: 'off (non-thinking model; extraBody can add a provider switch)',
    usedFor: 'consolidation (memory.js via ctx.llm.stream) and answering, same model',
    window: { turns: WINDOW, why: 'the last 6 complete turns as chat messages, as Soul/ROFM/Qwen/OpenViking/Hindsight/Suzu were tested (docs/tested-configurations.md)' },
    recall: { backend: o.recall, model: o.recall === 'local' ? 'Xenova/multilingual-e5-small' : null, mirror: savedRecall.mirror || process.env.HF_ENDPOINT || 'https://hf-mirror.com', topK: defaults.recallTopK, maxTokens: defaults.recallMaxTokens, minQueryLength: defaults.recallMinQueryLength, contrast: defaults.recallContrast, minScore: defaults.recallMinScore, lexical: defaults.recallLexical, names: defaults.recallNames, rrfK: defaults.recallRrfK, openBudgetTokens: defaults.openBudgetTokens, windowTurns: WINDOW, note: 'recall.js defaults; recallWindowTurns = window so the shown turns are not recalled twice' },
    memory: { handoffTokens: defaults.handoffTokens, minTokensBetweenHandoffs: defaults.minTokensBetweenHandoffs, consolidateEveryLines: defaults.consolidateEveryLines, consolidateIdleMinutes: defaults.consolidateIdleMinutes, dailyAt: defaults.dailyAt, inputChars: defaults.inputChars, sessionBaseTokens: SESSION_BASE, tz: o.tz },
    pricingAssumptionRmbPerMTokens: { inputCacheHit: price[0], inputCacheMiss: price[1], output: price[2], source: 'DeepSeek list price for deepseek-flash (assumption; override DSH_BENCH_PRICE_RMB)' },
    personas: oldMeta?.personas ?? {},
    usage: null, costRmb: null, startedAt: oldMeta?.startedAt ?? new RealDate().toISOString(), updatedAt: null,
  };
  const baseUsage = oldMeta?.usage ?? null; // a resumed run adds to what the earlier runs spent
  const writeMeta = () => {
    const u = JSON.parse(JSON.stringify(model.usage));
    if (baseUsage) for (const k of Object.keys(u)) for (const f of Object.keys(u[k])) u[k][f] += baseUsage[k]?.[f] ?? 0;
    meta.usage = u;
    const cost = (x) => (x.hit * price[0] + x.miss * price[1] + x.out * price[2]) / 1e6;
    meta.costRmb = { consolidate: +cost(u.consolidate).toFixed(4), answer: +cost(u.answer).toFixed(4), total: +(cost(u.consolidate) + cost(u.answer)).toFixed(4) };
    meta.updatedAt = new RealDate().toISOString();
    writeFileSync(`${files.meta}.tmp`, JSON.stringify(meta, null, 2)); renameSync(`${files.meta}.tmp`, files.meta);
  };
  writeMeta();

  const SYSTEM = [
    '你是 dot，他的聊天伙伴。这是你和他的一段新对话；下面是你记得的事和你们最近几轮的聊天。',
    '像平时一样直接回他。只依据你记得的事和聊天内容回答；记不清、没有依据的就照实说不确定，不要编。',
  ].join('\n');

  for (const persona of personas) {
    const qs = exams.filter((e) => e.persona === persona && (!only || only.has(e.id))).map((e, i) => ({ ...e, i })).sort((a, b) => RealDate.parse(a.now) - RealDate.parse(b.now) || a.i - b.i);
    if (!qs.length) { console.log(`[${persona}] no questions selected`); continue; }
    const histPath = join(dataset, qs[0].history_file);
    const histBuf = readFileSync(histPath);
    if (qs.some((q) => q.history_sha256 !== sha256(histBuf))) throw new Error(`${persona}: history SHA mismatch`);
    // Only the original message fields cross into the memory flow.
    const history = rows(histPath).map((r) => ({ turn: r['轮次'], at: RealDate.parse(r['逻辑时间']), user: r['用户消息'], assistant: r['助手回复'] }));
    history.forEach((h, i) => { if (h.turn !== i + 1 || (i && h.at < history[i - 1].at)) throw new Error(`${persona}: history order`); });

    const pdir = join(out, 'personas', persona);
    const home = join(pdir, 'dot'), ckpt = join(pdir, 'checkpoint');
    let state;
    if (existsSync(join(ckpt, 'bench-state.json'))) {
      if (!o.resume) throw new Error(`${pdir} has a checkpoint: --resume`);
      rmSync(home, { recursive: true, force: true }); cpSync(ckpt, home, { recursive: true });
      state = JSON.parse(readFileSync(join(home, 'bench-state.json'), 'utf8'));
      console.log(`[${persona}] resumed at turn ${state.turnsDone}`);
    } else {
      rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
      state = { persona, turnsDone: 0, clock: history[0].at - 60000, session: `${persona}-s1`, sessions: 1, sessionTokens: { [`${persona}-s1`]: SESSION_BASE }, maxSessionTokens: SESSION_BASE, tries: {} };
    }
    setClock(state.clock);
    const host = hostFor({ apply, home, model, modelName, state, sessionBaseTokens: SESSION_BASE, estimateTokens });
    const { api, contexts, emit } = host;

    // Let whatever the plugin started (consolidation, handoff, indexing) finish before time moves on.
    async function quiesce() {
      for (let pass = 0; pass < 2; pass++) {
        let idle = 0;
        while (idle < 5) { await new Promise((r) => { setImmediate(r); }); if (model.inflight === 0) idle++; else { idle = 0; await sleep(25); } }
        await api.recall.sync();
      }
    }

    // The plugin's 60-second timer (on whole minutes), fired at every minute where it can do something
    // before `until`: idle consolidation once the last line is consolidateIdleMinutes old (with ≥ 3
    // new lines), the daily consolidation + diary from dailyAt on. Work that stays due (a failed or
    // unparsed consolidation, a daily run that found idle consolidation in flight) is tried again a
    // minute later, as the real timer does — at most 4 times per piece of work here, to bound cost.
    const minute = (ms) => Math.ceil(ms / 60000) * 60000;
    const [dailyH, dailyM] = String(defaults.dailyAt).split(':').map(Number);
    const lastDiary = () => { try { return JSON.parse(readFileSync(join(home, 'memory', 'memory.json'), 'utf8')).lastDiary ?? null; } catch { return null; } };
    async function maintain(until, inclusive) {
      const before = (t) => (inclusive ? t <= until : t < until);
      for (;;) {
        const next = minute(clockMs + 1);
        const cands = [];
        const st = api.status();
        const lastAt = api.lastSaidAt(Infinity);
        if (st.sinceCursor >= 3 && lastAt) cands.push({ t: Math.max(next, minute(lastAt + defaults.consolidateIdleMinutes * 60000)), key: `idle:${lastAt}:${st.sinceCursor}` });
        const d = new LogicalDate(clockMs);
        const at = (days) => new RealDate(d.getFullYear(), d.getMonth(), d.getDate() + days, dailyH, dailyM).getTime();
        const today = dayLabel(d).slice(0, 10);
        let daily = lastDiary() === today ? at(1) : Math.max(next, at(0));
        if (dayLabel(new LogicalDate(daily)).slice(0, 10) !== dayLabel(new LogicalDate(at(0))).slice(0, 10)) daily = at(1);
        cands.push({ t: daily, key: `daily:${dayLabel(new LogicalDate(daily)).slice(0, 10)}` });
        const open = cands.filter((c) => (state.tries[c.key] ?? 0) < 4);
        if (!open.length) return;
        const t = Math.min(...open.map((c) => c.t));
        if (!before(t)) return;
        for (const c of open) if (c.t === t) state.tries[c.key] = (state.tries[c.key] ?? 0) + 1;
        for (const k of Object.keys(state.tries)) if (!cands.some((c) => c.key === k)) delete state.tries[k];
        setClock(t);
        host.tick();
        await quiesce();
      }
    }

    async function ingest(h) {
      await maintain(h.at, false);
      setClock(h.at);
      const id = state.session;
      emit(id, 'turn/start', {});
      emit(id, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: prompt('dot.owner-words', { stamp: stamp(h.at, h.at), text: h.user, busy: '' }) }] }, { surfaceOp: 'append' });
      emit(id, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: h.assistant }] } });
      setClock(h.at + 1);
      // Her conversation grows by this turn (measured at turn/end for the handoff).
      state.sessionTokens[id] = (state.sessionTokens[id] ?? SESSION_BASE) + estimateTokens(`[${stamp(h.at, h.at)}] ${h.user}`) + estimateTokens(h.assistant) + 8;
      state.maxSessionTokens = Math.max(state.maxSessionTokens, state.sessionTokens[state.session]);
      emit(id, 'turn/end', {});
      await quiesce();
      state.turnsDone = h.turn;
    }

    function checkpoint() {
      state.clock = clockMs;
      writeFileSync(join(home, 'bench-state.json'), JSON.stringify(state, null, 2));
      rmSync(`${ckpt}.tmp`, { recursive: true, force: true });
      cpSync(home, `${ckpt}.tmp`, { recursive: true });
      rmSync(ckpt, { recursive: true, force: true });
      renameSync(`${ckpt}.tmp`, ckpt);
    }

    function maintenanceCounts() {
      const c = { lines: 0, idle: 0, daily: 0, handoff: 0, chunks: 0, failed: 0 };
      try { for (const r of rows(join(home, 'memory', 'calls.jsonl'))) { const [base, more] = String(r.reason).split('+'); if (more) c.chunks++; else c[base] = (c[base] ?? 0) + 1; } } catch { /* none yet */ }
      c.failed = model.usage.consolidate.errors;
      let handoffs = 0; try { handoffs = rows(join(home, 'memory', 'handoffs.jsonl')).length; } catch { /* none */ }
      return { consolidations: c, handoffs };
    }
    const recordPersona = (status) => {
      const m = maintenanceCounts();
      meta.personas[persona] = { turns: history.length, turnsDone: state.turnsDone, questions: qs.length, answered: qs.filter((q) => answered.has(q.id)).length, unanswered: qs.filter((q) => unanswered.has(q.id)).length, ...m, sessions: state.sessions, maxSessionTokensEstimate: state.maxSessionTokens, recall: api.recall.status().state, status };
      writeMeta();
    };

    if (o.recall === 'local') {
      console.log(`[${persona}] recall: loading the local embedding model (first run downloads it)`);
      const ok = await api.recall.warm();
      console.log(`[${persona}] recall: ${api.recall.status().state}`);
      if (!ok) console.log(`[${persona}] WARNING: recall is not ready, queries fall back to lexical search (see recall status in meta.json)`);
    }

    const t0 = RealDate.now();
    let asked = 0;
    for (const q of qs) {
      if (asked >= maxQ) break;
      asked++;
      const now = RealDate.parse(q.now);
      if (done.has(q.id) && q.cutoff_turn <= state.turnsDone && now <= clockMs) continue; // answered before a resume
      while (state.turnsDone < history.length && history[state.turnsDone].at <= now) {
        await ingest(history[state.turnsDone]);
        if (state.turnsDone % 25 === 0) { checkpoint(); recordPersona('running'); }
      }
      await maintain(now, true);
      setClock(Math.max(now, clockMs)); // an exam at a turn's own time: after that turn
      if (state.turnsDone !== q.cutoff_turn) throw new Error(`${q.id}: ${state.turnsDone} turns ingested, cutoff_turn ${q.cutoff_turn}`);
      if (done.has(q.id)) continue;

      // ── the exam: an independent session; nothing here is recorded ──
      const examId = `exam:${q.id}`;
      const c = { agent: { session: { id: examId, header: { cwd: home } } } };
      const memoryText = contexts.get('dot:memory')?.text(c) ?? '';
      const r = await api.recall.prepare(examId, q.question);
      const recallText = contexts.get('dot:recall')?.text(c) ?? '';
      api.recall.clear(examId);
      const nowLine = nowText(now, api.lastSaidAt(clockMs + 1));
      const win = history.slice(Math.max(0, state.turnsDone - WINDOW), state.turnsDone);
      const messages = [
        { role: 'system', content: [SYSTEM, nowLine, memoryText, recallText].filter(Boolean).join('\n\n') },
        ...win.flatMap((h) => [{ role: 'user', content: prompt('dot.owner-words', { stamp: stamp(h.at, now), text: h.user, busy: '' }) }, { role: 'assistant', content: h.assistant }]),
        { role: 'user', content: prompt('dot.owner-words', { stamp: stamp(now, now), text: q.question, busy: '' }) },
      ];
      if (o['save-prompts']) appendFileSync(files.prompts, `${JSON.stringify({ id: q.id, messages })}\n`);
      const row = { id: q.id, persona, cutoff_turn: q.cutoff_turn, now: q.now, recall_hits: r?.hits?.length ?? 0, recall_mode: r?.mode ?? '', memory_chars: memoryText.length, window: win.length, sessions: state.sessions };
      try {
        const a = await model.complete(messages, { maxTokens: 2048, purpose: 'answer' });
        const answer = a.text.trim();
        if (!answer || /^[`*\s]*DOT_SILENT[`*\s。.]*$/.test(answer)) { row.error = 'no reply (empty or silent)'; unanswered.add(q.id); }
        else { appendFileSync(files.answers, `${JSON.stringify({ id: q.id, answer })}\n`); answered.add(q.id); }
        if (a.finish && a.finish !== 'stop') row.finish = a.finish;
      } catch (err) { row.error = clip(err.message, 300); unanswered.add(q.id); }
      appendFileSync(files.run, `${JSON.stringify(row)}\n`);
      done.add(q.id);
      checkpoint();
      recordPersona('running');
      const mc = maintenanceCounts().consolidations;
      console.log(`[${persona}] ${asked}/${qs.length} ${q.id} · turn ${q.cutoff_turn} · recall ${row.recall_hits} (${row.recall_mode}) · consolidations ${mc.lines + mc.idle + mc.daily + mc.handoff + mc.chunks}${row.error ? ` · ERROR ${row.error}` : ''} · ${Math.round((RealDate.now() - t0) / 1000)} s`);
    }
    checkpoint();
    recordPersona(asked >= qs.length ? 'done' : 'partial');
    console.log(`[${persona}] done: ${meta.personas[persona].answered} answered, ${meta.personas[persona].unanswered} without an answer`);
  }
  writeMeta();
  console.log(`usage: ${JSON.stringify(meta.usage)} · ≈ ¥${meta.costRmb.total}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.stack ?? err.message); process.exit(1); });
}
