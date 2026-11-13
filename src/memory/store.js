// dsh-dot/memory/store: what she remembers, as plain data and pure rules (no ctx, no model).
//
// The words she said and heard are the evidence (transcript + recall.js); what is kept here is only
// what stays true, small enough to be in front of her every turn:
//   banks      — Hermes (NousResearch hermes-agent; ported in dsh-hermes-memory, MIT): bounded lists
//                of short entries edited by add / replace / remove under a character budget.
//                `owner` (what she knows about you) and `self` (her own notes).
//   open       — 还没了的事: things planned, promised or put off that have no outcome yet. One item
//                each (what, when it was said, a due date). Done or called off → removed; code lets
//                the rest go by themselves: a few days past the due date, or long untouched without
//                one (the words stay in the transcript and the recall index). All live items are
//                kept; the budget only limits how many are shown, and what is due comes first.
//   people     — one registry for everyone she meets in any app; a person has many handles. Counts
//                and "last seen" are written by code from real events, a one-line impression by the
//                model. Tiers: owner, talked (exchanged messages), seen (only their posts), contact
//                (on a friend list, never talked to). What someone said or did is in the words, not
//                on the card.
// Text similarity is whale's (dsh-whale-inurqq, FABAGV, MIT): normalised characters, 3-gram Jaccard.
import { table } from '../prompts.js';
import { dayMark } from '../clock.js';
import { daysBetween } from './when.js';

export const MEMORY_VERSION = 2;

// Characters per bank; `open` is 还没了的事 as shown (a display budget, not storage), `impression` one person's line.
export const DEFAULT_LIMITS = Object.freeze({ owner: 1375, self: 2200, open: 800, impression: 80 });

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

/** Chinese runs ~1.4–1.6 characters per token; estimate conservatively. */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 1.5);

// ── quality gate (after molly-qq-whale's memory gate, the rules that matter here) ──────────────

// Lines about the plumbing (her silence marker, tool calls, handoff notes, "as an AI") are not
// memories. "token", "上下文", "提示词", "系统提示" are NOT in this list: the owner's own work is
// about agents and context windows, and a fact about him that mentions them is still a fact.
const META = /(DOT_SILENT|调用了.{0,12}工具|工具调用|交接记录|作为(一个)?AI|语言模型|我会记住|已记录|记忆库)/i;
const VACUOUS = /^(他|她|对方|用户)?(说)?(无所谓|随便|没什么|还行|一般|不知道|嗯|哦|好的?)[。.!！]?$/;

// Passwords and keys never enter memory: memory is shown to every turn. (Phone numbers and one-time
// verification codes are ordinary facts and stay.) "token" alone is not a secret — a sentence about
// token usage is ordinary talk; a secret token is one named as a credential, or one that looks like one.
const SECRET = /(密码|口令|密钥|令牌|password|passwd|passcode|api[ _-]?key|(access|secret|private|app|client)[ _-]?(key|secret)|(access|refresh|bearer|auth|session|github|gitlab|bot|api|personal access)[ _-]?token|私钥|助记词|seed phrase|\b(sk|ghp|gho|ghu|ghs|glpat|xox[abpr]|AKIA)[-_][A-Za-z0-9_-]{6,})/i;

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

// ── people: one registry for everyone she meets, in any app ────────────────────
//
// A person has an internal id (u0001…) and any number of handles — "<platform>:<uid>" when the app
// gives a stable number, "<platform>:name:<display name>" when all it shows is a name (a phone
// notification title, a post author). Every channel resolves through the same registry, so the
// same person reaching her by QQ on her computer, QQ on her phone, or a post on 小黑盒 lands on one
// card. A person first met twice under different handles may get two cards; they are merged once
// anything shows they are the same person (a friend list, the model noticing, or you).
// "Owner" is a tier on a person, not a separate notion. A card says who someone is and how she knows
// them; what they said or did is found in the words (recall).

const TIER_RANK = { contact: 0, seen: 1, talked: 2, owner: 3 };
const higherTier = (a, b) => ((TIER_RANK[a] ?? 0) >= (TIER_RANK[b] ?? 0) ? a : b);

/** A handle: "<platform>:<uid>", or "<platform>:name:<display name>" when no stable id is known. */
export function handleOf(platform, { uid = '', name = '' } = {}) {
  const p = String(platform ?? '').trim().toLowerCase() || 'unknown';
  const u = String(uid ?? '').trim();
  if (u) return `${p}:${u}`;
  const n = String(name ?? '').trim();
  return n ? `${p}:name:${n}` : '';
}
const platformOf = (handle) => String(handle).split(':')[0];
const nameOfHandle = (handle) => { const m = /^[^:]+:name:(.+)$/.exec(String(handle)); return m ? m[1] : ''; };

/** Bring old memory (people keyed by handle, one handle each) to the registry shape. */
export function migratePeople(memory) {
  const out = {};
  for (const [key, p] of Object.entries(memory.people ?? {})) {
    if (Array.isArray(p.handles)) { out[p.id ?? key] = p; continue; }
    const id = `u${String((memory.useq = (memory.useq ?? 0) + 1)).padStart(4, '0')}`;
    out[id] = { ...p, id, handles: [p.id ?? key], names: [...(p.names ?? [])], counts: { ...(p.counts ?? {}) } };
    for (const x of memory.pending ?? []) if (x.person === key) x.person = id;
  }
  memory.people = out;
  return memory;
}

/** The person holding this exact handle, or null. */
export function byHandle(people, handle) {
  if (!handle) return null;
  for (const p of Object.values(people)) if (p.handles.includes(handle)) return p;
  return null;
}

/**
 * Who is this: exact handles first (any of them), then — within the platform — a unique person
 * known by this display name. Ambiguous names resolve to nobody.
 */
export function resolvePerson(people, { handles = [], platform = '', name = '' } = {}) {
  for (const h of handles) { const p = byHandle(people, h); if (p) return p; }
  const n = String(name ?? '').trim();
  if (!n) return null;
  const plat = String(platform || platformOf(handles[0] ?? '')).toLowerCase();
  const hits = Object.values(people).filter((p) => p.names.includes(n) && (!plat || p.handles.some((h) => platformOf(h) === plat)));
  return hits.length === 1 ? hits[0] : null;
}

/** Find a person by internal id, by handle, or by a unique name (any platform). */
export function findPerson(people, ref) {
  const key = String(ref ?? '').trim();
  if (!key) return null;
  if (people[key]) return people[key];
  const h = byHandle(people, key);
  if (h) return h;
  const name = nameOfHandle(key) || key;
  const byName = Object.values(people).filter((p) => p.names.includes(name));
  return byName.length === 1 ? byName[0] : null;
}

export const ownerOf = (people) => Object.values(people).find((p) => p.tier === 'owner') ?? null;

function newPerson(memory, { handles, name, tier, at }) {
  const id = `u${String((memory.useq = (memory.useq ?? 0) + 1)).padStart(4, '0')}`;
  const names = [...new Set([String(name ?? '').trim(), ...handles.map(nameOfHandle)].filter(Boolean))];
  return (memory.people[id] = { id, handles: [...new Set(handles)], names, tier, firstSeen: at, lastSeen: at, counts: {}, impression: '' });
}

/** Give a person another handle; a handle held by someone else is not taken (that is a merge). */
export function addHandle(memory, p, handle) {
  if (!handle || p.handles.includes(handle)) return true;
  const other = byHandle(memory.people, handle);
  if (other && other !== p) return false;
  p.handles.push(handle);
  const n = nameOfHandle(handle);
  if (n && !p.names.includes(n)) p.names.push(n);
  return true;
}

/**
 * A real event involving someone, written by code: resolve (or create) the person, add the
 * handles seen, the name, the tier, and count the event. kind: dm | group | reply | comment |
 * like | follow | sent | mention | null (no count: a friend-list sync).
 */
export function touchPerson(memory, { handles = [], platform = '', name = '', tier = 'talked', kind = 'dm', at = Date.now() }) {
  const hs = [...new Set(handles.filter(Boolean))];
  if (!hs.length) return null;
  let p = resolvePerson(memory.people, { handles: hs, platform, name });
  if (!p) p = newPerson(memory, { handles: hs, name, tier, at });
  for (const h of hs) addHandle(memory, p, h);
  const n = String(name ?? '').trim();
  if (n && !p.names.includes(n)) p.names = [n, ...p.names].slice(0, 8);
  p.tier = higherTier(tier, p.tier);
  if (kind) { p.counts[kind] = (p.counts[kind] ?? 0) + 1; p.lastSeen = Math.max(p.lastSeen ?? 0, at); }
  return p;
}

/** Mark one person as the owner (the person this handle belongs to; created if needed). */
export function setOwner(memory, handle, name = '') {
  if (!handle) return null;
  for (const p of Object.values(memory.people)) if (p.tier === 'owner' && !p.handles.includes(handle)) p.tier = 'talked';
  const p = touchPerson(memory, { handles: [handle], name, tier: 'owner', kind: null });
  p.tier = 'owner';
  return p;
}

/**
 * Two cards are one person: everything moves onto `keep` (handles, names, counts, the impression
 * when it has none, the earlier first-seen, the later last-seen, the higher tier); `drop` is removed.
 */
export function mergePeople(memory, keepRef, dropRef, { why = '' } = {}) {
  let keep = findPerson(memory.people, keepRef), drop = findPerson(memory.people, dropRef);
  if (!keep || !drop) return { ok: false, error: `no such person: ${!keep ? keepRef : dropRef}` };
  if (keep === drop) return { ok: true, id: keep.id, noop: true };
  if ((TIER_RANK[drop.tier] ?? 0) > (TIER_RANK[keep.tier] ?? 0)) [keep, drop] = [drop, keep];
  keep.handles = [...new Set([...keep.handles, ...drop.handles])];
  keep.names = [...new Set([...keep.names, ...drop.names])].slice(0, 8);
  for (const [k, v] of Object.entries(drop.counts)) keep.counts[k] = (keep.counts[k] ?? 0) + v;
  keep.impression ||= drop.impression;
  keep.firstSeen = Math.min(keep.firstSeen ?? Infinity, drop.firstSeen ?? Infinity);
  keep.lastSeen = Math.max(keep.lastSeen ?? 0, drop.lastSeen ?? 0);
  keep.tier = higherTier(keep.tier, drop.tier);
  keep.mergedFrom = [...(keep.mergedFrom ?? []), { id: drop.id, handles: drop.handles, why, at: Date.now() }];
  delete memory.people[drop.id];
  return { ok: true, id: keep.id, dropped: drop.id };
}

/**
 * Someone thinks two cards are one person. Merges that would touch the owner wait for your
 * approval (being taken for the owner is the most trusted thing there is); others apply at once.
 */
export function proposeMerge(memory, a, b, { why = '' } = {}) {
  const pa = findPerson(memory.people, a), pb = findPerson(memory.people, b);
  if (!pa || !pb || pa === pb) return { ok: false, error: 'nothing to merge' };
  if (pa.tier === 'owner' || pb.tier === 'owner') {
    const dup = memory.merges.find((m) => [m.a, m.b].sort().join() === [pa.id, pb.id].sort().join());
    if (dup) return { ok: true, pending: dup.id };
    const id = `m${(memory.seq = (memory.seq ?? 0) + 1)}`;
    memory.merges.push({ id, a: pa.id, b: pb.id, why: String(why).slice(0, 120), at: Date.now() });
    return { ok: true, pending: id };
  }
  return mergePeople(memory, pa.id, pb.id, { why });
}

export function approveMerge(memory, id) {
  const i = memory.merges.findIndex((m) => m.id === id);
  if (i < 0) return { ok: false, error: `no pending merge ${id}` };
  const [m] = memory.merges.splice(i, 1);
  return mergePeople(memory, m.a, m.b, { why: m.why });
}

/**
 * A friend list (QQ's get_friend_list): each friend's number, nickname and the remark she gave
 * them. The remark is what her phone shows in a notification, so this is what ties a phone
 * "宽" to QQ 919231551. Friends become contact-tier cards (no counts); cards already made from
 * a name alone get the number, and two cards that turn out to be one friend are merged.
 */
export function syncFriends(memory, platform, friends, { at = Date.now() } = {}) {
  let merged = 0, linked = 0;
  for (const f of friends ?? []) {
    const uid = String(f?.uid ?? f?.user_id ?? '').trim();
    if (!uid) continue;
    const shown = [f.remark, f.nickname].map((x) => String(x ?? '').trim()).filter(Boolean);
    const idHandle = handleOf(platform, { uid });
    const nameHandles = shown.map((n) => handleOf(platform, { name: n }));
    const byId = byHandle(memory.people, idHandle);
    const byName = nameHandles.map((h) => byHandle(memory.people, h)).find(Boolean) ?? null;
    if (byId && byName && byId !== byName) { mergePeople(memory, byId.id, byName.id, { why: `${platform} 好友列表：${shown.join('/')} 就是 ${uid}` }); merged++; }
    const p = byHandle(memory.people, idHandle) ?? byName ?? newPerson(memory, { handles: [idHandle], name: shown[0], tier: 'contact', at });
    if (!p.handles.includes(idHandle)) { addHandle(memory, p, idHandle); linked++; }
    // Name handles only when unambiguous within this list (two friends both remarked "小王" share none).
    for (const [i, h] of nameHandles.entries()) {
      const same = (friends ?? []).filter((g) => [g?.remark, g?.nickname].map((x) => String(x ?? '').trim()).includes(shown[i])).length;
      if (same === 1) addHandle(memory, p, h);
    }
    for (const n of shown) if (!p.names.includes(n)) p.names.push(n);
  }
  return { merged, linked };
}

const COUNT_LABEL = { dm: '私聊', group: '群里说话', sent: '你发给他', reply: '回复', comment: '评论', like: '点赞', follow: '关注', mention: '提到' };
const TIER_LABEL = { owner: '是他', talked: '聊过', seen: '只在帖子里打过交道', contact: '在好友列表里，没怎么说过话' };

function ago(ms) {
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d} 天前`;
  const h = Math.floor(ms / 3600000);
  return h >= 1 ? `${h} 小时前` : '刚才';
}

/** One person, as she remembers them (used in the message that wakes her about them). */
export function renderPerson(p, now = Date.now()) {
  if (!p) return '';
  const name = p.names[0] || p.handles[0] || p.id;
  const counts = Object.entries(p.counts).filter(([, v]) => v > 0).map(([k, v]) => `${COUNT_LABEL[k] ?? k} ${v} 次`).join('，');
  const also = p.names.length > 1 ? `，也叫 ${p.names.slice(1).join('/')}` : '';
  const head = `${name}（${p.handles.join('、')}${also}）：${TIER_LABEL[p.tier] ?? p.tier}${counts ? `；${counts}` : ''}${p.lastSeen ? `；上次 ${ago(now - p.lastSeen)}` : ''}`;
  return p.impression ? `${head}\n  印象：${p.impression}` : head;
}

/** The model's (or her own) one line about a person. The owner has no card line: he has his bank. */
export function setImpression(memory, ref, text, { limits = DEFAULT_LIMITS } = {}) {
  const p = findPerson(memory.people, ref);
  if (!p || p.tier === 'owner') return false;
  const imp = String(text ?? '').trim();
  if (!imp) { p.impression = ''; return true; }
  if (rejectReason(imp)) return false;
  p.impression = imp.slice(0, limits.impression);
  return true;
}

// ── 还没了的事 ────────────────────────────────────────────────────────────────

/**
 * "2026-07-15" from "2026-07-15" / "07-15" / "7-15" (the year of `now`, or the next one when that
 * would put it half a year back: "01-06" said in December); '' when it is not a date.
 */
export function cleanDue(due, now = Date.now()) {
  const m = /^\s*(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?\s*$/.exec(String(due ?? ''));
  if (!m) return '';
  const mo = Number(m[2]), d = Number(m[3]);
  let y = Number(m[1] ?? new Date(now).getFullYear());
  if (!m[1] && daysBetween(new Date(y, mo - 1, d).getTime(), now) > 183) y++;
  const t = new Date(y, mo - 1, d);
  if (t.getMonth() !== mo - 1 || t.getDate() !== d) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** The item in `list` whose text contains `old` uniquely: { index } or { error }. */
function findItem(list, old) {
  const o = String(old ?? '').trim();
  if (!o) return { error: 'oldText is required' };
  const hits = list.map((x, i) => (x.text.includes(o) ? i : -1)).filter((i) => i >= 0);
  if (!hits.length) return { error: `no item contains "${o}"` };
  if (hits.length > 1) return { error: `"${o}" matches ${hits.length} items; use a longer piece` };
  return { index: hits[0] };
}
// The life of an item is code's: `at` when it was added, `saidAt` the last time it came up again (an
// add that was already there, a replace). Expiry options: { now, keepAfterDue, keepIdle } (days).
// Whole local days, so what she is shown changes at midnight, not in the middle of a conversation.
const dueMs = (x) => new Date(`${x.due}T00:00:00`).getTime();
/** Still live: a dated item until `keepAfterDue` days past its day; one without a date until `keepIdle` days untouched. */
export function isLive(x, { now = Date.now(), keepAfterDue = 3, keepIdle = 14 } = {}) {
  if (x.due) return daysBetween(dueMs(x), now) <= keepAfterDue;
  return daysBetween(Math.max(x.at ?? 0, x.saidAt ?? 0), now) <= keepIdle;
}
/** Drop the items that have run out (removed, not kept anywhere). Returns how many went. */
export function expireOpen(memory, opts = {}) {
  const before = memory.open.length;
  memory.open = memory.open.filter((x) => isLive(x, opts));
  return before - memory.open.length;
}

/**
 * One operation on 还没了的事: add { content, due } · replace { oldText, content, due } ·
 * done { oldText } (finished, called off, no longer wanted: it goes). `owed` is ignored; shelve /
 * restore (the shelf is gone) are a no-op with a note. Returns { ok, error?, note? }.
 */
export function openOp(memory, op, { now = Date.now() } = {}) {
  const action = String(op?.action ?? '');
  const content = String(op?.content ?? '').trim();
  const due = op?.due === undefined ? undefined : cleanDue(op.due, now);
  if (action === 'add') {
    if (!content) return { ok: false, error: 'content is required' };
    const why = rejectReason(content);
    if (why) return { ok: false, error: `not kept (${why})` };
    // Due the same day, a looser match is the same thing reworded (0.55: on the benchmark's replies the
    // rewordings scored 0.57+, while two different errands "明天…" shared a template at 0.52).
    const same = memory.open.find((x) => normText(x.text) === normText(content) || jaccard(x.text, content) >= (due && x.due === due ? 0.55 : 0.82));
    if (same) { same.saidAt = now; return { ok: true, note: 'already there' }; }
    memory.open.push({ id: `o${String((memory.oseq = (memory.oseq ?? 0) + 1)).padStart(4, '0')}`, text: content, at: now, due: due || '' });
    return { ok: true };
  }
  if (action === 'replace') {
    const f = findItem(memory.open, op?.oldText);
    if (f.error) return { ok: false, error: f.error };
    if (!content) return { ok: false, error: 'content is required (use done when it is over)' };
    if (rejectReason(content)) return { ok: false, error: `not kept (${rejectReason(content)})` };
    const x = memory.open[f.index];
    x.text = content;
    if (due !== undefined) x.due = due;
    x.saidAt = now;
    return { ok: true };
  }
  if (action === 'done' || action === 'remove') {
    const f = findItem(memory.open, op?.oldText);
    if (f.error) return { ok: false, error: f.error };
    memory.open.splice(f.index, 1);
    return { ok: true };
  }
  if (action === 'shelve' || action === 'restore') return { ok: true, note: 'shelve / restore no longer exist: items stay until done, or go by themselves after their date' };
  return { ok: false, error: `unknown action ${action}` };
}

/** One item as she reads it: its words, and the due date when it has one. */
export const renderItem = (x, now = Date.now()) => `${x.text}${x.due ? `（到 ${dayMark(dueMs(x), now)}）` : ''}`;

// ── the whole thing ───────────────────────────────────────────────────────────

export function emptyMemory() {
  return { version: MEMORY_VERSION, gen: 1, seq: 0, oseq: 0, owner: [], self: [], open: [], people: {}, merges: [], cursor: 0, consolidations: 0, useq: 0 };
}

/**
 * 0.19 memory (fragments, facts on cards, pending facts) → 0.20. Open fragments become 还没了的事
 * (and then run out like any other). Pinned fragments join the owner bank
 * while there is room. Everything else that is no longer kept — the other fragments, the facts on
 * cards, pending facts — is returned as `archive` for the caller to write to a file (the words they
 * came from are still in the transcript and the recall index), with a `report` of where each went.
 */
export function migrateV1(m, { limits = DEFAULT_LIMITS, now = Date.now() } = {}) {
  const frags = (m.fragments ?? []).filter((f) => f && typeof f.text === 'string' && f.text.trim());
  const report = { open: [], toOwner: [], archived: 0, facts: 0, pending: 0 };
  const archive = { from: 'dsh-dot memory v1 (0.19)', at: new Date(now).toISOString(), fragments: [], facts: {}, pending: [...(m.pending ?? [])] };
  const out = { ...m, version: MEMORY_VERSION, open: [...(m.open ?? [])] };
  for (const f of frags.filter((x) => x.open).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    out.open.push({ id: `o${String((out.oseq = (out.oseq ?? 0) + 1)).padStart(4, '0')}`, text: f.text, at: f.createdAt ?? now, due: '' });
  }
  for (const f of frags.filter((x) => !x.open)) {
    if (f.pinned && bankSize([...(out.owner ?? []), f.text]) <= limits.owner) { out.owner = [...(out.owner ?? []), f.text]; report.toOwner.push(f.text); continue; }
    archive.fragments.push(f);
  }
  report.open = out.open.map((x) => x.text);
  report.archived = archive.fragments.length;
  for (const p of Object.values(out.people ?? {})) {
    if (p.facts?.length) { archive.facts[p.id] = { names: p.names, facts: p.facts }; report.facts += p.facts.length; }
    delete p.facts;
    if (p.impression && p.impression.length > limits.impression) p.impression = p.impression.slice(0, limits.impression);
  }
  report.pending = archive.pending.length;
  for (const k of ['fragments', 'pending', 'fseq']) delete out[k];
  return { memory: out, archive, report };
}

/**
 * Memory as loaded from disk, brought to the current shape. A 0.19 file is migrated on the way; the
 * migration's archive and report ride along as `migration` (not saved: the caller writes them out
 * and deletes the key).
 */
export function normalizeMemory(m, { limits = DEFAULT_LIMITS, now = Date.now() } = {}) {
  const e = emptyMemory();
  if (!m || typeof m !== 'object') return e;
  let migration = null;
  if (Array.isArray(m.fragments) || Array.isArray(m.pending) || (m.version ?? 1) < MEMORY_VERSION) {
    const r = migrateV1(migratePeople({ ...m, people: { ...(m.people ?? {}) } }), { limits, now });
    m = r.memory;
    migration = { archive: r.archive, report: r.report };
  }
  // 0.23 kept a shelf and an `owed` flag: shelved items join the list (and run out like the rest).
  const open = [...(m.open ?? []), ...(Array.isArray(m.shelved) ? m.shelved : [])].map((x) => { const y = { ...x }; delete y.owed; delete y.shelvedAt; return y; });
  const out = migratePeople({ ...e, ...m, owner: [...(m.owner ?? [])], self: [...(m.self ?? [])], open, people: { ...(m.people ?? {}) }, merges: [...(m.merges ?? [])] });
  delete out.shelved;
  if (migration) out.migration = migration;
  return out;
}

const TODAY_MAX = 5;
/** Shown order of 还没了的事: dated items first, nearest date first; then the rest, newest first. */
const openOrder = (a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : (b.due ? 1 : 0) - (a.due ? 1 : 0)) || (b.at ?? 0) - (a.at ?? 0) || b.id.localeCompare(a.id);

/**
 * 还没了的事 as she is shown it, from all live items: `today` — due today and not brought up yet today
 * (at most TODAY_MAX; overdue ones are in the list, where dated items come first); `list` — the rest in
 * openOrder, as many as fit in `limits.open` characters (what does not fit is still stored).
 */
export function openView(memory, { limits = DEFAULT_LIMITS, now = Date.now(), keepAfterDue, keepIdle } = {}) {
  const live = memory.open.filter((x) => isLive(x, { now, keepAfterDue, keepIdle }));
  const today = live.filter((x) => x.due && daysBetween(dueMs(x), now) === 0 && !((x.saidAt ?? 0) >= dueMs(x)))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id)).slice(0, TODAY_MAX);
  const list = [];
  let used = 0;
  for (const x of live.filter((y) => !today.includes(y)).sort(openOrder)) {
    const n = x.text.length + 1;
    if (list.length && used + n > limits.open) continue;
    list.push(x); used += n;
  }
  return { today, list };
}

/**
 * What every turn of hers sees: you, her own notes, what is due today, what else is not over yet.
 * Byte-stable for the same memory and day (no counters; the clock only through the day), because a
 * context snapshot is re-sent only when its text changes.
 */
export function renderStanding(memory, { banks = true, now = Date.now(), ...view } = {}) {
  const { today, list } = openView(memory, { now, ...view });
  const t = table('memory.standing');
  const parts = [];
  // banks: false when another memory plugin narrates the owner/self memories (coexist people-only).
  if (banks && memory.owner.length) parts.push(`${t.owner}\n${memory.owner.map((e) => `- ${e}`).join('\n')}`);
  if (banks && memory.self.length) parts.push(`${t.self}\n${memory.self.map((e) => `- ${e}`).join('\n')}`);
  if (today.length) parts.push(`${t.today}\n${today.map((x) => `- ${renderItem(x, now)}`).join('\n')}`);
  if (list.length) parts.push(`${t.open}\n${list.map((x) => `- ${renderItem(x, now)}`).join('\n')}`);
  if (!parts.length) return '';
  return ['<memory>', t.intro, ...parts, '</memory>'].join('\n');
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
