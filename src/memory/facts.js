// dsh-dot/memory/facts: one sentence per thing worth keeping, with the situations it should come to
// mind in. The turns stay the record; a fact is a key to them that is written in the words of the
// moment it will be needed, which his later message can match when the turn itself would not.
//
//   written   when a batch of records is consolidated: one call reads his lines of that batch and
//             returns lines `MM-DD HH:MM｜the fact｜situation；situation`. Appended to facts.jsonl,
//             never rewritten. The days a fact speaks of (明天, 27号 …) are worked out by when.js.
//   indexed   each fact's sentence and each of its situations get a vector from the recall embedder
//             (kept beside the recall index, per backend + model) and go into two BM25 tables.
//   shown     when he wakes her: three ranked lists — how near a fact's day is to now, his words
//             against the facts (cosine + BM25), his words against the situations (cosine + BM25) —
//             fused by rank; the first `factsShown` go to one model call that names the ones that
//             bear on what he said; up to `factsPicked` of them are put in her prompt as lines.
//
// Measured on chat-memory-benchmark 2.2 (docs/MEMORY-ROOT-CAUSES.md, 2026-11-16 / 17).
import { readJsonl } from '../fsstore.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createBm25, openIndex } from './recall.js';
import { annotate } from './when.js';
import { dayMark, stamp } from '../clock.js';
import { prompt } from '../prompts.js';
import { head } from '../cut.js';

const DAY = 86400000;
const clip = (s, n) => (s.length > n ? `${head(s, n)}…` : s);
const dotp = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** The days (local midnight, ms) a sentence said at `at` speaks of, by when.js's own reading. */
export function daysOf(text, at) {
  const said = new Date(at);
  return [...annotate(String(text), at).matchAll(/（=(?:(\d{4})-)?(\d{2})-(\d{2})）/g)].map((m) => {
    if (m[1]) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    let d = new Date(said.getFullYear(), Number(m[2]) - 1, Number(m[3])).getTime();
    if (d < at - 200 * DAY) d = new Date(said.getFullYear() + 1, Number(m[2]) - 1, Number(m[3])).getTime();
    return d;
  });
}

/** The write call's reply → [{ at, text, when }]: lines `MM-DD HH:MM｜fact｜situation；situation`. */
export function parseFacts(raw, stamps, fallbackAt) {
  const out = [];
  for (const line of String(raw ?? '').split('\n')) {
    const m = /^\s*[-*]?\s*\[?((?:\d{4}-)?\d{2}-\d{2} \d{2}:\d{2})\]?\s*[｜|]\s*(.+?)\s*[｜|]\s*(.+)$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    const when = m[3].split(/[；;]/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
    if (text.length < 4 || !when.length) continue;
    out.push({ at: stamps.get(m[1]) ?? fallbackAt, text: clip(text, 160), when: when.map((w) => clip(w, 40)) });
  }
  return out;
}

/** Reciprocal-rank fusion (k 60) of lists of fact indexes, best first. */
export function fuse(lists, take = 100) {
  const score = new Map();
  for (const l of lists) l.slice(0, take).forEach((i, r) => score.set(i, (score.get(i) ?? 0) + 1 / (60 + r + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
}

/** Facts whose day is within three days back to fourteen ahead of `now`, the nearest first. */
export function nearInTime(facts, now) {
  const out = [];
  facts.forEach((f, i) => {
    const near = (f.days ?? []).filter((d) => d >= now - 3 * DAY && d <= now + 14 * DAY).map((d) => Math.abs(d - now));
    if (near.length) out.push([Math.min(...near), i]);
  });
  return out.sort((a, b) => a[0] - b[0]).map(([, i]) => i);
}

/** The numbers after "编号" in the pick call's reply, in order, each once. */
export function parsePick(raw, n) {
  const tail = String(raw ?? '').split('编号').at(-1);
  return [...new Set([...tail.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((i) => i >= 1 && i <= n))];
}

/**
 * opts: { cfg (facts, factsShown, factsPicked), dir (<home>/memory), recall (embed, indexId),
 * complete (text, reason, { foreground }) → { raw }, lines () → transcript lines, logger, audit }
 */
export function createFacts({ cfg, dir, recall, complete, lines, logger, audit = () => {} }) {
  const file = join(dir, 'facts.jsonl');
  let facts = [];
  { const got = readJsonl(file); facts = got.rows; if (got.bad) logger?.warn?.(`facts: ${got.bad} unreadable line(s) skipped`); }
  const on = () => cfg.facts !== false;

  // ── the index: rows { at: fact index, end: 0 for the sentence / 1… for a situation, text } ──
  const indexes = new Map();
  const index = () => { const id = recall.indexId(); if (!indexes.has(id)) indexes.set(id, openIndex(join(dir, 'facts', id))); return indexes.get(id); };
  const lex = { n: 0, text: createBm25(), when: createBm25() };
  function lexUp() {
    for (; lex.n < facts.length; lex.n++) { lex.text.add(facts[lex.n].text); lex.when.add(facts[lex.n].when.join(' ')); }
  }
  let chain = Promise.resolve();
  /** Vectors for the facts the index does not hold yet (the embedder may still be loading: then later). */
  function sync() {
    chain = chain.then(async () => {
      const ix = index();
      const from = ix.size ? ix.meta().at(-1).at + 1 : 0;
      for (let i = from; i < facts.length; i += 16) {
        const part = facts.slice(i, i + 16);
        const rows = part.flatMap((f, k) => [{ at: i + k, end: 0, session: 'f', text: f.text }, ...f.when.map((w, j) => ({ at: i + k, end: j + 1, session: 'f', text: w }))]);
        const a = await recall.embed(rows.filter((r) => r.end === 0).map((r) => r.text), 'passage');
        const b = await recall.embed(rows.filter((r) => r.end > 0).map((r) => r.text), 'query', 'index');
        if (!a || !b) return; // no embedder now: BM25 and the days carry it until there is one
        let x = 0, y = 0;
        ix.add(rows, rows.map((r) => (r.end === 0 ? a[x++] : b[y++])));
      }
    }).catch((err) => { logger.warn(`facts indexing failed: ${err.message}`); });
    return chain;
  }

  // ── written at consolidation ──
  /** One call over his lines of a consolidated batch; the facts it returns are appended. */
  async function write(batch) {
    if (!on()) return { skipped: 'off' };
    const his = batch.filter((l) => l.who === 'owner' && l.text);
    if (!his.length) return { skipped: 'nothing of his' };
    const now = batch.at(-1).at;
    const stamps = new Map();
    const records = his.map((l) => { const s = stamp(l.at, now); if (!stamps.has(s)) stamps.set(s, l.at); return `[${s}] ${l.text}`; }).join('\n');
    const r = await complete(prompt('memory.facts.write', { records }), 'facts');
    if (typeof r?.raw !== 'string') return r ?? { error: 'no reply' };
    const fresh = parseFacts(r.raw, stamps, his.at(-1).at).map((f) => ({ ...f, days: daysOf(f.text, f.at) }));
    if (fresh.length) {
      try { mkdirSync(dir, { recursive: true }); appendFileSync(file, fresh.map((f) => JSON.stringify(f)).join('\n') + '\n'); } catch (err) { logger.warn(`facts write failed: ${err.message}`); }
      facts.push(...fresh);
      void sync();
    }
    audit('facts-written', { lines: his.length, facts: fresh.length });
    return { ok: true, facts: fresh.length };
  }

  // ── shown when he wakes her ──
  /** The first `n` facts for his words at `now`, by the three fused lists. */
  async function shortlist(text, now, n) {
    lexUp();
    const N = facts.length;
    if (!N) return [];
    const byScore = (sc) => sc.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).slice(0, 100).map(([, i]) => i);
    const topic = [byScore(lex.text.score(text))], trig = [byScore(lex.when.score(text))];
    await chain;
    const ix = index();
    const q = ix.size ? await recall.embed([text], 'query') : null;
    if (q) {
      const meta = ix.meta(), vecs = ix.vecs();
      const t = new Float32Array(N).fill(-1), w = new Float32Array(N).fill(-1);
      for (let r = 0; r < meta.length; r++) {
        const f = meta[r].at; if (f >= N) continue;
        const s = dotp(q[0], vecs[r]);
        if (meta[r].end === 0) t[f] = s; else if (s > w[f]) w[f] = s;
      }
      const top = (a) => Array.from(a, (s, i) => [s, i]).filter(([s]) => s > -1).sort((x, y) => y[0] - x[0]).slice(0, 100).map(([, i]) => i);
      topic.push(top(t)); trig.push(top(w));
    }
    return fuse([nearInTime(facts, now), fuse(topic), fuse(trig)]).slice(0, n).map((i) => facts[i]);
  }

  const results = new Map(); // session → { promise, text, done }
  let held = false;
  /** Work out what to show for `session` on his `text`; the prompt assembly waits for `pending`. */
  function prepare(session, text, { force = false, now = Date.now() } = {}) {
    if (!on() || (held && !force) || !String(text ?? '').trim()) return null;
    const r = { text: '', done: false, picked: [] };
    r.promise = (async () => {
      const shown = (await shortlist(String(text), now, Number(cfg.factsShown) || 60)).sort((a, b) => a.at - b.at);
      if (!shown.length) return r;
      const recent = lines().filter((l) => (l.who === 'owner' || l.who === 'her') && l.at < now).slice(-12).map((l) => `${l.who === 'owner' ? '他' : '你'}：${clip(l.text, 300)}`).join('\n');
      const ask = prompt('memory.facts.pick', { facts: shown.map((f, i) => `${i + 1}. [${dayMark(f.at, now)}] ${f.text}`).join('\n'), recent: recent || '（没有）', now: stamp(now, now), said: clip(String(text), 600) });
      const reply = await complete(ask, 'facts-pick', { foreground: true });
      if (typeof reply?.raw !== 'string') return r;
      r.picked = parsePick(reply.raw, shown.length).slice(0, Number(cfg.factsPicked) || 6).map((i) => shown[i - 1]);
      if (r.picked.length) r.text = `${prompt('memory.facts.header')}\n${r.picked.map((f) => `- [${dayMark(f.at, now)}] ${f.text}`).join('\n')}`;
      return r;
    })().catch((err) => { logger.warn(`facts pick failed: ${err.message}`); return r; }).finally(() => { r.done = true; });
    results.set(session, r);
    return r.promise;
  }

  return {
    write, prepare, sync, shortlist,
    get size() { return facts.length; },
    /** Replayed history: his old messages wake nothing (bench adapters). */
    hold(v) { held = Boolean(v); },
    textFor: (session) => results.get(session)?.text ?? '',
    pending: (session) => { const r = results.get(session); return r && !r.done ? r.promise : null; },
    clear: (session) => results.delete(session),
  };
}
