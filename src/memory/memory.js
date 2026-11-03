// dsh-dot/memory: she remembers you, herself, the people she meets, and what happened — and her
// conversation is handed over to a fresh session long before it gets heavy.
//
//   transcript  <home>/memory/transcript.jsonl — what really happened in her conversation: what you
//               said, what she actually sent (qq_send), what her phone showed her, what her errands
//               found. The source for every consolidation and for the `recall` tool.
//   memory      <home>/memory/memory.json (+ memory.md for reading) — banks, people, fragments
//               (see store.js). Shown to every turn of hers as one byte-stable context.
//   consolidate one model call over the transcript since the last one: bank edits, people,
//               fragments. Every `consolidateEveryLines` lines, or after `consolidateIdleMinutes`
//               of quiet, or at a handoff.
//   recall      before each turn, the old turns most like the message that woke her (RAG over the
//               transcript, recall.js): local multilingual-e5-small by default, cloud or off by one command.
//   handoff     after dsh-whale-inurqq's: when her conversation passes `handoffTokens`, consolidate,
//               archive it, open a new one in <home>, and inject a handoff note (what she is doing,
//               what she promised, the last lines verbatim). Deliveries wait meanwhile.
// She edits her memory herself too: `memory` (Hermes-style add/replace/remove) and `recall`.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  DEFAULT_LIMITS, approvePending, ageFragments, bankOp, bankUsage, emptyMemory, findPerson, normalizeMemory,
  observeFragment, handleOf, renderPerson, renderStanding, search, touchPerson, updatePerson, compareFragments, rejectReason,
  resolvePerson, setOwner, ownerOf, proposeMerge, approveMerge, mergePeople, syncFriends, dayMark,
} from './store.js';
import { createRecall } from './recall.js';
import { unstamp } from '../clock.js';
import { sectionOf, setValues } from '../settings.js';
import { configure as configurePrompts, prompt, table } from '../prompts.js';

export const name = 'dot-memory';
export const inject = ['llm', 'agentDefaultModel'];

export const defaults = {
  home: '',
  handoffTokens: 150000,        // her conversation is handed over to a fresh session past this
  minTokensBetweenHandoffs: 40000,
  consolidateEveryLines: 20,    // transcript lines since the last consolidation that trigger one
  consolidateIdleMinutes: 30,   // …or this long quiet with at least 3 new lines
  fragmentBudgetTokens: 600,    // fragments shown to every turn
  agingEveryGens: 5,
  maxFragments: 300,
  handoffTailLines: 12,         // the last lines of the conversation carried verbatim into the new session
  inputChars: 40000,            // transcript characters one consolidation call reads; a larger backlog is read in chunks
  dailyAt: '23:30',             // once a day, after her active hours: consolidate whatever is new and write her diary
  maxTokens: 16384,
  limits: DEFAULT_LIMITS,
  // Living next to another memory plugin. full: everything on. people-only: keep people, fragments
  // and the diary, but leave the owner/self banks (prompt text and consolidation) to the other one,
  // so two plugins do not both narrate what she knows about him. auto: people-only when one of
  // otherMemoryServices is provided (cordis has no public way to list services, so it is a list).
  coexist: 'auto',
  // Names other memory plugins provide. A bare 'memory' is deliberately not here: too generic a name
  // to risk silencing her own banks because something unrelated provides it. Add names as you meet them.
  // Most memory plugins provide no service at all (dsh-auto-memory and friends), so the packages
  // installed next to this one are looked at too: any whose name says "memory" counts.
  otherMemoryServices: ['hermesMemory', 'autoMemory', 'dshMemory', 'memoryBank'],
  // Automatic recall (recall.js). Everything here can also be changed at runtime with
  // /dot memory recall … (saved to $DSH_HOME/dsh-memory.json, which wins over this config).
  recallBackend: 'local',       // local (multilingual-e5-small on this machine, no key) | siliconflow | dashscope | off
  recallModel: '',              // embedding model; '' = the backend's own (local Xenova/multilingual-e5-small · siliconflow BAAI/bge-m3 · dashscope qwen3.7-text-embedding); BAAI/bge-small-zh-v1.5 is the lighter Chinese-only local one
  recallRerankModel: '',        // cloud only; '' = BAAI/bge-reranker-v2-m3 · qwen3.7-text-rerank; 'none' = cosine only
  recallMirror: '',             // where local models download from; '' = $HF_ENDPOINT, else https://hf-mirror.com
  recallInstall: true,          // install @huggingface/transformers into $DSH_HOME/dsh-dot-recall on first use (300–480 MB; not a package dependency)
  recallTransformersVersion: '4.3.2',
  recallTopK: 8,                // turns injected per wake
  recallMaxTokens: 1500,        // …and at most this many tokens of them (the weakest are dropped first)
  // Which hits are worth showing her. Cosines are on a different scale for every model (bge-small-zh
  // 0.35–0.77, multilingual-e5-small 0.78–0.94) and every language, so the defaults are scale-free:
  recallMinQueryLength: 4,      // a waking message with fewer distinct content tokens (CJK characters, other words) recalls nothing: 好的 / 哈哈哈哈 / ok thanks. 0 = off
  recallContrast: 0.35,         // keep a cosine hit only if ≥ median + k·(best − median) over the whole index; 0 = off. Not applied after a reranker
  recallMinScore: 0,            // optional absolute floor (local: cosine; cloud: rerank score); 0 = none. Model-specific: 0.45 suited bge-small-zh, e5 needs ~0.87 and then drops English
  recallCandidates: 40,         // cosine candidates handed to a reranker
  recallWindowTurns: 0,         // 0: skip her whole current session (dsh keeps it in the window); N: skip only the last N turns (hosts that show a window)
  recallChunkChars: 1200,       // one turn's text is clipped to this before embedding
  recallWaitMs: 3000,           // prompt assembly waits this long for a query still running, then goes on without it
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
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** "2026-10-27 周一" — a day as the diary heads it (local time). */
export const dayLabel = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${'周日周一周二周三周四周五周六'.slice(d.getDay() * 2, d.getDay() * 2 + 2)}`; };

/** One transcript line as the consolidation reads it: [MM-DD HH:MM], or [YYYY-MM-DD HH:MM] from another year. */
export function transcriptLine(l, { now = Date.now() } = {}) { // safe as a .map callback: an index is not an options object
  const who = { owner: '他', her: '我', phone: '[手机]', note: '[我刚做的]', schedule: '[定时任务]' }[l.who] ?? l.who;
  const to = l.who === 'her' && l.to && l.to !== 'owner' ? `（发给 ${l.to}）` : '';
  return `[${stamp(l.at, now)}] ${who}${to}：${l.text}`;
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

/** What the consolidation call is asked to do (the JSON it returns, field by field). */
export const extractRules = () => prompt('memory.extract');

/** The whole consolidation prompt: the records, what she already has, the rules, and whether to write a handoff / diary. */
export function extractPrompt({ recent = '', text = '', bankless = false, owner = [], self = [], known = '', frags = '', pending = '', withHandoff = false, withDiary = false, day = '' }) {
  return [
    ...(recent ? [prompt('memory.extract.earlier'), recent, ''] : []),
    prompt('memory.extract.input', {
      records: text || '（这段时间没有新记录）',
      banks: bankless ? prompt('memory.extract.banks.off') : prompt('memory.extract.banks', { owner: owner.map((e) => `- ${e}`).join('\n') || '（空）', self: self.map((e) => `- ${e}`).join('\n') || '（空）' }),
      people: known || '（还没有）', fragments: frags || '（还没有）', pending: pending || '（没有）',
    }),
    '',
    extractRules(),
    `\n${prompt(withHandoff ? 'memory.extract.handoff-yes' : 'memory.extract.handoff-no')}`,
    `\n${withDiary ? prompt('memory.extract.diary-yes', { day }) : prompt('memory.extract.diary-no')}`,
  ].join('\n');
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

/** Apply one consolidation result to the memory. Returns what changed (for the audit and /dot memory). */
export function applyExtraction(memory, out, { limits = DEFAULT_LIMITS, now = Date.now() } = {}) {
  const report = { owner: 0, self: 0, people: 0, pending: 0, fragments: 0, errors: [] };
  for (const bank of ['owner', 'self']) {
    for (const op of [].concat(out?.[bank] ?? [])) {
      const r = bankOp(memory[bank], op, limits[bank]);
      if (r.ok) { if (!r.note) report[bank]++; memory[bank] = r.entries; } else report.errors.push(`${bank}: ${r.error}`);
    }
  }
  for (const u of [].concat(out?.people ?? [])) {
    if (!u || typeof u !== 'object') continue;
    let p = findPerson(memory.people, u.id) ?? resolvePerson(memory.people, { platform: u.platform, name: u.name });
    if (!p && u.name && u.platform) {
      // Someone new she met in an app: a card, tier as the model saw it (never owner).
      const tier = u.tier === 'seen' ? 'seen' : 'talked';
      p = touchPerson(memory, { handles: [handleOf(u.platform, { name: u.name })], platform: u.platform, name: u.name, tier, kind: tier === 'seen' ? 'comment' : 'mention', at: now });
    }
    if (!p) continue;
    const r = updatePerson(memory, { ...u, id: p.id }, { limits, now });
    report.people += r.applied; report.pending += r.pending;
  }
  for (const id of [].concat(out?.confirm ?? [])) { if (approvePending(memory, String(id), limits).ok) report.people++; }
  for (const m of [].concat(out?.same ?? [])) {
    const r = proposeMerge(memory, m?.a, m?.b, { why: m?.why, limits });
    if (r.ok && !r.noop) report.merges = (report.merges ?? 0) + 1;
  }
  for (const f of [].concat(out?.fragments ?? [])) {
    const r = observeFragment(memory, { ...f, gen: memory.gen, now });
    if (r.action === 'new' || r.action === 'dup') report.fragments++;
  }
  return report;
}

/**
 * Transcript lines from a session's raw event log (sessionQuery.readSession): used once, to give
 * memory the conversation that happened before memory was installed.
 */
/** His words as he typed them: without the line dot adds when they were steered into a running turn. */
export const ownerSaid = (text) => { const busy = `\n${prompt('dot.owner-words.busy')}`; return text.endsWith(busy) ? text.slice(0, -busy.length) : text; };

/**
 * What one qq_send really put on QQ, as a transcript line's text ('' = nothing went out), from its
 * `tool/result`: denied or failed → nothing; otherwise the bubbles qq_send reports as sent
 * (`meta.said`, `meta.imagesSent` — an interrupted send, a dropped leak line and an image QQ refused
 * are not in them). A result without that meta (older plugin version, a nested call): the first
 * `sent N` lines of the call's text, then images.
 */
export function qqSentText(args, result) {
  if (!result || result.isError || result.message?.isError) return '';
  const meta = result.meta && typeof result.meta === 'object' ? result.meta : null;
  let said, images;
  if (Array.isArray(meta?.said)) { said = meta.said.map(String); images = Number(meta.imagesSent) || 0; }
  else {
    const parts = String(args?.text ?? '').split(/<sep\s*\/>|\n/i).map((x) => x.trim()).filter(Boolean);
    const refs = [].concat(args?.images ?? []).filter(Boolean).length;
    const m = /^sent (\d+) message/.exec(contentText(result.message?.content ?? result.content));
    const n = m ? Number(m[1]) : parts.length + refs;
    said = parts.slice(0, n); images = Math.min(refs, Math.max(0, n - parts.length));
  }
  const text = said.join(' / ');
  return `${text}${images ? `${text ? ' ' : ''}[图片×${images}]` : ''}`;
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

/** The note a new session opens with after a handoff. */
export function renderHandoff(h, tail, gen) {
  const t = table('memory.handoff', { gen, now: h?.now ?? '' });
  const lines = [t.head];
  if (h?.now) lines.push(t.now);
  const list = (title, xs) => { if (xs?.length) { lines.push(title); for (const x of xs) lines.push(`  - ${x}`); } };
  list(t.inFlight, h?.inFlight);
  list(t.promises, h?.promises);
  list(t.openQuestions, h?.openQuestions);
  if (tail.length) { lines.push(t.tail); for (const l of tail) lines.push(`  ${clip(transcriptLine(l).replace(/\s*\n+\s*/g, ' / '), 240)}`); }
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger('dsh-dot/memory');
  const user = sectionOf('memory', (m) => logger.warn(m));
  const cfg = { ...defaults, ...setValues(config), ...user };
  cfg.limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}), ...(user.limits ?? {}) };
  if (cfg.enabled === false) { logger.info('off (dsh-dot.json: memory.enabled = false)'); return; }
  const home = cfg.home || join(homedir(), 'dot');
  configurePrompts({ home });
  const dir = join(home, 'memory');
  const files = { memory: join(dir, 'memory.json'), md: join(dir, 'memory.md'), transcript: join(dir, 'transcript.jsonl'), handoffs: join(dir, 'handoffs.jsonl'), calls: join(dir, 'calls.jsonl'), diary: join(dir, 'diary.md') };
  mkdirSync(dir, { recursive: true });
  const dot = () => ctx.get('dshDot');
  // Checked when used, not once at boot: the other plugin may start after this one.
  let coexistLogged = false;
  const peopleOnly = () => {
    if (cfg.coexist === 'people-only') return true;
    if (cfg.coexist !== 'auto') return false;
    const other = [].concat(cfg.otherMemoryServices ?? []).find((n) => { try { return ctx.get(n) != null; } catch { return false; } }) || installedMemoryPlugin();
    if (other && !coexistLogged) { coexistLogged = true; logger.info(`another memory service (${other}) is present: people-only mode (owner/self banks left to it)`); }
    return Boolean(other);
  };
  const audit = (event, data = {}) => (ctx.get('dshComputer')?.audit ?? ctx.get('dshPhone')?.audit)?.({ kind: 'memory', event, ...data });
  /** A memory plugin installed in the same profile (a package next to ours whose name says "memory"), or ''. Looked up once. */
  let installedMemory;
  function installedMemoryPlugin() {
    if (installedMemory !== undefined) return installedMemory;
    installedMemory = '';
    try {
      const here = fileURLToPath(import.meta.url);
      const nm = here.slice(0, here.lastIndexOf(`${sep}node_modules${sep}`) + 14);
      if (!nm.endsWith('node_modules')) return installedMemory;
      const names = [];
      for (const n of readdirSync(nm)) { if (n.startsWith('@')) { try { for (const m of readdirSync(join(nm, n))) names.push(`${n}/${m}`); } catch {} } else names.push(n); }
      installedMemory = names.find((n) => /memory/i.test(n) && !/^dsh-dot(-|$)/.test(n) && !n.includes('/dsh-dot')) ?? '';
    } catch {}
    return installedMemory;
  }

  let memory;
  try { memory = normalizeMemory(JSON.parse(readFileSync(files.memory, 'utf8'))); } catch (error) { void error; memory = emptyMemory(); }
  function save() {
    try {
      memory.fragments.sort(compareFragments);
      memory.fragments = memory.fragments.slice(0, cfg.maxFragments);
      writeFileSync(`${files.memory}.tmp`, JSON.stringify(memory, null, 2));
      renameSync(`${files.memory}.tmp`, files.memory);
      writeFileSync(files.md, renderMarkdown());
    } catch (err) { logger.warn(`memory save failed: ${err.message}`); }
  }
  function renderMarkdown() {
    const people = Object.values(memory.people).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    return [
      `# 她记得的（第 ${memory.gen} 段，整理过 ${memory.consolidations} 次）`, '',
      `## 关于你（${bankUsage(memory.owner, cfg.limits.owner)}）`, ...memory.owner.map((e) => `- ${e}`), '',
      `## 她自己记下的（${bankUsage(memory.self, cfg.limits.self)}）`, ...memory.self.map((e) => `- ${e}`), '',
      `## 认识的人（${people.length}）`, ...people.map((p) => renderPerson(p)), '',
      `## 待确认的合并（${memory.merges.length}）`, ...memory.merges.map((m) => `- ${m.id} · ${m.a} + ${m.b}：${m.why}`), '',
      `## 待核实（${memory.pending.length}）`, ...memory.pending.map((x) => `- ${x.id} · ${x.person}：${x.text}`), '',
      `## 碎片（${memory.fragments.length}）`, ...memory.fragments.map((f) => `- ${f.id} [${f.kind}/重要度${f.importance}/${f.refs} 次${f.pinned ? '/📌' : ''}] ${f.text}`), '',
    ].join('\n');
  }

  // ── transcript ──
  let lines = [];
  try { lines = readFileSync(files.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort(byTime); } catch (error) { void error; }
  let lastLineAt = lines.at(-1)?.at ?? 0;
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
  // Catch the index up with what happened while dsh was down (the local backend installs on first use).
  ctx.effect(() => { const t = setTimeout(() => { void recall.sync(); }, 20000); t.unref?.(); return () => clearTimeout(t); }, 'dsh-dot/memory: recall index');

  // First run: memory starts after a conversation may already be long. Read that conversation's log
  // once so the first consolidation (and the first handoff) has it.
  let backfilling = null;
  function backfill() {
    if (backfilling) return backfilling;
    backfilling = (async () => {
      if (lines.length || memory.consolidations || memory.backfilled) return 0;
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

  const dailyDue = () => {
    if (!/^\d{2}:\d{2}$/.test(String(cfg.dailyAt))) return false;
    const now = new Date();
    const today = dayLabel(now).slice(0, 10);
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return hhmm >= cfg.dailyAt && memory.lastDiary !== today;
  };

  // ── her conversation, as it happens ──
  const isConversation = (id, cwd) => {
    const d = dot();
    if (d?.isErrand?.(id)) return false;
    return (cwd && inside(home, cwd)) || id === d?.session?.();
  };
  const turns = new Map(); // session → { sentViaQq, last }
  const qqCalls = new Map(); // qq_send callId → { at, args }, until its tool/result
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (!id || !event || !isConversation(id, session?.header?.cwd)) return;
    const t = turns.get(id) ?? { sentViaQq: false, last: '' };
    switch (event.type) {
      case 'turn/start': turns.set(id, { sentViaQq: false, last: '' }); return;
      case 'user/message': {
        if (event.surfaceOp && event.surfaceOp !== 'append') return;
        const src = event.data?.source ?? {};
        // Wake messages carry a stamp ([11-04 04:51] …); a transcript line has its own time.
        const said = unstamp(contentText(event.data?.content ?? event.data?.message?.content));
        const text = src.kind === 'user' ? ownerSaid(said) : said;
        if (src.kind === 'user') record({ who: 'owner', session: id, text });
        else if (src.kind === 'schedule') record({ who: 'schedule', session: id, text });
        else if (src.kind === 'dsh-dot' && src.form === 'phone-notification') record({ who: 'phone', session: id, text: text.split('\n（')[0] });
        else if (src.kind === 'dsh-dot' && src.form === 'errand-note') record({ who: 'note', session: id, text: text.split('\n（')[0] });
        // What woke her is the query; the result is in front of her before the model is called.
        if (RECALL_WAKES(src) && !dot()?.isErrand?.(id)) void recall.prepare(id, src.kind === 'dsh-dot' ? text.split('\n（')[0] : text);
        return;
      }
      case 'tool/call': {
        // Only qq_send's text is her words; no tool's result is ever recorded (the `account` tool's passwords included).
        // It is recorded when its result says what went out (a denied or cut-off send is not what he got).
        if (event.data?.name !== 'qq_send') return;
        qqCalls.set(event.data.callId, { at: Date.now(), args: parseArgs(event.data.arguments) });
        if (qqCalls.size > 50) qqCalls.delete(qqCalls.keys().next().value);
        t.sentViaQq = true; turns.set(id, t);
        return;
      }
      case 'tool/result': {
        const call = qqCalls.get(event.data?.message?.toolCallId);
        if (!call) return;
        qqCalls.delete(event.data.message.toolCallId);
        const { args } = call;
        const text = qqSentText(args, event.data);
        if (!text) return;
        record({ at: call.at, who: 'her', session: id, to: String(args.to ?? ''), text });
        const m = /^user:(\d+)$/.exec(String(args.to ?? ''));
        const owner = ctx.get('dshQq')?.owner;
        const target = m ? `qq:${m[1]}` : args.to === 'owner' ? (owner ? `qq:${owner}` : ownerOf(memory.people)?.handles[0]) : '';
        if (target) { touchPerson(memory, { handles: [target], platform: 'qq', tier: 'talked', kind: 'sent' }); save(); }
        return;
      }
      case 'assistant/message': if (!event.data?.interrupted) { const text = contentText(event.data?.message?.content); if (text.trim()) { t.last = text; turns.set(id, t); } } return;
      case 'turn/end': {
        turns.delete(id);
        // Her final words count as said only when they were not a QQ turn (desktop / IM bot replies).
        if (!t.sentViaQq && t.last && !isSilent(t.last)) record({ who: 'her', session: id, text: t.last });
        recall.clear(id); recall.turnEnded();
        void afterTurn(id);
        return;
      }
      default:
    }
  });

  // ── consolidation ──
  // A backlog larger than one call reads (consolidations that failed, a long backfill) is consolidated
  // oldest-first in chunks: the cursor only ever moves past lines the model has actually read, so
  // nothing is skipped. The handoff, when asked for, is written with the last chunk.
  let consolidating = null;
  async function consolidate({ withHandoff = false, withDiary = false, reason = 'lines' } = {}) {
    // A handoff needs its own run (it writes the handoff); it waits for one already going.
    if (consolidating && withHandoff) { try { await consolidating; } catch (error) { void error; } }
    if (consolidating) return consolidating;
    consolidating = (async () => {
      await backfill();
      let result = { skipped: 'nothing new' };
      for (let round = 0; round < 20; round++) {
        const all = sinceCursor();
        if (!all.length && !withHandoff && !withDiary) return round ? result : { skipped: 'nothing new' };
        const fresh = takeChunk(all, cfg.inputChars);
        const last = fresh.length === all.length;
        result = await consolidateOnce(fresh, { withHandoff: withHandoff && last, withDiary: withDiary && last, reason: round ? `${reason}+${round}` : reason });
        if (!result.ok || last) return result;
      }
      return result;
    })();
    try { return await consolidating; } finally { consolidating = null; }
  }
  async function consolidateOnce(fresh, { withHandoff, reason, withDiary = false }) {
    {
      const sel = ctx.agentDefaultModel?.currentSelection?.() ?? {};
      if (!ctx.llm?.stream || !sel.model) return { skipped: 'no model' };
      const text = fresh.map(transcriptLine).join('\n');
      const bankless = peopleOnly();
      // A handoff with little new: the last stretch of the conversation, so the handoff can be written.
      const recent = withHandoff && fresh.length < 30 ? lines.filter((l) => l.at <= memory.cursor).slice(-(30 - fresh.length)).map(transcriptLine).join('\n') : '';
      const known = Object.values(memory.people).filter((p) => p.tier !== 'contact').map((p) => `${p.id} · ${p.names.join('/') || '(无名)'} · ${p.handles.join(', ')} · ${p.tier}`).join('\n');
      const frags = [...memory.fragments].sort(compareFragments).slice(0, 40).map((f) => `${f.id} | ${f.text}`).join('\n');
      const ask = extractPrompt({
        recent: recent ? clip(recent, 12000) : '', text, bankless, owner: memory.owner, self: memory.self, known, frags,
        pending: memory.pending.slice(-30).map((x) => `${x.id} | ${x.person} | ${x.text}`).join('\n'),
        withHandoff, withDiary, day: withDiary ? dayLabel(new Date()) : '',
      });
      let raw = '';
      let usage = null;
      try {
        let finish = null;
        for await (const chunk of ctx.llm.stream({ provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}), maxTokens: cfg.maxTokens, messages: [createUserMessage({ content: [{ type: 'text', text: ask }], source: { kind: 'dsh-dot-memory' } })] })) {
          if (chunk.type === 'text-delta') raw += chunk.text;
          if (chunk.type === 'usage') usage = chunk.usage ?? null;
          if (chunk.type === 'finish') finish = chunk.reason;
        }
        if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) throw new Error(`model call ended with ${finish.kind}: ${finish.failure?.message ?? ''}`);
      } catch (err) {
        logger.warn(`consolidation failed: ${err.message}`); audit('consolidate-failed', { reason, error: clip(err.message, 200) });
        return { error: err.message };
      }
      const spent = usage ? { in: Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0), out: Number(usage.outputTokens ?? 0) } : null;
      if (spent) { const d = dayLabel(new Date()).slice(0, 10); if (memory.ledger?.day !== d) memory.ledger = { day: d, in: 0, out: 0, calls: 0 }; memory.ledger.in += spent.in; memory.ledger.out += spent.out; memory.ledger.calls++; }
      try { appendFileSync(files.calls, `${JSON.stringify({ at: new Date().toISOString(), reason, lines: fresh.length, usage: spent, reply: clip(raw, 4000) })}\n`); } catch (error) { void error; }
      const out = parseLooseJson(raw);
      if (!out) { audit('consolidate-unparsed', { reason }); return { error: 'reply was not JSON' }; }
      if (bankless) { delete out.owner; delete out.self; }
      const report = applyExtraction(memory, out, { limits: cfg.limits });
      memory.cursor = fresh.at(-1)?.at ?? memory.cursor;
      memory.consolidations++;
      if (withDiary) {
        memory.lastDiary = dayLabel(new Date()).slice(0, 10);
        const entry = String(out.diary ?? '').trim();
        if (entry && !rejectReason(entry)) { try { appendFileSync(files.diary, `## ${dayLabel(new Date())}\n${entry}\n\n`); report.diary = true; } catch (err) { logger.warn(`diary write failed: ${err.message}`); } }
      }
      save();
      audit('consolidated', { reason, lines: fresh.length, ...report, errors: report.errors.length });
      logger.info(`consolidated ${fresh.length} line(s): owner ${report.owner}, self ${report.self}, people ${report.people} (+${report.pending} pending), fragments ${report.fragments}`);
      return { ok: true, report, handoff: out.handoff ?? null };
    }
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
      const c = await consolidate({ withHandoff: true, reason: 'handoff' });
      memory.gen++;
      const aged = ageFragments(memory, memory.gen, cfg.agingEveryGens);
      save();
      // Archive first: a wake that reaches an archived session is dropped without a word.
      try { await ctx.get('workspaceRegistry')?.archiveSession?.(fromId); } catch (err) { logger.warn(`archive of ${fromId} failed: ${err.message}`); }
      const { sessionId } = await controller.create({ cwd: home });
      try { await controller.rename?.({ sessionId, title: `dot · 第 ${memory.gen} 段` }); } catch (error) { void error; }
      d.setSession?.(sessionId);
      const tail = lines.filter((l) => l.session === fromId && ['owner', 'her'].includes(l.who)).slice(-cfg.handoffTailLines);
      const note = renderHandoff(c?.handoff ?? null, tail, memory.gen);
      const found = await controller.resolveAgent(sessionId);
      if (found && !('error' in found)) found.agent.inject?.(createUserMessage({ content: [{ type: 'text', text: note }], source: { ...HANDOFF_SOURCE, generation: memory.gen } }));
      appendFileSync(files.handoffs, `${JSON.stringify({ at: new Date().toISOString(), from: fromId, to: sessionId, gen: memory.gen, tokens, ms: Date.now() - t0, consolidated: Boolean(c?.ok), aged, note })}\n`);
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
    if (sinceCursor().length >= cfg.consolidateEveryLines) void consolidate({ reason: 'lines' });
  }
  ctx.effect(() => {
    const timer = setInterval(() => {
      const fresh = sinceCursor();
      if (fresh.length >= 3 && Date.now() - lastLineAt >= cfg.consolidateIdleMinutes * 60000) void consolidate({ reason: 'idle' });
      // Once a day at dailyAt: whatever is new is consolidated, and she writes her diary.
      if (dailyDue()) void consolidate({ reason: 'daily', withDiary: true });
    }, 60000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-dot/memory: idle consolidation');

  // ── what every turn of hers sees ──
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'dot:memory',
      order: 904,
      text: (c) => {
        const s = c.agent?.session;
        if (!s || !(dot()?.isErrand?.(s.id) || isConversation(s.id, s.header?.cwd))) return '';
        return renderStanding(memory, { budgetTokens: cfg.fragmentBudgetTokens, banks: !peopleOnly() });
      },
    });
    // The turns recall found for this wake. A dynamic context: dsh puts it after the history, so the
    // cached prefix holds. Her conversation only — errands are not her remembering.
    scope.systemPrompt.context({
      name: 'dot:recall',
      order: 905,
      text: (c) => { const s = c.agent?.session; return s && !dot()?.isErrand?.(s.id) && isConversation(s.id, s.header?.cwd) ? recall.textFor(s.id) : ''; },
    });
    // Contexts are read synchronously; a query still running (a cloud call, a cold model) is waited
    // for here, bounded by recallWaitMs, and its text put into the assembly. Registered on the
    // systemPrompt scope like the interlude's prompt trim (proven on a real dsh); without it the
    // result shows up from the next step on.
    scope.effect(() => scope.on('system-prompt/assemble', async (assembly, c, next) => {
      const id = c?.agent?.session?.id;
      const p = id && recall.pending(id);
      if (p && Array.isArray(assembly?.contexts)) {
        await Promise.race([p, new Promise((r) => { setTimeout(r, cfg.recallWaitMs).unref?.(); })]);
        const entry = assembly.contexts.find((x) => x.name === 'dot:recall');
        const text = recall.textFor(id);
        if (entry) entry.text = text; else if (text) assembly.contexts.push({ name: 'dot:recall', text });
      }
      return next();
    }), 'dsh-dot/memory: recall waits for its query');
  });

  // ── her own hands on it ──
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'memory',
      description: '你自己的长期记忆。target：owner=关于他（你的人），self=你自己的笔记（学会的事、习惯、看法），person=某个你认识的人（person 填 id 或名字）。action：add 加一条；replace 改一条（oldText 写原条目里独一无二的一小段）；remove 删一条。每栏有字数上限，满了先合并或删掉旧的。只记以后用得上的；寒暄和一次性的小事不用记，系统会自己整理。',
      parameters: { type: 'object', properties: { target: { type: 'string', enum: ['owner', 'self', 'person'] }, person: { type: 'string' }, action: { type: 'string', enum: ['add', 'replace', 'remove'] }, content: { type: 'string' }, oldText: { type: 'string' } }, required: ['target', 'action'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.ok ? `memory: ${v.usage ?? 'ok'}` : `memory error: ${v?.error}` }] },
      async execute(args) {
        if (args.target === 'person') {
          const p = findPerson(memory.people, args.person);
          if (!p) return { ok: false, error: `不认识 ${args.person}（先和对方打过交道才会有这张卡）` };
          if (p.tier === 'owner') return { ok: false, error: '他的事写在 target=owner' };
          if (p.tier === 'seen') { if (args.action === 'remove') p.impression = ''; else p.impression = String(args.content ?? '').slice(0, cfg.limits.impression); save(); return { ok: true, usage: 'impression' }; }
          const r = bankOp(p.facts, args, cfg.limits.person);
          if (!r.ok) return { ok: false, error: r.error };
          p.facts = r.entries; save();
          return { ok: true, usage: bankUsage(p.facts, cfg.limits.person) };
        }
        const bank = args.target === 'owner' ? 'owner' : 'self';
        const r = bankOp(memory[bank], args, cfg.limits[bank]);
        if (!r.ok) return { ok: false, error: r.error, entries: memory[bank] };
        memory[bank] = r.entries; save();
        audit('memory-tool', { target: bank, action: args.action });
        return { ok: true, usage: bankUsage(memory[bank], cfg.limits[bank]), note: r.note };
      },
    }), 'dsh-dot/memory: memory tool');
    scope.effect(() => scope.tools.register({
      name: 'recall',
      description: '想不起来的时候翻一翻：在你记得的事、认识的人、和以前真实聊过的原话里找。query 写关键词（人名、地点、事情）。',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { found: { type: 'string' } }, required: ['found'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.found ?? '' }] },
      async execute({ query }) {
        const people = search(Object.values(memory.people).map((p) => ({ text: `${p.names.join(' ')} ${p.impression} ${p.facts.join(' ')}`, p })), query, 3).map((x) => renderPerson(x.p));
        const frags = search(memory.fragments, query, 5).map((f) => `- ${f.text}`);
        const said = search(lines.filter((l) => rejectReason(l.text) !== 'secret'), query, 8).map(transcriptLine);
        const found = [people.length ? `认识的人：\n${people.join('\n')}` : '', frags.length ? `记得的事：\n${frags.join('\n')}` : '', said.length ? `原话：\n${said.join('\n')}` : ''].filter(Boolean).join('\n\n');
        return { found: found || '没翻到。' };
      },
    }), 'dsh-dot/memory: recall tool');
  });

  // ── the service: dot touches people from real events and shows their cards when they wake her ──
  const api = {
    /** A real event with someone, from any channel: { handles, platform, name, tier, kind }. Returns the person. */
    touch(e) { const p = touchPerson(memory, e); if (p) save(); return p; },
    /** Who is this ({ handles, platform, name }), without recording anything. */
    resolve(e) { return resolvePerson(memory.people, e); },
    card(ref) { return renderPerson(findPerson(memory.people, ref)); },
    setOwner(handle, name) { const p = setOwner(memory, handle, name); save(); return p; },
    /** When the last thing was said in her conversation (his words or hers) before `before`; 0 when nothing. */
    lastSaidAt(before = Date.now()) { for (let i = lines.length - 1; i >= 0; i--) { const l = lines[i]; if (l.at < before && (l.who === 'owner' || l.who === 'her')) return l.at; } return 0; },
    syncFriends(platform, friends) { const r = syncFriends(memory, platform, friends, { limits: cfg.limits }); save(); audit('friends-synced', { platform, friends: friends?.length ?? 0, ...r }); return r; },
    /** Cards for the people in a batch of wake items (their `handles`), deduplicated; the owner is left out. */
    cardsFor(items) {
      const seen = new Set();
      return [].concat(items ?? []).map((n) => resolvePerson(memory.people, { handles: n?.handles ?? (n?.from ? [n.from] : []), platform: n?.platform, name: n?.name }))
        .filter((p) => p && p.tier !== 'owner' && !seen.has(p.id) && seen.add(p.id)).map((p) => renderPerson(p)).join('\n');
    },
    /** For the interlude: what she knows to be true (memories, in HDSI's payload terms). */
    forInterlude() { return [...memory.owner.map((e) => `关于他：${e}`), ...[...memory.fragments].sort(compareFragments).slice(0, 12).map((f) => f.text)]; },
    /** For the interlude: her own notes — what she does these days and has learned. Her life is built around these. */
    herLife() { return [...memory.self]; },
    recall,
    consolidate, handoff, status: () => ({ gen: memory.gen, owner: memory.owner.length, self: memory.self.length, people: Object.keys(memory.people).length, pending: memory.pending.length, fragments: memory.fragments.length, sinceCursor: sinceCursor().length }),
    /** For the panel: banks with their usage, counts, today's ledger, the diary (newest first), her conversation's tokens. */
    async panel() {
      const id = dot()?.session?.();
      const d = dayLabel(new Date()).slice(0, 10);
      let diary = [];
      try { diary = readFileSync(files.diary, 'utf8').split(/^## /m).filter((x) => x.trim()).map((x) => { const [head, ...body] = x.split('\n'); return { day: head.trim(), text: body.join('\n').trim() }; }).reverse().slice(0, 14); } catch (error) { void error; }
      return {
        gen: memory.gen, consolidations: memory.consolidations,
        owner: { entries: memory.owner, chars: memory.owner.reduce((n, e) => n + e.length + 1, 0), limit: cfg.limits.owner },
        self: { entries: memory.self, chars: memory.self.reduce((n, e) => n + e.length + 1, 0), limit: cfg.limits.self },
        people: Object.values(memory.people).filter((p) => p.tier !== 'contact').length, contacts: Object.values(memory.people).filter((p) => p.tier === 'contact').length,
        pending: memory.pending.length, merges: memory.merges.length, fragments: memory.fragments.length, sinceCursor: sinceCursor().length,
        ledger: memory.ledger?.day === d ? memory.ledger : { day: d, in: 0, out: 0, calls: 0 },
        conversation: { session: id || '', tokens: id ? await measure(id) : 0, handoffAt: cfg.handoffTokens },
        diary, lastDiary: memory.lastDiary ?? null, dailyAt: cfg.dailyAt,
        recall: recall.status(),
      };
    },
    /** `/dot memory …` and `/dot people …` */
    async command(arg) {
      const [verb, sub, ...rest] = String(arg ?? '').trim().split(/\s+/);
      if (verb === 'people') {
        if (sub === 'approve' && rest[0]) { const r = /^m\d+$/.test(rest[0]) ? approveMerge(memory, rest[0], cfg.limits) : approvePending(memory, rest[0], cfg.limits); if (r.ok) save(); return r.ok ? `approved → ${r.person ?? r.id}` : r.error; }
        if (sub === 'merge' && rest[1]) { const r = mergePeople(memory, rest[0], rest[1], { why: 'manual', limits: cfg.limits }); if (r.ok) save(); return r.ok ? `merged → ${r.id}` : r.error; }
        if (sub === 'drop' && rest[0]) { const n = memory.pending.length; memory.pending = memory.pending.filter((x) => x.id !== rest[0]); save(); return n !== memory.pending.length ? `dropped ${rest[0]}` : `no pending ${rest[0]}`; }
        if (sub === 'forget' && rest[0]) { const p = findPerson(memory.people, [rest[0], ...rest.slice(1)].join(' ')); if (!p || p.tier === 'owner') return 'no such person (or it is you)'; delete memory.people[p.id]; memory.pending = memory.pending.filter((x) => x.person !== p.id); save(); return `forgot ${p.id}`; }
        const all = Object.values(memory.people);
        const people = all.filter((p) => p.tier !== 'contact').sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
        return [`people: ${people.length} (+${all.length - people.length} friends never talked to) · pending: ${memory.pending.length} · merges to confirm: ${memory.merges.length}`, ...people.slice(0, 30).map((p) => renderPerson(p)), ...(memory.merges.length ? ['merges to confirm (/dot people approve <m…>):', ...memory.merges.map((m) => `  ${m.id} · ${renderPerson(memory.people[m.a]).split('\n')[0]}  +  ${renderPerson(memory.people[m.b]).split('\n')[0]}：${m.why}`)] : []), ...(memory.pending.length ? ['pending (/dot people approve <id> | drop <id>):', ...memory.pending.slice(-20).map((x) => `  ${x.id} · ${x.person}：${x.text}`)] : [])].join('\n');
      }
      if (sub === 'recall') return recall.command(rest);
      if (sub === 'now') { const r = await consolidate({ reason: 'manual' }); return r.ok ? `consolidated: ${JSON.stringify(r.report)}` : `not run: ${r.skipped ?? r.error}`; }
      if (sub === 'diary') { const r = await consolidate({ reason: 'manual-diary', withDiary: true }); return r.ok ? `consolidated: ${JSON.stringify(r.report)} → ${files.diary}` : `not run: ${r.skipped ?? r.error}`; }
      if (sub === 'handoff') { const id = dot()?.session?.(); if (!id) return 'no conversation yet'; const r = await handoff(id, await measure(id)); return r.ok ? `handed over → ${r.sessionId}` : `not run: ${r.skipped ?? r.error}`; }
      const s = api.status();
      const id = dot()?.session?.();
      const tokens = id ? await measure(id) : 0;
      const led = memory.ledger?.day === dayLabel(new Date()).slice(0, 10) ? memory.ledger : { in: 0, out: 0, calls: 0 };
      return [`memory: 第 ${s.gen} 段 · owner ${bankUsage(memory.owner, cfg.limits.owner)} · self ${bankUsage(memory.self, cfg.limits.self)} · people ${s.people} (+${s.pending} pending) · fragments ${s.fragments} · today ${led.calls} call(s), ${led.in} in / ${led.out} out tokens · diary ${memory.lastDiary ?? 'never'} (daily at ${cfg.dailyAt})`,
        `conversation: ${id || '(none)'} · ${tokens} tokens (handoff at ${cfg.handoffTokens}) · ${s.sinceCursor} line(s) since the last consolidation (every ${cfg.consolidateEveryLines}, or ${cfg.consolidateIdleMinutes} min quiet)`,
        (await recall.command([])).split('\n').slice(0, 2).join('\n'),
        `files: ${files.md} · ${files.diary}`, '/dot memory now | diary | handoff | recall … · /dot people [approve <id> | drop <id> | merge <a> <b> | forget <name>]'].join('\n');
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
