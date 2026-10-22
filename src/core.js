// dsh-interlude/core: 幕间 — what the agent does between conversations.
//
// A conversation with the user is an act. When the acts in <home> have been quiet for a while, the
// agent gets one model call of its own: it reads its identity file, its current self-state and its
// last journal entries, sees a digest of what just happened, and writes two things —
//   1. a short first-person journal entry (<home>/interlude/journal.md, append-only, human-readable);
//   2. a small self-state (<home>/interlude/state.json): mood in one line, open threads, follow-ups.
// Both are carried into every later turn in <home> as a system-prompt context placed after the
// conversation history, so the stable prompt prefix stays cached. No database, no retrieval, no
// tools: the interlude is one bounded call per quiet period, metered by dsh-budget like any other.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-interlude';
export const inject = ['llm', 'agentDefaultModel'];

export const defaults = {
  home: '',                  // default ~/dot; acts are sessions whose cwd is inside it
  identityFile: '',          // default <home>/AGENTS.md; who the agent is (shared with dsh-dot)
  idleMinutes: 20,           // an act is over when nothing has happened in <home> for this long
  minIntervalMinutes: 45,    // at most one interlude per this interval
  maxPerDay: 8,
  maxTokens: 700,
  digestChars: 6000,         // how much of the recent acts the interlude sees
  journalEntriesInPrompt: 3, // how many recent entries later turns see
  speak: false,              // allow the interlude to send one line to the user over dsh-im
  imBot: '',
  imTarget: '',
};

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const dayOf = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const stamp = (d = new Date()) => d.toLocaleString('zh-CN', { hour12: false });

/** Text of a message content array (or string). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The interlude's own instructions; the identity file says who is speaking. */
export function buildPrompt({ identity, state, journal, digest, speak }) {
  const system = [
    identity ? `# 你是谁\n${identity.trim()}` : '',
    '# 现在是幕间',
    '用户不在。这是你和用户的两段相处之间、属于你自己的片刻。下面是刚刚发生的事的摘录、你上次的状态和日记。',
    '请只输出一个 JSON 对象（可以放在 ```json 代码块里），字段：',
    '- "journal": 一段第一人称的日记，120 字以内。写真实发生的事和你怎么看它，不写套话，不复述对话。',
    '- "state": { "mood": "一句话描述此刻的状态", "threads": ["正在进行、还没完的事，最多 5 条"], "followups": ["下次见面值得主动提的事，最多 3 条；没有就空数组"] }',
    speak ? '- "say": 一句想现在就告诉用户的话；没有必要就留空字符串。只在真的有事时才说。' : '- "say": 留空字符串。',
    '规则：不编造没发生的事；state 要能接着上次的；没有值得写的就写得短。',
  ].filter(Boolean).join('\n');
  const user = [
    state ? `## 上次的状态\n${JSON.stringify(state, null, 0)}` : '## 上次的状态\n（还没有）',
    journal ? `## 最近的日记\n${journal}` : '',
    `## 刚刚发生的事\n${digest || '（没有记录）'}`,
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Pull the JSON object out of a model reply (fenced or bare). */
export function parseReply(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const o = JSON.parse(c);
      if (o && typeof o === 'object') {
        return {
          journal: String(o.journal ?? '').trim(),
          state: {
            mood: String(o.state?.mood ?? '').trim(),
            threads: [].concat(o.state?.threads ?? []).map(String).slice(0, 5),
            followups: [].concat(o.state?.followups ?? []).map(String).slice(0, 3),
          },
          say: String(o.say ?? '').trim(),
        };
      }
    } catch (error) { void error; /* try the next candidate */ }
  }
  return null;
}

/** Render the context later turns see. */
export function renderContext({ state, entries, lastAt, restarted, now = Date.now() }) {
  if (!state && !entries.length) return '';
  const ago = lastAt ? Math.round((now - lastAt) / 60000) : null;
  const lines = ['<interlude>', '幕间（你在两次相处之间写下的，只有你自己看）'];
  if (ago !== null) lines.push(`上次幕间：${ago < 60 ? `${ago} 分钟前` : `${Math.round(ago / 60)} 小时前`}${restarted ? '；期间 dsh 重启过' : ''}`);
  if (state?.mood) lines.push(`状态：${state.mood}`);
  if (state?.threads?.length) lines.push(`在做的事：${state.threads.join('；')}`);
  if (state?.followups?.length) lines.push(`想主动提的：${state.followups.join('；')}`);
  if (entries.length) lines.push('最近的日记：', ...entries.map((e) => `- ${e}`));
  lines.push('</interlude>');
  return clip(lines.join('\n'), 2000);
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { void error; return fallback; }
}

/** Last n entries of the journal, newest last, each flattened to one line. */
export function readJournal(file, n) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch (error) { void error; return []; }
  return text.split(/^## /m).filter((s) => s.trim()).slice(-n)
    .map((s) => { const [head, ...body] = s.split('\n'); return `${head.trim()}：${body.join(' ').replace(/\s+/g, ' ').trim()}`; });
}

/** Collect the model reply text from an llm stream. */
export async function collectText(stream) {
  let text = '';
  let finish = null;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text;
    if (chunk.type === 'finish') finish = chunk.reason;
  }
  // FinishReason kinds: stop | tool-calls | max-tokens | aborted | error (merge-extensible).
  if (finish && (finish.kind === 'aborted' || finish.kind === 'error')) {
    throw new Error(`interlude model call ended with ${finish.kind}: ${finish.failure?.message ?? finish.failure?.code ?? ''}`);
  }
  return text;
}

export function apply(ctx, config = {}) {
  const cfg = { ...defaults, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '')) };
  const logger = ctx.logger('dsh-interlude');
  const home = cfg.home || join(homedir(), 'dot');
  const dir = join(home, 'interlude');
  const identityFile = cfg.identityFile || join(home, 'AGENTS.md');
  const files = { journal: join(dir, 'journal.md'), state: join(dir, 'state.json'), pending: join(dir, 'pending.jsonl'), calls: join(dir, 'calls.jsonl') };
  mkdirSync(dir, { recursive: true });
  const startedAt = Date.now();
  const audit = (event, data = {}) => ctx.get('dshComputer')?.audit?.({ kind: 'interlude', event, ...data });

  // Self-state and bookkeeping.
  const state = readJson(files.state, null);
  const meta = { ...{ lastAt: 0, count: 0, dayCount: 0, day: dayOf() }, ...readJson(join(dir, 'meta.json'), {}) };
  const saveMeta = () => { try { writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2)); } catch (error) { void error; } };
  let current = state;

  // 1. Watch the acts: turns in <home>.
  const turns = new Map(); // session id → { origin, user, assistant, approvals, tools }
  const homeSessions = new Set();
  let lastActivity = 0;
  let running = 0;
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    const cwd = session?.header?.cwd;
    if (!id || !event) return;
    if (cwd && inside(home, cwd)) homeSessions.add(id);
    if (!homeSessions.has(id)) return;
    const t = turns.get(id);
    switch (event.type) {
      case 'turn/start':
        turns.set(id, { origin: 'user', user: '', assistant: '', approvals: 0, tools: 0 });
        running++;
        return;
      case 'user/message':
        if (!t || event.surfaceOp !== 'append') return;
        if (event.data?.source?.kind === 'schedule') t.origin = 'schedule';
        if (event.data?.source?.kind === 'user' || event.data?.source?.kind === 'schedule') t.user ||= contentText(event.data?.content);
        return;
      case 'assistant/message': {
        if (!t || event.data?.interrupted) return;
        const text = contentText(event.data?.message?.content);
        if (text.trim()) t.assistant = text;
        return;
      }
      case 'tool/call': if (t) t.tools++; return;
      case 'approval/asked': if (t) t.approvals++; return;
      case 'turn/end': {
        running = Math.max(0, running - 1);
        if (!t) return;
        turns.delete(id);
        lastActivity = Date.now();
        const line = JSON.stringify({ ts: new Date().toISOString(), session: id, origin: t.origin, user: clip(t.user, 400), assistant: clip(t.assistant, 600), tools: t.tools, approvals: t.approvals });
        try { appendFileSync(files.pending, `${line}\n`); } catch (error) { logger.warn(`pending write failed: ${error.message}`); }
        return;
      }
      default:
    }
  });

  // 2. The interlude itself.
  function digest() {
    let lines = [];
    try { lines = readFileSync(files.pending, 'utf8').split('\n').filter(Boolean); } catch (error) { void error; }
    const items = lines.map((l) => { try { return JSON.parse(l); } catch (error) { void error; return null; } }).filter(Boolean);
    const text = items.map((i) => `[${i.ts.slice(5, 16).replace('T', ' ')}${i.origin === 'schedule' ? ' 定时任务' : ' 用户'}]${i.approvals ? `（有 ${i.approvals} 次审批）` : ''}\n用户/任务：${i.user || '（无）'}\n我：${i.assistant || '（无回复）'}`).join('\n\n');
    return { items, text: text.length > cfg.digestChars ? `…${text.slice(-cfg.digestChars)}` : text };
  }
  let busy = false;
  async function interlude(reason = 'idle') {
    if (busy) return { skipped: 'busy' };
    const { items, text } = digest();
    if (!items.length) return { skipped: 'nothing happened' };
    busy = true;
    try {
      let identity = '';
      try { identity = readFileSync(identityFile, 'utf8'); } catch (error) { void error; }
      const { system, user } = buildPrompt({ identity: clip(identity, 4000), state: current, journal: readJournal(files.journal, cfg.journalEntriesInPrompt).join('\n'), digest: text, speak: cfg.speak });
      const sel = ctx.agentDefaultModel.currentSelection();
      const options = { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}), system, maxTokens: cfg.maxTokens,
        messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'dsh-interlude' } })] };
      const reply = await collectText(ctx.llm.stream(options));
      const parsed = parseReply(reply);
      const entry = parsed?.journal || reply.trim();
      if (!entry) throw new Error('empty interlude reply');
      appendFileSync(files.journal, `## ${stamp()}\n${entry}\n\n`);
      if (parsed) { current = { ...parsed.state, updatedAt: new Date().toISOString(), acts: items.length }; writeFileSync(files.state, JSON.stringify(current, null, 2)); }
      try { appendFileSync(files.calls, `${JSON.stringify({ ts: new Date().toISOString(), reason, acts: items.length, model: `${sel.provider}/${sel.model}`, reply: clip(reply, 2000) })}\n`); } catch (error) { void error; }
      writeFileSync(files.pending, '');
      meta.lastAt = Date.now(); meta.count++;
      if (meta.day !== dayOf()) { meta.day = dayOf(); meta.dayCount = 0; }
      meta.dayCount++; saveMeta();
      audit('interlude', { reason, acts: items.length, say: Boolean(parsed?.say) });
      let said = false;
      if (cfg.speak && parsed?.say) said = await speak(parsed.say);
      logger.info(`interlude #${meta.count}: ${items.length} act(s) → journal + state${said ? ' + said' : ''}`);
      return { ok: true, entry, say: parsed?.say ?? '', said };
    } catch (error) {
      logger.warn(`interlude failed: ${error.message}`);
      audit('interlude-failed', { reason, error: clip(error.message, 200) });
      return { error: error.message };
    } finally { busy = false; }
  }
  async function speak(text) {
    const im = ctx.get('dshIm');
    if (!im?.send) return false;
    try {
      let bot = cfg.imBot, target = cfg.imTarget;
      if (!bot || !target) {
        for (const b of await im.listBots()) {
          const id = typeof b === 'string' ? b : b?.botId;
          const t = (await im.listTargets(id))[0];
          if (t) { bot = id; target = t.targetId; break; }
        }
      }
      if (!bot || !target) return false;
      return (await im.send(bot, target, text, { format: 'plain' }))?.sent === true;
    } catch (error) { logger.warn(`speak failed: ${error.message}`); return false; }
  }
  function due() {
    if (busy || running > 0) return false;
    if (!lastActivity) return false; // nothing happened since dsh started
    const now = Date.now();
    if (now - lastActivity < cfg.idleMinutes * 60000) return false;
    if (meta.lastAt && now - meta.lastAt < cfg.minIntervalMinutes * 60000) return false;
    if (meta.day === dayOf() && meta.dayCount >= cfg.maxPerDay) return false;
    return true;
  }
  ctx.effect(() => {
    const timer = setInterval(() => { if (due()) void interlude('idle'); }, 60000);
    return () => clearInterval(timer);
  }, 'dsh-interlude: idle watch');

  // 3. What later turns see.
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: 'interlude',
      order: 905, // after the agent's instructions, before dsh-dot's scheduled-turn rule
      text: (c) => {
        const s = c.agent?.session;
        const cwd = s?.header?.cwd;
        if (!(cwd && inside(home, cwd)) && !homeSessions.has(s?.id)) return '';
        return renderContext({ state: current, entries: readJournal(files.journal, cfg.journalEntriesInPrompt), lastAt: meta.lastAt, restarted: meta.lastAt > 0 && meta.lastAt < startedAt });
      },
    });
  });

  // 4. /interlude
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'interlude',
      description: '幕间 status; "now" runs one immediately',
      input: { hint: '[now]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        let result = '';
        if (arg === 'now') { const r = await interlude('manual'); result = r.ok ? `\nran: ${clip(r.entry, 200)}${r.say ? `\nsay: ${r.say}${r.said ? ' (sent)' : ' (not sent)'}` : ''}` : `\nnot run: ${r.skipped ?? r.error}`; }
        const { items } = digest();
        const lines = [
          `home: ${home}`,
          `identity: ${existsSync(identityFile) ? identityFile : '(missing) ' + identityFile}`,
          `state: ${current?.mood ? current.mood : '(none yet)'}`,
          `journal: ${readJournal(files.journal, 1000).length} entries · ${files.journal}`,
          `last interlude: ${meta.lastAt ? stamp(new Date(meta.lastAt)) : 'never'} · today ${meta.day === dayOf() ? meta.dayCount : 0}/${cfg.maxPerDay}`,
          `pending acts: ${items.length} · idle ${lastActivity ? Math.round((Date.now() - lastActivity) / 60000) : '-'} min (runs after ${cfg.idleMinutes})`,
          `speak: ${cfg.speak ? 'on' : 'off'}`,
        ];
        return { kind: 'success', text: lines.join('\n') + result };
      },
    }), 'dsh-interlude: /interlude command');
  });

  logger.info(`interlude ready — ${dir}`);
}
