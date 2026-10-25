// dsh-dot/memory/store: what she remembers, as plain data and pure rules (no ctx, no model).
//
// Three kinds of memory, after three projects:
//   banks      — Hermes (NousResearch hermes-agent; ported in dsh-hermes-memory, MIT): two bounded
//                lists of short entries, `owner` (what she knows about you) and `self` (her own notes),
//                edited by add / replace / remove under a character budget.
//   people     — one card per person she meets, keyed by platform identity. Counts and "last seen"
//                are written by code from real events; impressions and facts by the model. Three
//                tiers: owner, talked (exchanged messages), seen (only interacted with their posts:
//                counts and a one-line impression, no facts). Facts about anyone but you wait in
//                `pending` until they are said again or approved.
//   fragments  — dsh-whale-inurqq (FABAGV, MIT): small events with a tag (0/1/2), refs that grow
//                each time the same thing is said again, pinning, aging per generation, and a
//                byte-stable selection under a token budget.
// Text similarity is whale's: normalised characters, 3-gram Jaccard (works for Chinese without a
// tokenizer).

export const MEMORY_VERSION = 1;

export const DEFAULT_LIMITS = Object.freeze({ owner: 1375, self: 2200, person: 400, impression: 40 });

// ── text ─────────────────────────────────────────────────────────────────────

export function normText(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, '').replace(/[，。、；：？！,.;:?!"'“”‘’()（）[\]【】《》<>~～—\-…·]/g, '');
}

export function shingles(norm) {
  const s = String(norm ?? '');
  const out = new Set();
  if (s.length <= 3) { if (s) out.add(s); return out; }
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : shingles(normText(a));
  const B = b instanceof Set ? b : shingles(normText(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A.size <= B.size ? A : B) if ((A.size <= B.size ? B : A).has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Character-bigram Jaccard: looser than the 3-gram one, for "is this the same fact said again"
 * about one person (Chinese paraphrases share bigrams far more than trigrams).
 */
export function similar2(a, b) {
  const grams = (t) => { const s = normText(t); const out = new Set(); for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2)); if (s.length < 2 && s) out.add(s); return out; };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Chinese runs ~1.4–1.6 characters per token; estimate conservatively. */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 1.5);

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// ── quality gate (after molly-qq-whale's memory gate, the rules that matter here) ──────────────

const META = /(系统提示|提示词|system prompt|token|上下文|DOT_SILENT|调用了|工具调用|交接记录|作为(一个)?AI|语言模型|我会记住|已记录|记忆库)/i;
const VACUOUS = /^(他|她|对方|用户)?(说)?(无所谓|随便|没什么|还行|一般|不知道|嗯|哦|好的?)[。.!！]?$/;

// Passwords and keys never enter memory: memory is shown to every turn. (Phone numbers and one-time
// verification codes are ordinary facts and stay.)
const SECRET = /(密码|口令|password|passwd|passcode|api[ _-]?key|access[ _-]?key|secret[ _-]?key|token|私钥|助记词|seed phrase)/i;

/** Why a remembered line should not be kept, or '' when it is fine. */
export function rejectReason(text) {
  const t = String(text ?? '').trim();
  if (SECRET.test(t)) return 'secret';
  if (normText(t).length < 4) return 'too-short';
  if (META.test(t)) return 'meta';
  if (VACUOUS.test(t)) return 'vacuous';
  return '';
}

// ── banks (Hermes) ────────────────────────────────────────────────────────────

const bankSize = (entries) => entries.reduce((n, e) => n + e.length + 1, 0);

/**
 * One Hermes-style operation on a bank. Returns { ok, entries } or { ok: false, error }.
 * replace/remove match by a short unique substring (oldText).
 */
export function bankOp(entries, op, limit) {
  const list = [...(entries ?? [])];
  const content = String(op?.content ?? '').trim();
  const old = String(op?.oldText ?? '').trim();
  const find = () => {
    if (!old) return { error: 'oldText is required' };
    const hits = list.map((e, i) => (e.includes(old) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 0) return { error: `no entry contains "${old}"` };
    if (hits.length > 1) return { error: `"${old}" matches ${hits.length} entries; use a longer piece` };
    return { index: hits[0] };
  };
  if (op?.action === 'add') {
    if (!content) return { ok: false, error: 'content is required' };
    const why = rejectReason(content);
    if (why) return { ok: false, error: `not kept (${why})` };
    if (list.some((e) => normText(e) === normText(content) || jaccard(e, content) >= 0.82)) return { ok: true, entries: list, note: 'already there' };
    list.push(content);
  } else if (op?.action === 'replace') {
    const f = find(); if (f.error) return { ok: false, error: f.error };
    if (!content) return { ok: false, error: 'content is required (use remove to delete)' };
    list[f.index] = content;
  } else if (op?.action === 'remove') {
    const f = find(); if (f.error) return { ok: false, error: f.error };
    list.splice(f.index, 1);
  } else return { ok: false, error: `unknown action ${op?.action}` };
  if (bankSize(list) > limit) return { ok: false, error: `over the limit (${bankSize(list)}/${limit} chars): replace overlapping entries with shorter ones, or remove stale ones, then retry` };
  return { ok: true, entries: list };
}

export const bankUsage = (entries, limit) => `${bankSize(entries ?? [])}/${limit} chars`;

// ── people ────────────────────────────────────────────────────────────────────

const TIER_RANK = { seen: 0, talked: 1, owner: 2 };

/** A person's id: "<platform>:<handle>". Handles without a stable number use "name:<display name>". */
export function personId(platform, handle) {
  const p = String(platform ?? '').trim().toLowerCase() || 'unknown';
  const h = String(handle ?? '').trim();
  return `${p}:${h}`;
}

/** Find a person by id, or by one of their names (exact). */
export function findPerson(people, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  if (people[key]) return people[key];
  const byName = Object.values(people).filter((p) => p.names.includes(key) || p.names.includes(key.replace(/^.*?:name:/, '')));
  return byName.length === 1 ? byName[0] : null;
}

/**
 * A real event involving a person, written by code: counts, last seen, names, tier.
 * kind: dm | group | reply | comment | like | follow | sent | mention.
 */
export function touchPerson(people, { id, name = '', platform = '', tier = 'talked', kind = 'dm', at = Date.now() }) {
  if (!id) return null;
  const p = people[id] ?? (people[id] = { id, platform: platform || id.split(':')[0], names: [], tier, firstSeen: at, lastSeen: at, counts: {}, impression: '', facts: [] });
  const n = String(name ?? '').trim();
  if (n && !p.names.includes(n)) p.names = [n, ...p.names].slice(0, 6);
  if ((TIER_RANK[tier] ?? 0) > (TIER_RANK[p.tier] ?? 0)) p.tier = tier;
  p.counts[kind] = (p.counts[kind] ?? 0) + 1;
  p.lastSeen = Math.max(p.lastSeen ?? 0, at);
  return p;
}

const COUNT_LABEL = { dm: '私聊', group: '群里说话', sent: '你发给他', reply: '回复', comment: '评论', like: '点赞', follow: '关注', mention: '提到' };

function ago(ms) {
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d} 天前`;
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? `${h} 小时前` : '刚才';
}

/** One person, as she remembers them (used in the message that wakes her about them). */
export function renderPerson(p, now = Date.now()) {
  if (!p) return '';
  const name = p.names[0] || p.id;
  const counts = Object.entries(p.counts).filter(([, v]) => v > 0).map(([k, v]) => `${COUNT_LABEL[k] ?? k} ${v} 次`).join('，');
  const head = `${name}（${p.id}${p.names.length > 1 ? `，也叫 ${p.names.slice(1).join('/')}` : ''}）：${p.tier === 'seen' ? '只在帖子里打过交道' : '聊过'}${counts ? `；${counts}` : ''}；上次 ${ago(now - (p.lastSeen ?? now))}`;
  const lines = [head];
  if (p.impression) lines.push(`  印象：${p.impression}`);
  for (const f of p.tier === 'seen' ? [] : p.facts) lines.push(`  - ${f}`);
  return lines.join('\n');
}

/**
 * The model's view of a person after a consolidation: an impression, facts. Owner facts go to the
 * owner bank instead. Facts about others are held in `pending` until restated or approved.
 */
export function updatePerson(memory, u, { limits = DEFAULT_LIMITS, now = Date.now() } = {}) {
  const p = findPerson(memory.people, u?.id) ?? findPerson(memory.people, u?.name);
  if (!p || p.tier === 'owner') return { applied: 0, pending: 0 };
  let applied = 0, pending = 0;
  const imp = String(u?.impression ?? '').trim();
  if (imp && !rejectReason(imp)) { p.impression = imp.slice(0, limits.impression); applied++; }
  if (p.tier === 'seen') return { applied, pending };
  for (const raw of [].concat(u?.facts ?? [])) {
    const fact = String(raw ?? '').trim();
    if (!fact || rejectReason(fact)) continue;
    if (p.facts.some((f) => similar2(f, fact) >= 0.6)) continue;
    const again = memory.pending.findIndex((x) => x.person === p.id && similar2(x.text, fact) >= 0.3);
    if (again >= 0) {
      // Said a second time: it is kept.
      memory.pending.splice(again, 1);
      if (bankSize([...p.facts, fact]) <= limits.person) { p.facts.push(fact); applied++; }
      continue;
    }
    memory.pending.push({ id: `p${(memory.seq = (memory.seq ?? 0) + 1)}`, person: p.id, text: fact, at: now });
    pending++;
  }
  memory.pending = memory.pending.slice(-200);
  return { applied, pending };
}

/** Approve a pending fact (by its id): it joins the person's card if there is room. */
export function approvePending(memory, id, limits = DEFAULT_LIMITS) {
  const i = memory.pending.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: `no pending ${id}` };
  const [item] = memory.pending.splice(i, 1);
  const p = memory.people[item.person];
  if (!p) return { ok: false, error: `no person ${item.person}` };
  if (bankSize([...p.facts, item.text]) > limits.person) { memory.pending.splice(i, 0, item); return { ok: false, error: `${p.id}'s card is full (${limits.person} chars)` }; }
  p.facts.push(item.text);
  return { ok: true, person: p.id };
}

// ── fragments (whale) ─────────────────────────────────────────────────────────

export const FRAGMENT_KINDS = ['event', 'plan', 'promise', 'preference', 'fact'];
const MAX_IMPORTANCE = 9;

/** Add a fragment, or count it again when it is already there (refs + 1, importance + tag). */
export function observeFragment(memory, { text, tag, kind, mergeWith, gen, now = Date.now() }) {
  const body = String(text ?? '').trim();
  const t = Number(tag);
  if (!body || !Number.isInteger(t) || t < 0 || t > 2 || rejectReason(body)) return { action: 'dropped' };
  const norm = normText(body);
  const hash = fnv1a(norm);
  const list = memory.fragments;
  let hit = list.find((f) => f.hash === hash) ?? (mergeWith ? list.find((f) => f.id === mergeWith) : null);
  if (!hit) {
    let best = null, sim = 0;
    for (const f of list) { const s = jaccard(f.text, body); if (s > sim) { sim = s; best = f; } }
    if (best && sim >= 0.82) hit = best;
  }
  if (hit) {
    hit.refs += 1;
    hit.importance = Math.min(MAX_IMPORTANCE, hit.importance + t);
    hit.lastSeenAt = now; hit.lastSeenGen = gen;
    if (body.length > hit.text.length) { hit.text = body; hit.hash = hash; }
    return { action: 'dup', id: hit.id };
  }
  const id = `f${String((memory.fseq = (memory.fseq ?? 0) + 1)).padStart(4, '0')}`;
  list.push({ id, text: body, hash, kind: FRAGMENT_KINDS.includes(kind) ? kind : 'event', importance: t, refs: 1, pinned: false, createdAt: now, lastSeenAt: now, lastSeenGen: gen });
  return { action: 'new', id };
}

/** Every `every` generations: unpinned fragments not seen for 5 lose 1 importance; 0/1-ref ones unseen for 10 go. */
export function ageFragments(memory, gen, every = 5) {
  if (gen <= 0 || gen % Math.max(1, every) !== 0) return { decayed: 0, dropped: 0 };
  let decayed = 0;
  for (const f of memory.fragments) if (!f.pinned && f.importance > 0 && (f.lastSeenGen ?? 0) <= gen - 5) { f.importance--; decayed++; }
  const before = memory.fragments.length;
  memory.fragments = memory.fragments.filter((f) => f.pinned || !(f.importance === 0 && f.refs === 1 && (f.lastSeenGen ?? 0) <= gen - 10));
  return { decayed, dropped: before - memory.fragments.length };
}

/** pinned → importance → refs → lastSeenAt → id: a total order, so the rendered text is byte-stable. */
export function compareFragments(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
  if (b.importance !== a.importance) return b.importance - a.importance;
  if (b.refs !== a.refs) return b.refs - a.refs;
  if ((b.lastSeenAt ?? 0) !== (a.lastSeenAt ?? 0)) return (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
  return a.id.localeCompare(b.id);
}

export function selectFragments(fragments, budgetTokens) {
  const picked = [];
  let used = 0;
  for (const f of [...fragments].sort(compareFragments)) {
    const cost = estimateTokens(f.text);
    if (used + cost > budgetTokens) break;
    picked.push(f); used += cost;
  }
  return picked;
}

// ── the whole thing ───────────────────────────────────────────────────────────

export function emptyMemory() {
  return { version: MEMORY_VERSION, gen: 1, seq: 0, fseq: 0, owner: [], self: [], people: {}, pending: [], fragments: [], cursor: 0, consolidations: 0 };
}

export function normalizeMemory(m) {
  const e = emptyMemory();
  if (!m || typeof m !== 'object') return e;
  return { ...e, ...m, owner: [...(m.owner ?? [])], self: [...(m.self ?? [])], people: { ...(m.people ?? {}) }, pending: [...(m.pending ?? [])], fragments: [...(m.fragments ?? [])] };
}

/**
 * What every turn of hers sees: you, her own notes, what still matters. Byte-stable for the same
 * memory (no clocks, no counters), because a context snapshot is re-sent only when its text changes.
 */
export function renderStanding(memory, { budgetTokens = 600 } = {}) {
  const parts = [];
  if (memory.owner.length) parts.push(`## 关于他\n${memory.owner.map((e) => `- ${e}`).join('\n')}`);
  if (memory.self.length) parts.push(`## 你自己记下的\n${memory.self.map((e) => `- ${e}`).join('\n')}`);
  const picked = selectFragments(memory.fragments, budgetTokens);
  if (picked.length) parts.push(`## 最近的事（越靠前越要紧）\n${picked.map((f) => `- ${f.pinned ? '📌' : ''}${f.text}`).join('\n')}`);
  if (!parts.length) return '';
  return ['<memory>', '这是你自己记得的事，不是谁发来的消息。别复述、别说"根据记忆"，当作本来就知道。', ...parts, '</memory>'].join('\n');
}

/** Lines matching a query (character bigrams), for the recall tool. */
export function search(items, query, limit = 8) {
  const q = normText(query);
  if (!q) return [];
  const grams = new Set();
  for (let i = 0; i + 2 <= q.length; i++) grams.add(q.slice(i, i + 2));
  if (q.length < 2) grams.add(q);
  const scored = [];
  for (const item of items) {
    const t = normText(item.text);
    let s = 0;
    for (const g of grams) if (t.includes(g)) s++;
    if (s > 0) scored.push({ item, s: s / grams.size });
  }
  return scored.sort((a, b) => b.s - a.s || (b.item.at ?? 0) - (a.item.at ?? 0)).slice(0, limit).map((x) => x.item);
}
