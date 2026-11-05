// dsh-dot/memory · recall: before each turn of hers, the old conversation turns that look most like
// the message that woke her, as "原话 you remember" — RAG over her own transcript.
//
// It sits next to the portrait / fragments / diary / handoff, not instead of them: on the public
// memory benchmark those win the "what did we agree / what did he correct / when is his birthday"
// questions, and verbatim recall wins "what exactly did he say about X three weeks ago". The lexical
// `recall` tool stays as her own way to look things up.
//
//   index    one chunk per turn (what woke her + what she said back, with the date), embedded once,
//            appended to <home>/memory/recall/<backend>-<model>/{vectors.f32, meta.jsonl}. One index
//            per backend+model, so switching back and forth never mixes vector spaces or re-embeds.
//   query    the waking message (owner, QQ, notification, schedule) → top-k by cosine (cloud backends
//            rerank the top candidates), minus what is already in her context window, in time order.
//            Two filters, neither tied to a model's cosine scale: a message with fewer than
//            recallMinQueryLength distinct content tokens (好的 / 哈哈哈哈 / ok thanks) recalls nothing,
//            and a hit must stand out from the whole index (contrast, below). recallMinScore is an
//            optional absolute floor on top.
//   lexical  next to the vectors, two channels that read words, not meaning (0.19): BM25 over characters
//            and character bigrams (CJK) and words (the rest) of the same chunks — a rare name (阿兰, 签名牌) outweighs
//            the rest of a question, which one sentence vector cannot do — and names: a person or a
//            name her memory knows (people cards with their aliases, fragments' who) that the message
//            mentions pulls in the turns that mention any name of theirs. The channels are fused by
//            reciprocal rank (RRF), so their scores never need to be on one scale. recallLexical /
//            recallNames turn them off.
//   backends local  — multilingual-e5-small (ONNX q8) via transformers.js on the CPU, no key; the
//                     same 85/108 as bge-small-zh-v1.5 on the Chinese benchmark, plus English and ~100
//                     other languages, for 129 MB / ~0.4 GB RSS instead of 23 MB / ~0.13 GB (bge-small-zh
//                     stays one command away). The library is 300–480 MB, so it is not a dependency: it
//                     is installed into $DSH_HOME on first use (the way qq/phone pull their MCP servers
//                     with npx), models come from an HF mirror. Until both are there, queries fall back
//                     to lexical search (said in status).
//            siliconflow / dashscope — cloud embedding + rerank, key from /dot memory recall key or env.
//            off.
// Passwords and keys never reach the index, the cloud, or her prompt (the same filter as fragments).
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateTokens, rejectReason, search } from './store.js';
import { prompt } from '../prompts.js';

export const BACKENDS = ['local', 'siliconflow', 'dashscope', 'off'];
const MODELS = {
  local: { embed: 'Xenova/multilingual-e5-small', rerank: 'none' }, // 0.15.2; was Xenova/bge-small-zh-v1.5
  siliconflow: { embed: 'BAAI/bge-m3', rerank: 'BAAI/bge-reranker-v2-m3' },
  dashscope: { embed: 'qwen3.7-text-embedding', rerank: 'qwen3.7-text-rerank' },
};
const KEY_ENV = { siliconflow: 'SILICONFLOW_API_KEY', dashscope: 'DASHSCOPE_API_KEY' };
// transformers.js needs the ONNX export; people will type the BAAI name from the model card.
const ALIASES = { 'BAAI/bge-small-zh-v1.5': 'Xenova/bge-small-zh-v1.5', 'BAAI/bge-m3': 'Xenova/bge-m3', 'intfloat/multilingual-e5-small': 'Xenova/multilingual-e5-small' };
// Per-model conventions from each model card (pooling, query/passage prefixes), and the q8 download size.
export const SPECS = {
  'Xenova/bge-small-zh-v1.5': { pooling: 'cls', query: '为这个句子生成表示以用于检索相关文章：', passage: '', mb: 23 },
  'Xenova/bge-m3': { pooling: 'cls', query: '', passage: '', mb: 560 },
  'Xenova/multilingual-e5-small': { pooling: 'mean', query: 'query: ', passage: 'passage: ', mb: 129 },
};

/**
 * How much a message says, in any script: distinct CJK / kana / hangul characters plus distinct words
 * in the rest (case-folded), punctuation and emoji ignored. 好的 → 2, 哈哈哈哈 → 1, "ok thanks" → 2,
 * 我回来了 → 4, "What did Caroline research?" → 4.
 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
export function queryLength(q) {
  const s = String(q ?? '').toLowerCase();
  return new Set(s.match(CJK) ?? []).size + new Set(s.replace(CJK, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).size;
}

/**
 * Contrast: keep a cosine hit only if it stands out from the crowd — score ≥ median + k·(best − median)
 * over every chunk searched. Small talk and vague messages match everything about equally; a real
 * question has a few turns well above the rest. Scale-free, so the same k works for bge-small-zh
 * (cosines 0.35–0.77) and e5 (0.78–0.94), Chinese and English. Needs a crowd: below CONTRAST_MIN_POOL
 * chunks the median says nothing and every hit is kept.
 */
const CONTRAST_MIN_POOL = 20;
export function contrastCut(scores, k) {
  if (!(k > 0) || scores.length < CONTRAST_MIN_POOL) return -Infinity;
  const s = Float64Array.from(scores).sort();
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return median + k * (s[s.length - 1] - median);
}

/**
 * What BM25 counts in a text: characters and character bigrams inside each CJK / kana / hangul run,
 * whole words elsewhere (case-folded). No tokenizer, so a made-up name splits no worse
 * than a common word.
 */
const RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu;
const CJK1 = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export function lexTokens(text) {
  const out = [];
  for (const m of String(text ?? '').toLowerCase().matchAll(RUN)) {
    const r = m[0];
    if (!CJK1.test(r[0])) { out.push(r); continue; }
    // Characters and bigrams both: a two-character name is one bigram, which two common bigrams
    // (咋样 + 样了) would outweigh; its two rare characters tip it back.
    for (let i = 0; i < r.length; i++) { out.push(r[i]); if (i + 2 <= r.length) out.push(r.slice(i, i + 2)); }
  }
  return out;
}

/** An incremental Okapi BM25 index (k1 1.2, b 0.75) over lexTokens. */
export function createBm25({ k1 = 1.2, b = 0.75 } = {}) {
  const docs = []; const df = new Map(); let total = 0;
  return {
    get size() { return docs.length; },
    add(text) {
      const toks = lexTokens(text); const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      docs.push({ tf, len: toks.length }); total += toks.length;
    },
    /** Scores for the documents `ids` (all when omitted). */
    score(query, ids = docs.map((_, i) => i)) {
      const n = docs.length; const avg = total / (n || 1);
      const terms = [...new Set(lexTokens(query))].map((t) => { const d = df.get(t) ?? 0; return { t, idf: d ? Math.log(1 + (n - d + 0.5) / (d + 0.5)) : 0 }; }).filter((x) => x.idf > 0);
      return ids.map((i) => {
        const d = docs[i]; let s = 0;
        for (const { t, idf } of terms) { const f = d.tf.get(t); if (f) s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg)); }
        return s;
      });
    },
  };
}

/**
 * Name groups (one person's names, or one name) the message mentions. A name counts from 2
 * characters on, so 他 / 阿 never match everything.
 */
export function namesIn(query, groups) {
  const q = String(query ?? '').toLowerCase();
  const out = [];
  for (const g of groups ?? []) {
    const names = [...new Set([].concat(g ?? []).map((n) => String(n ?? '').trim().toLowerCase()).filter((n) => [...n].length >= 2))];
    if (names.some((n) => q.includes(n))) out.push(names);
  }
  return out;
}

/** Reciprocal rank fusion: lists of keys, best first → [[key, score]] best first. */
export function rrf(lists, k = 60) {
  const m = new Map();
  for (const l of lists) l.forEach((key, r) => m.set(key, (m.get(key) ?? 0) + 1 / (k + r + 1)));
  return [...m].sort((a, b) => b[1] - a[1]);
}

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
export const settingsFile = () => join(dshHome(), 'dsh-memory.json');
const readSettings = () => { try { return existsSync(settingsFile()) ? JSON.parse(readFileSync(settingsFile(), 'utf8')) : {}; } catch { return {}; } };
// Holds API keys: owner-only, like dsh-qq.json.
function writeRecallSettings(patch) {
  const all = readSettings();
  const next = { ...all, recall: { ...(all.recall ?? {}), ...patch } };
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  try { chmodSync(settingsFile(), 0o600); } catch {}
  return next.recall;
}

const WHO = { owner: '他', her: '我', phone: '[手机]', note: '[我刚做的]', schedule: '[定时任务]' };
const p2 = (n) => String(n).padStart(2, '0');
const dateStamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_');
const mask = (k) => (k ? `${k.slice(0, 3)}…${k.slice(-4)}` : '');

/**
 * Transcript lines → one chunk per turn: whatever woke her, then what she said back. A new chunk
 * starts when something comes in after she has spoken, or the session changes. Secret lines are
 * dropped here, so they are neither embedded (nor sent to a cloud API) nor shown.
 */
export function chunkTurns(lines, maxChars = 1200) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    const text = String(l?.text ?? '').trim();
    const incoming = l?.who !== 'her';
    if (!cur || cur.session !== l.session || (incoming && cur.replied)) { cur = { at: l.at, end: l.at, session: l.session ?? '', lines: [], replied: false }; out.push(cur); }
    cur.end = l.at;
    if (!incoming) cur.replied = true;
    if (!text || rejectReason(text) === 'secret') continue;
    const to = l.who === 'her' && l.to && l.to !== 'owner' ? `（发给 ${l.to}）` : '';
    cur.lines.push(`${WHO[l.who] ?? l.who}${to}：${text.replace(/\s*\n+\s*/g, ' / ')}`);
  }
  return out.filter((c) => c.lines.length).map((c) => ({ at: c.at, end: c.end, session: c.session, text: clip(`[${dateStamp(c.at)}] ${c.lines.join('\n')}`, maxChars) }));
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (v) => { const n = Math.sqrt(dot(v, v)) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; };

/** One index on disk: vectors.f32 (n × dim, normalized) + meta.jsonl (one line per chunk). */
export function openIndex(dir) {
  const f = { vec: join(dir, 'vectors.f32'), meta: join(dir, 'meta.jsonl') };
  let meta = [], vecs = [], dim = 0;
  try {
    meta = readFileSync(f.meta, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    dim = meta[0]?.dim ?? 0;
    const buf = dim ? readFileSync(f.vec) : Buffer.alloc(0);
    const n = Math.min(meta.length, Math.floor(buf.length / (dim * 4)));
    const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * dim * 4));
    for (let i = 0; i < n; i++) vecs.push(all.subarray(i * dim, (i + 1) * dim));
    // A crash between the two appends leaves them uneven: keep the common prefix.
    if (n !== meta.length || buf.length !== n * dim * 4) { meta = meta.slice(0, n); rewrite(); }
  } catch { meta = []; vecs = []; }
  function rewrite() {
    mkdirSync(dir, { recursive: true });
    writeFileSync(f.meta, meta.map((m) => JSON.stringify(m)).join('\n') + (meta.length ? '\n' : ''));
    const all = new Float32Array(vecs.length * dim); vecs.forEach((v, i) => all.set(v, i * dim));
    writeFileSync(f.vec, Buffer.from(all.buffer));
  }
  return {
    dir,
    get size() { return meta.length; },
    get end() { return meta.at(-1)?.end ?? 0; },
    meta: () => meta,
    vecs: () => vecs,
    add(chunks, vectors) {
      if (!chunks.length) return;
      mkdirSync(dir, { recursive: true });
      const vs = vectors.map(norm);
      dim ||= vs[0].length;
      if (vs.some((v) => v.length !== dim)) throw new Error(`embedding size changed (${dim} → ${vs.find((v) => v.length !== dim).length}): /dot memory recall rebuild`);
      const rows = chunks.map((c) => ({ at: c.at, end: c.end, session: c.session, text: c.text, dim }));
      const all = new Float32Array(vs.length * dim); vs.forEach((v, i) => all.set(v, i * dim));
      appendFileSync(f.vec, Buffer.from(all.buffer));
      appendFileSync(f.meta, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      meta.push(...rows); vecs.push(...vs);
    },
    clear() { meta = []; vecs = []; dim = 0; rmSync(f.meta, { force: true }); rmSync(f.vec, { force: true }); },
  };
}

// ── backends ──

async function post(url, key, body, { tries = 3, timeoutMs = 30000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return res.json();
    if (attempt < tries && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** OpenAI-compatible embeddings + SiliconFlow/Jina-style or DashScope-native rerank. */
function cloudEmbedder(backend, { key, model, rerank, siliconflowUrl, dashscopeUrl }) {
  const ds = backend === 'dashscope';
  const base = (ds ? `${dashscopeUrl.replace(/\/$/, '')}/compatible-mode/v1` : siliconflowUrl.replace(/\/$/, ''));
  const batch = ds ? 10 : 32;
  return {
    async embed(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += batch) {
        const j = await post(`${base}/embeddings`, key, { model, input: texts.slice(i, i + batch), encoding_format: 'float' });
        for (const d of [...j.data].sort((a, b) => a.index - b.index)) out.push(Float32Array.from(d.embedding));
      }
      return out;
    },
    rerank: rerank && rerank !== 'none' ? async (query, docs, topN) => {
      if (ds) {
        const j = await post(`${dashscopeUrl.replace(/\/$/, '')}/api/v1/services/rerank/text-rerank/text-rerank`, key, { model: rerank, input: { query, documents: docs }, parameters: { top_n: topN, return_documents: false } });
        return j.output.results.map((r) => ({ index: r.index, score: r.relevance_score }));
      }
      const j = await post(`${base}/rerank`, key, { model: rerank, query, documents: docs, top_n: topN, return_documents: false });
      return j.results.map((r) => ({ index: r.index, score: r.relevance_score }));
    } : null,
  };
}

/**
 * transformers.js, from wherever it already is (installed next to this plugin) or from
 * $DSH_HOME/dsh-dot-recall, installing it there on first use. Never a dependency of the plugin.
 */
export const libDir = () => join(dshHome(), 'dsh-dot-recall');
function resolveTransformers() {
  for (const from of [import.meta.url, pathToFileURL(join(libDir(), 'package.json')).href]) {
    try { return createRequire(from).resolve('@huggingface/transformers'); } catch { /* next */ }
  }
  return '';
}
let installing = null;
function installTransformers(version, log) {
  installing ??= new Promise((resolve, reject) => {
    const dir = libDir();
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), '{ "private": true, "description": "dsh-dot memory recall: @huggingface/transformers, installed on first use" }\n');
    const win = process.platform === 'win32';
    log(`installing @huggingface/transformers@${version} into ${dir} (300–480 MB, once)`);
    const child = spawn(win ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--omit=dev', `@huggingface/transformers@${version}`], { cwd: dir, shell: win, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let tail = '';
    const keep = (d) => { tail = (tail + d).slice(-2000); try { appendFileSync(join(dir, 'install.log'), d); } catch {} };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('error', (err) => reject(new Error(`npm not runnable: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited ${code}: ${tail.trim().split('\n').at(-1) ?? ''}`))));
  }).finally(() => { installing = null; });
  return installing;
}

let tf = null;
async function localEmbedder({ model, mirror, install, version, log, onPhase }) {
  let entry = resolveTransformers();
  if (!entry) {
    if (!install) throw new Error('@huggingface/transformers is not installed (recallInstall is off)');
    onPhase('installing');
    await installTransformers(version, log);
    entry = resolveTransformers();
    if (!entry) throw new Error('installed, but @huggingface/transformers still cannot be resolved');
  }
  tf ??= await import(pathToFileURL(entry).href);
  // Models are fetched once into $DSH_HOME, from the mirror (hf-mirror.com unless set otherwise).
  tf.env.cacheDir = join(libDir(), 'models');
  tf.env.allowLocalModels = false;
  tf.env.remoteHost = `${mirror.replace(/\/+$/, '')}/`;
  const spec = SPECS[model] ?? { pooling: 'mean', query: '', passage: '' };
  // First use of a model: say so, it is the slow part (129 MB for the default) and recall is lexical meanwhile.
  let progress_callback;
  if (!existsSync(join(tf.env.cacheDir, model, 'onnx', 'model_quantized.onnx'))) {
    const size = spec.mb ? `~${spec.mb} MB` : 'size unknown';
    log(`recall: downloading ${model} (${size}, once) from ${mirror} into ${tf.env.cacheDir}; lexical recall until it is done`);
    onPhase(`downloading (${size})`);
    const t0 = Date.now();
    let pct = -1;
    progress_callback = (p) => {
      if (p?.status === 'progress_total' && Number.isFinite(p.progress) && Math.floor(p.progress) !== pct) { pct = Math.floor(p.progress); onPhase(`downloading (${size}) ${pct}%`); }
      if (p?.status === 'ready') log(`recall: ${model} downloaded in ${Math.round((Date.now() - t0) / 1000)} s`);
    };
  } else onPhase('loading');
  const ex = await tf.pipeline('feature-extraction', model, { dtype: 'q8', device: 'cpu', ...(progress_callback ? { progress_callback } : {}) });
  return {
    async embed(texts, role = 'passage') {
      const out = [];
      for (const t of texts) out.push(Float32Array.from((await ex((spec[role] ?? '') + t, { pooling: spec.pooling, normalize: true, truncation: true })).data));
      return out;
    },
    rerank: null,
  };
}

// ── the recall ──

/**
 * opts: { cfg (memory config: recall* keys), dir (<home>/memory), lines () → in-memory transcript
 * lines, transcriptFile, logger, audit, embedder? (backend, spec) → { embed, rerank } — tests/hosts,
 * names? () → name groups her memory knows ([[name, alias…], …]) for the names channel }
 */
export function createRecall({ cfg, dir, lines, transcriptFile, logger, audit = () => {}, embedder: makeEmbedder, names = () => [] }) {
  const saved = () => readSettings().recall ?? {};
  // Command-set values (dsh-memory.json) win over plugin config, so switching needs no restart or file edit.
  const backend = () => { const b = saved().backend ?? cfg.recallBackend; return BACKENDS.includes(b) ? b : 'local'; };
  const pick = (field, b, def) => saved()[field]?.[b] || (b === cfg.recallBackend && cfg[def]) || MODELS[b]?.[field === 'model' ? 'embed' : 'rerank'] || '';
  const model = (b = backend()) => { const m = pick('model', b, 'recallModel'); return b === 'local' ? (ALIASES[m] ?? m) : m; };
  const rerankModel = (b = backend()) => (b === 'local' ? 'none' : pick('rerank', b, 'recallRerankModel'));
  const keyOf = (b) => { const k = saved().keys?.[b]; if (k) return { key: k, from: 'dsh-memory.json' }; const e = process.env[KEY_ENV[b]]; return e ? { key: e, from: KEY_ENV[b] } : { key: '', from: '' }; };
  const mirror = () => saved().mirror || cfg.recallMirror || process.env.HF_ENDPOINT || 'https://hf-mirror.com';

  const indexes = new Map(); // `${backend}-${model}` → index
  const index = (b = backend()) => { const id = `${b}-${slug(model(b))}`; if (!indexes.has(id)) indexes.set(id, openIndex(join(dir, 'recall', id))); return indexes.get(id); };

  // Embedder per backend + model (+ mirror / key), loaded lazily. The local one can take minutes the
  // first time (install, download): nothing waits for that — queries go lexical meanwhile, and
  // indexing resumes once it is ready. A failure is retried after 10 minutes, or after a command.
  const emb = new Map(); // id → { phase, error, failedAt, ready, impl }
  const embId = (b) => `${b}|${model(b)}|${rerankModel(b)}|${b === 'local' ? mirror() : keyOf(b).key}`;
  function current(b = backend()) {
    if (b === 'off') return null;
    const id = embId(b);
    const old = emb.get(id);
    if (old && !(old.phase === 'error' && Date.now() - old.failedAt > 10 * 60000)) return old;
    const e = { phase: 'starting', error: '', failedAt: 0, impl: null };
    const spec = { model: model(b), rerank: rerankModel(b), mirror: mirror(), key: keyOf(b).key, siliconflowUrl: cfg.recallSiliconflowUrl, dashscopeUrl: cfg.recallDashscopeUrl };
    e.ready = (async () => {
      if (makeEmbedder) return makeEmbedder(b, spec);
      if (b === 'local') return localEmbedder({ ...spec, install: cfg.recallInstall, version: cfg.recallTransformersVersion, log: (m) => logger.info(m), onPhase: (p) => { e.phase = p; } });
      if (!spec.key) throw new Error(`no key: /dot memory recall key ${b} <key>, or set ${KEY_ENV[b]}`);
      return cloudEmbedder(b, spec);
    })().then((impl) => { e.impl = impl; e.phase = 'ready'; logger.info(`recall: ${b} ${spec.model} ready`); return impl; }, (err) => {
      Object.assign(e, { phase: 'error', error: err.message, failedAt: Date.now() });
      logger.warn(`recall: ${b} not available (${err.message}); lexical fallback`); audit('recall-unavailable', { backend: b, error: clip(err.message, 200) });
      return null;
    });
    emb.set(id, e);
    return e;
  }
  const forgetFailures = () => { for (const [k, v] of emb) if (v.phase === 'error') emb.delete(k); };
  /** The embedder if it is ready within `waitMs`, else null. */
  async function ready(b = backend(), waitMs = Infinity) {
    const e = current(b);
    if (!e || e.phase === 'error') return null;
    if (e.phase === 'ready') return e.impl;
    return waitMs === Infinity ? e.ready : Promise.race([e.ready, new Promise((r) => { setTimeout(r, waitMs, null).unref?.(); })]);
  }

  // ── indexing: up to the end of the last finished turn, incrementally; queued so runs never overlap ──
  let completeThrough = lines().at(-1)?.at ?? 0; // at boot every line on disk belongs to a finished turn
  let chain = Promise.resolve();
  function sync() {
    chain = chain.then(async () => {
      const b = backend();
      const e = current(b);
      if (!e || e.phase === 'error') return;
      if (e.phase !== 'ready') { if (!e.resume) { e.resume = true; void e.ready.then((x) => x && sync()); } return; }
      const ix = index(b);
      let src = lines();
      // The in-memory transcript is trimmed; a new or rebuilt index reads the whole file.
      if (!src.length || ix.end < src[0].at) { try { src = readFileSync(transcriptFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none yet */ } }
      const chunks = chunkTurns(src.filter((l) => l.at > ix.end && l.at <= completeThrough), cfg.recallChunkChars);
      for (let i = 0; i < chunks.length; i += 32) {
        const part = chunks.slice(i, i + 32);
        ix.add(part, await e.impl.embed(part.map((c) => c.text), 'passage'));
      }
      if (chunks.length > 8) logger.info(`recall: indexed ${chunks.length} turn(s) (${b}, ${ix.size} total)`);
    }).catch((err) => { logger.warn(`recall indexing failed: ${err.message}`); audit('recall-index-failed', { error: clip(err.message, 200) }); });
    return chain;
  }

  // BM25 over an index's chunks, caught up incrementally (rebuilt when the index was cleared or switched).
  let lexCache = null;
  function bm25For(ix) {
    const meta = ix.meta();
    if (!lexCache || lexCache.dir !== ix.dir || lexCache.n > meta.length) lexCache = { dir: ix.dir, n: 0, bm: createBm25() };
    for (; lexCache.n < meta.length; lexCache.n++) lexCache.bm.add(meta[lexCache.n].text);
    return lexCache.bm;
  }
  const LEX_TOP = 20;
  /**
   * The word channels over `pool` (chunks with .i into `bm`): BM25 hits that stand out (the same
   * contrast rule as the vectors), and turns that mention a name the message mentions. Lists of
   * pool positions, best first.
   */
  function wordLists(q, pool, bm) {
    const lists = [];
    if (cfg.recallLexical !== false && pool.length) {
      const sc = bm.score(q, pool.map((c) => c.i));
      const cut = Math.max(contrastCut(sc, Number(cfg.recallContrast) || 0), 1e-9);
      lists.push(sc.map((s, j) => ({ j, s })).filter((x) => x.s >= cut).sort((a, b) => b.s - a.s).slice(0, LEX_TOP).map((x) => x.j));
    }
    if (cfg.recallNames !== false && pool.length) {
      let groups = [];
      try { groups = namesIn(q, names()); } catch { groups = []; }
      if (groups.length) {
        const hit = pool.map((c, j) => ({ j, n: groups.filter((g) => g.some((n) => c.text.toLowerCase().includes(n))).length, at: c.at })).filter((x) => x.n > 0);
        lists.push(hit.sort((a, b) => b.n - a.n || b.at - a.at).slice(0, LEX_TOP).map((x) => x.j));
      }
    }
    return lists.filter((l) => l.length);
  }
  const rrfK = () => Number(cfg.recallRrfK) || 60;

  /** What to inject for `query` in `session`: { text, hits, mode, ms } (text '' when nothing). */
  let last = null;
  async function query(q, { session = '', record = true } = {}) {
    const t0 = performance.now();
    const b = backend();
    const res = { text: '', hits: [], mode: b, ms: 0 };
    q = clip(String(q ?? '').trim(), 500);
    // Off, nothing to search for, or a secret (which must not go to a cloud API either).
    if (b === 'off' || !q || rejectReason(q) === 'secret') return res;
    // Too little said to look anything up (好的 / 哈哈 / ok): nothing, not even lexically.
    if (queryLength(q) < (Number(cfg.recallMinQueryLength) || 0)) {
      res.mode = `${b}·short`;
      if (record) last = { at: Date.now(), ms: 0, mode: res.mode, hits: 0, query: clip(q, 40) };
      return res;
    }
    const impl = await ready(b, 50);
    if (impl) await sync();
    let picked;
    const N = Number(cfg.recallWindowTurns) || 0;
    // What she already sees: her whole current session (dsh keeps it in the window until the
    // handoff), or — for a host that shows only the last N turns — those N.
    const outside = (all) => (N > 0 ? all.slice(0, Math.max(0, all.length - N)) : all.filter((c) => c.session !== session));
    if (impl) {
      try {
        const ix = index(b);
        const pool = outside(ix.meta().map((m, i) => ({ ...m, i })));
        picked = [];
        if (pool.length) {
          const [qv] = (await impl.embed([q], 'query')).map(norm);
          const vecs = ix.vecs();
          let cand = pool.map((c, j) => ({ c, j, s: dot(qv, vecs[c.i]) }));
          const cut = impl.rerank ? -Infinity : contrastCut(cand.map((x) => x.s), Number(cfg.recallContrast) || 0);
          const floor = Number(cfg.recallMinScore) || -Infinity;
          cand.sort((x, y) => y.s - x.s);
          const words = wordLists(q, pool, bm25For(ix));
          if (impl.rerank) {
            // The reranker reads every channel's candidates; its score decides.
            const keys = rrf([cand.slice(0, cfg.recallCandidates).map((x) => x.j), ...words], rrfK()).slice(0, cfg.recallCandidates).map(([j]) => j);
            const r = await impl.rerank(q, keys.map((j) => pool[j].text), Math.min(cfg.recallTopK, keys.length));
            picked = r.map((x) => ({ c: pool[keys[x.index]], s: x.score })).filter((x) => x.s >= floor);
          } else {
            const vec = cand.filter((x) => x.s >= cut && x.s >= floor).slice(0, words.length ? LEX_TOP : cfg.recallTopK).map((x) => x.j);
            picked = words.length ? rrf([vec, ...words], rrfK()).slice(0, cfg.recallTopK).map(([j, s]) => ({ c: pool[j], s })) : vec.map((j) => ({ c: pool[j], s: cand.find((x) => x.j === j).s }));
          }
        }
      } catch (err) { logger.warn(`recall query failed (${err.message}); lexical this time`); picked = null; }
    }
    if (!picked) {
      // Not ready (installing, downloading, no key, failed, a cloud hiccup): the same turns, found by words.
      res.mode = `${b}→lexical`;
      const all = outside(chunkTurns(lines(), cfg.recallChunkChars)).map((c, i) => ({ ...c, i }));
      const bm = createBm25(); for (const c of all) bm.add(c.text);
      const words = wordLists(q, all, bm);
      picked = words.length ? rrf(words, rrfK()).slice(0, cfg.recallTopK).map(([j, s]) => ({ c: all[j], s })) : search(all, q, cfg.recallTopK).map((c, i) => ({ c, s: 1 - i / 100 }));
    }
    // Fit the budget by dropping the weakest, then show in time order.
    const budget = Number(cfg.recallMaxTokens) || Infinity;
    picked.sort((x, y) => y.s - x.s);
    let used = 0;
    picked = picked.filter((x) => { const n = estimateTokens(x.c.text); if (used + n > budget) return false; used += n; return true; });
    picked.sort((x, y) => x.c.at - y.c.at);
    res.hits = picked.map((x) => ({ at: x.c.at, score: Number(x.s.toFixed?.(3) ?? x.s), text: x.c.text }));
    res.text = picked.length ? [prompt('memory.recall.header'), ...picked.map((x) => x.c.text)].join('\n\n') : '';
    res.ms = Math.round(performance.now() - t0);
    if (record) last = { at: Date.now(), ms: res.ms, mode: res.mode, hits: res.hits.length, query: clip(q, 40) };
    return res;
  }

  // ── per-session result for the prompt: computed when the waking message arrives ──
  const results = new Map(); // session → { promise, text }
  function prepare(session, text) {
    const r = { text: '', done: false };
    r.promise = query(text, { session }).then((x) => { r.text = x.text; return x; }, (err) => { logger.warn(`recall query failed: ${err.message}`); return { text: '' }; }).finally(() => { r.done = true; });
    results.set(session, r);
    return r.promise;
  }

  function status() {
    const b = backend();
    const ix = b === 'off' ? null : index(b);
    const e = b === 'off' ? null : emb.get(embId(b));
    const k = KEY_ENV[b] ? keyOf(b) : null;
    const state = b === 'off' ? 'off' : !e ? 'not started' : e.phase === 'ready' ? 'ready' : e.phase === 'error' ? `unavailable: ${e.error} → lexical fallback` : `${e.phase} → lexical fallback meanwhile`;
    return { backend: b, model: b === 'off' ? '' : model(b), rerank: b === 'off' ? '' : rerankModel(b), state, ready: e?.phase === 'ready', turns: ix?.size ?? 0, indexedThrough: ix?.end ?? 0, lastQuery: last, mirror: b === 'local' ? mirror() : '', key: k ? (k.key ? `${mask(k.key)} (${k.from})` : 'none') : '', dir: ix?.dir ?? '' };
  }

  async function command(args) {
    const [verb, a, ...rest] = args;
    const fmt = () => {
      const s = status();
      const lq = s.lastQuery ? `last query ${s.lastQuery.ms} ms, ${s.lastQuery.hits} hit(s) via ${s.lastQuery.mode}` : 'no query yet';
      return [`recall: ${s.backend}${s.model ? ` · ${s.model}` : ''}${s.rerank && s.rerank !== 'none' ? ` + ${s.rerank}` : ''} · ${s.state}`,
        `index: ${s.turns} turn(s)${s.indexedThrough ? ` through ${dateStamp(s.indexedThrough)}` : ''} · ${lq} · top ${cfg.recallTopK}, ≤${cfg.recallMaxTokens} tokens${s.mirror ? ` · mirror ${s.mirror}` : ''}${s.key ? ` · key ${s.key}` : ''}`,
        '/dot memory recall backend <local|siliconflow|dashscope|off> | key <backend> <key> | model <name> | rerank <name|none> | mirror <url> | rebuild | test <一句话>'].join('\n');
    };
    if (!verb) return fmt();
    if (verb === 'backend') {
      if (!BACKENDS.includes(a)) return `backend: one of ${BACKENDS.join(', ')}`;
      writeRecallSettings({ backend: a }); forgetFailures(); audit('recall-backend', { backend: a });
      void sync();
      return `${fmt()}\n(switched; each backend keeps its own index, built in the background)`;
    }
    if (verb === 'key') {
      if (!KEY_ENV[a] || !rest[0]) return 'usage: /dot memory recall key <siliconflow|dashscope> <key>   ("-" removes it)';
      const keys = { ...(saved().keys ?? {}) };
      if (rest[0] === '-') delete keys[a]; else keys[a] = rest[0];
      writeRecallSettings({ keys }); forgetFailures(); audit('recall-key', { backend: a, set: rest[0] !== '-' });
      if (backend() === a) void sync();
      return `${a} key ${rest[0] === '-' ? 'removed' : `saved (${mask(rest[0])}) to ${settingsFile()}`}\n${fmt()}`;
    }
    if (verb === 'model' || verb === 'rerank') {
      const b = backend();
      if (b === 'off') return 'recall is off: /dot memory recall backend <…> first';
      if (verb === 'rerank' && b === 'local') return 'local has no reranker (it scored 85/108 without one); rerank is for siliconflow / dashscope';
      if (!a) return fmt();
      const field = verb;
      const cur = { ...(saved()[field] ?? {}) };
      if (a === 'default') delete cur[b]; else cur[b] = a;
      writeRecallSettings({ [field]: cur }); forgetFailures(); audit('recall-model', { backend: b, [field]: a });
      void sync();
      return `${fmt()}\n(a new model gets its own index, built in the background; the old one is kept)`;
    }
    if (verb === 'mirror') {
      if (!a) return `mirror: ${mirror()}`;
      if (a !== 'default' && !/^https?:\/\/\S+$/.test(a)) return 'mirror: an http(s) URL, or "default"';
      writeRecallSettings({ mirror: a === 'default' ? '' : a }); forgetFailures();
      void sync();
      return `mirror: ${mirror()} (used for the next model download)`;
    }
    if (verb === 'rebuild') {
      if (backend() === 'off') return 'recall is off';
      index().clear(); forgetFailures(); audit('recall-rebuild', { backend: backend() });
      await sync();
      return `rebuilt\n${fmt()}`;
    }
    if (verb === 'test') {
      const q = [a, ...rest].join(' ');
      if (!q) return 'usage: /dot memory recall test <一句话>';
      // As if this came in now from a session she is not in: nothing is excluded as "in the window".
      const r = await query(q, { session: '\u0000test', record: false });
      return `${r.mode} · ${r.ms} ms · ${r.hits.length} hit(s)\n\n${r.hits.map((h) => `(${h.score}) ${h.text}`).join('\n\n') || '（没翻到）'}`;
    }
    return `unknown: recall ${verb}\n${fmt()}`;
  }

  return {
    sync, query, prepare, status, command,
    /** Wait until the backend is usable (install / download / key check) and the index caught up. */
    async warm() { const ok = Boolean(await ready()); await sync(); return ok; },
    /** A turn of hers ended: every transcript line so far belongs to a finished turn. */
    turnEnded() { completeThrough = Date.now(); void sync(); },
    /** What her prompt shows now for `session` ('' when nothing or not ready yet). */
    textFor: (session) => results.get(session)?.text ?? '',
    /** The in-flight query for `session`, if any (prompt assembly waits for it, bounded). */
    pending: (session) => { const r = results.get(session); return r && !r.done ? r.promise : null; },
    clear: (session) => results.delete(session),
    backend,
  };
}
