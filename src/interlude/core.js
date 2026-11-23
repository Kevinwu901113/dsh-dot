// dsh-interlude/core: who she is, and what she really does on her own.
//
// This component used to write her a life between conversations (a narrator model, one call per round:
// script, continuity, intents — the "interlude"). That is gone (0.24): what a narrator writes about her
// phone, her accounts and the things he asked for cannot be told from what happened, and it went back
// into her conversation as fact. What is left is what does not need a narrator:
//   - the Canon (her persona) as the first section of her prompt, dsh's own openers trimmed, her voice
//     as the last thing before she answers;
//   - 自己的时间: a few times a day she has time of her own, in her conversation, inside a token budget;
//   - the ledger of what she did on her own, what it cost and what he said about it (doings.js).
// Her life is what she really did. The component, service, settings section, folder and prompt ids keep
// the name "interlude" so that nothing an installed copy has (canon.json, dsh-dot.json, prompt
// overrides) stops working.
//
// The Canon file keeps HDS-Interlude's `storyDefaults` field names
// (https://github.com/REcklessNOLOve117/HDS-Interlude) so that personas shared on its preset hub can be imported.
import { deny } from '../refusals.js';
import { PHONE_TOOL_PREFIX, PHONE_TYPE_TOOL } from '../tool-prefixes.js';
import { typesText } from '../phone/phone.js';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { sectionOf, setValues } from '../settings.js';
import { installLlmGate } from '../llm-gate.js';
import { prompt } from '../prompts.js';
import { runPendingReset } from '../reset.js';
import { describeNow, stamp } from '../clock.js';
import { inHours, msLeftInHours } from '../hours.js';
import { createDoings, tokensOf } from './doings.js';
import { readCard, readChecks, syncCard } from '../persona/card.js';
import { cardFor } from '../persona/parts.js';
import { head } from '../cut.js';

export const name = 'dot-interlude';
export const inject = ['llm', 'agentDefaultModel'];

/** Social apps she might install, by site and by name — nothing is installed for her; only what is on her phone counts. */
export const KNOWN_APPS = {
  labels: { 小黑盒: 'com.max.xiaoheihe', B站: 'tv.danmaku.bili', 微博: 'com.sina.weibo', 小红书: 'com.xingin.xhs', 知乎: 'com.zhihu.android', 抖音: 'com.ss.android.ugc.aweme', 酷安: 'com.coolapk.market', 贴吧: 'com.baidu.tieba', 豆瓣: 'com.douban.frodo', QQ空间: 'com.tencent.mobileqq' },
};

export const defaults = {
  home: '',                   // default ~/dot; the interlude files live in <home>/interlude
  scope: 'home+im',           // which sessions are acts: 'home' (cwd inside home), 'im' (opened from an IM bot), 'home+im', 'all'
  canon: null,                // a storyDefaults object used until a preset is imported ({ characterName, characterProfile, ... })
  presetHub: 'https://typ0.space', // community preset hub (HDS-Interlude's persona format); `/interlude preset <share code>` imports from here
  // System-prompt sections dropped for the character's sessions so the Canon opens the prompt. dsh's
  // "You are an AI agent powered by DeepSeek Harness" + the agent preset's "You are a coding agent"
  // are what the community calls the root of the AI flavour. [] keeps everything.
  trimSections: ['harness:identity', 'deployment:persona-prefix', 'context:file-reference'],
  canonOnly: false,           // true: keep only the Canon, dot's rules and MCP (VM) sections
  // A line or two on how she talks, after everything else in her conversation's prompt (the Canon's
  // `voice` field, or interlude.voice from her name). false: none.
  voice: false,
  identityFile: '',           // optional extra Canon text file; not read unless set
  idleMinutes: 10,            // her own time does not start within this long of her last turn
  // DeepSeek's reasoning shares this budget with the reply (the weekly review).
  maxTokens: 16384,
  // Yuan per million tokens ({ in, cached, out }) so she sees cost in money too; null = tokens only.
  price: null,
  // 自己的时间: a few times a day she is woken with nothing to do but her own time — all her
  // tools, her own folder (<home>/her), no list of what to do. Limits live in the gates (approvals, QQ
  // refused, typing in social apps asks) and in the token budget, which ends the turn when it runs out.
  freeTimesPerDay: 2,         // 0 = off; needs dsh-dot
  freeTokenCap: 150000,       // per free time; past 80% she is told to wrap up, at 100% the turn is stopped
  freeDailyTokens: 300000,    // all free time in a day
  imBot: '',
  imTarget: '',
};

/** dsh-im tags messages it relays with an rpcId of `<channel>-<uuid>`; the desktop UI does not. */
export const IM_RPC = /^(weixin|wechat|qq|feishu|lark|dingtalk|wecom|wework|telegram|discord|slack|whatsapp|email|office)-/i;
export const isImMessage = (m) => IM_RPC.test(String(m?.source?.rpcId ?? ''));
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const dayOf = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const clip = (s, n) => (s.length > n ? `${head(s, n)}…` : s);

/** Source of the message that opens her own time. */
export const FREE_SOURCE = Object.freeze({ kind: 'dsh-interlude', form: 'free' });
/** Phone apps where typing could post, comment or message someone: the social ones, QQ and WeChat. */
export const SOCIAL_PACKAGES = [...new Set([...Object.values(KNOWN_APPS.labels), 'com.tencent.mobileqq', 'com.tencent.mm'])];

/** Her own folder as a short listing (relative paths, size, day), at most `max` entries. */
export function listPlace(root, { max = 60, depth = 3 } = {}) {
  const out = [];
  const walk = (dir, rel, d) => {
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch (error) { void error; return; }
    for (const e of names) {
      if (out.length >= max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); if (d < depth) walk(join(dir, e.name), r, d + 1); continue; }
      try { const st = statSync(join(dir, e.name)); const t = new Date(st.mtimeMs); out.push(`${r} · ${st.size} B · ${t.getMonth() + 1}-${t.getDate()}`); } catch (error) { void error; }
    }
  };
  walk(root, '', 1);
  return out;
}

/** The message that opens her own time. */
export function freePrompt({ budget, left, place, listing = [], context = {} }, now = Date.now()) {
  return prompt('interlude.free', {
    stamp: stamp(now, now), budget, left, place,
    listing: listing.length ? listing.map((l) => `- ${l}`).join('\n') : '（空的）',
    context: JSON.stringify(context, null, 1),
  });
}

/** Text of a message content array (or string). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
}


export { describeNow };


function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { void error; return fallback; }
}

/**
 * Collect a model reply from an llm stream: its text, the arguments of the first tool call (the
 * `interval` tool carries the round's fields as provider-validated JSON), and the token usage.
 */
export async function collectReply(stream) {
  let text = '';
  const calls = new Map(); // tool-call index → arguments so far
  let usage = null;
  let finish = null;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text;
    else if (chunk.type === 'tool-call-delta') calls.set(chunk.index, (calls.get(chunk.index) ?? '') + (chunk.argumentsDelta ?? ''));
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.arguments) calls.set(chunk.index, chunk.block.arguments);
    else if (chunk.type === 'usage') usage = chunk.usage ?? null;
    else if (chunk.type === 'finish') finish = chunk.reason;
  }
  // FinishReason kinds: stop | tool-calls | max-tokens | aborted | error.
  if (finish && (finish.kind === 'aborted' || finish.kind === 'error')) {
    throw new Error(`interlude model call ended with ${finish.kind}: ${finish.failure?.message ?? finish.failure?.code ?? ''}`);
  }
  const args = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v).find(Boolean) ?? '';
  return { text, args, usage, finish };
}


/** storyDefaults → the Canon text the model sees (prompt section and interlude rounds). */
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

/** Import a preset from the preset hub by share code (public API; the page needs no login for this). */
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
  const logger = ctx.logger('dsh-interlude');
  runPendingReset({ logger }); // a reset scheduled on the dot page: before any state is read (src/reset.js)
  const cfg = { ...defaults, ...setValues(config), ...sectionOf('interlude', (m) => logger.warn(m)) };
  if (cfg.enabled === false) { logger.info('off (dsh-dot.json: interlude.enabled = false)'); return; }
  const home = cfg.home || join(homedir(), 'dot');
  const dir = join(home, 'interlude');
  const files = {
    meta: join(dir, 'meta.json'),
    canon: join(dir, 'canon.json'), doings: join(dir, 'doings.json'),
  };
  mkdirSync(dir, { recursive: true });
  // The Canon: an imported preset wins; otherwise the configured storyDefaults; AGENTS.md is not involved.
  let canon = readJson(files.canon, null) ?? (cfg.canon ? { storyDefaults: cfg.canon, source: { kind: 'config' } } : null);
  const canonText = (opts) => {
    let extra = '';
    if (cfg.identityFile) { try { extra = readFileSync(cfg.identityFile, 'utf8'); } catch (error) { void error; } }
    // Her card (<home>/persona.md) is what she reads; a home without one still gets the canon rendered as before.
    // In her conversation it is the parts meant for the one who decides (persona/parts.js): who she is, not how she talks.
    return [cardFor(home, 'decide', readCard(home)) || renderCanon(canon, opts), extra.trim()].filter(Boolean).join('\n\n');
  };
  /** The reminder of how she talks: the Canon's own (`voice`) when it has one, else the built-in from her name. */
  const voiceText = () => {
    const own = String(canon?.voice ?? canon?.storyDefaults?.voice ?? '').trim();
    const name = canon?.storyDefaults?.characterName ?? '';
    if (own) return own;
    return name || canon?.storyDefaults?.characterProfile ? prompt('interlude.voice', { name: name || '你自己' }) : '';
  };
  const audit = (event, data = {}) => ctx.get('dshComputer')?.audit?.({ kind: 'interlude', event, ...data });
  /** A persona imported on purpose replaces her card and checks; what was there is kept beside them (.bak-<time>). */
  const writeCard = () => { audit('card-synced', syncCard(home, canon, { force: true })); };
  const doings = createDoings(files.doings);
  const herPlace = join(home, 'her');
  mkdirSync(herPlace, { recursive: true });
  // Today's model calls of this component (the weekly review) as a cost record: dayTokensIn counts the cached reads too.
  const roundCost = () => ({ in: Math.max(0, (meta.dayTokensIn ?? 0) - (meta.dayTokensCached ?? 0)), cached: meta.dayTokensCached ?? 0, out: meta.dayTokensOut ?? 0 });

  const meta = { day: dayOf(), ...readJson(files.meta, {}) };
  const rollDay = () => { if (meta.day !== dayOf()) { meta.day = dayOf(); meta.dayTokensIn = 0; meta.dayTokensCached = 0; meta.dayTokensOut = 0; meta.dayFreeTokens = 0; meta.dayFrees = 0; } };
  const saveMeta = () => { try { writeFileSync(files.meta, JSON.stringify(meta, null, 2)); } catch (error) { void error; } };
  // Her card and checks file follow the canon (src/persona/card.js): written when there are none, written again when
  // another canon.json took its place — never over a file the user edited.
  if (canon) {
    try { const w = syncCard(home, canon); if (Object.values(w).some((v) => v === 'written' || v === 'rewritten')) { logger.info(`persona: card ${w.card}, checks ${w.checks} (from canon.json)`); audit('card-synced', w); } else if (w.card === 'kept') logger.info('persona: persona.md was edited by hand or is not from this canon.json; left as it is'); }
    catch (error) { logger.warn(`persona card not written: ${error.message}`); }
  }

  // 1. Her sessions: which ones are hers, whether a turn is running, when she was last busy.
  const homeSessions = new Set(); // sessions that are acts: cwd inside home, or opened from an IM bot
  const wantHome = cfg.scope === 'all' || String(cfg.scope).includes('home');
  const wantIm = cfg.scope === 'all' || String(cfg.scope).includes('im');
  let lastActivity = 0;
  let running = 0;
  const dshDot = () => ctx.get('dshDot');
  const at = (ms) => (ms ? describeNow(new Date(ms)) : null);
  /** A task of her own came back: settled in the ledger. */
  const remember = (kind, r, doing = '') => {
    if (doing) doings.settle(doing, { status: r.status, result: r.report, usage: r.cost, doneAt: r.doneAt });
    audit('task-returned', { kind, status: r.status });
  };
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    const cwd = session?.header?.cwd;
    if (!id || !event) return;
    if (cfg.scope === 'all' || (wantHome && cwd && inside(home, cwd))) homeSessions.add(id);
    if (wantIm && event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(isImMessage)) homeSessions.add(id);
    if (wantIm && event.type === 'user/message' && isImMessage(event.data)) homeSessions.add(id);
    if (!homeSessions.has(id)) return;
    // What the scheduler needs to know: a turn is running, and when she was last busy.
    if (event.type === 'turn/start') { running++; return; }
    if (event.type === 'turn/end') { running = Math.max(0, running - 1); lastActivity = Date.now(); }
  });

  /** A task queued now expires when her active hours end (or at dot's own TTL, whichever is first). */
  const hours = () => dshDot()?.awakeHours ?? ''; // her day is dsh-dot's to say (dot.awakeHours)
  const ttlInHours = () => { const left = msLeftInHours(hours()); return Number.isFinite(left) ? Math.max(60000, Math.min(left, dshDot()?.taskTtlMs ?? 1800000)) : undefined; };


  // 自己的时间: a few times a day, at random moments in her active hours, she gets time of her own, in her conversation.
  const free = new Map(); // session id → { cost, budget, warned, stopped }
  let freeQueued = false; // one free time at a time, from queued to done
  const freeLeft = () => Math.max(0, cfg.freeDailyTokens - (meta.dayFreeTokens ?? 0));
  const planFree = (now = Date.now()) => {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(hours()).trim());
    const day = new Date(now); day.setHours(0, 0, 0, 0);
    let start = day.getTime(), end = start + 86400000;
    if (m) { start = day.getTime() + (+m[1] * 60 + +m[2]) * 60000; end = day.getTime() + (+m[3] * 60 + +m[4]) * 60000; if (end <= start) end += 86400000; }
    const from = Math.max(now, start), to = end - 30 * 60000;
    // Slots still ahead (yesterday's, past midnight when the hours wrap) are kept.
    const kept = (meta.freeAt ?? []).filter((t) => t > now && t < start);
    meta.freeAt = [...kept, ...(to > from ? Array.from({ length: Math.max(0, cfg.freeTimesPerDay) }, () => Math.round(from + Math.random() * (to - from))) : [])].sort((a, b) => a - b);
    meta.freeDay = dayOf(new Date(now)); saveMeta();
  };
  async function freeTime(phase = 'free') {
    rollDay();
    const held = (why) => { audit('free-held', { phase, why }); return { skipped: why }; };
    if (!dshDot()?.task) return held('needs dot (dsh-dot)');
    if (free.size || freeQueued) return held('already running');
    if (freeLeft() < Math.min(cfg.freeTokenCap, 20000)) return held('daily budget used');
    const budget = Math.min(cfg.freeTokenCap, freeLeft());
    const mem = ctx.get('dotMemory');
    const context = {
      now: describeNow(new Date()),
      yourNotes: mem?.herLife?.() ?? [],
      yourDoings: doings.view({ rounds: roundCost(), price: cfg.price, recent: 10 }),
    };
    let doing = '', sid = '', f = null;
    const text = freePrompt({ budget, left: freeLeft(), place: herPlace, listing: listPlace(herPlace), context });
    const r = dshDot().task({
      kind: 'free', key: `free|${dayOf()}|${meta.dayFrees ?? 0}`, text, source: FREE_SOURCE, ttlMs: ttlInHours(),
      onStart: (id) => { sid = id; f = { cost: 0, budget, warned: false, stopped: false }; free.set(id, f); },
      onDone: (res) => {
        freeQueued = false;
        if (sid && free.get(sid) === f) free.delete(sid);
        const status = f?.stopped ? 'stopped' : res.status;
        remember('free', { ...res, status }, doing);
        audit('free-done', { status, tokens: res.cost ? tokensOf(res.cost) : 0 });
      },
    });
    if (r === 'refreshed') return held('already queued');
    freeQueued = true;
    doing = doings.add({ kind: 'free', what: '自己的时间' });
    meta.dayFrees = (meta.dayFrees ?? 0) + 1; saveMeta();
    audit('free-queued', { phase, budget });
    return { ok: true, budget };
  }
  // What her own time costs, step by step: told to wrap up past 80% of its budget, stopped at 100%.
  // A cached re-read of the context weighs a tenth (what it costs on DeepSeek), or every step would
  // spend the whole context again and the budget would buy three steps.
  const freeWeight = (u) => (Number(u.inputTokens ?? 0) || 0) + (Number(u.cacheWriteTokens ?? 0) || 0) + (Number(u.outputTokens ?? 0) || 0) + 0.1 * (Number(u.cacheReadTokens ?? 0) || 0);
  const agentOf = async (id) => {
    const a = ctx.get('agents')?.get?.(id);
    if (a) return a;
    try { const found = await ctx.get('sessionController')?.resolveAgent(id); return found && !('error' in found) ? found.agent : null; } catch (error) { void error; return null; }
  };
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    const f = free.get(id);
    if (!f || event?.type !== 'assistant/message' || !event.data?.usage) return;
    const step = Math.round(freeWeight(event.data.usage));
    f.cost += step; meta.dayFreeTokens = (meta.dayFreeTokens ?? 0) + step; saveMeta();
    if (!f.stopped && f.cost >= f.budget) {
      f.stopped = true; // from here the gate refuses every tool, whether or not the cancel lands
      void (async () => {
        const agent = await agentOf(id);
        try { if (typeof agent?.cancel === 'function') { agent.cancel({ kind: 'hook', reason: 'dsh-interlude: free time budget' }, { keepInbox: true }); audit('free-stopped', { session: id, cost: f.cost }); return; } } catch (error) { void error; }
        audit('free-stop-refused-tools', { session: id, cost: f.cost });
      })();
      return;
    }
    if (!f.warned && f.cost >= 0.8 * f.budget) {
      f.warned = true;
      void (async () => {
        const agent = await agentOf(id);
        if (free.get(id) !== f || f.stopped) return; // over by now: no message to wake an idle agent with
        const m = createUserMessage({ content: [{ type: 'text', text: prompt('interlude.free.budget', { stamp: stamp(), used: f.cost, budget: f.budget }) }], source: FREE_SOURCE });
        try {
          if (typeof agent?.steer === 'function') agent.steer(m);
          else if (typeof agent?.send === 'function') agent.send(m, 'next-step', true);
          else { audit('free-warn-unavailable', { session: id }); return; }
          audit('free-warned', { session: id, cost: f.cost });
        } catch (error) { void error; }
      })();
    }
  });
  // In her own time: typing in a social app asks him first.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = exec.agent?.session?.id;
    // Her own time runs in her conversation; her hands (dsh-dot/hands) do the typing, so the rule about typing looks at them too.
    const hands = Boolean(free.size && dshDot()?.isHands?.(sessionId, exec.agent?.session?.header?.cwd));
    if (!sessionId || !(free.has(sessionId) || hands)) return next();
    if (free.get(sessionId)?.stopped) return deny(prompt('interlude.free.over'));
    const tool = exec.name === PHONE_TYPE_TOOL ? exec.name : exec.name.startsWith(PHONE_TOOL_PREFIX) ? exec.name.slice(PHONE_TOOL_PREFIX.length) : '';
    const input = exec.input ?? exec.args ?? exec.arguments;
    if (tool && typesText(tool, input)) {
      const phone = ctx.get('dshPhone');
      // The phone first (one session drives it at a time), then which app is in front.
      const busyPhone = await phone?.lease?.(sessionId, tool);
      if (busyPhone) return deny(busyPhone);
      let pkg = '';
      try { pkg = String((await phone?.foreground?.()) ?? '').split('/')[0]; } catch (error) { void error; }
      // A batch that opens an app and types: the app it opens is where the typing lands.
      const opened = tool === 'mobile_batch_commands' ? /launch_app[\s\S]*?"(?:packageName|package|appId)"\s*:\s*"([\w.]+)"/.exec(JSON.stringify(input ?? ''))?.[1] : '';
      if (opened) pkg = opened;
      if (SOCIAL_PACKAGES.includes(pkg) || (tool === 'mobile_batch_commands' && /launch_app/.test(JSON.stringify(input ?? '')) && !opened)) {
        const r = await next();
        if (r?.kind === 'deny' || r?.kind === 'ask') return r;
        const label = Object.keys(KNOWN_APPS.labels).find((k) => KNOWN_APPS.labels[k] === pkg) ?? (pkg || '一个刚打开的 App');
        audit('free-typing-asked', { session: sessionId, app: pkg });
        return { kind: 'ask', reason: prompt('interlude.free.typing', { app: label }) };
      }
    }
    return next();
  }, { prepend: true });


  // 3. Scheduling: the weekly review and her own time.
  function tick() {
    if (running > 0) return;
    const now = Date.now();
    rollDay();
    if (cfg.freeTimesPerDay > 0 && dshDot()?.task) {
      if (meta.freeDay !== dayOf(new Date(now))) planFree(now);
      if ((meta.freeAt ?? []).length && meta.freeAt[0] <= now && inHours(hours()) && (!lastActivity || now - lastActivity >= cfg.idleMinutes * 60000)) {
        meta.freeAt = meta.freeAt.slice(1); saveMeta();
        void freeTime('scheduled'); return;
      }
    }
  }
  ctx.effect(() => { const timer = setInterval(tick, 60000); return () => clearInterval(timer); }, 'dsh-interlude: scheduler');
  // Model requests (src/llm-gate.js): her own time runs in her conversation and her hands' session (dot registers those).
  installLlmGate(ctx, { name: 'dot-interlude' });

  // 4. 幕前: the Canon is a system-prompt section (right after the deployment persona, static per
  // session so the cached prefix holds).
  const inHome = (c) => { const s = c.agent?.session; return cfg.scope === 'all' || Boolean((wantHome && s?.header?.cwd && inside(home, s.header.cwd)) || homeSessions.has(s?.id)); };
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'interlude:canon',
      order: scope.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') + 1 || 1,
      text: (c) => (inHome(c) ? canonText() : ''),
    }), 'dsh-interlude: canon section');
    // Drop dsh's own openers for the character's sessions so the Canon is the first thing the model
    // reads; other sessions are untouched. (A `complete` section cannot do this per session.)
    const OURS = /^(interlude|dot|phone|qq|computer|memory):/;
    const keep = (name) => name === 'interlude:canon' || name === 'dot:rules' || name.startsWith('mcp:');
    scope.effect(() => scope.on('system-prompt/assemble', async (_assembly, c, next) => {
      const assembly = await next();
      if (!inHome(c)) return assembly;
      // A lean conversation of hers (dot.lean) sees only her own tools, so the host's sections about the others — the
      // shell, jobs, file search, subagents, workflows, MCP resources — are not hers to read either: what is left is
      // what this plugin wrote for her (her card, her rules, her phone, her QQ).
      const sess = c.agent?.session;
      let lean = false;
      try { lean = Boolean(ctx.get('dshDot')?.lean?.(sess?.id, sess?.header?.agentPreset)); } catch { lean = false; }
      const sections = assembly.sections.filter((sec) => (lean ? OURS.test(sec.name) : cfg.canonOnly ? keep(sec.name) : !cfg.trimSections.includes(sec.name)));
      // The tool list of the request is part of the assembly, and what this returns is what is sent (dsh-system-prompt):
      // a lean conversation is offered her own tools only — also the ones her agent's preset brought, which a
      // tools.restrict() does not reach. The host's two transport names stay (PTC's run_code, structured output).
      return sections.length === assembly.sections.length ? assembly : { ...assembly, sections };
    }), 'dsh-interlude: prompt trim');
    // How she talks, as the very last thing before she answers (after the history, the memory and the
    // interlude): what is read last weighs most (cf. SillyTavern's Author's Note at depth 0, Character
    // Card V2 post_history_instructions). Her conversation only: her hands do not chat.
    // It goes with whatever has just reached her (dshDot.turnNote, the last part of it), not into dsh's snapshot.
  });
  ctx.inject?.(['dshDot'], (c) => c.effect(() => (c.dshDot ?? ctx.get('dshDot'))?.turnNote?.({
    name: 'interlude:voice', order: 990,
    text: ({ agent }) => (!cfg.voice || !inHome({ agent }) || dshDot()?.retired?.(agent?.session?.id) ? '' : voiceText()),
  }) ?? (() => {}), 'dsh-interlude: how she talks, last'));

  // 4b. Her own hands on the ledger: in her conversation, when he reacts to something she did on her own.
  const doingsLine = (d) => `#${d.id} ${new Date(d.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} ${d.kind} ${d.app ? `${d.app} ${d.action} ` : ''}${d.what} → ${d.status}${d.result ? `：${clip(d.result, 80)}` : ''}${d.cost ? ` · ${tokensOf(d.cost)} token` : ''}${(d.feedback ?? []).map((f) => ` ｜${f.from === 'owner' ? '他' : '我'}：${f.text}`).join('')}`;

  // 5. /interlude
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'interlude',
      description: 'Her persona and her own doings: status; "preset <share code>" imports a Canon from the preset hub, "canon" shows it, "doings" lists what she did on her own and what it cost, "feedback [#id] <text>" tells her what you think of one, "free" gives her some time of her own now',
      input: { hint: '[preset <code> | canon | doings | feedback [#id] <text> | free]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        let result = '';
        if (/^preset\s+\S+/.test(arg)) {
          try {
            canon = await fetchPreset(cfg.presetHub, arg.split(/\s+/)[1]);
            writeFileSync(files.canon, JSON.stringify(canon, null, 2));
            writeCard();
            audit('canon-imported', { title: canon.source.title, shareCode: canon.source.shareCode });
            result = `\nimported: ${canon.source.title} by @${canon.source.author} (${canon.source.license}) → ${files.canon}`;
          } catch (error) { result = `\nimport failed: ${error.message}`; }
        } else if (arg === 'free') {
          const r = await freeTime('command');
          result = r.ok ? `\nher own time is queued (budget ${r.budget} tokens)` : `\nnot queued: ${r.skipped}`;
        } else if (arg === 'doings') {
          result = `\n${doings.all().slice(-15).map(doingsLine).join('\n') || '(nothing yet)'}`;
        } else if (/^feedback\s+\S/.test(arg)) {
          const m = /^feedback\s+(?:#(\S+)(?:\s+|$))?([\s\S]*)$/.exec(arg);
          const d = m && m[2].trim() ? doings.feedback(m[1] ?? '', m[2], 'owner') : null;
          if (d) audit('feedback', { id: d.id, from: 'owner', via: 'command' });
          result = d ? `\nnoted on #${d.id}: ${d.what}` : m && !m[2].trim() ? '\nwhat should she hear? /interlude feedback [#id] <text>' : `\nno such doing${m?.[1] ? ` #${m[1]}` : ''}`;
        } else if (arg === 'canon') {
          result = `\n${canonText() || '(no canon: /interlude preset <share code>, or set config.canon)'}`;
        }
        rollDay();
        const lines = [
          `home: ${home} · scope: ${cfg.scope}`,
          `canon: ${canon ? `${canon.storyDefaults.characterName}${canon.source?.title ? ` ← ${canon.source.title} (@${canon.source.author}, ${canon.source.shareCode})` : ` (${canon.source?.kind ?? 'canon.json'})`}` : '(none) — /interlude preset <share code>'}`,
          `free time: ${cfg.freeTimesPerDay > 0 ? `${meta.dayFrees ?? 0}/${cfg.freeTimesPerDay} today, ${meta.dayFreeTokens ?? 0}/${cfg.freeDailyTokens} tokens, next ${(meta.freeAt ?? [])[0] ? describeNow(new Date(meta.freeAt[0])) : '-'}${dshDot()?.task ? '' : ' (needs dsh-dot)'}` : 'off'} · idle ${lastActivity ? Math.round((Date.now() - lastActivity) / 60000) : '-'} min · awake ${hours() || 'always'}`,
          `doings: ${doings.all().length} on the ledger`, `today ${meta.dayTokensIn ?? 0} in / ${meta.dayTokensOut ?? 0} out tokens`,
        ];
        return { kind: 'success', text: lines.join('\n') + result };
      },
    }), 'dsh-interlude: /interlude command');
  });

  // For the panel (dsh-dot/dot) and the page: her persona, what she did on her own, her portrait — as data.
  ctx.provide?.('dshInterlude', {
    /** Import her persona from the preset hub by share code (the dot page's setup; /interlude preset does the same). */
    async importPreset(code) {
      canon = await fetchPreset(cfg.presetHub, code);
      writeFileSync(files.canon, JSON.stringify(canon, null, 2));
      writeCard();
      audit('canon-imported', { title: canon.source.title, shareCode: canon.source.shareCode });
      return { name: canon.storyDefaults.characterName, title: canon.source.title, author: canon.source.author, license: canon.source.license };
    },
    /** What code checks in what she says to him: the phrases of <home>/persona.checks.txt, as patterns. */
    checks() { return readChecks(home); },
    /** Her card as she reads it ('' when the home has none and the canon is rendered instead). */
    card() { return readCard(home); },
    /** Her card as the text she is made of — <home>/persona.md, or the canon rendered when there is none: what the call that writes her words gets as its whole system prompt (dot/say.js). */
    cardText() { return cardFor(home, 'say', readCard(home)) || renderCanon(canon) || ''; },
    /** The imported persona, or null while she runs on the built-in one. */
    canon() { return canon?.source ? { name: canon.storyDefaults?.characterName, title: canon.source.title, author: canon.source.author } : null; },
    /** One line on who she is (for the QQ group scorer): name + the character profile. */
    who() { const sd = canon?.storyDefaults ?? {}; return `${sd.characterName ?? 'dot'}：${String(sd.characterProfile ?? '').replace(/\s+/g, ' ').slice(0, 240)}`; },
    status() {
      rollDay();
      return {
        name: canon?.storyDefaults?.characterName ?? 'dot',
        today: { tokensIn: meta.dayTokensIn ?? 0, tokensOut: meta.dayTokensOut ?? 0 },
        doings: doings.view({ rounds: roundCost(), price: cfg.price, recent: 8 }),
        free: { today: meta.dayFrees ?? 0, perDay: cfg.freeTimesPerDay, tokens: meta.dayFreeTokens ?? 0, dailyTokens: cfg.freeDailyTokens, next: (meta.freeAt ?? [])[0] ?? null },
        awakeHours: hours(),
      };
    },
  });

  logger.info(`interlude ready — ${dir}`);
}
