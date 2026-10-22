// dsh-interlude/core: 幕间 for DeepSeek Harness, after HDS-Interlude (https://github.com/REcklessNOLOve117/HDS-Interlude):
// "聊天在幕前发生，生活在幕间继续。"
//
// 幕前 (on stage) is any dsh conversation in <home>: dsh runs it, dsh-im carries it, dsh-dot pushes
// scheduled results. 幕间 (between acts) is this plugin: one model call per round in which the
// character writes the life that happened since the story cursor, decides whether it has a real
// reason to reach out, and leaves a small continuity snapshot behind. Later acts open with that
// snapshot in view.
//
// Rounds, after HDSI's fixed phases (a user message is phase 1 and is handled by dsh itself):
//   follow-up  — a conversation has just gone quiet (idleMinutes)
//   advance    — independent life progression at a regular interval, even with no conversation
//   intent     — a stored intent (reminder, promised reply, contact check) came due
// Continuity layers kept from HDSI: Canon (the identity file), recent script (script.md), the
// continuity snapshot (state.json), Overlay (overlay.md, slow non-destructive change), intents
// (intents.json). Not ported: long-term facts with retrieval, Alter (mood drift), Perspective,
// multi-participant stories, seen/delayed replies inside a conversation.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-interlude';
export const inject = ['llm', 'agentDefaultModel'];

export const defaults = {
  home: '',                   // default ~/dot; the interlude files live in <home>/interlude
  scope: 'home+im',           // which sessions are acts: 'home' (cwd inside home), 'im' (opened from an IM bot), 'home+im', 'all'
  canon: null,                // HDSI storyDefaults used until a preset is imported ({ characterName, characterProfile, ... })
  presetHub: 'https://typ0.space', // HDSI preset hub; `/interlude preset <share code>` imports from here
  // System-prompt sections dropped for the character's sessions so the Canon opens the prompt. dsh's
  // "You are an AI agent powered by DeepSeek Harness" + the agent preset's "You are a coding agent"
  // are what the community calls the root of the AI flavour. [] keeps everything.
  trimSections: ['harness:identity', 'deployment:persona-prefix', 'context:file-reference'],
  canonOnly: false,           // true: keep only the Canon, dot's rules and MCP (VM) sections
  identityFile: '',           // optional extra Canon text file; not read unless set
  idleMinutes: 10,            // follow-up round this long after a conversation goes quiet
  advanceEveryMinutes: 180,   // independent life progression; 0 disables
  activeHours: '08:00-23:00', // outside this, no advance rounds and no proactive contact
  maxRoundsPerDay: 12,
  maxTokens: 900,
  digestChars: 6000,
  scriptEntriesInPrompt: 2,   // recent script excerpts later acts see
  speak: false,               // allow proactive contact over dsh-im
  maxContactsPerDay: 2,
  willingnessThreshold: 0.6,
  imBot: '',
  imTarget: '',
};

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
/** dsh-im tags messages it relays with an rpcId of `<channel>-<uuid>`; the desktop UI does not. */
export const IM_RPC = /^(weixin|wechat|qq|feishu|lark|dingtalk|wecom|wework|telegram|discord|slack|whatsapp|email|office)-/i;
export const isImMessage = (m) => IM_RPC.test(String(m?.source?.rpcId ?? ''));
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const dayOf = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Text of a message content array (or string). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
}

/** 'HH:MM-HH:MM' (may wrap midnight) → is `date` inside it? Empty spec = always. */
export function inHours(spec, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!m) return true;
  const start = +m[1] * 60 + +m[2], end = +m[3] * 60 + +m[4], now = date.getHours() * 60 + date.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

/** HDSI sends nowLocal with weekday and daylight period as the authoritative endpoint. */
export function describeNow(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  const h = d.getHours();
  const period = h < 5 ? '深夜' : h < 9 ? '清晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 20 ? '傍晚' : '夜里';
  const wd = '日一二三四五六'[d.getDay()];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 星期${wd} ${period}`;
}

/** The round's instructions. Phase decides what the model is asked to do with the gap. */
export function buildPrompt({ phase, identity, state, overlay, script, digest, cursor, now, intent, speak }) {
  const gap = cursor ? `从 ${describeNow(new Date(cursor))} 到 ${describeNow(now)}` : `到 ${describeNow(now)} 为止的这段时间`;
  const system = [
    identity ? `# 主角（Canon）\n${identity.trim()}` : '',
    '# 现在是幕间',
    '聊天在幕前发生，生活在幕间继续。你是接手这部进行中的剧本的作者，主角生活在此时此刻。从历史剧本的时间点继续衔接书写；让已发生的事情留下可能的后果，让已完成的动作留在过去；把叙事的注意力放在主角此刻正在感知的地方。写完后留下接下来需要的连续性。',
    `时间：${gap}。写到现在为止，不写未来；未来的事只能放进 intents。`,
    phase === 'follow-up' ? '这一轮是「对话后续」：刚才的对话结束了，写它在主角生活里留下的余波，以及主角接着做了什么。' : '',
    phase === 'advance' ? '这一轮是「生活推进」：这段时间没有对话。写主角自己在做的事。没有用户消息，不要编造用户说了什么。' : '',
    phase === 'seed' ? '这一轮是「开场」：剧本还没有开始，没有历史。写主角到现在为止的最近一天：3 到 5 段，每段以 [MM-DD HH:MM] 开头、按时间先后、最后一段写到现在。这是她自己的日子（配角、地点、习惯都从设定来），和用户没有对话，不要编造用户说了什么。state 写现在的状态，intents 放她接下来一两天确实打算做的事。' : '',
    phase === 'intent' && intent ? `这一轮是「到期的意图」：${intent.text}（${intent.kind}，定于 ${describeNow(new Date(intent.at))}）。重新看看现在的生活，决定是履行、延后还是放下；延后要给新的时间，放下要在 script 里说明。` : '',
    '只输出一个 JSON 对象（可放在 ```json 代码块里）：',
    `- "script": 这段时间的剧本，第三人称当代生活剧，${phase === 'seed' ? '600' : '300'} 字以内。围绕主角的日常动作、不规律事件和人际交流展开，用具体动作和感官细节代替给心情命名；不复述幕前的对话原文；主角若真的发了消息，把原话写进剧本。`,
    '- "state": { "mood": "此刻的状态一句话", "now": "正在做或刚做完的事", "next": "接下来打算", "threads": ["进行中、未完成的事，最多 5 条"] }',
    '- "overlay": ["这段时间形成的稳定变化：新的习惯、对某事的看法、关系上的变化。没有就空数组；一般为空。"]',
    '- "intents": [{ "at": "ISO 8601 本地时间", "kind": "reminder | reply | contact", "text": "到时候要做什么", "willingness": 0~1 }]，只放确实需要在未来某个时刻处理的事；没有就空数组。',
    speak
      ? '- "contact": { "text": "主角现在发给用户的原话（多条用 <sep/> 分隔）", "willingness": 0~1, "reason": "来自生活里的具体理由" } 或 null。用户长时间沉默本身不是理由；没有具体理由就 null。'
      : '- "contact": null。',
    '规则：不编造没发生的事；state 和 overlay 要接着上次的；不确定就写得短。',
  ].filter(Boolean).join('\n');
  const user = [
    state ? `## 上次的状态\n${JSON.stringify(state)}` : '## 上次的状态\n（还没有）',
    overlay ? `## Overlay（已经形成的稳定变化）\n${overlay}` : '',
    script ? `## 最近的生活剧本\n${script}` : '',
    digest ? `## 幕前刚发生的对话\n${digest}` : '## 幕前\n（这段时间没有对话）',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Pull the JSON object out of a model reply (fenced or bare) and normalise it. */
export function parseReply(text, now = Date.now()) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const o = JSON.parse(c);
      if (!o || typeof o !== 'object') continue;
      const str = (v) => String(v ?? '').trim();
      const num = (v, d = 0) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : d);
      const intents = [].concat(o.intents ?? []).map((i) => ({
        at: Number.isFinite(Date.parse(i?.at)) ? new Date(i.at).toISOString() : null,
        kind: ['reminder', 'reply', 'contact'].includes(i?.kind) ? i.kind : 'reminder',
        text: str(i?.text), willingness: num(i?.willingness, 0.5),
      })).filter((i) => i.at && i.text && Date.parse(i.at) > now).slice(0, 5);
      const contact = o.contact && typeof o.contact === 'object' && str(o.contact.text)
        ? { text: str(o.contact.text), willingness: num(o.contact.willingness, 0), reason: str(o.contact.reason) } : null;
      return {
        script: str(o.script),
        state: { mood: str(o.state?.mood), now: str(o.state?.now), next: str(o.state?.next), threads: [].concat(o.state?.threads ?? []).map(str).filter(Boolean).slice(0, 5) },
        overlay: [].concat(o.overlay ?? []).map(str).filter(Boolean).slice(0, 3),
        intents, contact,
      };
    } catch (error) { void error; }
  }
  return null;
}

/** Render the context later acts see. */
export function renderContext({ state, overlay, entries, intents, cursor, restarted, now = Date.now() }) {
  if (!state && !entries.length) return '';
  const ago = cursor ? Math.round((now - cursor) / 60000) : null;
  const lines = ['<interlude>', '幕前开始。下面是你在幕间写下的连续性，只有你自己看得到；像真实经历一样使用它，不要向用户复述。'];
  if (ago !== null) lines.push(`上次幕间：${ago < 60 ? `${ago} 分钟前` : `${Math.round(ago / 60)} 小时前`}${restarted ? '；期间 dsh 重启过（像睡了一觉）' : ''}`);
  if (state?.mood) lines.push(`状态：${state.mood}`);
  if (state?.now) lines.push(`刚才在做：${state.now}`);
  if (state?.next) lines.push(`接下来：${state.next}`);
  if (state?.threads?.length) lines.push(`进行中：${state.threads.join('；')}`);
  if (overlay) lines.push(`已形成的变化：${overlay}`);
  const due = intents.filter((i) => Date.parse(i.at) <= now + 24 * 3600000);
  if (due.length) lines.push(`近期的打算：${due.map((i) => `${i.text}（${describeNow(new Date(i.at))}）`).join('；')}`);
  if (entries.length) lines.push('最近的生活：', ...entries.map((e) => `- ${e}`));
  lines.push('</interlude>');
  return clip(lines.join('\n'), 2400);
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { void error; return fallback; }
}

/** Last n entries of the script, oldest first, flattened to one line each. */
export function readScript(file, n) {
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
  // FinishReason kinds: stop | tool-calls | max-tokens | aborted | error.
  if (finish && (finish.kind === 'aborted' || finish.kind === 'error')) {
    throw new Error(`interlude model call ended with ${finish.kind}: ${finish.failure?.message ?? finish.failure?.code ?? ''}`);
  }
  return text;
}

/** HDSI storyDefaults → the Canon text the model sees (prompt section and interlude rounds). */
export function renderCanon(canon, { withStyle = false } = {}) {
  const sd = canon?.storyDefaults ?? canon ?? {};
  const name = String(sd.characterName ?? '').trim();
  if (!name && !sd.characterProfile) return '';
  const part = (title, v) => (v && String(v).trim() ? `## ${title}\n${String(v).trim()}` : '');
  return [
    `# 你是 ${name || '主角'}`,
    part('角色设定', sd.characterProfile), part('视角', sd.perspective), part('和用户的关系', sd.relationship),
    part('用户', sd.userProfile), part('配角', sd.supportingCast), part('世界', sd.world), part('主要地点', sd.location),
    part('回复规则', sd.replyRules ?? canon?.replyRules),
    part('不要这样说（出现即失败）', Array.isArray(canon?.blacklist) ? canon.blacklist.map((b) => `- ${b}`).join('\n') : canon?.blacklist),
    part('对话范例（说话的样子）', canon?.examples),
    withStyle ? part('叙事文风', sd.style) : '',
  ].filter(Boolean).join('\n\n');
}

/** Import a preset from the HDSI hub by share code (public API; the page needs no login for this). */
export async function fetchPreset(hub, code, fetchImpl = globalThis.fetch) {
  const want = String(code).replace(/[^0-9a-z]/gi, '').toUpperCase();
  if (want.length < 6) throw new Error('share code looks wrong');
  const list = await (await fetchImpl(`${hub}/api/presets`)).json();
  const row = (list.rows ?? []).find((r) => String(r.share_code ?? '').replace(/-/g, '').toUpperCase() === want);
  if (!row) throw new Error(`no preset with share code ${code} on ${hub}`);
  const { preset } = await (await fetchImpl(`${hub}/api/presets/${encodeURIComponent(row.slug)}`)).json();
  const sd = preset?.payload?.storyDefaults;
  if (!sd?.characterName) throw new Error('preset has no storyDefaults');
  return {
    storyDefaults: sd,
    source: { hub, shareCode: row.share_code, slug: preset.slug, title: preset.title, author: preset.author, license: preset.license, revision: preset.revision, fetchedAt: new Date().toISOString() },
  };
}

export function apply(ctx, config = {}) {
  const cfg = { ...defaults, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '')) };
  const logger = ctx.logger('dsh-interlude');
  const home = cfg.home || join(homedir(), 'dot');
  const dir = join(home, 'interlude');
  const files = {
    script: join(dir, 'script.md'), state: join(dir, 'state.json'), overlay: join(dir, 'overlay.md'),
    intents: join(dir, 'intents.json'), pending: join(dir, 'pending.jsonl'), calls: join(dir, 'calls.jsonl'), meta: join(dir, 'meta.json'),
    canon: join(dir, 'canon.json'),
  };
  mkdirSync(dir, { recursive: true });
  // The Canon: an imported preset wins; otherwise the configured storyDefaults; AGENTS.md is not involved.
  let canon = readJson(files.canon, null) ?? (cfg.canon ? { storyDefaults: cfg.canon, source: { kind: 'config' } } : null);
  const canonText = (opts) => {
    let extra = '';
    if (cfg.identityFile) { try { extra = readFileSync(cfg.identityFile, 'utf8'); } catch (error) { void error; } }
    return [renderCanon(canon, opts), extra.trim()].filter(Boolean).join('\n\n');
  };
  const startedAt = Date.now();
  const audit = (event, data = {}) => ctx.get('dshComputer')?.audit?.({ kind: 'interlude', event, ...data });

  let state = readJson(files.state, null);
  let intents = readJson(files.intents, []);
  const meta = { cursor: 0, count: 0, day: dayOf(), dayRounds: 0, dayContacts: 0, lastAdvance: 0, ...readJson(files.meta, {}) };
  if (!meta.lastAdvance) meta.lastAdvance = startedAt; // the first life round comes one interval after boot
  const rollDay = () => { if (meta.day !== dayOf()) { meta.day = dayOf(); meta.dayRounds = 0; meta.dayContacts = 0; } };
  const saveMeta = () => { try { writeFileSync(files.meta, JSON.stringify(meta, null, 2)); } catch (error) { void error; } };
  const saveIntents = () => { try { writeFileSync(files.intents, JSON.stringify(intents, null, 2)); } catch (error) { void error; } };
  const readOverlay = () => { try { return readFileSync(files.overlay, 'utf8').trim(); } catch (error) { void error; return ''; } };

  // 1. 幕前: watch the acts in <home>.
  const turns = new Map();
  const homeSessions = new Set(); // sessions that are acts: cwd inside home, or opened from an IM bot
  const wantHome = cfg.scope === 'all' || String(cfg.scope).includes('home');
  const wantIm = cfg.scope === 'all' || String(cfg.scope).includes('im');
  let lastActivity = 0;
  let running = 0;
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    const cwd = session?.header?.cwd;
    if (!id || !event) return;
    if (cfg.scope === 'all' || (wantHome && cwd && inside(home, cwd))) homeSessions.add(id);
    if (wantIm && event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(isImMessage)) homeSessions.add(id);
    if (wantIm && event.type === 'user/message' && isImMessage(event.data)) homeSessions.add(id);
    if (!homeSessions.has(id)) return;
    const t = turns.get(id);
    switch (event.type) {
      case 'turn/start': turns.set(id, { origin: 'user', user: '', assistant: '', approvals: 0, tools: 0 }); running++; return;
      case 'user/message':
        if (!t || event.surfaceOp !== 'append') return;
        if (event.data?.source?.kind === 'schedule') t.origin = 'schedule';
        if (['user', 'schedule'].includes(event.data?.source?.kind)) t.user ||= contentText(event.data?.content);
        return;
      case 'assistant/message': { if (!t || event.data?.interrupted) return; const text = contentText(event.data?.message?.content); if (text.trim()) t.assistant = text; return; }
      case 'tool/call': if (t) t.tools++; return;
      case 'approval/asked': if (t) t.approvals++; return;
      case 'turn/end': {
        running = Math.max(0, running - 1);
        if (!t) return;
        turns.delete(id);
        lastActivity = Date.now();
        const quiet = t.origin === 'schedule' && /^[`*\s]*DOT_SILENT[`*\s。.]*$/.test(t.assistant);
        const line = JSON.stringify({ ts: new Date().toISOString(), session: id, origin: t.origin, user: clip(t.user, 400), assistant: clip(t.assistant, 600), tools: t.tools, approvals: t.approvals, quiet });
        try { appendFileSync(files.pending, `${line}\n`); } catch (error) { logger.warn(`pending write failed: ${error.message}`); }
        return;
      }
      default:
    }
  });

  // 2. 幕间: one round.
  function digest() {
    let lines = [];
    try { lines = readFileSync(files.pending, 'utf8').split('\n').filter(Boolean); } catch (error) { void error; }
    const items = lines.map((l) => { try { return JSON.parse(l); } catch (error) { void error; return null; } }).filter(Boolean);
    const text = items.map((i) => `[${i.ts.slice(5, 16).replace('T', ' ')}${i.origin === 'schedule' ? ' 定时任务' : ' 用户'}]${i.approvals ? `（有 ${i.approvals} 次审批）` : ''}\n用户/任务：${i.user || '（无）'}\n我：${i.assistant || '（无回复）'}`).join('\n\n');
    return { items, text: text.length > cfg.digestChars ? `…${text.slice(-cfg.digestChars)}` : text };
  }
  let busy = false;
  async function round(phase, intent = null) {
    if (busy) return { skipped: 'busy' };
    rollDay();
    if (meta.dayRounds >= cfg.maxRoundsPerDay) return { skipped: 'daily cap' };
    const { items, text } = digest();
    if (phase === 'follow-up' && !items.some((i) => !i.quiet)) return { skipped: 'nothing happened' };
    if (phase === 'seed' && readScript(files.script, 1).length) return { skipped: 'script already has entries (seed only opens an empty script)' };
    busy = true;
    const now = Date.now();
    try {
      const identity = canonText({ withStyle: true });
      const { system, user } = buildPrompt({
        phase, identity: clip(identity, 4000), state, overlay: readOverlay(), script: readScript(files.script, cfg.scriptEntriesInPrompt).join('\n'),
        digest: text, cursor: meta.cursor, now, intent, speak: cfg.speak,
      });
      const sel = ctx.agentDefaultModel.currentSelection();
      const options = { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}), system, maxTokens: cfg.maxTokens,
        messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'dsh-interlude' } })] };
      const reply = await collectText(ctx.llm.stream(options));
      const parsed = parseReply(reply, now);
      const script = parsed?.script || reply.trim();
      if (!script) throw new Error('empty script');
      if (phase === 'seed') {
        // "[MM-DD HH:MM] ..." segments become dated entries; anything untagged keeps the current time.
        const segs = script.split(/\n(?=\[\d{1,2}-\d{1,2} \d{1,2}:\d{2}\])/).map((t) => t.trim()).filter(Boolean);
        const year = new Date(now).getFullYear();
        for (const seg of segs) {
          const m = /^\[(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})\]\s*/.exec(seg);
          const at = m ? new Date(year, +m[1] - 1, +m[2], +m[3], +m[4]) : new Date(now);
          appendFileSync(files.script, `## ${describeNow(at)} · seed\n${m ? seg.slice(m[0].length) : seg}\n\n`);
        }
      } else {
        appendFileSync(files.script, `## ${describeNow(new Date(now))} · ${phase}\n${script}\n\n`);
      }
      if (parsed) {
        state = { ...parsed.state, updatedAt: new Date(now).toISOString() };
        writeFileSync(files.state, JSON.stringify(state, null, 2));
        if (parsed.overlay.length) appendFileSync(files.overlay, parsed.overlay.map((o) => `- ${dayOf(new Date(now))} ${o}\n`).join(''));
        if (intent) intents = intents.filter((i) => i.id !== intent.id);
        for (const i of parsed.intents) intents.push({ id: `${now.toString(36)}-${intents.length}`, ...i, createdAt: new Date(now).toISOString() });
        intents = intents.slice(-20);
        saveIntents();
      }
      try { appendFileSync(files.calls, `${JSON.stringify({ ts: new Date(now).toISOString(), phase, acts: items.length, model: `${sel.provider}/${sel.model}`, reply: clip(reply, 2000) })}\n`); } catch (error) { void error; }
      writeFileSync(files.pending, '');
      meta.cursor = now; meta.count++; meta.dayRounds++;
      if (phase === 'advance') meta.lastAdvance = now;
      saveMeta();
      let said = false;
      if (parsed?.contact) said = await contact(parsed.contact, phase);
      audit('round', { phase, acts: items.length, intents: intents.length, contact: Boolean(parsed?.contact), said });
      logger.info(`interlude #${meta.count} (${phase}): ${items.length} act(s)${said ? ' + contact' : ''}`);
      return { ok: true, script, contact: parsed?.contact ?? null, said };
    } catch (error) {
      logger.warn(`interlude ${phase} failed: ${error.message}`);
      audit('round-failed', { phase, error: clip(error.message, 200) });
      return { error: error.message };
    } finally { busy = false; }
  }

  // Agency, simplified from HDSI: speak enabled, active hours, willingness, daily cap.
  async function contact(c, phase) {
    if (!cfg.speak) return false;
    if (!inHours(cfg.activeHours)) { audit('contact-held', { phase, why: 'outside active hours' }); return false; }
    if (c.willingness < cfg.willingnessThreshold) { audit('contact-held', { phase, why: 'willingness' }); return false; }
    if (meta.dayContacts >= cfg.maxContactsPerDay) { audit('contact-held', { phase, why: 'daily cap' }); return false; }
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
      // HDSI's <sep/> marks separate sends of the same moment; deliver them as separate messages.
      const parts = c.text.split(/<sep\s*\/>/i).map((t) => t.trim()).filter(Boolean);
      let ok = false;
      for (const part of parts) ok = (await im.send(bot, target, part, { format: 'plain' }))?.sent === true || ok;
      if (ok) { meta.dayContacts++; saveMeta(); appendFileSync(files.script, `（主动联系：${parts.join(' / ')}）\n\n`); }
      return ok;
    } catch (error) { logger.warn(`contact failed: ${error.message}`); return false; }
  }

  // 3. Scheduling: follow-up after quiet, advance on an interval, intents when due.
  function tick() {
    if (busy || running > 0) return;
    const now = Date.now();
    rollDay();
    const due = intents.find((i) => Date.parse(i.at) <= now);
    if (due) { void round('intent', due); return; }
    if (lastActivity && now - lastActivity >= cfg.idleMinutes * 60000 && digest().items.some((i) => !i.quiet)) { void round('follow-up'); return; }
    if (cfg.advanceEveryMinutes > 0 && inHours(cfg.activeHours) && now - Math.max(meta.cursor, meta.lastAdvance) >= cfg.advanceEveryMinutes * 60000 && (!lastActivity || now - lastActivity >= cfg.idleMinutes * 60000)) {
      void round('advance');
    }
  }
  ctx.effect(() => { const timer = setInterval(tick, 60000); return () => clearInterval(timer); }, 'dsh-interlude: scheduler');

  // 4. 幕前: the Canon is a system-prompt section (right after the deployment persona, static per
  // session so the cached prefix holds); the continuity is a dynamic context after the history.
  const inHome = (c) => { const s = c.agent?.session; return cfg.scope === 'all' || Boolean((wantHome && s?.header?.cwd && inside(home, s.header.cwd)) || homeSessions.has(s?.id)); };
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'interlude:canon',
      order: scope.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') + 1 || 1,
      text: (c) => (inHome(c) ? canonText() : ''),
    }), 'dsh-interlude: canon section');
    // Drop dsh's own openers for the character's sessions so the Canon is the first thing the model
    // reads; other sessions are untouched. (A `complete` section cannot do this per session.)
    const keep = (name) => name === 'interlude:canon' || name === 'dot:rules' || name.startsWith('mcp:');
    scope.effect(() => scope.on('system-prompt/assemble', async (_assembly, c, next) => {
      const assembly = await next();
      if (!inHome(c)) return assembly;
      const sections = assembly.sections.filter((sec) => (cfg.canonOnly ? keep(sec.name) : !cfg.trimSections.includes(sec.name)));
      return sections.length === assembly.sections.length ? assembly : { ...assembly, sections };
    }), 'dsh-interlude: prompt trim');
    scope.systemPrompt.context({
      name: 'interlude',
      order: 905,
      text: (c) => {
        if (!inHome(c)) return '';
        return renderContext({ state, overlay: readOverlay(), entries: readScript(files.script, cfg.scriptEntriesInPrompt), intents, cursor: meta.cursor, restarted: meta.cursor > 0 && meta.cursor < startedAt });
      },
    });
  });

  // 5. /interlude
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'interlude',
      description: '幕间 status; "now" runs a follow-up round, "advance" a life round, "seed" opens an empty script with the last day of life, "preset <share code>" imports a Canon from the HDSI hub, "canon" shows it',
      input: { hint: '[now | advance | seed | preset <code> | canon]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        let result = '';
        if (/^preset\s+\S+/.test(arg)) {
          try {
            canon = await fetchPreset(cfg.presetHub, arg.split(/\s+/)[1]);
            writeFileSync(files.canon, JSON.stringify(canon, null, 2));
            audit('canon-imported', { title: canon.source.title, shareCode: canon.source.shareCode });
            result = `\nimported: ${canon.source.title} by @${canon.source.author} (${canon.source.license}) → ${files.canon}`;
          } catch (error) { result = `\nimport failed: ${error.message}`; }
        } else if (arg === 'canon') {
          result = `\n${canonText() || '(no canon: /interlude preset <share code>, or set config.canon)'}`;
        } else if (arg === 'now' || arg === 'advance' || arg === 'seed') {
          const r = await round(arg === 'now' ? 'follow-up' : arg);
          result = r.ok ? `\nran: ${clip(r.script, 200)}${r.contact ? `\ncontact: ${r.contact.text} (${r.said ? 'sent' : 'held'})` : ''}` : `\nnot run: ${r.skipped ?? r.error}`;
        }
        const { items } = digest();
        rollDay();
        const lines = [
          `home: ${home} · scope: ${cfg.scope}`,
          `canon: ${canon ? `${canon.storyDefaults.characterName}${canon.source?.title ? ` ← ${canon.source.title} (@${canon.source.author}, ${canon.source.shareCode})` : ` (${canon.source?.kind ?? 'canon.json'})`}` : '(none) — /interlude preset <share code>'}`,
          `state: ${state?.mood || '(none yet)'}${state?.now ? ` · ${state.now}` : ''}`,
          `script: ${readScript(files.script, 10000).length} entries · overlay: ${readOverlay().split('\n').filter(Boolean).length} lines · intents: ${intents.length}`,
          `cursor: ${meta.cursor ? describeNow(new Date(meta.cursor)) : 'never'} · today ${meta.dayRounds}/${cfg.maxRoundsPerDay} rounds, ${meta.dayContacts}/${cfg.maxContactsPerDay} contacts`,
          `pending acts: ${items.length} · idle ${lastActivity ? Math.round((Date.now() - lastActivity) / 60000) : '-'} min (follow-up after ${cfg.idleMinutes}) · advance every ${cfg.advanceEveryMinutes} min in ${cfg.activeHours}`,
          `speak: ${cfg.speak ? 'on' : 'off'}`,
        ];
        return { kind: 'success', text: lines.join('\n') + result };
      },
    }), 'dsh-interlude: /interlude command');
  });

  logger.info(`interlude ready — ${dir}`);
}
