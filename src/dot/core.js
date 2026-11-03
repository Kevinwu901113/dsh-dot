// dsh-dot/core: the glue that turns dsh into an always-on personal agent ("dot").
//
// Everything with an existing plugin is left to that plugin:
//   identity     → dsh-interlude's Canon (or dsh's own persona config); dot adds only its working rules
//   schedules    → official schedule service, built into dsh >= 0.2.1 (schedule_create, cron, restores cold sessions)
//   IM           → dsh-im (chats, approvals by reply, proactive delivery service `dshIm`)
//   spending cap (optional) → dsh-budget (`overLimit: block`)
//   computer     → dsh-computer (VM, approval gates, live view, audit log)
// What is left, because no plugin does it:
//   1. results of scheduled turns in <home> go to IM through dsh-im's public `send()`,
//      unless the reply is only DOT_SILENT (nothing worth reporting);
//   2. an approval asked during such a turn is announced on IM with the live-view link;
//   3. dsh-budget blocks are announced on IM, and the `daily` block is lifted at local midnight;
//   4. VM failures are announced on IM; /dot shows the status.
import { PHONE_TOOL_PREFIX, VM_TOOL_PREFIX } from '../tool-prefixes.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mountPanel } from './panel.js';
import { sectionOf, setValues } from '../settings.js';
import { configure as configurePrompts, fill, prompt, table } from '../prompts.js';
import { ago, describeNow, stamp } from '../clock.js';

export const name = 'dsh-dot';
// Devices are optional components: the computer (dshComputer) and the phone (dshPhone). dot works
// with either; with neither it still relays, but says so in /dot.
export const inject = [];

export const SILENT = 'DOT_SILENT';

/** Source of the message that wakes her for a phone notification; such turns are not pushed to IM. */
export const PHONE_NOTIFICATION_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'phone-notification' });
/**
 * The owner's QQ private messages enter her session as what they are: the person typing to her.
 * Same source shape dsh-im uses for relayed IM (`kind: 'user'` + a channel-prefixed rpcId), so dsh
 * treats them as direct human input — which is what lets a QQ message start a long task (goal).
 * Nobody else's messages get this.
 */
export const ownerSource = () => ({ kind: 'user', rpcId: `qq-dot-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}` });
/** Source of the periodic "pick up your phone" turn; not pushed to IM either. */
export const PHONE_CHECK_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'phone-check' });
/** The periodic turn: she picks up her phone the way people do between things. */
export const phoneCheckText = (now = Date.now()) => prompt('dot.phone-check', { stamp: stamp(now, now), silent: SILENT });
/** When a wake happened: the first item's arrival (held items keep theirs), else now. */
const firstAt = (items, now) => { const t = Date.parse(items?.[0]?.at ?? ''); return Number.isFinite(t) ? Math.min(t, now) : now; };
/** His QQ words as she gets them: one stamp per batch, then exactly what he typed, one message per line. */
export const ownerWords = (items, now = Date.now()) => prompt('dot.owner-words', { stamp: stamp(firstAt(items, now), now), text: items.map((n) => n.text).join('\n') });
/** The one line that tells her what time it is, and how long since the last thing said in her conversation. */
export function nowText(now = Date.now(), lastAt = 0) {
  const t = table('dot.now');
  const since = ago(lastAt, now);
  return fill(t.line, { now: describeNow(new Date(now)), since: since ? fill(t.since, { ago: since }) : '' });
}

const APP_NAMES = { qq: 'QQ', 'com.tencent.mobileqq': 'QQ', 'com.tencent.mm': '微信', 'com.max.xiaoheihe': '小黑盒', 'tv.danmaku.bili': 'B站', 'com.sina.weibo': '微博', 'com.xingin.xhs': '小红书', 'com.zhihu.android': '知乎', 'com.ss.android.ugc.aweme': '抖音', 'com.taobao.taobao': '淘宝', 'com.eg.android.AlipayGphone': '支付宝', 'org.telegram.messenger': 'Telegram', 'com.android.chrome': 'Chrome' };

/** Conversation title without the counters chat apps append ("宽(2条新消息)" → "宽"). */
export const conversationTitle = (title) => String(title ?? '').replace(/\s*[（(]\d+\s*条(新消息)?[)）]\s*$/, '').trim();

/**
 * Group notifications by conversation (notification key, then app + title), keeping each
 * conversation's distinct texts in arrival order — so three messages from one person read as a
 * list, not as the last one with "(3条新消息)".
 */
export function groupNotifications(items) {
  const groups = new Map();
  for (const n of items) {
    const title = conversationTitle(n.title);
    const id = n.key || `${n.pkg}|${title}`;
    const g = groups.get(id) ?? { pkg: n.pkg, title, texts: [] };
    const text = String(n.text ?? '').trim();
    if (text && g.texts.at(-1) !== text) g.texts.push(text);
    groups.set(id, g);
  }
  return [...groups.values()];
}

/** The wake-up text for the notifications that arrived together (or while she was busy): what the phone showed, and that she decides. */
export function notificationText(list, { whileBusy = false, now = Date.now() } = {}) {
  const items = Array.isArray(list) ? list : [list];
  const groups = groupNotifications(items);
  const app = (pkg) => APP_NAMES[pkg] ?? pkg;
  const render = (g) => {
    const who = `${app(g.pkg)}${g.title ? ` · ${g.title}` : ''}`;
    if (g.texts.length <= 1) return `${who}：${g.texts[0] || '（无内容）'}`;
    return `${who}：\n${g.texts.map((t) => `- ${t}`).join('\n')}`;
  };
  const messages = groups.length === 1 ? render(groups[0]) : `${prompt('dot.notification.many', { count: groups.length })}\n${groups.map((g) => `· ${render(g)}`).join('\n')}`;
  const when = whileBusy ? prompt('dot.notification.busy') : '';
  const viaQq = groups.some((g) => g.pkg === 'qq');
  const how = prompt(viaQq ? (groups.every((g) => g.pkg === 'qq') ? 'dot.notification.how-qq' : 'dot.notification.how-mixed') : 'dot.notification.how-app');
  return prompt('dot.notification', { stamp: stamp(firstAt(items, now), now), messages, when, how, silent: SILENT });
}
/** The whole message that wakes her: the notifications, the people she remembers in them, the unverified-name warning. */
export function wakeText(items, { whileBusy = false, cards = '', now = Date.now() } = {}) {
  const text = `${notificationText(items, { whileBusy, now })}${cards ? `\n${prompt('dot.notification.cards', { cards })}` : ''}`;
  return items.some((n) => n.unverifiedOwner) ? `${text}\n${prompt('dot.notification.unverified')}` : text;
}

/** Model-facing rule for a turn started by a scheduled task. */
export const scheduledRule = () => prompt('dot.scheduled', { silent: SILENT });

/** Standing working rules for sessions in <home>: a prompt section, so no AGENTS.md is needed. */
export function workingRules({ computer = true, phone = false } = {}) {
  const [computerIntro, computerRule] = computer ? prompt('dot.rules.computer', { vmPrefix: VM_TOOL_PREFIX }).split('\n') : ['', ''];
  const [phoneIntro, phoneRule] = phone ? prompt('dot.rules.phone', { phonePrefix: PHONE_TOOL_PREFIX }).split('\n') : ['', ''];
  return prompt('dot.rules', { computer: computerIntro, phone: phoneIntro, computerRule: computerRule ?? '', phoneRule: phoneRule ?? '', silent: SILENT });
}

export const defaults = {
  home: '',             // default ~/dot
  scope: 'home+im',     // which sessions are dot's: 'home' (cwd inside home), 'im' (opened from an IM bot), 'home+im', 'all'
  imBot: '',            // dsh-im Bot ID; default: the first bot that has a saved delivery target
  imTarget: '',         // dsh-im Target ID; default: that bot's first saved target
  budgetPollSeconds: 15,
  autoUnblockDaily: true,
  notifyBatchMs: 1000,  // notifications arriving within this window wake her once, together
  phoneCheckEveryMinutes: 30, // if nothing woke her meanwhile: a "pick up your phone" turn; 0 = off
  notifyHours: '', // optional quiet hours ('HH:MM-HH:MM'): outside them app notifications do not wake her; '' (default) = always
  // Her errand session: phone checks, app notifications, interlude observations and plays run here,
  // so screenshots and element dumps never enter the conversation she has with you. Only the
  // conclusion of an errand reaches her conversation, as context for her next turn there.
  errands: true,
  errandMaxTokens: 60000, // the errand session is archived and a fresh one started past this
  // Notifications from these apps are conversations: they wake her conversation, not the errand.
  conversationApps: ['qq', 'com.tencent.mobileqq', 'com.tencent.mm'],
};

/** Source of the note an errand leaves in her conversation (injected; it does not wake her). */
export const ERRAND_NOTE_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'errand-note' });
/** The note an errand leaves in her conversation: what she did on her phone, in her own words. */
export function errandNote(origin, text, now = Date.now()) {
  const what = table('dot.errand-note.what');
  return prompt('dot.errand-note', { stamp: stamp(now, now), what: what[Object.hasOwn(what, origin) ? origin : 'other'], text: String(text).trim() });
}

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
/** dsh-im tags messages it relays with an rpcId of `<channel>-<uuid>`; the desktop UI does not. */
export const IM_RPC = /^(weixin|wechat|qq|feishu|lark|dingtalk|wecom|wework|telegram|discord|slack|whatsapp|email|office)-/i;
// "qq-dot-…" is our own tag (ownerSource): his QQ words relayed by dot, not a dsh-im bot session —
// counting those made her conversation an "IM bot session", which the memory handoff leaves alone
// (11-03: 456k tokens, no handoff since 10-29).
export const isImMessage = (m) => { const r = String(m?.source?.rpcId ?? ''); return IM_RPC.test(r) && !r.startsWith('qq-dot-'); };
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
/** 'HH:MM-HH:MM' (may wrap midnight) → is `date` inside it? Empty spec = always. */
export function inHours(spec, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!m) return true;
  const start = +m[1] * 60 + +m[2], end = +m[3] * 60 + +m[4], now = date.getHours() * 60 + date.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
const today = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** Text of a message content array (or string). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
}

/** `DOT_SILENT` alone, tolerating markdown decoration and punctuation around it. */
export const isSilent = (text) => typeof text === 'string'
  && text.replace(/[`*\s。."'“”]/g, '').replace(/^_+|_+$/g, '') === SILENT;

/** Drop a trailing marker after real content. */
export const stripSilent = (text) => text.replace(new RegExp(`\\s*${SILENT}\\s*$`), '').trim();

function createStore(file) {
  let data = {};
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { void error; /* first run */ }
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; try { writeFileSync(file, JSON.stringify(data, null, 2)); } catch (error) { void error; /* state is best-effort */ } },
  };
}

/**
 * Reach the user through dsh-im's public delivery service.
 * @param {() => object | undefined} getIm - returns the `dshIm` service when installed.
 */
export function createNotifier(getIm, cfg, logger, getQq = () => undefined) {
  async function target() {
    const q = getQq();
    if (q?.connected && q.owner) return { qq: q, name: `QQ ${q.owner}`, target: q.owner, bot: 'napcat' };
    const im = getIm();
    if (!im?.send) return { error: 'dsh-im is not installed (and her QQ is not connected)' };
    if (cfg.imBot && cfg.imTarget) return { im, bot: cfg.imBot, target: cfg.imTarget };
    try {
      // listBots() returns [{ botId, channel }].
      const bots = cfg.imBot ? [cfg.imBot] : (await im.listBots()).map((b) => (typeof b === 'string' ? b : b?.botId)).filter(Boolean);
      for (const bot of bots) {
        const targets = await im.listTargets(bot);
        const t = cfg.imTarget ? targets.find((x) => x.targetId === cfg.imTarget) : targets[0];
        if (t) return { im, bot, target: t.targetId, name: t.name };
      }
    } catch (err) {
      return { error: err.message };
    }
    return { error: 'no saved delivery target (dsh-im settings → bot → 新建目标)' };
  }
  async function send(text, format = 'markdown') {
    const t = await target();
    if (t.error) { logger.warn(`not delivered (${t.error}): ${text.slice(0, 80)}`); return false; }
    if (t.qq) { try { return (await t.qq.send('owner', text)).sent > 0; } catch (err) { logger.warn(`qq send failed: ${err.message}`); return false; } }
    try {
      // "<sep/>" (HDSI's convention for several sends in one moment) becomes separate messages.
      const parts = text.split(/<sep\s*\/>/i).map((p) => p.trim()).filter(Boolean);
      let ok = false;
      for (const part of parts.length ? parts : [text]) ok = (await t.im.send(t.bot, t.target, part, { format }))?.sent === true || ok;
      return ok;
    } catch (err) {
      logger.warn(`dsh-im send failed: ${err.message}`);
      return false;
    }
  }
  return { send, target };
}

export function apply(ctx, config = {}) {
  // An empty string means "not set", except for notifyHours, where '' is documented as "always".
  const logger = ctx.logger('dsh-dot');
  const cfg = { ...defaults, ...setValues(config, { keepEmpty: ['notifyHours'] }), ...sectionOf('dot', (m) => logger.warn(m)) };
  if (cfg.enabled === false) { logger.info('off (dsh-dot.json: dot.enabled = false)'); return; }
  const computer = () => ctx.get('dshComputer');
  const phone = () => ctx.get('dshPhone');
  const audit = (event, data = {}) => (computer()?.audit ?? phone()?.audit)?.({ kind: 'dot', event, ...data });
  const home = cfg.home || join(homedir(), 'dot');
  configurePrompts({ home, logger });
  const store = createStore(join(dshHome(), 'dsh-dot-state.json'));
  const im = createNotifier(() => ctx.get('dshIm'), cfg, logger, () => ctx.get('dshQq'));

  mkdirSync(home, { recursive: true });
  for (const [svc, pkg] of [['dshIm', '@xmanrui/dsh-im'], ['schedule', 'the schedule service (built into dsh >= 0.2.1)']]) {
    if (ctx.get(svc) === undefined) logger.warn(`${pkg} is not installed (see the dsh-dot README install command)`);
  }
  if (ctx.get('budget') === undefined) logger.info('dsh-budget not installed: no spending cap, budget notices disabled (optional)');

  // Which sessions are dot's. 'home': cwd inside <home>. 'im': any session a dsh-im bot opened,
  // whatever its workspace (the bot's first message carries an IM rpcId, which arrives in the inbox
  // before the turn starts). Treat them the same: an IM conversation is dot's wherever it lands.
  const imSessions = new Set();
  let lastSession = store.get('lastSession') || ''; // her most recent session: where phone notifications wake her (remembered across restarts)
  const wantHome = cfg.scope === 'all' || String(cfg.scope).includes('home');
  const wantIm = cfg.scope === 'all' || String(cfg.scope).includes('im');
  const isDotSession = (id, cwd) => cfg.scope === 'all' || (wantHome && cwd && inside(home, cwd)) || (wantIm && imSessions.has(id));

  // Her errand session (see defaults.errands). Created on first use in <home>, remembered across
  // restarts, archived and replaced once it grows past errandMaxTokens.
  let errandId = cfg.errands ? (store.get('errandSession') || '') : '';
  let errandCreating = null;
  // Errands that were rotated away stay errands: their last turn/end must not make one of them her
  // "latest session" (his QQ message then goes into an archived errand and he never gets an answer).
  const pastErrands = new Set(store.get('pastErrands') ?? []);
  const isErrand = (id) => Boolean(id) && (id === errandId || pastErrands.has(id));
  // Startup self-check: the remembered pointer must be a live conversation of hers. An old state file
  // can point at an errand or at a session archived since (11-03: his QQ messages went into an
  // archived errand and nobody answered). What dsh cannot tell us (no registry yet, no title) is skipped.
  const staleWhy = (id) => {
    if (!id) return '';
    if (isErrand(id)) return 'errand';
    try { if (/跑腿/.test(String(ctx.get('agents')?.get?.(id)?.session?.header?.title ?? ''))) return 'errand title'; } catch (error) { void error; }
    try { const ids = ctx.get('workspaceRegistry')?.archivedSessionIds; if ((Array.isArray(ids) || ids instanceof Set) && [...ids].includes(id)) return 'archived'; } catch (error) { void error; }
    return '';
  };
  const selfCheck = () => {
    const why = staleWhy(lastSession);
    if (!why) return;
    audit('last-session-cleared', { session: lastSession, why });
    logger.warn(`her remembered conversation ${lastSession} is ${why === 'archived' ? 'archived' : 'an errand'}: cleared (the next message to her picks a new one)`);
    lastSession = ''; store.set('lastSession', '');
  };
  selfCheck();
  // The registry can come up after dot: look again once it is there.
  ctx.inject?.(['workspaceRegistry'], (c) => c.effect(() => { selfCheck(); return () => {}; }, 'dsh-dot: startup self-check'));
  async function ensureErrand() {
    if (!cfg.errands) return '';
    if (errandId) return errandId;
    if (errandCreating) return errandCreating;
    const controller = ctx.get('sessionController');
    if (typeof controller?.create !== 'function') return '';
    errandCreating = (async () => {
      try {
        const { sessionId } = await controller.create({ cwd: home });
        try { await controller.rename?.({ sessionId, title: 'dot · 跑腿' }); } catch (error) { void error; }
        errandId = sessionId; store.set('errandSession', sessionId);
        audit('errand-created', { session: sessionId });
        return sessionId;
      } catch (err) { logger.warn(`errand session not created: ${err.message}`); return ''; } finally { errandCreating = null; }
    })();
    return errandCreating;
  }
  async function rotateErrandIfLarge(id) {
    const agent = ctx.get('agents')?.get?.(id);
    const meter = ctx.get('tokenMeter');
    if (!agent || typeof meter?.measure !== 'function') return;
    let tokens = 0;
    try { tokens = Number(meter.measure(agent.session)?.totalTokens ?? 0); } catch (error) { void error; return; }
    if (tokens < cfg.errandMaxTokens) return;
    if (errandId === id) { errandId = ''; store.set('errandSession', ''); }
    pastErrands.add(id); store.set('pastErrands', [...pastErrands].slice(-20));
    if (lastSession === id) { lastSession = ''; store.set('lastSession', ''); }
    try { await ctx.get('workspaceRegistry')?.archiveSession?.(id); } catch (err) { logger.warn(`errand archive failed: ${err.message}`); }
    audit('errand-rotated', { session: id, tokens });
  }
  /** Leave what an errand found in her conversation, without waking it. */
  async function noteToConversation(origin, text) {
    const id = lastSession;
    const controller = ctx.get('sessionController');
    if (!id || !controller) return;
    try {
      const found = await controller.resolveAgent(id);
      if (!found || 'error' in found || typeof found.agent.inject !== 'function') return;
      found.agent.inject(createUserMessage({ content: [{ type: 'text', text: errandNote(origin, text) }], source: ERRAND_NOTE_SOURCE }));
      audit('errand-noted', { session: id, origin });
    } catch (err) { logger.warn(`errand note failed: ${err.message}`); }
  }

  // Today's counters for the panel (persisted; reset when the day changes).
  const stats = () => { const st = store.get('stats'); return st && st.day === today() ? st : { day: today(), woke: 0, owner: 0 }; };
  const bump = (k, n = 1) => { const st = stats(); st[k] = (st[k] ?? 0) + n; store.set('stats', st); };

  // 1 + 2. Scheduled turns in dot's sessions: silence or deliver; announce approvals.
  const turns = new Map(); // session id → { turn, scheduled, text }
  const incoming = new Set(); // sessions whose inbox holds a reminder for the next turn
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    const cwd = session?.header?.cwd;
    if (!id || !event) return;
    if (wantIm && event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(isImMessage)) imSessions.add(id);
    if (wantIm && event.type === 'user/message' && isImMessage(event.data)) imSessions.add(id);
    if (!isDotSession(id, cwd)) return;
    if (event.type === 'turn/end' && lastSession !== id && !isErrand(id)) { lastSession = id; store.set('lastSession', id); }
    // A reminder enters the inbox before its turn starts, and the prompt is assembled at turn
    // start, before the user/message event: note it here so the turn knows from its first step.
    if (event.type === 'agent/inbox/spliced') {
      if ((event.data?.inserted ?? []).some((m) => m?.source?.kind === 'schedule')) incoming.add(id);
      return;
    }
    if (event.type === 'turn/start') {
      turns.set(id, { turn: event.data?.turn, scheduled: incoming.delete(id), text: '', startedAt: Date.now() });
      return;
    }
    const t = turns.get(id);
    if (!t) return;
    if (event.type === 'user/message' && event.data?.source?.kind === 'schedule') { t.scheduled = true; return; }
    // His words came over his QQ: the turn's answer goes back there (unless she already sent one herself).
    if (event.type === 'user/message' && /^qq-/.test(String(event.data?.source?.rpcId ?? ''))) { t.fromQq = true; return; }
    const ended = event.type === 'turn/end' && (event.data?.turn === undefined || event.data.turn === t.turn);
    if (ended) {
      turns.delete(id); // every turn, scheduled or not: `turns` is also "is she busy right now"
      if (id === lastSession || isErrand(id)) setTimeout(() => releaseHeld(id), 50); // after this event settles, so the followup starts a fresh turn
    }
    // An errand turn: its conclusion (unless DOT_SILENT) goes to her conversation as a note.
    if (isErrand(id)) {
      if (event.type === 'user/message' && event.data?.source?.kind === 'dsh-dot') { t.origin = event.data.source.form; return; }
      if (event.type === 'user/message' && event.data?.source?.kind === 'dsh-interlude') { t.origin = event.data.source.form; return; }
      if (event.type === 'assistant/message' && !event.data?.interrupted) { const text = contentText(event.data?.message?.content); if (text.trim()) t.text = text; return; }
      if (ended) {
        const text = stripSilent(t.text.trim());
        // Observations hand their text to the interlude themselves; only her own doings are noted.
        if (text && !isSilent(t.text.trim()) && ['phone-check', 'phone-notification', 'play'].includes(t.origin)) void noteToConversation(t.origin === 'phone-notification' ? 'notification' : t.origin, text);
        void rotateErrandIfLarge(id);
      }
      return;
    }
    if (!t.scheduled && !t.fromQq) return;
    if (event.type === 'assistant/message' && !event.data?.interrupted) {
      const text = contentText(event.data?.message?.content);
      if (text.trim()) t.text = text; // the last non-empty reply of the turn is its answer
      return;
    }
    if (event.type === 'approval/asked') {
      // Payload: { id, toolName, reason? }. dsh-computer's gate puts the live-view link in reason.
      const onPhone = String(event.data?.toolName ?? '').startsWith(PHONE_TOOL_PREFIX);
      const vm = (onPhone ? phone()?.status?.() : computer()?.status?.()) ?? {};
      const link = vm.publicLiveViewUrl || vm.liveViewUrl;
      const reason = String(event.data?.reason ?? '').trim();
      const lines = [`🔐 dot 需要你审批：${event.data?.toolName ?? '工具调用'}`, reason, '在 DeepSeek Harness 里批准或拒绝。'];
      if (link && !reason.includes(link)) lines.push(`实时画面：${link}`);
      void im.send(lines.filter(Boolean).join('\n'), 'plain');
      audit('approval-notified', { session: id, tool: event.data?.toolName });
      return;
    }
    if (ended) {
      const text = t.text.trim();
      if (!text || isSilent(text)) { audit('silent', { session: id }); return; }
      if (t.fromQq && !t.scheduled) {
        // She answered him in the conversation; if no qq_send to him happened during the turn, relay it.
        const q = ctx.get('dshQq');
        if (!q?.connected || (q.sentToOwnerAt ?? 0) >= t.startedAt) { audit('qq-answered-herself', { session: id }); return; }
        q.send('owner', stripSilent(text)).then((r) => audit('qq-relayed', { session: id, sent: r.sent }), (err) => { logger.warn(`qq relay failed: ${err.message}`); audit('qq-relay-failed', { session: id, error: err.message }); });
        return;
      }
      void im.send(stripSilent(text)).then((sent) => audit('delivered', { session: id, sent }));
    }
  });

  // Working rules are a system-prompt section for sessions in <home> (static per session, so the
  // cached prefix holds). The silence rule is additionally put in front of the model on the turn a
  // schedule wakes, as a dynamic context; only those turns get it.
  const inHome = (c) => { const s = c.agent?.session; return isDotSession(s?.id, s?.header?.cwd) || turns.has(s?.id); };
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'dot:rules',
      order: (scope.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 0) + 2,
      text: (c) => (inHome(c) ? workingRules({ computer: Boolean(computer()), phone: Boolean(phone()) }) : ''),
    }), 'dsh-dot: working rules section');
    // Her clock: after the history (like dot:memory), on her conversation and her errands. "Since the
    // last message" counts from the last line said before this turn began, so it holds for the turn.
    scope.systemPrompt.context({
      name: 'dot:now',
      order: 899,
      text: (c) => {
        if (!inHome(c)) return '';
        const started = turns.get(c.agent?.session?.id)?.startedAt ?? Date.now();
        return nowText(Date.now(), ctx.get('dotMemory')?.lastSaidAt?.(started) ?? 0);
      },
    });
    scope.systemPrompt.context({
      name: 'dot:scheduled-turn',
      order: 900,
      text: (c) => (turns.get(c.agent?.session?.id)?.scheduled ? scheduledRule() : ''),
    });
  });

  // 3. Budget.
  let blocked = store.get('blocked') ?? []; // persisted so a standing block is not re-announced after a restart
  async function pollBudget() {
    const budget = ctx.get('budget');
    if (!budget?.status) return;
    let now;
    try { now = budget.status().blockedScopes ?? []; } catch (error) { void error; return; }
    if (cfg.autoUnblockDaily && now.includes('daily') && store.get('blockedOn') && store.get('blockedOn') !== today()) {
      try { budget.unblock('daily'); now = now.filter((s) => s !== 'daily'); } catch (error) { logger.warn(`auto-unblock failed: ${error.message}`); }
      audit('budget-auto-unblock', { scope: 'daily' });
      await im.send('✅ dot: 新的一天，昨天的日预算阻断已自动解除，定时任务照常运行。', 'plain');
    }
    const added = now.filter((s) => !blocked.includes(s));
    if (added.length) {
      store.set('blockedOn', today());
      audit('budget-blocked', { scopes: now });
      await im.send(`⛔ dot: 预算已用完，已暂停（${now.join('、')}）。\n在 DeepSeek Harness 里发送 /budget unblock ${added[0]} 可立即恢复${cfg.autoUnblockDaily && added.includes('daily') ? '；日预算会在明天零点自动恢复' : ''}。`, 'plain');
    }
    if (blocked.length && !now.length) { audit('budget-unblocked'); await im.send('▶️ dot: 预算阻断已解除，恢复工作。', 'plain'); }
    if (String(blocked) !== String(now)) store.set('blocked', now);
    blocked = now;
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void pollBudget().catch((e) => logger.warn(e.message)); }, cfg.budgetPollSeconds * 1000);
    return () => clearInterval(timer);
  }, 'dsh-dot: budget watch');

  // 4. Device health (whichever devices are installed; they may come up after dot).
  ctx.inject(['dshComputer'], (c) => c.effect(() => c.dshComputer.onStatus?.((s) => {
    if (s.state === 'error') void im.send(`⚠️ dot: 虚拟机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-computer.log`, 'plain');
  }) ?? (() => {}), 'dsh-dot: computer status'));
  // 5. Her phone rings: a new notification wakes her in her latest session. She reads and answers in
  // the app herself; the dsh reply is not relayed anywhere.
  let waking = Promise.resolve();
  let batch = [], batchTimer = null;
  const held = new Map(); // session id → items that arrived while it was running a turn; delivered as one message when it ends
  let deliverTracked; let phoneCheckNow; // assigned below (phone check), used by flush/releaseHeld
  // Conversations (the owner, QQ, WeChat) wake her conversation; every other app's notification is an errand.
  const isConversation = (n) => n.fromOwner || cfg.conversationApps.includes(n.pkg);
  const deliver = (all, whileBusy, target) => {
    const controller = ctx.get('sessionController');
    const id = target ?? lastSession;
    const pkgs = [...new Set(all.map((n) => n.pkg))];
    if (!controller || !id) { audit('notification-dropped', { pkgs, why: id ? 'no sessionController' : 'no session yet' }); return; }
    const fromOwner = all.filter((n) => n.fromOwner);
    const items = all.filter((n) => !n.fromOwner);
    waking = waking.then(async () => {
      const found = await controller.resolveAgent(id);
      if (!found || 'error' in found) { audit('notification-dropped', { pkgs, why: found?.error?.message ?? 'session not found' }); return; }
      // The owner's words, exactly as typed (several messages → several lines), as human input.
      if (fromOwner.length) {
        // His words reached her on the phone while her computer QQ is not up: she answers in the phone app.
        found.agent.followup(createUserMessage({ content: [{ type: 'text', text: ownerWords(fromOwner) }], source: ownerSource() }));
        audit('owner-message', { session: id, count: fromOwner.length, whileBusy }); bump('owner', fromOwner.length);
      }
      if (!items.length) return;
      // The people in these messages, as she remembers them (dsh-dot/memory).
      const cards = ctx.get('dotMemory')?.cardsFor?.(items) ?? '';
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: wakeText(items, { whileBusy, cards }) }], source: PHONE_NOTIFICATION_SOURCE }));
      bump('woke', 1);
      audit('notification-woke', { session: id, count: items.length, pkgs: [...new Set(items.map((n) => n.pkg))], whileBusy, sinceSeenMs: Date.now() - Date.parse(items[0].at), sincePostedMs: items[0].postedAt ? Date.now() - items[0].postedAt : undefined });
    }).catch((err) => { logger.warn(`wake for notification failed: ${err.message}`); audit('notification-dropped', { pkgs, why: err.message }); });
  };
  let frozen = 0; let frozenQueue = []; // while her conversation is being handed over (dsh-dot/memory)
  const send = (id, items) => {
    if (!items.length) return;
    if (frozen && id === lastSession) { frozenQueue.push(...items); audit('notification-held', { count: items.length, why: 'handoff' }); return; }
    // That session is in the middle of a turn: hold these; the turn's end delivers everything at once, in order.
    if (id && turns.has(id)) { held.set(id, [...(held.get(id) ?? []), ...items]); audit('notification-held', { count: items.length, why: 'turn running', errand: isErrand(id) }); return; }
    deliverTracked(items, false, id);
  };
  const flush = async () => {
    const items = batch; batch = []; batchTimer = null;
    if (!items.length) return;
    const errands = items.filter((n) => !isConversation(n));
    const e = errands.length ? await ensureErrand() : '';
    // No errand session (errands off, or it cannot be created): everything wakes her conversation, together.
    if (!e) { send(lastSession, items); return; }
    send(lastSession, items.filter(isConversation));
    send(e, errands);
  };
  // Items held for an errand that was rotated meanwhile go to the current errand, not the archived one.
  const releaseHeld = async (id) => { const items = held.get(id); if (!items?.length) return; held.delete(id); deliverTracked(items, true, pastErrands.has(id) ? (await ensureErrand()) || lastSession : id); };
  const conversationPlatform = { qq: 'qq', 'com.tencent.mobileqq': 'qq', 'com.tencent.mm': 'wechat' };
  const wake = (n) => {
    // Her QQ on the computer delivers the same messages as events; the phone's QQ notifications would double them.
    if (n.pkg === 'com.tencent.mobileqq' && ctx.get('dshQq')?.connected) { audit('notification-held', { pkg: n.pkg, why: 'qq channel connected' }); return; }
    // Who this is: one registry for every channel (dsh-dot/memory). Her computer QQ gives the
    // number, and only the owner's number (set by hand with /qq owner) makes a message his own words.
    // A chat app's notification shows only a display name — anyone can choose one — so a phone-side
    // message is never his, whatever the name resolves to; a name that resolves to his card is not
    // recorded on it either (that would turn the name into one of his handles).
    if (!n.handles && conversationPlatform[n.pkg] && conversationTitle(n.title)) {
      const name = conversationTitle(n.title);
      n = { ...n, platform: conversationPlatform[n.pkg], name, handles: [`${conversationPlatform[n.pkg]}:name:${name}`], via: 'phone', fromOwner: false };
    }
    if (n.handles) {
      const mem = ctx.get('dotMemory');
      const known = mem?.resolve?.({ handles: n.handles, platform: n.platform, name: n.name });
      if (known?.tier === 'owner' && !n.fromOwner) {
        // Looks like him, cannot be verified: a plain message, flagged, and his card untouched.
        n = { ...n, unverifiedOwner: true, title: `${n.title}（未验证身份）` };
        audit('owner-name-unverified', { pkg: n.pkg, name: n.name, via: n.via });
      } else {
        mem?.touch?.({ handles: n.handles, platform: n.platform, name: n.name, tier: n.fromOwner ? 'owner' : 'talked', kind: n.kind === 'group' ? 'group' : 'dm' });
      }
    }
    if (!n.fromOwner && cfg.notifyHours && !inHours(cfg.notifyHours)) { audit('notification-held', { pkg: n.pkg, why: 'outside notifyHours' }); return; }
    batch.push(n);
    if (!batchTimer) { batchTimer = setTimeout(flush, cfg.notifyBatchMs); batchTimer.unref?.(); }
  };
  ctx.inject(['dshPhone'], (c) => c.effect(() => c.dshPhone.onNotification?.(wake) ?? (() => {}), 'dsh-dot: phone notifications'));
  // QQ messages (NapCat in the computer) take the same road as phone notifications: batch, hold while busy, group.
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onMessage?.((m) => wake({
    key: `qq:${m.kind}:${m.groupId || m.userId}`, pkg: 'qq', title: m.kind === 'group' ? `群 ${m.groupId} · ${m.who}` : `${m.who}（${m.userId}）`, text: m.text, at: m.at, postedAt: Date.parse(m.at), fromOwner: Boolean(m.fromOwner),
    handles: [`qq:${m.userId}`], platform: 'qq', name: m.who, kind: m.kind,
  })) ?? (() => {}), 'dsh-dot: qq messages'));
  // 6. She picks up her phone now and then even when it did not ring: a normal turn (she may act),
  // only inside notifyHours, only when the phone is up, she is not busy, and nothing woke her lately.
  let lastWakeAt = 0;
  const goalActive = (agent) => { try { return ctx.get('goals')?.get(agent)?.phase === 'active'; } catch { return false; } };
  const wakeOriginal = deliver;
  deliverTracked = (items, whileBusy, id) => { lastWakeAt = Date.now(); wakeOriginal(items, whileBusy, id); };
  const phoneCheck = () => {
    const every = cfg.phoneCheckEveryMinutes * 60000;
    // The phone is one device: not while her conversation is running a turn (she may be using it).
    if (!every || !phone()?.isReady || !lastSession || turns.has(lastSession)) return;
    if (errandId && turns.has(errandId)) return;
    if (frozen) return;
    if (cfg.notifyHours && !inHours(cfg.notifyHours)) return;
    if (Date.now() - lastWakeAt < every) return;
    const controller = ctx.get('sessionController');
    if (!controller) return;
    lastWakeAt = Date.now();
    waking = waking.then(async () => {
      const main = await controller.resolveAgent(lastSession);
      // She is on a long task: the goal driver brings her back round after round; don't cut in.
      if (main && !('error' in main) && goalActive(main.agent)) { audit('phone-check-skipped', { why: 'goal active' }); return; }
      const target = (await ensureErrand()) || lastSession;
      const found = target === lastSession ? main : await controller.resolveAgent(target);
      if (!found || 'error' in found) return;
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: phoneCheckText() }], source: PHONE_CHECK_SOURCE }));
      audit('phone-check', { session: target, errand: target !== lastSession });
    }).catch((err) => logger.warn(`phone check failed: ${err.message}`));
  };
  ctx.effect(() => { const timer = setInterval(phoneCheck, 60000); return () => clearInterval(timer); }, 'dsh-dot: phone check');
  phoneCheckNow = phoneCheck;
  ctx.inject(['dshPhone'], (c) => c.effect(() => c.dshPhone.onStatus?.((s) => {
    if (s.state === 'error') void im.send(`⚠️ dot: 手机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-phone.log`, 'plain');
    if (s.state === 'needs-license') void im.send('📱 dot: 手机还没装好——需要先接受 Android SDK 许可。在 dsh 里发 /phone accept（默认 16 GB 存储，要别的大小发 /phone accept 32 这样，建好后不能改）。', 'plain');
  }) ?? (() => {}), 'dsh-dot: phone status'));

  // /dot
  // The command registry can come up after dot, so register through a child that waits for it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'dot',
      description: 'dot status; "test" sends a test message to your IM; "check" makes her pick up her phone now; "memory" / "people" show what she remembers',
      input: { hint: '[test | check | memory [now|diary|handoff|recall [backend|key|model|rerank|mirror|rebuild|test]] | people [approve|drop <id> | forget <name>]]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        // /dot memory … and /dot people … belong to dsh-dot/memory.
        if (/^(memory|people)\b/.test(arg)) {
          const mem = ctx.get('dotMemory');
          return { kind: 'success', text: mem ? await mem.command(arg) : 'dsh-dot/memory is not loaded' };
        }
        const t = await im.target();
        let test = '';
        if (arg === 'test') test = `\ntest message: ${(await im.send('👋 dot 测试消息：IM 通道正常。', 'plain')) ? 'sent' : 'FAILED'}`;
        if (arg === 'check') { lastWakeAt = 0; phoneCheckNow?.(); test = '\nphone check: asked her to pick up her phone (if the phone is up and she is not busy)'; }
        const vm = computer()?.status?.();
        const ph = phone()?.status?.();
        const lines = [
          `computer: ${vm ? `${vm.state}${vm.publicLiveViewUrl ? ` · ${vm.publicLiveViewUrl}` : ''}` : 'not installed (optional)'} · phone: ${ph ? `${ph.state}${ph.error ? ` (${ph.error})` : ''}` : 'not installed (optional)'}`,
          `IM: ${t.error ? `not ready (${t.error})` : `${t.name ?? t.target} via ${t.bot}`}`,
          `scope: ${cfg.scope} · home: ${home} · im sessions seen: ${imSessions.size}`,
          // Where his next message goes: when she "does not answer", look here first.
          `her conversation: ${lastSession ? `${lastSession}${turns.has(lastSession) ? ' (in a turn)' : ''}` : '(none yet: say something to her in a session under home)'} · errand: ${errandId || '(none)'}`,
          `budget: ${ctx.get('budget') ? (blocked.length ? `BLOCKED (${blocked.join(', ')})` : 'ok') : 'not installed (optional)'}`,
          `schedule: ${ctx.get('schedule') ? 'ok' : 'not installed'}`,
        ];
        return { kind: 'success', text: lines.join('\n') + test };
      },
    }), 'dsh-dot: /dot command');
  });

  // Other components (interlude, memory) need to know which session is her conversation and which is the errand.
  ctx.provide?.('dshDot', {
    home,
    session: () => lastSession,
    setSession: (id) => { if (id && id !== lastSession) { lastSession = id; store.set('lastSession', id); } },
    errand: ensureErrand,
    errandId: () => errandId,
    stats,
    isErrand,
    busy: (id) => turns.has(id),
    isIm: (id) => imSessions.has(id),
    /** Hold deliveries to her conversation (a handoff is moving it); the returned function releases them to the new one. */
    freeze() {
      frozen++;
      let done = false;
      return () => {
        if (done) return; done = true;
        frozen = Math.max(0, frozen - 1);
        if (frozen || !frozenQueue.length) return;
        const items = frozenQueue; frozenQueue = [];
        deliverTracked(items, true, lastSession);
      };
    },
  });

  // The panel: `/dsh-dot/` on dsh's own web server (the "dot" sidebar tab is an iframe of it).
  ctx.inject(['webServer', 'connection'], (c) => c.effect(() => mountPanel(ctx, c.webServer, logger, c.connection), 'dsh-dot: panel'));

  logger.info(`dot ready — home ${home}`);
}
