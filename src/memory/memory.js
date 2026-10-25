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
//   handoff     after dsh-whale-inurqq's: when her conversation passes `handoffTokens`, consolidate,
//               archive it, open a new one in <home>, and inject a handoff note (what she is doing,
//               what she promised, the last lines verbatim). Deliveries wait meanwhile.
// She edits her memory herself too: `memory` (Hermes-style add/replace/remove) and `recall`.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  DEFAULT_LIMITS, approvePending, ageFragments, bankOp, bankUsage, emptyMemory, findPerson, normalizeMemory,
  observeFragment, personId, renderPerson, renderStanding, search, touchPerson, updatePerson, compareFragments,
} from './store.js';

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
  inputChars: 40000,            // transcript characters a consolidation reads (newest kept)
  maxTokens: 16384,
  limits: DEFAULT_LIMITS,
};

export const HANDOFF_SOURCE = Object.freeze({ kind: 'handoff' });

const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const contentText = (content) => (typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join(''));
const isSilent = (t) => /^[`*\s]*DOT_SILENT[`*\s。.]*$/.test(String(t ?? ''));
const stamp = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One transcript line as the consolidation reads it. */
export function transcriptLine(l) {
  const who = { owner: '他', her: '我', phone: '[手机]', note: '[我刚做的]', schedule: '[定时任务]' }[l.who] ?? l.who;
  const to = l.who === 'her' && l.to && l.to !== 'owner' ? `（发给 ${l.to}）` : '';
  return `[${stamp(l.at)}] ${who}${to}：${l.text}`;
}

export const EXTRACT_RULES = `你在帮她整理记忆。上面是她这段时间真实发生的事（"他"是她的人；"我"是她自己真正发出去的话；[手机] 是手机通知；[我刚做的] 是她自己在手机上做过的事）。只根据这些记录，不要猜，不要补。

只输出一个 JSON 对象，不要代码围栏，不要解释：
{
  "owner": [{"action":"add|replace|remove","content":"...","oldText":"..."}],
  "self": [{"action":"add|replace|remove","content":"...","oldText":"..."}],
  "people": [{"id":"已知的 id，没有就留空","platform":"qq/wechat/xiaoheihe/bilibili/…","name":"名字","tier":"talked|seen","impression":"一句话印象，20 字以内","facts":["关于这个人的具体事"]}],
  "fragments": [{"text":"...","kind":"event|plan|promise|preference|fact","tag":0,"mergeWith":null}],
  "confirm": ["这段记录又一次证实了的待核实条目 id"],
  "handoff": {"now":"她此刻在做什么、什么心情","inFlight":[],"promises":[],"openQuestions":[]}
}

各栏怎么写：
- owner：关于他、长期有效的事（他是谁、在做什么、喜好、雷点、称呼、长期计划）。一次性的事不进这里，进 fragments。已有的条目要改就 replace（oldText 写原条目里一小段），过时了就 remove。每条一句话。
- self：她自己长期的东西：学会了什么（装了什么 App、学会怎么用）、形成的习惯、自己的看法。不写她的设定（设定在别处）。
- people：除了他以外，这段记录里和她真正打过交道的人。互发过消息的 tier=talked；只是看/点赞/评论过对方帖子的 tier=seen（seen 只写 impression，不写 facts）。不确定是不是同一个人就别合并。
- fragments：这段时间发生的具体的事，每条 60 字以内，保留时间、人名、数字、地点。tag：0=知道就行；1=影响接下来怎么说话（他今天心情、正在做的事、刚纠正过的说法）；2=不记住就会出错（他的计划和截止、她答应过的事、他明确的要求）。和已有碎片说的是同一件事就给 mergeWith（填已有 id），拿不准就新增。
- confirm：待核实清单里，这段记录明确又证实了一次的条目，填它们的 id。
- handoff：只有要求时才写，否则给 null。
- 没有可写的就给空数组。寒暄、语气词、系统和工具的事一律不记。`;

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
    let p = findPerson(memory.people, u.id) ?? findPerson(memory.people, u.name);
    if (!p && u.name && u.platform) {
      // Someone new she met in an app: a card, tier as the model saw it (never owner).
      const tier = u.tier === 'seen' ? 'seen' : 'talked';
      p = touchPerson(memory.people, { id: personId(u.platform, `name:${String(u.name).trim()}`), name: u.name, platform: u.platform, tier, kind: tier === 'seen' ? 'comment' : 'mention', at: now });
    }
    if (!p) continue;
    const r = updatePerson(memory, { ...u, id: p.id }, { limits, now });
    report.people += r.applied; report.pending += r.pending;
  }
  for (const id of [].concat(out?.confirm ?? [])) { if (approvePending(memory, String(id), limits).ok) report.people++; }
  for (const f of [].concat(out?.fragments ?? [])) {
    const r = observeFragment(memory, { ...f, gen: memory.gen, now });
    if (r.action === 'new' || r.action === 'dup') report.fragments++;
  }
  return report;
}

/** The note a new session opens with after a handoff. */
export function renderHandoff(h, tail, gen) {
  const lines = [`【交接 · 第 ${gen} 段】这是你自己上一段对话留下的交接，不是谁的新消息；接着往下过就行，别回应它，也别提"交接"。`];
  if (h?.now) lines.push(`· 你此刻：${h.now}`);
  const list = (title, xs) => { if (xs?.length) { lines.push(`· ${title}：`); for (const x of xs) lines.push(`  - ${x}`); } };
  list('手上还没做完的', h?.inFlight);
  list('你答应过的', h?.promises);
  list('还没问清、或他还没回的', h?.openQuestions);
  if (tail.length) { lines.push('· 上一段最后几句（原文）：'); for (const l of tail) lines.push(`  ${transcriptLine(l)}`); }
  return lines.join('\n');
}

export function apply(ctx, config = {}) {
  const cfg = { ...defaults, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '')) };
  cfg.limits = { ...DEFAULT_LIMITS, ...(config.limits ?? {}) };
  const logger = ctx.logger('dsh-dot/memory');
  const home = cfg.home || join(homedir(), 'dot');
  const dir = join(home, 'memory');
  const files = { memory: join(dir, 'memory.json'), md: join(dir, 'memory.md'), transcript: join(dir, 'transcript.jsonl'), handoffs: join(dir, 'handoffs.jsonl'), calls: join(dir, 'calls.jsonl') };
  mkdirSync(dir, { recursive: true });
  const dot = () => ctx.get('dshDot');
  const audit = (event, data = {}) => (ctx.get('dshComputer')?.audit ?? ctx.get('dshPhone')?.audit)?.({ kind: 'memory', event, ...data });

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
      `## 待核实（${memory.pending.length}）`, ...memory.pending.map((x) => `- ${x.id} · ${x.person}：${x.text}`), '',
      `## 碎片（${memory.fragments.length}）`, ...memory.fragments.map((f) => `- ${f.id} [${f.kind}/重要度${f.importance}/${f.refs} 次${f.pinned ? '/📌' : ''}] ${f.text}`), '',
    ].join('\n');
  }

  // ── transcript ──
  let lines = [];
  try { lines = readFileSync(files.transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (error) { void error; }
  let lastLineAt = lines.at(-1)?.at ?? 0;
  const record = (l) => {
    const line = { at: Date.now(), ...l, text: clip(String(l.text ?? '').trim(), 2000) };
    if (!line.text) return;
    lines.push(line); lastLineAt = line.at;
    if (lines.length > 5000) lines = lines.slice(-4000);
    try { appendFileSync(files.transcript, `${JSON.stringify(line)}\n`); } catch (err) { logger.warn(`transcript write failed: ${err.message}`); }
  };
  const sinceCursor = () => lines.filter((l) => l.at > memory.cursor);

  // ── her conversation, as it happens ──
  const isConversation = (id, cwd) => {
    const d = dot();
    if (d?.isErrand?.(id)) return false;
    return (cwd && inside(home, cwd)) || id === d?.session?.();
  };
  const turns = new Map(); // session → { sentViaQq, last }
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (!id || !event || !isConversation(id, session?.header?.cwd)) return;
    const t = turns.get(id) ?? { sentViaQq: false, last: '' };
    switch (event.type) {
      case 'turn/start': turns.set(id, { sentViaQq: false, last: '' }); return;
      case 'user/message': {
        if (event.surfaceOp && event.surfaceOp !== 'append') return;
        const src = event.data?.source ?? {};
        const text = contentText(event.data?.content ?? event.data?.message?.content);
        if (src.kind === 'user') record({ who: 'owner', session: id, text });
        else if (src.kind === 'schedule') record({ who: 'schedule', session: id, text });
        else if (src.kind === 'dsh-dot' && src.form === 'phone-notification') record({ who: 'phone', session: id, text: text.split('\n（')[0] });
        else if (src.kind === 'dsh-dot' && src.form === 'errand-note') record({ who: 'note', session: id, text: text.split('\n（')[0] });
        return;
      }
      case 'tool/call': {
        if (event.data?.name !== 'qq_send') return;
        let args = {};
        try { args = JSON.parse(event.data.arguments ?? '{}'); } catch (error) { void error; }
        const text = String(args.text ?? '').replace(/<sep\s*\/>/gi, ' / ');
        const images = [].concat(args.images ?? []).length;
        record({ who: 'her', session: id, to: String(args.to ?? ''), text: `${text}${images ? `${text ? ' ' : ''}[图片×${images}]` : ''}` });
        t.sentViaQq = true; turns.set(id, t);
        const m = /^user:(\d+)$/.exec(String(args.to ?? ''));
        const owner = ctx.get('dshQq')?.owner;
        if (m || (args.to === 'owner' && owner)) { touchPerson(memory.people, { id: m ? `qq:${m[1]}` : `qq:${owner}`, tier: (!m || m[1] === String(owner)) ? 'owner' : 'talked', kind: 'sent' }); save(); }
        return;
      }
      case 'assistant/message': if (!event.data?.interrupted) { const text = contentText(event.data?.message?.content); if (text.trim()) { t.last = text; turns.set(id, t); } } return;
      case 'turn/end': {
        turns.delete(id);
        // Her final words count as said only when they were not a QQ turn (desktop / IM bot replies).
        if (!t.sentViaQq && t.last && !isSilent(t.last)) record({ who: 'her', session: id, text: t.last });
        void afterTurn(id);
        return;
      }
      default:
    }
  });

  // ── consolidation ──
  let consolidating = null;
  async function consolidate({ withHandoff = false, reason = 'lines' } = {}) {
    if (consolidating) return consolidating;
    consolidating = (async () => {
      const fresh = sinceCursor();
      if (!fresh.length && !withHandoff) return { skipped: 'nothing new' };
      const sel = ctx.agentDefaultModel?.currentSelection?.() ?? {};
      if (!ctx.llm?.stream || !sel.model) return { skipped: 'no model' };
      let text = fresh.map(transcriptLine).join('\n');
      if (text.length > cfg.inputChars) text = `…${text.slice(-cfg.inputChars)}`;
      const known = Object.values(memory.people).map((p) => `${p.id} · ${p.names.join('/') || '(无名)'} · ${p.tier}`).join('\n');
      const frags = [...memory.fragments].sort(compareFragments).slice(0, 40).map((f) => `${f.id} | ${f.text}`).join('\n');
      const prompt = [
        '=== 这段时间的记录 ===', text || '（这段时间没有新记录）', '',
        '=== 已有：关于他 ===', memory.owner.map((e) => `- ${e}`).join('\n') || '（空）',
        '=== 已有：她自己记下的 ===', memory.self.map((e) => `- ${e}`).join('\n') || '（空）',
        '=== 已认识的人 ===', known || '（还没有）',
        '=== 已有碎片 ===', frags || '（还没有）',
        '=== 待核实（关于别人的事，说过一次）===', memory.pending.slice(-30).map((x) => `${x.id} | ${x.person} | ${x.text}`).join('\n') || '（没有）', '',
        EXTRACT_RULES,
        withHandoff ? '\n这次要写 handoff：她马上换到一段新对话，handoff 让她接得上。' : '\nhandoff 给 null。',
      ].join('\n');
      let raw = '';
      try {
        let finish = null;
        for await (const chunk of ctx.llm.stream({ provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}), maxTokens: cfg.maxTokens, messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'dsh-dot-memory' } })] })) {
          if (chunk.type === 'text-delta') raw += chunk.text;
          if (chunk.type === 'finish') finish = chunk.reason;
        }
        if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) throw new Error(`model call ended with ${finish.kind}: ${finish.failure?.message ?? ''}`);
      } catch (err) {
        logger.warn(`consolidation failed: ${err.message}`); audit('consolidate-failed', { reason, error: clip(err.message, 200) });
        return { error: err.message };
      }
      try { appendFileSync(files.calls, `${JSON.stringify({ at: new Date().toISOString(), reason, lines: fresh.length, reply: clip(raw, 4000) })}\n`); } catch (error) { void error; }
      const out = parseLooseJson(raw);
      if (!out) { audit('consolidate-unparsed', { reason }); return { error: 'reply was not JSON' }; }
      const report = applyExtraction(memory, out, { limits: cfg.limits });
      memory.cursor = fresh.at(-1)?.at ?? memory.cursor;
      memory.consolidations++;
      save();
      audit('consolidated', { reason, lines: fresh.length, ...report, errors: report.errors.length });
      logger.info(`consolidated ${fresh.length} line(s): owner ${report.owner}, self ${report.self}, people ${report.people} (+${report.pending} pending), fragments ${report.fragments}`);
      return { ok: true, report, handoff: out.handoff ?? null };
    })();
    try { return await consolidating; } finally { consolidating = null; }
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
        return renderStanding(memory, { budgetTokens: cfg.fragmentBudgetTokens });
      },
    });
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
        const said = search(lines, query, 8).map(transcriptLine);
        const found = [people.length ? `认识的人：\n${people.join('\n')}` : '', frags.length ? `记得的事：\n${frags.join('\n')}` : '', said.length ? `原话：\n${said.join('\n')}` : ''].filter(Boolean).join('\n\n');
        return { found: found || '没翻到。' };
      },
    }), 'dsh-dot/memory: recall tool');
  });

  // ── the service: dot touches people from real events and shows their cards when they wake her ──
  const api = {
    touch(e) { const p = touchPerson(memory.people, e); if (p) save(); return p; },
    card(ref) { return renderPerson(findPerson(memory.people, ref)); },
    /** Cards for the people in a batch of wake items (those with `from`), deduplicated. */
    cardsFor(items) {
      const ids = [...new Set([].concat(items ?? []).map((n) => n?.from).filter(Boolean))];
      return ids.map((id) => findPerson(memory.people, id)).filter((p) => p && p.tier !== 'owner').map((p) => renderPerson(p)).join('\n');
    },
    /** For the interlude: what she knows to be true (memories, in HDSI's payload terms). */
    forInterlude() { return [...memory.owner.map((e) => `关于他：${e}`), ...memory.self.map((e) => `她自己：${e}`), ...[...memory.fragments].sort(compareFragments).slice(0, 12).map((f) => f.text)]; },
    consolidate, handoff, status: () => ({ gen: memory.gen, owner: memory.owner.length, self: memory.self.length, people: Object.keys(memory.people).length, pending: memory.pending.length, fragments: memory.fragments.length, sinceCursor: sinceCursor().length }),
    /** `/dot memory …` and `/dot people …` */
    async command(arg) {
      const [verb, sub, ...rest] = String(arg ?? '').trim().split(/\s+/);
      if (verb === 'people') {
        if (sub === 'approve' && rest[0]) { const r = approvePending(memory, rest[0], cfg.limits); if (r.ok) save(); return r.ok ? `approved → ${r.person}` : r.error; }
        if (sub === 'drop' && rest[0]) { const n = memory.pending.length; memory.pending = memory.pending.filter((x) => x.id !== rest[0]); save(); return n !== memory.pending.length ? `dropped ${rest[0]}` : `no pending ${rest[0]}`; }
        if (sub === 'forget' && rest[0]) { const p = findPerson(memory.people, [rest[0], ...rest.slice(1)].join(' ')); if (!p || p.tier === 'owner') return 'no such person (or it is you)'; delete memory.people[p.id]; memory.pending = memory.pending.filter((x) => x.person !== p.id); save(); return `forgot ${p.id}`; }
        const people = Object.values(memory.people).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
        return [`people: ${people.length} · pending: ${memory.pending.length}`, ...people.slice(0, 30).map((p) => renderPerson(p)), ...(memory.pending.length ? ['pending (/dot people approve <id> | drop <id>):', ...memory.pending.slice(-20).map((x) => `  ${x.id} · ${x.person}：${x.text}`)] : [])].join('\n');
      }
      if (sub === 'now') { const r = await consolidate({ reason: 'manual' }); return r.ok ? `consolidated: ${JSON.stringify(r.report)}` : `not run: ${r.skipped ?? r.error}`; }
      if (sub === 'handoff') { const id = dot()?.session?.(); if (!id) return 'no conversation yet'; const r = await handoff(id, await measure(id)); return r.ok ? `handed over → ${r.sessionId}` : `not run: ${r.skipped ?? r.error}`; }
      const s = api.status();
      const id = dot()?.session?.();
      const tokens = id ? await measure(id) : 0;
      return [`memory: 第 ${s.gen} 段 · owner ${bankUsage(memory.owner, cfg.limits.owner)} · self ${bankUsage(memory.self, cfg.limits.self)} · people ${s.people} (+${s.pending} pending) · fragments ${s.fragments}`,
        `conversation: ${id || '(none)'} · ${tokens} tokens (handoff at ${cfg.handoffTokens}) · ${s.sinceCursor} line(s) since the last consolidation (every ${cfg.consolidateEveryLines}, or ${cfg.consolidateIdleMinutes} min quiet)`,
        `files: ${files.md}`, '/dot memory now | handoff · /dot people [approve <id> | drop <id> | forget <name>]'].join('\n');
    },
  };
  ctx.provide?.('dotMemory', api);
  logger.info(`memory ready — ${dir}`);
}
