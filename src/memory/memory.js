// dsh-dot/memory: she remembers you, herself, what is not over yet, and the people she meets — and
// her conversation is handed over to a fresh session long before it gets heavy.
//
//   transcript  <home>/memory/transcript.jsonl — what really happened in her conversation: what you
//               said, what she actually sent (qq_send), what her phone showed her, what her hands
//               found. The evidence: recall finds in it, consolidation reads it.
//   recall      before each turn, the old turns that bear on the message that woke her (recall.js):
//               vector + BM25 candidates, reranked, shown by day with exact dates.
//   memory      <home>/memory/memory.json (+ memory.md for reading) — three notes (about him, her own,
//               还没了的事, which code lets go after their date) and the people (store.js). In front of her every turn.
//   consolidate one model call over the transcript since the last one: 还没了的事 and people. When
//               `consolidateEveryLines` new lines have piled up, before the diary, and before a handoff.
//   daily       once a day, on the night (dshDot.onSleep; without dot at her first turn after midnight), when there was anything that day: one call writes the diary
//               and is the only writer of the owner / self banks besides her own tool — what of the
//               day is lasting, as adds and replaces code applies. A full bank takes something new only by a replace.
//   handoff     after dsh-whale-inurqq's: when her conversation passes `handoffTokens`, consolidate,
//               archive it, open a new one in <home>, and start it with the last lines verbatim
//               (her notes are in <memory>; older words come back through recall).
// She edits her notes herself too (`memory`), and looks things up (`recall`).
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  DEFAULT_LIMITS, bankOp, noteChange, bankSize, bankUsage, bankFull, emptyMemory, findPerson, normalizeMemory, openOp, expireOpen, openView, renderItem, setImpression,
  handleOf, renderPerson, renderStanding, search, touchPerson, rejectReason, wordOp,
  resolvePerson, setOwner, ownerOf, proposeMerge, approveMerge, mergePeople, syncFriends,
} from './store.js';
import { createRecall, factLines } from './recall.js';
import { createFacts } from './facts.js';
import { annotate } from './when.js';
import { dayMark, unstamp } from '../clock.js';
import { lastEnd, lastStart } from '../hours.js';
import { sectionOf, setValues } from '../settings.js';
import { installLlmGate, outcomeText } from '../llm-gate.js';
import { WORK, callModel } from '../llm-call.js';
import { configure as configurePrompts, prompt, table } from '../prompts.js';
import { NO_BACKFILL, runPendingReset } from '../reset.js';
import { head } from '../cut.js';
import { ownerSaid } from '../said.js';

export const name = 'dot-memory';
export const inject = ['llm', 'agentDefaultModel'];

export const defaults = {
  home: '',
  handoffTokens: 60000,         // her conversation is handed over to a fresh session past this (her hands do the long work in their own sessions; past this a conversation is mostly old turns resent at every step)
  minTokensBetweenHandoffs: 20000,
  consolidateEveryLines: 120,   // transcript lines since the last consolidation that trigger one (also: before the diary, and every handoff)
  chunkLines: 160,              // at most this many lines per consolidation call (above the trigger, so one batch is one call); a backlog is read in several
  minChunkLines: 10,            // after failed calls the chunk is halved, down to this
  handoffTailLines: 12,         // the last lines of the conversation carried verbatim into the new session
  inputChars: 40000,            // transcript characters one consolidation call reads; a larger backlog is read in chunks
  maxTokens: 16384,
  limits: DEFAULT_LIMITS,        // limits.open is how much of 还没了的事 is shown each turn, not how much is kept
  openKeepDaysAfterDue: 3,      // an item with a due date goes this many days after it
  openKeepDaysIdle: 14,         // an item without one goes after this many days untouched (added, replaced, brought up again)
  // Living next to another memory plugin. full: everything on. people-only: keep people, 还没了的事
  // and the diary, but leave the owner/self notes (prompt text and consolidation) to the other one,
  // so two plugins do not both narrate what she knows about him. auto: people-only when one of
  // otherMemoryServices is provided (cordis has no public way to list services, so it is a list).
  coexist: 'auto',
  // Names other memory plugins provide. A bare 'memory' is deliberately not here: too generic a name
  // to risk silencing her own notes because something unrelated provides it. Add names as you meet them.
  otherMemoryServices: ['hermesMemory', 'autoMemory', 'dshMemory', 'memoryBank'],
  // Automatic recall (recall.js). Everything here can also be changed at runtime with
  // /dot memory recall … (saved to $DSH_HOME/dsh-memory.json, which wins over this config).
  recallBackend: 'local',       // local (on this machine, no key) | siliconflow | dashscope | off
  recallModel: '',              // embedding model; '' = the backend's own (local Xenova/multilingual-e5-small · siliconflow BAAI/bge-m3 · dashscope qwen3.7-text-embedding); BAAI/bge-small-zh-v1.5 is the lighter Chinese-only local one
  recallRerankModel: '',        // '' or 'none' = no reranker (the default); a name turns one on: local Xenova/bge-reranker-base · siliconflow BAAI/bge-reranker-v2-m3 · dashscope qwen3.7-text-rerank
  recallMirror: '',             // where local models download from; '' = $HF_ENDPOINT, else https://hf-mirror.com
  recallInstall: true,          // install @huggingface/transformers into $DSH_HOME/dsh-dot-recall on first use (300–480 MB; not a package dependency)
  recallTransformersVersion: '4.3.2',
  recallCandidates: 20,         // turns each channel (vector, BM25) hands to the reranker, when one is set
  recallTopK: 30,               // at most this many turns found per wake — fewer when fewer stand out; shown without her replies
  recallMaxTokens: 1500,        // …and at most this many tokens of them (the weakest are dropped first)
  recallRecentTurns: 20,        // the last turns before her window are a ranked list of their own (newest first), without a reranker; 0 = off
  recallNeighbors: 1,           // budget left over goes to the turns this close before and after each hit; 0 = off
  recallRerankMin: 0,           // a reranked turn needs at least this score (0–1); 0 = the reranker's order alone decides
  recallMinQueryLength: 4,      // a waking message with fewer distinct content tokens (CJK characters, other words) recalls nothing: 好的 / 哈哈哈哈 / ok thanks. 0 = off
  // Without a reranker (none set, or still downloading): a hit must stand out from the whole index —
  // score ≥ median + k·(best − median), per channel, scale-free. 0 = off.
  recallContrast: 0.35,
  recallMinScore: 0,            // optional absolute cosine floor, without a reranker; 0 = none
  recallLexical: true,          // the BM25 channel (characters + character bigrams); false = vectors only
  recallWindowTurns: 0,         // 0: skip her whole current session (dsh keeps it in the window); N: skip only the last N turns (hosts that show a window)
  recallChunkChars: 1200,       // one turn's text is clipped to this before embedding
  recallWaitMs: 3000,           // prompt assembly waits this long for a query still running, then goes on without it
  // Facts (facts.js): a sentence per thing worth keeping, written when records are consolidated, and
  // the ones that bear on what he just said put in her prompt (one model call per wake picks them).
  facts: true,
  factsShown: 60,               // the pick call reads this many, the best by the fused lists
  factsPicked: 6,               // at most this many lines reach her prompt
  factsWaitMs: 8000,            // prompt assembly waits this long for the pick, then goes on without it
  recallSiliconflowUrl: 'https://api.siliconflow.cn/v1',
  recallDashscopeUrl: 'https://dashscope.aliyuncs.com', // a workspace host (https://<ws>.cn-beijing.maas.aliyuncs.com) works too
};

// Messages that wake her and are worth remembering against: his, QQ / phone notifications, schedules.
const RECALL_WAKES = (src) => src.kind === 'user' || src.kind === 'schedule' || (src.kind === 'dsh-dot' && src.form === 'phone-notification');

export const HANDOFF_SOURCE = Object.freeze({ kind: 'handoff' });
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const contentText = (content) => (typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join(''));
const isSilent = (t) => /^[`*\s]*DOT_SILENT[`*\s。.]*$/.test(String(t ?? ''));
const stamp = (ms, now = Date.now()) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${dayMark(ms, now)} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const clip = (s, n) => (s.length > n ? `${head(s, n)}…` : s);
/** "2026-10-27 周一" — a day as the diary heads it (local time). */
export const dayLabel = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${'周日周一周二周三周四周五周六'.slice(d.getDay() * 2, d.getDay() * 2 + 2)}`; };

/**
 * One transcript line as the consolidation reads it: [MM-DD HH:MM] (or [YYYY-MM-DD HH:MM] from
 * another year), with 明天 / 下周三 given their date by code (when.js).
 */
export function transcriptLine(l, { now = Date.now() } = {}) { // safe as a .map callback: an index is not an options object
  const who = { owner: '他', her: '我', phone: '[手机]', note: '[我刚做的]', schedule: '[定时任务]' }[l.who] ?? l.who;
  const to = l.who === 'her' && l.to && l.to !== 'owner' ? `（发给 ${l.to}）` : '';
  return `[${stamp(l.at, now)}] ${who}${to}：${annotate(l.who === 'note' ? factLines(l.text) : l.text, l.at, now)}`;
}

/**
 * The oldest transcript lines whose rendered text fits in `maxChars` (always at least one), so a
 * backlog is consolidated in order and the cursor never jumps past unread lines.
 */
export function takeChunk(fresh, maxChars) {
  const out = [];
  let used = 0;
  for (const l of fresh) {
    const n = transcriptLine(l).length + 1;
    if (out.length && used + n > maxChars) break;
    out.push(l); used += n;
  }
  return out;
}

/**
 * The book of things (dot/ledger.js) as the consolidation call is shown it: what was under way or ended since `from`,
 * one line a thing with how it stands. '' when there is none — the section is then not there at all. The book is where
 * a thing of her hands is kept; shown here so the same thing is not also written down as 还没了的事.
 */
export function thingsSection(things = [], from = 0) {
  const t = table('memory.extract.things');
  const rows = things.filter((e) => e && (e.state !== 'ended' || (e.endedAt ?? 0) >= from)).slice(0, 12).reverse()
    .map((e) => `- [${t[e.state === 'ended' ? e.outcome : e.state] ?? e.state}] ${clip(String(e.task ?? '').split(/[。\n]/)[0].trim(), 80)}`);
  return rows.length ? `${t.head}\n${rows.join('\n')}` : '';
}

/** What the consolidation call is asked to do (the JSON it returns, field by field). */
export const extractRules = () => prompt('memory.extract');

/**
 * The whole consolidation prompt, from what changes least to what changes most, so calls share the
 * longest prefix (the provider's cache): the rules (never change), the people (new ones are added at
 * the end, an impression now and then), 还没了的事 (different nearly every call), the new records.
 */
export function extractPrompt({ text = '', known = '', open = '', words = [], things = '' }) {
  return [
    extractRules(),
    '',
    prompt('memory.extract.input', { records: text || '（这段时间没有新记录）', people: known || '（还没有）', open: open || '（没有）', things, words: words.map((e) => `- ${e}`).join('\n') || '（还没有）' }),
  ].join('\n');
}

const BANKS = ['owner', 'self'];
/**
 * The daily call: the fixed instructions, then both banks (oldest → newest, size, limit; a full bank's
 * header says so and asks for a replace), then the day and its records — what is the same from call
 * to call first. banks: { owner, self }, or null
 * when they are another plugin's (people-only): then it is told to write the diary only.
 */
export function dailyPrompt({ day, text, banks, limits = DEFAULT_LIMITS }) {
  const show = (bank) => `${table('memory.daily.bank', { size: bankSize(banks[bank]), limit: limits[bank] })[bankFull(banks[bank], limits[bank]) ? `${bank}.full` : bank]}\n${banks[bank].map((e) => `- ${e}`).join('\n') || '（空）'}`;
  return prompt('memory.daily', {
    banks: banks ? BANKS.map(show).join('\n') : table('memory.daily.bank', { size: 0, limit: 0 }).off,
    day, records: text || '（今天没有记录）',
  });
}

/** Pull a JSON object out of a reply (bare, fenced, or between the first { and last }). */
export function parseLooseJson(raw) {
  const text = String(raw ?? '').trim();
  const tries = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) tries.push(fenced[1].trim());
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) { try { const v = JSON.parse(t); if (v && typeof v === 'object') return v; } catch (error) { void error; } }
  return null;
}

/**
 * Apply one consolidation result to the memory. Returns what changed (for the audit and /dot memory).
 * Items that have run out go afterwards (keepAfterDue / keepIdle: days, see isLive). `segment` is the
 * record the call read: a done on an item it does not mention is skipped (openOp).
 */
export function applyExtraction(memory, out, { limits = DEFAULT_LIMITS, now = Date.now(), keepAfterDue, keepIdle, segment, evidence = segment } = {}) {
  // owner / self are not the consolidation's (the daily call writes them): in a reply they are ignored.
  const report = { words: 0, open: 0, done: 0, expired: 0, people: 0, errors: [] };
  // 词 and 梗: each kept only with a quote that is in the records just read (`evidence`) and contains it.
  for (const op of [].concat(out?.words ?? [])) {
    if (!op || typeof op !== 'object') continue;
    const r = wordOp(memory.words ?? [], op, limits.words ?? DEFAULT_LIMITS.words, { evidence });
    if (r.ok) { if (!r.note) report.words++; memory.words = r.entries; } else report.errors.push(`words: ${r.error}`);
  }
  for (const op of [].concat(out?.open ?? [])) {
    if (!op || typeof op !== 'object') continue;
    const r = openOp(memory, { ...op, due: op.due ?? undefined }, { now, segment });
    if (!r.ok) { report.errors.push(`open: ${r.error}`); continue; }
    if (r.note) continue;
    if (op.action === 'done' || op.action === 'remove') report.done++; else report.open++;
  }
  report.expired = expireOpen(memory, { now, keepAfterDue, keepIdle });
  for (const u of [].concat(out?.people ?? [])) {
    if (!u || typeof u !== 'object') continue;
    let p = findPerson(memory.people, u.id) ?? resolvePerson(memory.people, { platform: u.platform, name: u.name });
    if (!p && u.name && u.platform) {
      // Someone new she met in an app: a card, tier as the model saw it (never owner).
      const tier = u.tier === 'seen' ? 'seen' : 'talked';
      p = touchPerson(memory, { handles: [handleOf(u.platform, { name: u.name })], platform: u.platform, name: u.name, tier, kind: tier === 'seen' ? 'comment' : 'mention', at: now });
    }
    if (!p) continue;
    if (u.impression && setImpression(memory, p.id, u.impression, { limits })) report.people++;
  }
  for (const m of [].concat(out?.same ?? [])) {
    const r = proposeMerge(memory, m?.a, m?.b, { why: m?.why });
    if (r.ok && !r.noop) report.merges = (report.merges ?? 0) + 1;
  }
  return report;
}

/**
 * Transcript lines from a session's raw event log (sessionQuery.readSession): used once, to give
 * memory the conversation that happened before memory was installed.
 */
export { ownerSaid } from '../said.js';

/** An image she sent, as her transcript writes it — the ref itself, so the line can be sent again as it reads: `[表情包 sticker:<id>]`, else `[图 <ref>]` (phone:screen, phone:latest, a URL, face:<n>, a path). */
export const sentImage = (ref) => { const r = String(ref ?? '').trim(); return /^sticker:/i.test(r) ? `[表情包 ${r}]` : `[图 ${r}]`; };
/**
 * What one qq_send really put on QQ, as a transcript line's text ('' = nothing went out), from its
 * `tool/result`: denied or failed → nothing; otherwise the bubbles qq_send reports as sent
 * (`meta.said`, `meta.images` — an interrupted send, a dropped leak line and an image QQ refused
 * are not in them), the images as their refs (sentImage). A result without `meta.images` (0.17.0's
 * `imagesSent` count, an older version, a nested call): the first that many of the call's images; a
 * result with no meta at all: the first `sent N` lines of the call's text, then images.
 */
export function qqSentText(args, result) {
  if (!result || result.isError || result.message?.isError) return '';
  const meta = result.meta && typeof result.meta === 'object' ? result.meta : null;
  const asked = [].concat(args?.images ?? []).filter(Boolean).map(String);
  let said, images;
  if (Array.isArray(meta?.said)) { said = meta.said.map(String); images = Array.isArray(meta.images) ? meta.images.map(String) : asked.slice(0, Number(meta.imagesSent) || 0); }
  else {
    const parts = String(args?.text ?? '').split(/<sep\s*\/>|\n/i).map((x) => x.trim()).filter(Boolean);
    const m = /^sent (\d+) message/.exec(contentText(result.message?.content ?? result.content));
    const n = m ? Number(m[1]) : parts.length + asked.length;
    said = parts.slice(0, n); images = asked.slice(0, Math.max(0, n - parts.length));
  }
  return [said.join(' / '), ...images.map(sentImage)].filter(Boolean).join(' ');
}
const parseArgs = (s) => { try { return JSON.parse(s ?? '{}') ?? {}; } catch { return {}; } };
/** Lines kept in time order: a qq_send is recorded at its result, with the time of its call. */
const byTime = (a, b) => (a.at ?? 0) - (b.at ?? 0);

export function transcriptFromEvents(events, session) {
  const out = [];
  const calls = new Map(); // callId → { at, args }
  const qqTurns = new Set((events ?? []).filter((e) => e?.type === 'tool/call' && e.data?.name === 'qq_send').map((e) => e.data?.turn));
  for (const e of events ?? []) {
    const at = Number(e?.time) || 0;
    if (e?.type === 'user/message') {
      const src = e.data?.source ?? {};
      const text = unstamp(contentText(e.data?.content));
      if (src.kind === 'user') out.push({ at, session, who: 'owner', text: ownerSaid(text) });
      else if (src.kind === 'dsh-dot' && src.form === 'phone-notification') out.push({ at, session, who: 'phone', text: text.split('\n（')[0] });
    } else if (e?.type === 'tool/call' && e.data?.name === 'qq_send') {
      calls.set(e.data.callId, { at, args: parseArgs(e.data.arguments) });
    } else if (e?.type === 'tool/result' && calls.has(e.data?.message?.toolCallId)) {
      const c = calls.get(e.data.message.toolCallId); calls.delete(e.data.message.toolCallId);
      const text = qqSentText(c.args, e.data);
      if (text) out.push({ at: c.at, session, who: 'her', to: String(c.args.to ?? ''), text });
    } else if (e?.type === 'assistant/message' && !e.data?.interrupted && !qqTurns.has(e.data?.turn)) {
      const text = contentText(e.data?.message?.content);
      if (text.trim() && !isSilent(text) && text.length <= 600) out.push({ at, session, who: 'her', text });
    }
  }
  return out.sort(byTime).filter((l) => String(l.text ?? '').trim()).map((l) => ({ ...l, text: clip(String(l.text).trim(), 2000) }));
}

/** The note a new session opens with after a handoff: the last lines of the old one, verbatim. */
export function renderHandoff(tail, gen) {
  const t = table('memory.handoff', { gen });
  const lines = [t.head];
  if (tail.length) { lines.push(t.tail); for (const l of tail) lines.push(`  ${clip(transcriptLine(l).replace(/\s*\n+\s*/g, ' / '), 240)}`); }
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger('dsh-dot/memory');
  runPendingReset({ logger }); // a reset scheduled on the dot page: before any state is read (src/reset.js)
  const user = sectionOf('memory', (m) => logger.warn(m));
  const cfg = { ...defaults, ...setValues(config), ...user };
  if (process.env.DSH_DOT_FACTS === 'off') cfg.facts = false; // the switch without a config file (and for tests of the rest)
  cfg.limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}), ...(user.limits ?? {}) };
  const keep = { keepAfterDue: Number(cfg.openKeepDaysAfterDue), keepIdle: Number(cfg.openKeepDaysIdle) };
  if (cfg.enabled === false) { logger.info('off (dsh-dot.json: memory.enabled = false)'); return; }
  const home = cfg.home || join(homedir(), 'dot');
  configurePrompts({ home });
  const dir = join(home, 'memory');
  const files = { memory: join(dir, 'memory.json'), md: join(dir, 'memory.md'), transcript: join(dir, 'transcript.jsonl'), handoffs: join(dir, 'handoffs.jsonl'), calls: join(dir, 'calls.jsonl'), diary: join(dir, 'diary.md'), archive: join(dir, 'memory.v019.json'), migration: join(dir, 'memory-migration.md') };
  mkdirSync(dir, { recursive: true });
  const dot = () => ctx.get('dshDot');
  installLlmGate(ctx, { name: 'dsh-dot/memory' }); // her consolidation and diary wait behind his requests (complete() below)
  // Checked when used, not once at boot: the other plugin may start after this one.
  let coexistLogged = false;
  const peopleOnly = () => {
    if (cfg.coexist === 'people-only') return true;
    if (cfg.coexist !== 'auto') return false;
    const other = [].concat(cfg.otherMemoryServices ?? []).find((n) => { try { return ctx.get(n) != null; } catch { return false; } });
    if (other && !coexistLogged) { coexistLogged = true; logger.info(`another memory service (${other}) is present: people-only mode (owner/self notes left to it)`); }
    return Boolean(other);
  };
  const audit = (event, data = {}) => (ctx.get('dshComputer')?.audit ?? ctx.get('dshPhone')?.audit)?.({ kind: 'memory', event, ...data });

  // A memory.json that cannot be read or migrated is copied aside before anything is saved over it.
  let memory;
  let frozen = false; // true: saving would destroy data no copy holds; nothing is written until a restart
  const keepAside = (why) => {
    const to = `${files.memory}.broken-${Date.now()}`;
    try { copyFileSync(files.memory, to); logger.warn(`memory.json ${why}: kept as ${to}; starting empty`); return true; } catch (err) { logger.warn(`memory.json ${why}, and it could not be copied aside (${err.message}): not saving until this is fixed`); return false; }
  };
  if (existsSync(files.memory)) {
    let raw = null;
    try { raw = JSON.parse(readFileSync(files.memory, 'utf8')); } catch (err) { frozen = !keepAside(`is not readable (${err.message})`); }
    if (raw) { try { memory = normalizeMemory(raw, { limits: cfg.limits }); } catch (err) { frozen = !keepAside(`could not be migrated (${err.message})`); } }
  }
  memory ??= emptyMemory();
  function save() {
    if (frozen) return;
    try {
      writeFileSync(`${files.memory}.tmp`, JSON.stringify(memory, null, 2));
      renameSync(`${files.memory}.tmp`, files.memory);
      writeFileSync(files.md, renderMarkdown());
    } catch (err) { logger.warn(`memory save failed: ${err.message}`); }
  }
  function renderMarkdown() {
    const people = Object.values(memory.people).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    const usage = (items, limit) => `${items.reduce((n, x) => n + x.text.length + 1, 0)}/${limit} chars`;
    return [
      `# 她记得的（第 ${memory.gen} 段，整理过 ${memory.consolidations} 次）`, '',
      `## 关于你（${bankUsage(memory.owner, cfg.limits.owner)}）`, ...memory.owner.map((e) => `- ${e}`), '',
      `## 她自己记下的（${bankUsage(memory.self, cfg.limits.self)}）`, ...memory.self.map((e) => `- ${e}`), '',
      `## 还没了的事（${usage(memory.open, cfg.limits.open)}）`, ...memory.open.map((x) => `- ${x.id} ${renderItem(x)}`), '',
      `## 认识的人（${people.length}）`, ...people.map((p) => renderPerson(p)), '',
      `## 待确认的合并（${memory.merges.length}）`, ...memory.merges.map((m) => `- ${m.id} · ${m.a} + ${m.b}：${m.why}`), '',
    ].join('\n');
  }
  // A 0.19 memory was migrated on load: what is no longer kept goes to memory.v019.json (never
  // overwritten), and memory-migration.md says where everything went.
  if (memory.migration) {
    const { archive, report } = memory.migration;
    delete memory.migration;
    // The archive first, under a name never used before; the migrated memory is saved only once it is
    // on disk (or the whole old file is copied aside) — otherwise what was archived would be lost.
    let kept = '';
    const target = existsSync(files.archive) ? files.archive.replace(/\.json$/, `-${Date.now()}.json`) : files.archive;
    try { writeFileSync(target, JSON.stringify(archive, null, 2)); kept = target; } catch (err) {
      logger.warn(`migration archive ${target}: ${err.message}`);
      const copy = `${files.memory}.pre-0.20-${Date.now()}`;
      try { copyFileSync(files.memory, copy); kept = copy; } catch (err2) { logger.warn(`could not copy the 0.19 memory aside either (${err2.message}): not saving until this is fixed`); frozen = true; }
    }
    try {
      writeFileSync(files.migration, [
        `# 记忆升级到 0.20（${new Date().toISOString()}）`, '',
        `- 还没了的事：${report.open.length} 件进了第三栏（很久没再提的会自己拿掉，原话都还在）`,
        `- 钉住的碎片进了"关于他"：${report.toOwner.length} 条`, ...report.toOwner.map((t) => `  - ${t}`),
        `- 不再保留、存进 ${kept || '（没能写出，memory.json 未改动）'}：碎片 ${report.archived} 条、人物卡上的事实 ${report.facts} 条、待核实 ${report.pending} 条（原话都还在，提到时会翻出来）`, '',
      ].join('\n'));
    } catch (err) { logger.warn(`migration files: ${err.message}`); }
    save();
    audit('migrated', { open: report.open.length, toOwner: report.toOwner.length, archived: report.archived, facts: report.facts, pending: report.pending });
    logger.info(`memory migrated to 0.20: ${report.open.length} open, ${report.archived} fragment(s) archived → ${files.migration}`);
  }
  // 还没了的事 that ran out while dsh was down (or a shelf from 0.23, folded in on load) go now.
  if (expireOpen(memory, keep)) save();

  // ── transcript ──
  let lines = [];
  try { lines = readFileSync(files.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort(byTime); } catch (error) { void error; }
  let lastLineAt = lines.at(-1)?.at ?? 0;
  // Her sessions with a turn running now: what she says outside one (a turn's answer going out after it ended) is complete at once.
  const running = new Set();
  const record = (l) => {
    const line = { at: Date.now(), ...l, text: clip(String(l.text ?? '').trim(), 2000) };
    if (!line.text) return;
    // A qq_send line carries its call's time and arrives at its result: it goes back to its place.
    let i = lines.length;
    while (i > 0 && (lines[i - 1].at ?? 0) > line.at) i--;
    lines.splice(i, 0, line); lastLineAt = Math.max(lastLineAt, line.at);
    if (lines.length > 5000) lines = lines.slice(-4000);
    try { appendFileSync(files.transcript, `${JSON.stringify(line)}\n`); } catch (err) { logger.warn(`transcript write failed: ${err.message}`); }
  };
  const sinceCursor = () => lines.filter((l) => l.at > memory.cursor);
  const recall = createRecall({ cfg, dir, lines: () => lines, transcriptFile: files.transcript, logger, audit: (event, data) => audit(event, data), embedder: config.recallEmbedder });
  const facts = createFacts({ cfg, dir, recall, complete: (text, reason, o) => complete(text, reason, o), lines: () => lines, logger, audit: (event, data) => audit(event, data) });
  // Catch the index up with what happened while dsh was down (the local backend installs on first use).
  ctx.effect(() => { const t = setTimeout(() => { void recall.sync(); }, 20000); t.unref?.(); return () => clearTimeout(t); }, 'dsh-dot/memory: recall index');

  // First run: memory starts after a conversation may already be long. Read that conversation's log
  // once so the first consolidation (and the first handoff) has it.
  let backfilling = null;
  function backfill() {
    if (backfilling) return backfilling;
    backfilling = (async () => {
      if (lines.length || memory.consolidations || memory.backfilled) return 0;
      // A reset left this note: her memory was emptied on purpose, the old conversation is not read back in (src/reset.js).
      if (existsSync(join(home, 'memory', NO_BACKFILL))) return 0;
      const id = dot()?.session?.();
      const sq = ctx.get('sessionQuery');
      if (!id || typeof sq?.readSession !== 'function') { backfilling = null; return 0; }
      try {
        const { events } = await sq.readSession(id);
        const old = transcriptFromEvents(events, id).slice(-400);
        if (!old.length) return 0;
        lines = [...old, ...lines];
        writeFileSync(files.transcript, `${[...lines].map((l) => JSON.stringify(l)).join('\n')}\n`);
        memory.backfilled = { session: id, lines: old.length, at: Date.now() };
        save();
        audit('backfilled', { session: id, lines: old.length });
        logger.info(`backfilled ${old.length} line(s) from ${id}`);
        return old.length;
      } catch (err) { logger.warn(`backfill failed: ${err.message}`); backfilling = null; return 0; }
    })();
    return backfilling;
  }
  ctx.effect(() => { const t = setTimeout(() => { void backfill(); }, 15000); t.unref?.(); return () => clearTimeout(t); }, 'dsh-dot/memory: backfill');

  // Her day runs from when she wakes to when she next wakes (dot.awakeHours); its end is when she falls asleep.
  const awakeHours = () => dot()?.awakeHours ?? ''; // without dsh-dot: calendar days, ending at midnight
  const herDay = (now = new Date()) => dayLabel(new Date(lastStart(awakeHours(), now)));
  // The day that has ended by the clock: the one before her usual hours last ran out.
  const endedDay = (now = new Date()) => herDay(new Date(lastEnd(awakeHours(), now) - 1));
  // With dsh-dot and hours to sleep in, the day ends when she falls asleep (her state, not the clock: a night she is
  // still up talking has not ended); otherwise by the clock.
  const dayToEnd = () => { const d = dot(); if (!d?.sleeps) return endedDay(); return d.asleepSince ? herDay(new Date(d.asleepSince)) : ''; };
  // What a day's end reads: everything since the last one (so the small hours he kept her up are not lost between two days), a day and a half back at most.
  const sinceDayEnd = (now = new Date()) => { const last = Number(memory.lastDiaryAt ?? 0), start = lastStart(awakeHours(), new Date(lastEnd(awakeHours(), now) - 1)); return last > now.getTime() - 36 * 3600000 ? last : start; };
  const dailyDue = () => {
    if (!memory.lastDiary) { memory.lastDiary = endedDay().slice(0, 10); return false; } // a new memory: nothing before it existed; its first day ends tonight
    return memory.lastDiary < dayToEnd().slice(0, 10);
  };
  // A new memory: nothing before it existed, its first day ends tonight (said now, not at the first night: by then the day that has ended is that one).
  if (!memory.lastDiary) memory.lastDiary = endedDay().slice(0, 10);
  const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  // ── her conversation, as it happens ──
  // Which session is hers is dot's to say (dshDot.hers: her conversation, made by the plugin): a session opened by hand
  // in her home is not her conversation, and what is said there is not hers to remember. Without dot, her home.
  const isConversation = (id, cwd) => {
    const d = dot();
    if (d?.retired?.(id)) return false;
    if (typeof d?.hers === 'function') return Boolean(d.hers(id, cwd));
    return Boolean(cwd && inside(home, cwd)) || (Boolean(id) && id === d?.session?.());
  };
  // What she says is on record where it goes out, never worked out from what kind of turn it was: QQ at the moment
  // it has been sent (dshQq.onSent — her qq_send and the relayed answer of a turn alike), every other way out by
  // whoever sends it (api.herSaid: the desktop, another IM, her phone's QQ).
  ctx.inject?.(['dshQq'], (c) => c.effect(() => (c.dshQq ?? ctx.get('dshQq'))?.onSent?.((m) => {
    const text = [(m.said ?? []).join(' / '), ...(m.images ?? []).map(sentImage)].filter(Boolean).join(' ');
    if (!text) return;
    const session = dot()?.session?.() ?? '';
    record({ at: m.at, who: 'her', session, to: m.toOwner ? 'owner' : m.to, text });
    if (!running.has(session)) recall.said();
    const n = /^user:(\d+)$/.exec(String(m.to ?? ''));
    if (n) { touchPerson(memory, { handles: [`qq:${n[1]}`], platform: 'qq', tier: 'talked', kind: 'sent' }); save(); }
  }) ?? (() => {}), 'dsh-dot/memory: her qq words'));
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (!id || !event || !isConversation(id, session?.header?.cwd)) return;
    switch (event.type) {
      case 'turn/start': running.add(id); return;
      case 'user/message': {
        if (event.surfaceOp && event.surfaceOp !== 'append') return;
        const src = event.data?.source ?? {};
        // Wake messages carry a stamp ([11-04 04:51] …); a transcript line has its own time.
        const said = unstamp(contentText(event.data?.content ?? event.data?.message?.content));
        const text = src.kind === 'user' ? ownerSaid(said) : said;
        // A code he just gave her for a sign-in is not kept (dshDot.redact masks it while such a thing is fresh).
        if (src.kind === 'user') record({ who: 'owner', session: id, text: dot()?.redact?.(text) ?? text });
        if (src.kind === 'schedule') record({ who: 'schedule', session: id, text });
        else if (src.kind === 'dsh-dot' && src.form === 'phone-notification') record({ who: 'phone', session: id, text: text.split('\n（')[0] });
        else if (src.kind === 'dsh-dot' && src.form === 'errand-note') record({ who: 'note', session: id, text: text.split('\n（')[0] });
        // What her hands did and found (dot/hands.js): something she did.
        else if (src.kind === 'dsh-dot' && src.form === 'hands-result') record({ who: 'note', session: id, text: factLines(text).slice(0, 600) });
        // What woke her is the query; the result is in front of her before the model is called.
        if (RECALL_WAKES(src) && !dot()?.retired?.(id)) prepareFor(id, src.kind === 'dsh-dot' ? text.split('\n（')[0] : text);
        return;
      }
      case 'turn/end': {
        running.delete(id); recall.clear(id); facts.clear(id); recall.turnEnded();
        if (!dot()?.onSleep && dailyDue()) void dayEnd(); // no dot: no night to end the day on
        void afterTurn(id);
        return;
      }
      default:
    }
  });

  // ── model calls ──
  /** One completion with her default model: { raw, spent } or { error }. Every call is counted in the day's ledger. */
  async function complete(text, reason, { foreground = false } = {}) {
    // A background call thinks at the work effort; the pick, part of answering him, at the model's own — and it must
    // not wait behind his own turn (llm-gate).
    const r = await callModel(ctx, { effort: foreground ? undefined : WORK, background: !foreground, maxTokens: cfg.maxTokens, messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-dot-memory' } })] });
    if (r.outcome.kind === 'no-model') return { skipped: 'no model' };
    if (r.outcome.held) return { skipped: `account held: ${r.outcome.kind}`, held: true }; // not sent (llm-gate): no failure of the call's own
    // Cut short at maxTokens, the words so far are given back marked (facts are lines: the whole ones count; a JSON is not whole).
    if (!r.ok && r.outcome.kind !== 'truncated') {
      const error = outcomeText(r.outcome);
      logger.warn(`${reason} failed: ${error}`); audit('consolidate-failed', { reason, error: clip(error, 200) });
      return { error };
    }
    const raw = r.text, usage = r.usage;
    const spent = usage ? { in: Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0), cached: Number(usage.cacheReadTokens ?? 0), out: Number(usage.outputTokens ?? 0) } : null;
    if (spent) { const d = dayLabel(new Date()).slice(0, 10); if (memory.ledger?.day !== d) memory.ledger = { day: d, in: 0, out: 0, calls: 0 }; memory.ledger.in += spent.in; memory.ledger.out += spent.out; memory.ledger.calls++; }
    return { raw, spent, ...(r.ok ? {} : { truncated: true }) };
  }

  // ── consolidation ──
  // A backlog larger than one call reads (consolidations that failed, a long backfill) is consolidated
  // oldest-first in chunks: the cursor only ever moves past lines the model has actually read, so
  // nothing is skipped.
  // A call that fails (no JSON back — e.g. a reasoning model that spent its whole output budget
  // thinking) must not be retried on every turn with an ever larger backlog: each failure halves the
  // next chunk (down to minChunkLines), and the `lines` trigger waits for another batch of new lines.
  let consolidating = null;
  let failStreak = 0;
  let holdUntil = 0; // the `lines` trigger waits until this many lines are pending
  const chunkLines = () => Math.max(cfg.minChunkLines, Math.floor(cfg.chunkLines / 2 ** failStreak));
  async function consolidate({ reason = 'lines' } = {}) {
    if (consolidating) return consolidating;
    consolidating = (async () => {
      await backfill();
      let result = { skipped: 'nothing new' };
      for (let round = 0; round < 20; round++) {
        const all = sinceCursor();
        if (!all.length) return result;
        const fresh = takeChunk(all.slice(0, chunkLines()), cfg.inputChars);
        result = await consolidateOnce(fresh, { reason: round ? `${reason}+${round}` : reason });
        if (result.held) return result; // the account, not the size of the chunk: tried again as it was
        if (!result.ok) {
          failStreak = Math.min(failStreak + 1, 6);
          holdUntil = sinceCursor().length + cfg.consolidateEveryLines;
          logger.warn(`consolidation failed (${result.error ?? result.skipped}); next try on ${chunkLines()} line(s), after ${cfg.consolidateEveryLines} more`);
          return result;
        }
        failStreak = 0; holdUntil = 0;
        if (fresh.length === all.length) return result;
      }
      return result;
    })();
    try { return await consolidating; } finally { consolidating = null; }
  }
  async function consolidateOnce(fresh, { reason }) {
    const text = fresh.map(transcriptLine).join('\n');
    const known = Object.values(memory.people).filter((p) => p.tier !== 'contact').map((p) => `${p.id} · ${p.names.join('/') || '(无名)'} · ${p.handles.join(', ')} · ${p.tier}${p.impression ? ` · ${p.impression}` : ''}`).join('\n');
    // The items she is shown, in her order (not every stored one: those are many and go by themselves).
    const view = openView(memory, { limits: cfg.limits, ...keep });
    let things = ''; try { things = thingsSection(dot()?.things?.(20) ?? [], fresh[0]?.at ?? 0); } catch (error) { void error; }
    const ask = extractPrompt({ text, known, things, words: memory.words ?? [], open: [...view.today, ...view.list].map((x) => `- ${renderItem(x)}`).join('\n') });
    const r = await complete(ask, 'consolidation');
    if (!r.raw && r.raw !== '') return r;
    try { appendFileSync(files.calls, `${JSON.stringify({ at: new Date().toISOString(), reason, lines: fresh.length, usage: r.spent, reply: clip(r.raw, 4000) })}\n`); } catch (error) { void error; }
    if (r.truncated) { audit('consolidate-failed', { reason, error: `output cut at maxTokens (${r.spent?.out ?? '?'} output tokens)` }); return { error: 'reply cut at maxTokens' }; }
    const out = parseLooseJson(r.raw);
    if (!out) { audit('consolidate-unparsed', { reason, chars: r.raw.length, out: r.spent?.out ?? 0 }); return { error: r.raw.trim() ? 'reply was not JSON' : `empty reply (${r.spent?.out ?? '?'} output tokens: the output cap went to reasoning?)` }; }
    const report = applyExtraction(memory, out, { limits: cfg.limits, ...keep, segment: text });
    for (const e of report.errors) if (e.startsWith('open: done skipped')) logger.warn(e);
    // What the daily call reads instead of these lines (it only reads what no consolidation has).
    const note = typeof out.day === 'string' ? clip(out.day.trim(), 400) : '';
    memory.dayNotes = (memory.dayNotes ?? []).filter((n) => n.at >= startOfToday() - 86400000);
    if (note && !rejectReason(note) && fresh.length) memory.dayNotes.push({ from: fresh[0].at, at: fresh.at(-1).at, text: note });
    memory.cursor = fresh.at(-1)?.at ?? memory.cursor;
    memory.consolidations++;
    save();
    // The facts of the same batch: their own call, after the notes are safe (a failure costs these lines' facts only).
    { const f = await facts.write(fresh); if (f?.error) logger.warn(`facts not written for ${fresh.length} line(s): ${f.error}`); }
    audit('consolidated', { reason, lines: fresh.length, ...report, errors: report.errors.length });
    logger.info(`consolidated ${fresh.length} line(s): words ${report.words}, open +${report.open} / done ${report.done} / expired ${report.expired}, people ${report.people}`);
    return { ok: true, report };
  }

  // ── the daily call: the diary, and the owner / self banks ──
  // Once a day, when anything happened: one call returns the diary and, per bank, only what of the day
  // is lasting — adds and replaces, applied with bankOp (one that does not fit or does not apply is
  // skipped, the rest still go in; a full bank's header asks for a replace). It reads the day's
  // lines no consolidation has read yet; of the lines one has, it reads that call's note (`day`)
  // instead, so no line is paid for twice. What is still unread and longer than inputChars is read
  // in several calls, oldest first, each seeing the banks as the one before left them (the notes go
  // with the first); the diary is the last call's.
  let writingDiary = null;
  async function diary({ reason = 'daily', day = herDay() } = {}) {
    if (writingDiary) return writingDiary;
    writingDiary = (async () => {
      const from = sinceDayEnd();
      const today = lines.filter((l) => l.at >= from && l.at > memory.cursor && rejectReason(l.text) !== 'secret');
      const earlier = (memory.dayNotes ?? []).filter((n) => n.at >= from).map((n) => `[${stamp(n.from)} 到 ${stamp(n.at)} 的摘记] ${n.text}`);
      const banks = !peopleOnly(); // people-only: the banks are the other plugin's; the diary alone
      if (!today.length && !earlier.length) { memory.lastDiary = day.slice(0, 10); memory.lastDiaryAt = Date.now(); save(); return { skipped: 'nothing happened today' }; }
      const notes = {};
      const note = (bank, n) => { if (n) notes[bank] = notes[bank] ? `${notes[bank]}; ${n}` : n; };
      let left = today, out = null, first = true;
      do {
        const part = left.length ? takeChunk(left, cfg.inputChars) : [];
        left = left.slice(part.length);
        const text = [...(first ? earlier : []), ...part.map(transcriptLine)].join('\n');
        first = false;
        const r = await complete(dailyPrompt({ day, text, banks: banks ? { owner: memory.owner, self: memory.self } : null, limits: cfg.limits }), 'daily');
        if (r.raw === undefined) return r;
        try { appendFileSync(files.calls, `${JSON.stringify({ at: new Date().toISOString(), reason, lines: part.length, usage: r.spent, reply: clip(r.raw, 4000) })}\n`); } catch (error) { void error; }
        out = parseLooseJson(r.raw);
        if (banks) for (const bank of BANKS) note(bank, applyOps(bank, out));
      } while (left.length);
      memory.lastDiary = day.slice(0, 10); memory.lastDiaryAt = Date.now();
      memory.dayNotes = [];
      const entry = typeof out?.diary === 'string' ? out.diary.trim().replace(/^["“「]|["”」]$/g, '') : '';
      if (entry && !rejectReason(entry)) { try { appendFileSync(files.diary, `## ${day}\n${entry}\n\n`); } catch (err) { logger.warn(`diary write failed: ${err.message}`); } }
      save();
      audit('diary', { reason, lines: today.length, notes: earlier.length, written: Boolean(entry), banks: Object.keys(notes) });
      logger.info(`daily (${reason}): diary ${entry ? 'written' : 'not written'}${Object.entries(notes).map(([b, n]) => `; ${b} ${n}`).join('')}`);
      return { ok: true, diary: entry, banks: notes };
    })();
    try { return await writingDiary; } finally { writingDiary = null; }
  }
  /**
   * The day's ops on one bank (`<bank>: [{action: add|replace, …}]`), applied in order with bankOp: an
   * op that does not apply (no or several entries match its oldText, a line not kept, an add or a longer
   * replace that does not fit, not an add or a replace) is skipped with a warning, the rest still go in. Returns what happened, or ''.
   */
  function applyOps(bank, out) {
    if (out?.[bank] == null) return '';
    let added = 0, replaced = 0;
    const skipped = [];
    for (const op of [].concat(out[bank])) {
      const r = op && typeof op === 'object' && ['add', 'replace'].includes(op.action) ? bankOp(memory[bank], op, cfg.limits[bank]) : { ok: false, error: `not an add or replace: ${clip(JSON.stringify(op) ?? '', 60)}` };
      if (!r.ok) { skipped.push(r.error); continue; }
      if (r.note) continue; // already there
      noteChange(memory, bank, memory[bank], r.entries, { by: 'daily' });
      memory[bank] = r.entries;
      if (op.action === 'add') added++; else replaced++;
    }
    for (const e of skipped) logger.warn(`daily: ${bank} op skipped (${e})`);
    if (skipped.length) audit('daily-op-skipped', { bank, errors: skipped.map((e) => clip(e, 200)) });
    if (!added && !replaced && !skipped.length) return '';
    return `+${added} added, ${replaced} replaced${skipped.length ? `, ${skipped.length} skipped` : ''} → ${bankUsage(memory[bank], cfg.limits[bank])}`;
  }
  // ── handoff ──
  let handingOff = false;
  async function measure(id) {
    const agent = ctx.get('agents')?.get?.(id);
    const meter = ctx.get('tokenMeter');
    if (!agent || typeof meter?.measure !== 'function') return 0;
    try { return Number(meter.measure(agent.session)?.totalTokens ?? 0); } catch (error) { void error; return 0; }
  }
  async function handoff(fromId, tokens = 0) {
    if (handingOff) return { skipped: 'already' };
    const d = dot();
    const controller = ctx.get('sessionController');
    if (!d || typeof controller?.create !== 'function') return { skipped: 'no dot or session controller' };
    if (d.isIm?.(fromId)) return { skipped: 'IM bot session (its bot owns the binding)' };
    handingOff = true;
    await backfill();
    const release = d.freeze?.() ?? (() => {});
    const t0 = Date.now();
    try {
      // Whatever is new is consolidated first: her notes must be up to date before the old session goes.
      if (consolidating) { try { await consolidating; } catch (error) { void error; } }
      const c = await consolidate({ reason: 'handoff' });
      memory.gen++;
      save();
      // Archive first: a wake that reaches an archived session is dropped without a word.
      try { await ctx.get('workspaceRegistry')?.archiveSession?.(fromId); } catch (err) { logger.warn(`archive of ${fromId} failed: ${err.message}`); }
      const { sessionId } = await (d.createConversation?.(controller) ?? controller.create({ cwd: home }));
      try { await controller.rename?.({ sessionId, title: `dot · 第 ${memory.gen} 段` }); } catch (error) { void error; }
      d.setSession?.(sessionId);
      const tail = lines.filter((l) => l.session === fromId && ['owner', 'her'].includes(l.who)).slice(-cfg.handoffTailLines);
      const note = renderHandoff(tail, memory.gen);
      const found = await controller.resolveAgent(sessionId);
      if (found && !('error' in found)) found.agent.inject?.(createUserMessage({ content: [{ type: 'text', text: note }], source: { ...HANDOFF_SOURCE, generation: memory.gen } }));
      appendFileSync(files.handoffs, `${JSON.stringify({ at: new Date().toISOString(), from: fromId, to: sessionId, gen: memory.gen, tokens, ms: Date.now() - t0, consolidated: Boolean(c?.ok), tail: tail.length })}\n`);
      audit('handoff', { from: fromId, to: sessionId, gen: memory.gen, tokens });
      logger.info(`handoff: ${fromId} → ${sessionId} (第 ${memory.gen} 段, ${tokens} tokens)`);
      return { ok: true, sessionId };
    } catch (err) {
      logger.warn(`handoff failed: ${err.message}`); audit('handoff-failed', { from: fromId, error: clip(err.message, 200) });
      return { error: err.message };
    } finally { release(); handingOff = false; }
  }
  const handoffBase = new Map(); // session → tokens when it was created by a handoff (0) — cooldown baseline
  async function afterTurn(id) {
    if (handingOff) return;
    const tokens = await measure(id);
    const grown = tokens - (handoffBase.get(id) ?? 0);
    if (tokens >= cfg.handoffTokens && grown >= cfg.minTokensBetweenHandoffs) {
      const goal = (() => { try { return ctx.get('goals')?.get(ctx.get('agents')?.get?.(id))?.phase === 'active'; } catch { return false; } })();
      if (goal) { audit('handoff-deferred', { session: id, why: 'goal active' }); return; }
      const r = await handoff(id, tokens);
      if (r.sessionId) handoffBase.set(r.sessionId, 0);
      return;
    }
    const pending = sinceCursor().length;
    if (pending >= cfg.consolidateEveryLines && pending >= holdUntil) void consolidate({ reason: 'lines' });
  }
  // The day's end, once a day, on the night (dshDot.onSleep: when she falls asleep, or after a restart while she
  // sleeps). Without dot her day ends at midnight, and is ended at the first turn of hers after it. A failed diary is
  // tried again the next night, and reads everything since the last one written (sinceDayEnd).
  // The day's unread lines are consolidated first: what he said tonight about tomorrow is in 还没了的事
  // before the day ends, and the diary call reads that call's note, not the lines again. A failed
  // consolidation leaves them unread, and the diary reads them as before.
  let endingDay = null;
  function dayEnd() {
    endingDay ??= (async () => {
      if (sinceCursor().length) { try { await consolidate({ reason: 'day-end' }); } catch (error) { void error; } }
      return diary({ reason: 'daily', day: dayToEnd() || endedDay() });
    })().finally(() => { endingDay = null; });
    return endingDay;
  }
  ctx.inject?.(['dshDot'], (c) => c.effect(() => (c.dshDot ?? dot())?.onSleep?.(() => { if (dailyDue()) void dayEnd(); }) ?? (() => {}), 'dsh-dot/memory: the day ends when she falls asleep'));

  // One query per arrival: asked for where the words are about to reach her (the turn note) and again when they
  // are on record (the session event) — the second asking of the same words is the first.
  const prepared = new Map(); // session → the words last asked about
  const prepareFor = (id, said) => { if (!said || prepared.get(id) === said) return; prepared.set(id, said); void recall.prepare(id, said); void facts.prepare(id, said); };

  // ── what every turn of hers sees ──
  ctx.inject(['systemPrompt'], (scope) => {
    // Her notes: her conversation only — her hands do a job and report, they are not her remembering.
    scope.systemPrompt.context({
      name: 'dot:memory',
      order: 904,
      text: (c) => {
        const s = c.agent?.session;
        if (!s || dot()?.retired?.(s.id) || !isConversation(s.id, s.header?.cwd)) return '';
        return renderStanding(memory, { banks: !peopleOnly(), limits: cfg.limits, ...keep });
      },
    });
  });
  // What recall and the fact strips found for the words that have just reached her go with those words (the short
  // message after them, dshDot.turnNote), not into the snapshot her notes are in: they change with every message, and
  // dsh appends the whole snapshot again when any part of it changes. The query starts here, from the words as they
  // are about to be put in front of her, and is waited for (recallWaitMs / factsWaitMs) — so what it finds is there
  // for the reply to these words, not from the next step on.
  const wakeWords = (messages) => { for (const m of messages ?? []) { const src = m?.source ?? {}; if (!RECALL_WAKES(src)) continue; const said = unstamp(contentText(m.content)); const text = src.kind === 'user' ? ownerSaid(said) : said; return src.kind === 'dsh-dot' ? text.split('\n（')[0] : text; } return ''; };
  const waited = (p, ms) => (p ? Promise.race([p, new Promise((r) => { setTimeout(r, ms).unref?.(); })]) : null);
  ctx.inject?.(['dshDot'], (c) => c.effect(() => {
    const d = c.dshDot ?? ctx.get('dshDot');
    const mine = (agent) => { const s = agent?.session; return s && !d?.retired?.(s.id) && isConversation(s.id, s.header?.cwd) ? s.id : ''; };
    const offs = [
      d?.turnNote?.({ name: 'dot:recall', order: 905, text: async ({ agent, messages }) => { const id = mine(agent); if (!id) return ''; const said = wakeWords(messages); if (said) prepareFor(id, said); await waited(recall.pending(id), cfg.recallWaitMs); return recall.textFor(id); } }),
      d?.turnNote?.({ name: 'dot:facts', order: 906, text: async ({ agent }) => { const id = mine(agent); if (!id) return ''; await waited(facts.pending(id), cfg.factsWaitMs); return facts.textFor(id); } }),
    ];
    return () => { for (const off of offs) off?.(); };
  }, 'dsh-dot/memory: what recall found goes with the words that woke her'));

  // ── her own hands on it ──
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'memory',
      description: '你自己的长期记忆。target：owner=关于他（你的人）；self=你自己的笔记（习惯、看法；人设和说话风格不记，它们在 Canon 里；怎么用手机、App 不记，手艺簿会记）；open=还没了的事（说过要做、答应了、先搁着的）；person=某个你认识的人的一句印象（person 填 id 或名字）。action：add 加一条；replace 改一条（oldText 写原条目里独一无二的一小段）；remove 删一条。open 另有 done（办完了、取消了，oldText 指那条），add/replace 时可带 due（MM-DD）；open 过了日子几天、或没日子很久没再提，会自己拿掉，不用去删。owner、self 有字数上限，满了加不进去：要记新的，先用 replace 换掉一条现在不那么要紧的。只记以后用得上的；具体说过的话不用抄，原话会留着。',
      parameters: { type: 'object', properties: { target: { type: 'string', enum: ['owner', 'self', 'open', 'person'] }, person: { type: 'string' }, action: { type: 'string', enum: ['add', 'replace', 'remove', 'done'] }, content: { type: 'string' }, oldText: { type: 'string' }, due: { type: 'string' } }, required: ['target', 'action'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.ok ? `memory: ${v.usage ?? 'ok'}` : `memory error: ${v?.error}` }] },
      async execute(args) {
        if (args.target === 'person') {
          const p = findPerson(memory.people, args.person);
          if (!p) return { ok: false, error: `不认识 ${args.person}（先和对方打过交道才会有这张卡）` };
          if (p.tier === 'owner') return { ok: false, error: '他的事写在 target=owner' };
          if (!setImpression(memory, p.id, args.action === 'remove' ? '' : args.content, { limits: cfg.limits })) return { ok: false, error: 'not kept' };
          save(); return { ok: true, usage: 'impression' };
        }
        if (args.target === 'open') {
          if (args.action === 'shelve' || args.action === 'restore') return { ok: true, note: `${args.action} 已经没有了：还没了的事一直留着，办完了给 done，过了日子会自己拿掉` };
          const r = openOp(memory, { ...args, action: args.action === 'remove' ? 'done' : args.action });
          if (!r.ok) return { ok: false, error: r.error, items: memory.open.map((x) => x.text) };
          expireOpen(memory, keep);
          save(); audit('memory-tool', { target: 'open', action: args.action });
          return { ok: true, usage: `${memory.open.length} open`, ...(r.note ? { note: r.note } : {}) };
        }
        const bank = args.target === 'owner' ? 'owner' : 'self';
        if (!['add', 'replace', 'remove'].includes(args.action)) return { ok: false, error: `${args.action} is for target=open` };
        const r = bankOp(memory[bank], args, cfg.limits[bank]);
        if (r.full) return { ok: false, error: `这一栏满了（${bankSize(memory[bank])}/${cfg.limits[bank]} 字），没记上：要记这条，用 replace 换掉一条现在不那么要紧的（过去了的一次性的事，或同一件事的旧说法）。`, entries: memory[bank] };
        if (!r.ok) return { ok: false, error: r.error, entries: memory[bank] };
        noteChange(memory, bank, memory[bank], r.entries, { by: 'her' });
        memory[bank] = r.entries; save();
        audit('memory-tool', { target: bank, action: args.action });
        return { ok: true, usage: bankUsage(memory[bank], cfg.limits[bank]), ...(r.note ? { note: r.note } : {}) };
      },
    }), 'dsh-dot/memory: memory tool');
    scope.effect(() => scope.tools.register({
      name: 'recall',
      description: '想不起来的时候翻一翻：在认识的人、还没了的事、和以前真实聊过的原话里找。query 写想找的事或关键词（人名、地点、事情）。',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { found: { type: 'string' } }, required: ['found'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.found ?? '' }] },
      async execute({ query }) {
        const people = search(Object.values(memory.people).map((p) => ({ text: `${p.names.join(' ')} ${p.impression}`, p })), query, 3).map((x) => renderPerson(x.p));
        const items = search(memory.open, query, 5).map((x) => `- ${renderItem(x)}`);
        let said = '';
        try { said = (await recall.find(query)).text; } catch (err) { logger.warn(`recall tool: ${err.message}`); }
        const found = [people.length ? `认识的人：\n${people.join('\n')}` : '', items.length ? `还没了的事：\n${items.join('\n')}` : '', said].filter(Boolean).join('\n\n');
        return { found: found || '没翻到。' };
      },
    }), 'dsh-dot/memory: recall tool');
  });

  // ── the service: dot touches people from real events and shows their cards when they wake her ──
  const api = {
    /** What she said that reached him, as dot delivered it (a QQ turn's answer: the bubbles that went out). */
    /** The last lines between her and him, oldest first: [{ who: 'owner' | 'her', text, at }] — what was said, as it went out. */
    recent(n = 12, { withinMs = 12 * 3600000, now = Date.now() } = {}) {
      return lines.filter((l) => (l.who === 'owner' || (l.who === 'her' && (!l.to || l.to === 'owner'))) && now - l.at <= withinMs).slice(-n).map((l) => ({ who: l.who, text: l.text, at: l.at }));
    },
    herSaid({ session, text, at, to }) {
      if (!String(text ?? '').trim()) return;
      record({ ...(at ? { at } : {}), who: 'her', session, ...(to ? { to: String(to) } : {}), text: String(text) });
      if (!running.has(session)) recall.said();
      const m = /^user:(\d+)$/.exec(String(to ?? ''));
      if (m) { touchPerson(memory, { handles: [`qq:${m[1]}`], platform: 'qq', tier: 'talked', kind: 'sent' }); save(); }
    },
    /** A real event with someone, from any channel: { handles, platform, name, tier, kind }. Returns the person. */
    touch(e) { const p = touchPerson(memory, e); if (p) save(); return p; },
    /** Who is this ({ handles, platform, name }), without recording anything. */
    resolve(e) { return resolvePerson(memory.people, e); },
    /** Whether anyone she really knows goes by this name (any platform). */
    knows(name) { return Object.values(memory.people).some((p) => p.names.includes(name)); },
    card(ref) { return renderPerson(findPerson(memory.people, ref)); },
    setOwner(handle, name) { const p = setOwner(memory, handle, name); save(); return p; },
    /** When the last thing was said in her conversation (his words or hers) before `before`; 0 when nothing. */
    lastSaidAt(before = Date.now()) { for (let i = lines.length - 1; i >= 0; i--) { const l = lines[i]; if (l.at < before && (l.who === 'owner' || l.who === 'her')) return l.at; } return 0; },
    syncFriends(platform, friends) { const r = syncFriends(memory, platform, friends); save(); audit('friends-synced', { platform, friends: friends?.length ?? 0, ...r }); return r; },
    /** Cards for the people in a batch of wake items (their `handles`), deduplicated; the owner is left out. */
    cardsFor(items) {
      const seen = new Set();
      return [].concat(items ?? []).map((n) => resolvePerson(memory.people, { handles: n?.handles ?? (n?.from ? [n.from] : []), platform: n?.platform, name: n?.name }))
        .filter((p) => p && p.tier !== 'owner' && !seen.has(p.id) && seen.add(p.id)).map((p) => renderPerson(p)).join('\n');
    },
    /** For the interlude: her own notes — what she does these days and has learned. Her life is built around these. */
    herLife() { return [...memory.self]; },
    recall,
    facts,
    consolidate, diary, dayEnd, handoff, status: () => ({ gen: memory.gen, owner: memory.owner.length, self: memory.self.length, words: (memory.words ?? []).length, open: memory.open.length, people: Object.keys(memory.people).length, sinceCursor: sinceCursor().length }),
    /** For the panel: notes with their usage, counts, today's ledger, the diary (newest first), her conversation's tokens. */
    async panel() {
      const id = dot()?.session?.();
      const d = dayLabel(new Date()).slice(0, 10);
      let entries = [];
      try { entries = readFileSync(files.diary, 'utf8').split(/^## /m).filter((x) => x.trim()).map((x) => { const [head, ...body] = x.split('\n'); return { day: head.trim(), text: body.join('\n').trim() }; }).reverse().slice(0, 14); } catch (error) { void error; }
      return {
        gen: memory.gen, consolidations: memory.consolidations,
        owner: { entries: memory.owner, chars: memory.owner.reduce((n, e) => n + e.length + 1, 0), limit: cfg.limits.owner },
        self: { entries: memory.self, chars: memory.self.reduce((n, e) => n + e.length + 1, 0), limit: cfg.limits.self },
        open: { entries: memory.open.map((x) => renderItem(x)), chars: memory.open.reduce((n, x) => n + x.text.length + 1, 0), limit: cfg.limits.open },
        people: Object.values(memory.people).filter((p) => p.tier !== 'contact').length, contacts: Object.values(memory.people).filter((p) => p.tier === 'contact').length,
        merges: memory.merges.length, sinceCursor: sinceCursor().length, consolidateEvery: cfg.consolidateEveryLines,
        ledger: memory.ledger?.day === d ? memory.ledger : { day: d, in: 0, out: 0, calls: 0 },
        conversation: { session: id || '', tokens: id ? await measure(id) : 0, handoffAt: cfg.handoffTokens },
        diary: entries, lastDiary: memory.lastDiary ?? null, dayEnds: String(awakeHours()).split('-')[1] ?? '',
        recall: recall.status(),
      };
    },
    /** `/dot memory …` and `/dot people …` */
    async command(arg) {
      const [verb, sub, ...rest] = String(arg ?? '').trim().split(/\s+/);
      if (verb === 'people') {
        if (sub === 'approve' && rest[0]) { const r = approveMerge(memory, rest[0]); if (r.ok) save(); return r.ok ? `merged → ${r.id}` : r.error; }
        if (sub === 'merge' && rest[1]) { const r = mergePeople(memory, rest[0], rest[1], { why: 'manual' }); if (r.ok) save(); return r.ok ? `merged → ${r.id}` : r.error; }
        if (sub === 'forget' && rest[0]) { const p = findPerson(memory.people, [rest[0], ...rest.slice(1)].join(' ')); if (!p || p.tier === 'owner') return 'no such person (or it is you)'; delete memory.people[p.id]; save(); return `forgot ${p.id}`; }
        const all = Object.values(memory.people);
        const people = all.filter((p) => p.tier !== 'contact').sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
        return [`people: ${people.length} (+${all.length - people.length} friends never talked to) · merges to confirm: ${memory.merges.length}`, ...people.slice(0, 30).map((p) => renderPerson(p)), ...(memory.merges.length ? ['merges to confirm (/dot people approve <m…>):', ...memory.merges.map((m) => `  ${m.id} · ${renderPerson(memory.people[m.a]).split('\n')[0]}  +  ${renderPerson(memory.people[m.b]).split('\n')[0]}：${m.why}`)] : [])].join('\n');
      }
      if (sub === 'recall') return recall.command(rest);
      if (sub === 'now') { const r = await consolidate({ reason: 'manual' }); return r.ok ? `consolidated: ${JSON.stringify(r.report)}` : `not run: ${r.skipped ?? r.error}`; }
      if (sub === 'diary') { const r = await diary({ reason: 'manual' }); return r.ok ? `diary → ${files.diary}\n${r.diary}${Object.entries(r.banks ?? {}).map(([b, t]) => `\n${b}: ${t}`).join('')}` : `not run: ${r.skipped ?? r.error}`; }
      if (sub === 'handoff') { const id = dot()?.session?.(); if (!id) return 'no conversation yet'; const r = await handoff(id, await measure(id)); return r.ok ? `handed over → ${r.sessionId}` : `not run: ${r.skipped ?? r.error}`; }
      const s = api.status();
      const id = dot()?.session?.();
      const tokens = id ? await measure(id) : 0;
      const led = memory.ledger?.day === dayLabel(new Date()).slice(0, 10) ? memory.ledger : { in: 0, out: 0, calls: 0 };
      return [`memory: 第 ${s.gen} 段 · owner ${bankUsage(memory.owner, cfg.limits.owner)} · self ${bankUsage(memory.self, cfg.limits.self)} · open ${s.open} · people ${s.people} · today ${led.calls} call(s), ${led.in} in / ${led.out} out tokens · diary ${memory.lastDiary ?? 'never'} (the day ends when she falls asleep; awake ${awakeHours() || 'always, days end at midnight'})`,
        `conversation: ${id || '(none)'} · ${tokens} tokens (handoff at ${cfg.handoffTokens}) · ${s.sinceCursor} line(s) since the last consolidation (every ${cfg.consolidateEveryLines})`,
        (await recall.command([])).split('\n').slice(0, 2).join('\n'),
        `files: ${files.md} · ${files.diary}`, '/dot memory now | diary | handoff | recall … · /dot people [approve <m…> | merge <a> <b> | forget <name>]'].join('\n');
    },
  };
  // Her QQ (dsh-dot/qq): the owner's number makes his card the owner's, and the friend list — the
  // remarks she gave people are what her phone shows — ties phone names to numbers. Re-synced
  // every few hours while QQ is connected.
  let lastFriendSync = 0;
  async function syncQq() {
    const q = ctx.get('dshQq');
    if (!q) return;
    if (q.owner) { const o = ownerOf(memory.people); if (!o || !o.handles.includes(`qq:${q.owner}`)) api.setOwner(`qq:${q.owner}`); }
    if (!q.connected || typeof q.friends !== 'function' || Date.now() - lastFriendSync < 6 * 3600000) return;
    lastFriendSync = Date.now();
    try { api.syncFriends('qq', await q.friends()); } catch (err) { lastFriendSync = 0; logger.warn(`friend list sync failed: ${err.message}`); }
  }
  ctx.effect(() => { const first = setTimeout(() => { void syncQq(); }, 20000); const t = setInterval(() => { void syncQq(); }, 5 * 60000); first.unref?.(); t.unref?.(); return () => { clearTimeout(first); clearInterval(t); }; }, 'dsh-dot/memory: qq identities');

  ctx.provide?.('dotMemory', api);
  logger.info(`memory ready — ${dir}`);
}
