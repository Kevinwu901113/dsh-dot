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
//   2. an approval asked in her sessions is announced to the owner (QQ when connected, else IM) with
//      the live-view link, and taken as rejected when nobody answers within approvalWaitMs;
//   3. dsh-budget blocks are announced on IM, and the `daily` block is lifted at local midnight;
//   4. VM failures are announced on IM; /dot shows the status.
import { PHONE_TOOL_PREFIX, PHONE_ZOOM_TOOL, VM_TOOL_PREFIX } from '../tool-prefixes.js';
import { createManuals, defaultManuals } from './manuals.js';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mountPanel } from './panel.js';
import { diagnose, report as doctorReport } from './doctor.js';
import { sectionOf, setValues } from '../settings.js';
import { configure as configurePrompts, fill, overrideNotes, prompt, rebase, table } from '../prompts.js';
import { ago, describeNow, mondayOf, stamp } from '../clock.js';

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
/**
 * His QQ words as she gets them: one stamp per batch, then exactly what he typed, one message per line;
 * `whileBusy` (steered into the turn she is in the middle of) adds one line saying so.
 */
export const ownerWords = (items, now = Date.now(), { whileBusy = false } = {}) => prompt('dot.owner-words', { stamp: stamp(firstAt(items, now), now), text: items.map((n) => n.text).join('\n'), busy: whileBusy ? prompt('dot.owner-words.busy') : '' });
/**
 * A wake text with the pictures in it: the text cut right after each picture's words (`[表情包 sticker:<id>]`,
 * `[图片]`), one `{ type: 'image', attachment }` there, in message order. The text parts joined are the text
 * exactly, so what memory records (text parts only) does not change. A picture whose words are not in
 * the text, or past `max` / `maxBytes` for the whole message, is left out (its words stay).
 * @param images - `[{ ref: ImageAttachmentRef, text }]` from dsh-dot/qq.
 */
export function withImages(text, images = [], { max = Infinity, maxBytes = Infinity } = {}) {
  const content = [];
  let from = 0, n = 0, bytes = 0;
  for (const im of images ?? []) {
    if (!im?.ref || !im.text || n >= max || bytes + (Number(im.ref.bytes) || 0) > maxBytes) continue;
    const i = text.indexOf(im.text, from);
    if (i < 0) continue;
    const end = i + im.text.length;
    content.push({ type: 'text', text: text.slice(from, end) }, { type: 'image', attachment: im.ref });
    from = end; n++; bytes += Number(im.ref.bytes) || 0;
  }
  if (from < text.length || !content.length) content.push({ type: 'text', text: text.slice(from) });
  return content;
}
/** The model-facing reason a qq_send to him is held back: he said something she has not read yet. */
export const ownerInterruptText = () => prompt('dot.owner-interrupt');
/** Is this qq_send `to` him? "owner", or his number (bare or user:/private:). */
export function isOwnerTarget(to, owner) {
  const s = String(to ?? '').trim();
  if (s === 'owner') return true;
  const m = /^(?:user|private|好友)?[:：]?\s*(\d{5,})$/i.exec(s);
  return Boolean(owner && m && m[1] === String(owner));
}
/** His words already handed to this agent for its next step, not yet read by the model (dsh `agent.inbox.nextStep`). */
export function ownerUnread(agent) {
  try { return (agent?.inbox?.nextStep ?? []).some((m) => String(m?.source?.rpcId ?? '').startsWith('qq-dot-')); } catch { return false; }
}
/** The one line that tells her what time it is, and how long since the last thing said in her conversation. */
export function nowText(now = Date.now(), lastAt = 0) {
  const t = table('dot.now');
  const since = ago(lastAt, now);
  return fill(t.line, { now: describeNow(new Date(now)), monday: mondayOf(now), since: since ? fill(t.since, { ago: since }) : '' });
}

const APP_NAMES = { qq: 'QQ', 'com.tencent.mobileqq': 'QQ', 'com.tencent.mm': '微信', 'com.max.xiaoheihe': '小黑盒', 'tv.danmaku.bili': 'B站', 'com.sina.weibo': '微博', 'com.xingin.xhs': '小红书', 'com.zhihu.android': '知乎', 'com.ss.android.ugc.aweme': '抖音', 'com.taobao.taobao': '淘宝', 'com.eg.android.AlipayGphone': '支付宝', 'org.telegram.messenger': 'Telegram', 'com.android.chrome': 'Chrome' };

const appName = (pkg) => APP_NAMES[pkg] ?? pkg;

/**
 * What an app notification (not a conversation) does, by the first matching rule (`dot.notifyRules`;
 * `pkg` exact, `title` / `text` regexes): 'ignore' (only recorded), 'direct' (about her: wakes after
 * notifyBatchMs), else 'batch' (merged per thread for threadBatchMs).
 */
export const NOTIFY_RULES = [
  { pkg: 'com.max.xiaoheihe', title: '黑盒今日热点订阅|签到提醒|今日未签到', action: 'ignore' },
  { text: '来自《.+》，点击查看', action: 'ignore' }, // promos and news digests: text 来自《…》，点击查看>>
  { title: '@了你|回复了你|关注了你|私信', action: 'direct' },
];
export function notifyAction(n, rules = NOTIFY_RULES) {
  const hit = (re, s) => !re || new RegExp(re).test(String(s ?? ''));
  return rules.find((r) => (!r.pkg || r.pkg === n.pkg) && hit(r.title, n.title) && hit(r.text, n.text))?.action ?? 'batch';
}
/** The post an app notification quotes (小黑盒: 来自“<post title>”), or ''. */
const sourceOf = (n) => /来自[“"「](.+?)[”"」]/.exec(String(n.text ?? ''))?.[1] ?? '';
/** Thread of an app notification: its app, plus the post it quotes when there is one. */
export const threadOf = (n) => (sourceOf(n) ? `${n.pkg}|${sourceOf(n)}` : String(n.pkg));
/** One call as loop detection sees it: tool + arguments, spacing collapsed and digits stripped. */
export const loopKey = (name, args) => `${name} ${(typeof args === 'string' ? args : JSON.stringify(args ?? {})).replace(/\d+/g, '').replace(/\s+/g, ' ').trim()}`;

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
    // The same words twice in a row are one line, unless they carry a picture (two [图片] are two pictures).
    if (text && (g.texts.at(-1) !== text || n.images?.length)) g.texts.push(text);
    groups.set(id, g);
  }
  return [...groups.values()];
}

/** The wake-up text for the notifications that arrived together (or while she was busy): what the phone showed, and that she decides. */
export function notificationText(list, { whileBusy = false, now = Date.now() } = {}) {
  const items = Array.isArray(list) ? list : [list];
  const groups = groupNotifications(items);
  const render = (g) => {
    const who = `${appName(g.pkg)}${g.title ? ` · ${g.title}` : ''}`;
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
  // His messages have their own buffer: delivered once he has been quiet this long (every message
  // restarts it), but never later than ownerMaxWaitMs after the first; while QQ says he is typing
  // (NapCat input_status), up to ownerTypingMaxMs. Mid-turn they are steered into her running turn.
  ownerQuietMs: 1500,
  ownerMaxWaitMs: 6000,
  ownerTypingMaxMs: 15000,
  ownerDenyMax: 2,      // per turn: how often a qq_send to him is held back because he said something she has not read
  phoneCheckEveryMinutes: 30, // if nothing woke her meanwhile: a "pick up your phone" turn; 0 = off
  notifyHours: '', // optional quiet hours ('HH:MM-HH:MM'): outside them app notifications do not wake her; '' (default) = always
  // Her errand session: phone checks, app notifications, interlude observations and plays run here,
  // so screenshots and element dumps never enter the conversation she has with you. Only the
  // conclusion of an errand reaches her conversation, as context for her next turn there.
  errands: true,
  errandMaxTokens: 60000, // the errand session is archived and a fresh one started past this
  // Notifications from these apps are conversations: they wake her conversation, not the errand.
  conversationApps: ['qq', 'com.tencent.mobileqq', 'com.tencent.mm'],
  notifyRules: NOTIFY_RULES, // every other app's notifications: ignore / direct / batch (see notifyAction)
  threadBatchMs: 20000, // 'batch' notifications of one thread arriving within this window wake her errand once
  heldMaxMs: 600000,    // held this long for a busy errand: delivered to a fresh errand instead
  loopRepeat: 5,        // the same call (digits aside) this often in one turn: further ones are refused
  // Interlude tasks (her own plays and looks) wait behind real work: one at a time, only while no
  // notification is queued or held for an errand and no errand turn runs.
  interludeQueueMax: 3,        // queued past this, the oldest is dropped
  interludeTaskTtlMs: 1800000, // not started within this long: given up ('expired')
  // Her phone's and computer's manuals are handed over the first time she reaches for those tools in a
  // session (manuals.js), instead of riding along in every system prompt between the Canon and her words.
  manuals: true,
  promptsPort: 7870,    // /dot prompts: the prompt and persona editor page (scripts/prompts.mjs) on 127.0.0.1
  // Liveness. An approval in her sessions nobody answers within approvalWaitMs is taken as rejected
  // (0 = wait for ever). A turn with no session event for turnStallMs is stalled; an errand stalled
  // for errandStallMs is cancelled (her conversation never is: he is told once).
  approvalWaitMs: 600000,
  turnStallMs: 300000,
  errandStallMs: 600000,
};

/** What she reads when an approval nobody answered expired (in place of dsh's "the user rejected tool"). */
export const approvalTimeoutText = (minutes) => prompt('dot.approval-timeout', { minutes });
/** The note a stalled errand leaves in her conversation: what it was doing when it was given up. */
export const errandStalledText = (doing, minutes) => prompt('dot.errand-stalled', { doing, minutes });
/** The owner's one message per turn for the approvals she is waiting on (the first one's details). */
export function approvalNotice({ tool, reason = '', link = '', minutes = 0, count = 1 }) {
  const r = String(reason ?? '').trim();
  const lines = [`🔐 她在等你批 ${count} 件事，在 DeepSeek Harness 里处理${minutes ? `；${minutes} 分钟没人点就当拒绝` : ''}。`, `${tool || '工具调用'}${r ? `：${r}` : ''}`];
  if (link && !r.includes(link)) lines.push(`实时画面：${link}`);
  return lines.filter(Boolean).join('\n');
}
/** Tool name without its MCP server prefix (mcp__dot-vm__browser_click → browser_click). */
export const shortTool = (name) => String(name ?? '').replace(/^mcp__.+?__/, '');
/**
 * An open turn as the panel and /dot show it: 'approval' (waiting on one, not yet expired),
 * 'timed-out' (stalled after an approval expired), 'stalled' (no session event for turnStallMs), 'running'.
 */
export function turnState(t, { now = Date.now(), turnStallMs = defaults.turnStallMs, approval } = {}) {
  const idleMs = Math.max(0, now - (t.lastEventAt ?? t.startedAt ?? now));
  const stalled = turnStallMs > 0 && idleMs >= turnStallMs;
  if (approval && !approval.timedOutAt) return { state: 'approval', idleMs, waitMs: Math.max(0, now - approval.since), tool: approval.tool };
  if (stalled) return { state: t.approvalTimedOutAt || approval?.timedOutAt ? 'timed-out' : 'stalled', idleMs };
  return { state: 'running', idleMs };
}

/** Errand turns whose conclusion is noted in her conversation (observations hand theirs to the interlude). */
const NOTED = ['phone-check', 'phone-notification', 'play', 'try'];
/** Source of the note an errand leaves in her conversation (injected; it does not wake her). */
export const ERRAND_NOTE_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'errand-note' });
export const SETUP_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'setup' });

const COMPUTER_STAGE = { downloading: '下载镜像中（第一次要几 GB）', installing: '创建中', starting: '开机中' };
/**
 * While her phone or computer is still being installed or booting: what each is doing, for her
 * turn (a dynamic context, gone once both are up, so the cached prefix is untouched). '' = all up.
 */
export function setupText(phoneStatus, computerStatus) {
  const lines = [];
  const p = phoneStatus;
  if (p && p.state !== 'ready') {
    lines.push(`手机：${p.state === 'needs-license' ? '还没装（等他在 dsh 里发 /phone accept）' : p.state === 'downloading' ? (p.progress?.text ?? '下载中') : p.state === 'booting' ? '开机中' : p.state === 'error' ? `出错了（${p.error ?? '未知'}），/phone 看详情` : p.state}`);
  }
  const c = computerStatus;
  if (c && (c.state === 'starting' || c.state === 'error')) {
    lines.push(`电脑：${c.state === 'error' ? `出错了（${c.error ?? '未知'}），/computer 看详情` : COMPUTER_STAGE[c.stage] ?? '开机中'}`);
  }
  return lines.length ? prompt('dot.setup', { devices: lines.join('\n') }) : '';
}
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
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const answers = (url) => new Promise((r) => {
  const q = httpGet(url, { agent: false, timeout: 1000 }, (res) => { res.resume(); r(res.statusCode === 200); });
  q.on('error', () => r(false)).on('timeout', () => q.destroy());
});
/**
 * /dot prompts: scripts/prompts.mjs in a child process (it rewrites process.env.DSH_HOME and the
 * prompt home when imported, which must not happen inside the dsh host). Same <home> as hers.
 */
export function promptsPage({ home, port, timeoutMs = 20000 }) {
  const url = `http://127.0.0.1:${port}/`;
  const log = join(dshHome(), 'dsh-dot-prompts.log');
  let child = null, starting = null;
  async function start() {
    if (child && child.exitCode === null) return url;
    mkdirSync(dshHome(), { recursive: true });
    try { if (statSync(log).size > 1_000_000) rmSync(log, { force: true }); } catch {}
    const fd = openSync(log, 'a');
    let failed = '';
    try {
      // dsh may be Electron: ELECTRON_RUN_AS_NODE makes its executable a plain Node.
      child = spawn(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'prompts.mjs')], {
        cwd: PACKAGE_ROOT, stdio: ['ignore', fd, fd, 'ipc'], windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DOT_HOME: home, PORT: String(port) },
      });
    } finally { closeSync(fd); }
    const c = child;
    c.unref(); c.channel?.unref(); // the channel only lets the page know when dsh is gone (see prompts.mjs)
    c.on('error', (err) => { failed = err.message; });
    c.on('exit', (code, sig) => { failed ||= `exited (${sig ?? code})`; if (child === c) child = null; });
    for (const until = Date.now() + timeoutMs; Date.now() < until && !failed;) {
      if (await answers(url)) return url;
      await new Promise((r) => setTimeout(r, 200));
    }
    stop();
    throw new Error(`${failed || `no answer within ${timeoutMs / 1000} s`} — log: ${log}`);
  }
  function stop() {
    const c = child; child = null;
    if (!c || c.exitCode !== null) return Promise.resolve(false);
    return new Promise((r) => { c.once('exit', () => r(true)); c.kill(); });
  }
  return {
    url,
    start: () => (starting ??= start().finally(() => { starting = null; })),
    stop,
  };
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
  // Every change goes through here; the phone puts her conversation first (dshPhone.setPriority, when it has one).
  const setLast = (id) => { if (id === lastSession) return; lastSession = id; store.set('lastSession', id); phone()?.setPriority?.(id); };
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
    setLast('');
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
  /** This errand takes no new work (the next one gets a fresh session); it stays an errand. */
  const retire = (id) => {
    if (errandId === id) { errandId = ''; store.set('errandSession', ''); }
    pastErrands.add(id); store.set('pastErrands', [...pastErrands].slice(-20));
  };
  async function rotateErrandIfLarge(id) {
    const agent = ctx.get('agents')?.get?.(id);
    const meter = ctx.get('tokenMeter');
    if (!agent || typeof meter?.measure !== 'function') return;
    let tokens = 0;
    try { tokens = Number(meter.measure(agent.session)?.totalTokens ?? 0); } catch (error) { void error; return; }
    if (tokens < cfg.errandMaxTokens) return;
    retire(id);
    if (lastSession === id) setLast('');
    try { await ctx.get('workspaceRegistry')?.archiveSession?.(id); } catch (err) { logger.warn(`errand archive failed: ${err.message}`); }
    audit('errand-rotated', { session: id, tokens });
  }
  /** Leave what an errand found (or `note`) in her conversation, without waking it; true when it got there. */
  async function noteToConversation(origin, text, note = errandNote(origin, text)) {
    const id = lastSession;
    const controller = ctx.get('sessionController');
    if (!id || !controller) return false;
    try {
      const found = await resolveLive(id);
      if (!found || 'error' in found || typeof found.agent.inject !== 'function') return false;
      found.agent.inject(createUserMessage({ content: [{ type: 'text', text: note }], source: ERRAND_NOTE_SOURCE }));
      audit('errand-noted', { session: id, origin });
      return true;
    } catch (err) { logger.warn(`errand note failed: ${err.message}`); return false; }
  }

  // Today's counters for the panel (persisted; reset when the day changes).
  const stats = () => { const st = store.get('stats'); return st && st.day === today() ? st : { day: today(), woke: 0, owner: 0 }; };
  const bump = (k, n = 1) => { const st = stats(); st[k] = (st[k] ?? 0) + n; store.set('stats', st); };

  // 1 + 2. Scheduled turns in dot's sessions: silence or deliver; announce approvals.
  const turns = new Map(); // session id → { turn, scheduled, text, startedAt, lastEventAt, doing, said }
  const approvals = new Map(); // callId (else the log's id) → { session, tool, reason, since, eventId?, notified?, timedOutAt? }
  let manualFor = () => null; // set where the manuals are (below)
  const expiredCalls = new Map(); // callId → minutes waited: its tool result is rewritten (tools/post-execute)
  const ownerDenies = new Map(); // session id → qq_send calls to him held back this turn (read-before-send gate)
  const incoming = new Set(); // sessions whose inbox holds a reminder for the next turn
  const origins = new Map(); // session id → form of the dsh-dot / dsh-interlude message waiting in its inbox (its next turn's origin)
  const flight = new Map(); // errand id → app notifications delivered to it, until its turn ends (what is in flight, per thread)
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    const cwd = session?.header?.cwd;
    if (!id || !event) return;
    if (wantIm && event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(isImMessage)) imSessions.add(id);
    if (wantIm && event.type === 'user/message' && isImMessage(event.data)) imSessions.add(id);
    if (!isDotSession(id, cwd)) return;
    const open = turns.get(id);
    if (open) {
      open.lastEventAt = Date.now();
      if (event.type === 'tool/call') open.doing = shortTool(event.data?.name);
      if (event.type === 'assistant/message' && !event.data?.interrupted) { const said = contentText(event.data?.message?.content).trim(); if (said) open.said = said; }
    }
    // Pending approvals (the log's pair; the answerer below adds the ones it sees first).
    if (event.type === 'approval/asked') {
      const key = event.data?.callId ?? event.data?.id;
      if (key && !approvals.has(key)) approvals.set(key, { session: id, tool: String(event.data?.toolName ?? ''), reason: String(event.data?.reason ?? ''), since: Date.now() });
      if (key) approvals.get(key).eventId = event.data?.id;
    }
    if (event.type === 'approval/decided') for (const [k, a] of approvals) if (a.eventId === event.data?.id) approvals.delete(k);
    if (event.type === 'turn/end' && !isErrand(id)) setLast(id);
    // A reminder enters the inbox before its turn starts, and the prompt is assembled at turn
    // start, before the user/message event: note it here so the turn knows from its first step.
    if (event.type === 'agent/inbox/spliced') {
      if ((event.data?.inserted ?? []).some((m) => m?.source?.kind === 'schedule')) incoming.add(id);
      const from = (event.data?.inserted ?? []).find((m) => ['dsh-dot', 'dsh-interlude'].includes(m?.source?.kind));
      if (from) origins.set(id, from.source.form);
      return;
    }
    if (event.type === 'turn/start') {
      ownerDenies.delete(id);
      turns.set(id, { turn: event.data?.turn, scheduled: incoming.delete(id), origin: origins.get(id), text: '', startedAt: Date.now(), lastEventAt: Date.now() });
      origins.delete(id);
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
      flight.delete(id);
      // After this event settles, so the followup starts a fresh turn; held work first, then an interlude task.
      if (id === lastSession || isErrand(id)) setTimeout(() => { void releaseHeld(id).then(nextTask); }, 50);
    }
    // An errand turn: its conclusion (unless DOT_SILENT) goes to her conversation as a note.
    if (isErrand(id)) {
      if (event.type === 'user/message' && event.data?.source?.kind === 'dsh-dot') { t.origin = event.data.source.form; return; }
      if (event.type === 'user/message' && event.data?.source?.kind === 'dsh-interlude') { t.origin = event.data.source.form; return; }
      if (event.type === 'assistant/message') {
        // What the turn cost, step by step: an interlude task hands it back with its result.
        const u = event.data?.usage;
        if (u) { t.cost ??= { in: 0, cached: 0, out: 0 }; t.cost.in += (Number(u.inputTokens ?? 0) || 0) + (Number(u.cacheWriteTokens ?? 0) || 0); t.cost.cached += Number(u.cacheReadTokens ?? 0) || 0; t.cost.out += Number(u.outputTokens ?? 0) || 0; }
        if (!event.data?.interrupted) { const text = contentText(event.data?.message?.content); if (text.trim()) t.text = text; }
        return;
      }
      if (ended) {
        const text = stripSilent(t.text.trim());
        // Observations hand their text to the interlude themselves; only her own doings are noted.
        if (text && !isSilent(t.text.trim()) && NOTED.includes(t.origin)) void noteToConversation(t.origin === 'phone-notification' ? 'notification' : t.origin, text);
        if (taskRunning?.session === id) finishTask(taskRunning, 'done', text, t.cost);
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

  // 2. Approvals in her sessions: he is told at once (QQ when connected, else IM), and an ask nobody
  // answers within approvalWaitMs is rejected — an unanswered one held an errand for 13 hours
  // (11-04). Prepended, so it wraps the answerers behind it (the UI); their late answer is dropped.
  const liveLink = (toolName) => {
    const vm = (String(toolName ?? '').startsWith(PHONE_TOOL_PREFIX) ? phone()?.status?.() : computer()?.status?.()) ?? {};
    return vm.publicLiveViewUrl || vm.liveViewUrl || '';
  };
  const hers = (agent) => { const s = agent?.session; return Boolean(s?.id) && (isDotSession(s.id, s.header?.cwd) || isErrand(s.id) || turns.has(s.id)); };
  const EXPIRED = Symbol('expired'), WITHDRAWN = Symbol('withdrawn');
  ctx.on('approval/request', async (req, next) => {
    if (!hers(req.agent)) return next();
    const id = req.agent.session.id;
    const key = req.callId ?? Symbol('approval');
    const a = approvals.get(key) ?? { session: id, tool: String(req.toolName ?? ''), reason: String(req.reason ?? ''), since: Date.now() };
    approvals.set(key, a);
    const wait = Number(cfg.approvalWaitMs) || 0;
    const minutes = wait > 0 ? Math.max(1, Math.round(wait / 60000)) : 0;
    a.notified = true;
    // One message per turn (16 in 7 minutes on 11-04): the first ask; later ones only count.
    const t = turns.get(id);
    const count = t ? (t.approvalsAsked = (t.approvalsAsked ?? 0) + 1) : 1;
    if (count === 1) {
      void im.send(approvalNotice({ tool: req.toolName, reason: req.reason, link: liveLink(req.toolName), minutes, count: [...approvals.values()].filter((x) => x.session === id).length }), 'plain');
      audit('approval-notified', { session: id, tool: req.toolName, errand: isErrand(id) });
    } else audit('approval-merged', { session: id, tool: req.toolName, count });
    if (!wait) { try { return await next(); } finally { approvals.delete(key); } }
    let timer, onAbort;
    const expired = new Promise((r) => {
      timer = setTimeout(() => r(EXPIRED), wait); timer.unref?.();
      onAbort = () => r(WITHDRAWN);
      req.signal?.addEventListener?.('abort', onAbort, { once: true });
    });
    try {
      const out = await Promise.race([Promise.resolve().then(() => next()), expired]);
      if (out === WITHDRAWN) return 'cancelled';
      if (out !== EXPIRED) return out;
      a.timedOutAt = Date.now();
      if (t) { t.approvalTimedOutAt = a.timedOutAt; t.doing = `${shortTool(req.toolName)}（审批过期）`; }
      if (req.callId !== undefined) expiredCalls.set(req.callId, minutes);
      audit('approval-timeout', { session: id, tool: req.toolName, waitedMs: wait, errand: isErrand(id) });
      void im.send(`⌛ dot: ${req.toolName} 的审批 ${minutes} 分钟没人点，过期了，当拒绝处理——她放下了这步。`, 'plain');
      return 'rejected';
    } finally {
      clearTimeout(timer); req.signal?.removeEventListener?.('abort', onAbort);
      approvals.delete(key);
    }
  }, { prepend: true });
  // dsh words a rejection as "the user rejected tool …": an expired one says what happened instead.
  // And the first call of her phone or computer tools in a session brings their manual along (manuals.js).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const minutes = expiredCalls.get(exec?.callId);
    const note = cfg.manuals && exec?.name ? manualFor(exec) : null;
    if (minutes === undefined && !note) return next();
    if (minutes !== undefined) expiredCalls.delete(exec.callId);
    const d = await next();
    const contexts = [...(d?.additionalContexts ?? []), ...(note ? [createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: 'dsh-dot', form: 'manual' } })] : [])];
    const out = minutes !== undefined ? { kind: 'block', feedback: [{ type: 'text', text: approvalTimeoutText(minutes) }] } : { ...d };
    if (contexts.length) out.additionalContexts = contexts; else delete out.additionalContexts;
    return out;
  });

  // Working rules are a system-prompt section for sessions in <home> (static per session, so the
  // cached prefix holds). The silence rule is additionally put in front of the model on the turn a
  // schedule wakes, as a dynamic context; only those turns get it.
  const inHome = (c) => { const s = c.agent?.session; return isDotSession(s?.id, s?.header?.cwd) || turns.has(s?.id); };
  const manuals = createManuals({
    routes: cfg.manuals ? defaultManuals({ phonePrefix: PHONE_TOOL_PREFIX, vmPrefix: VM_TOOL_PREFIX, phoneZoom: PHONE_ZOOM_TOOL }) : [],
    hint: (key) => table('dot.manuals.hint', { serial: phone()?.status?.()?.serial ?? phone()?.serial ?? '' })[key] ?? '',
    given: (key, manual) => prompt('dot.manuals.given', { what: table('dot.manuals.what')[key] ?? key, manual }),
  });
  // The manual rides along with the first call's result, for her next step (in the post-execute hook above).
  manualFor = (exec) => {
    const note = manuals.take(exec.name, exec.agent?.session?.id);
    if (note) audit('manual-handed', { session: exec.agent?.session?.id, tool: exec.name });
    return note;
  };
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.on('system-prompt/assemble', async (_a, c, next) => {
      const assembly = await next();
      return cfg.manuals && inHome(c) ? manuals.assemble(assembly, c.agent?.session?.id) : assembly;
    }), 'dsh-dot: manuals on first use');
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
    // First install / boot: her phone and computer take minutes to come up; she talks meanwhile.
    scope.systemPrompt.context({
      name: 'dot:setup',
      order: 898,
      text: (c) => (inHome(c) ? setupText(phone()?.status?.(), computer()?.status?.()) : ''),
    });
    scope.systemPrompt.context({
      name: 'dot:scheduled-turn',
      order: 900,
      text: (c) => (turns.get(c.agent?.session?.id)?.scheduled ? scheduledRule() : ''),
    });
    // One voice: an errand turn reports back (it never talks to him); her conversation knows what is still in flight.
    scope.systemPrompt.context({
      name: 'dot:errand',
      order: 901,
      text: (c) => {
        const id = c.agent?.session?.id;
        if (isErrand(id)) return NOTED.includes(turns.get(id)?.origin) ? prompt('dot.errand-report', { silent: SILENT }) : '';
        return id && id === lastSession ? inFlightText() : '';
      },
    });
  });

  /** One line for her conversation: what her errands are doing right now, per thread (they have not reported yet). */
  const errandsDoing = () => {
    const t = table('dot.errand-inflight');
    return [...turns.keys()].filter(isErrand).map((id) => {
      const threads = Map.groupBy(flight.get(id) ?? [], threadOf);
      if (!threads.size) return t.other;
      return [...threads.values()].map((ns) => fill(t.thread, { app: appName(ns[0].pkg), source: sourceOf(ns[0]) ? `《${sourceOf(ns[0])}》` : '', count: ns.length })).join('、');
    }).join('；');
  };
  const inFlightText = () => { const doing = errandsDoing(); return doing ? fill(table('dot.errand-inflight').line, { doing }) : ''; };
  /** What she is busy with right now (an interlude task records it when it has to wait). */
  const busyWith = () => [errandsDoing(), turns.has(lastSession) ? table('dot.errand-inflight').chat : ''].filter(Boolean).join('；');

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
  let lastWakeAt = 0; // a notification or his words arrived (or a phone check ran): no phone check for a while
  let batch = [], batchTimer = null; // conversations (his, QQ, WeChat): one wake for what arrives within notifyBatchMs
  const threads = new Map(); // thread → { items, due, timer }: app notifications waiting for their thread's wake
  const held = new Map(); // session id → items that arrived while it was running a turn (each with heldAt); delivered as one message when it ends
  let deliverTracked; let phoneCheckNow; // assigned below (phone check), used by flush/releaseHeld
  // Conversations (the owner, QQ, WeChat) wake her conversation; every other app's notification is an errand.
  const isConversation = (n) => n.fromOwner || cfg.conversationApps.includes(n.pkg);
  /**
   * Her agent for a session: the live agent loop from ctx.agents (steer/inject/cancel) when it is
   * running; otherwise the session controller's resolveAgent — the client API layer, whose handle on
   * the desktop host only offers followup — which also loads a session that is not live.
   */
  const resolveLive = async (id) => {
    const live = ctx.get('agents')?.get?.(id);
    if (typeof live?.followup === 'function') return { agent: live };
    return ctx.get('sessionController')?.resolveAgent(id);
  };
  const deliver = (all, whileBusy, target) => {
    const controller = ctx.get('sessionController');
    const id = target ?? lastSession;
    const pkgs = [...new Set(all.map((n) => n.pkg))];
    if (!controller || !id) { audit('notification-dropped', { pkgs, why: id ? 'no sessionController' : 'no session yet' }); return; }
    const fromOwner = all.filter((n) => n.fromOwner);
    const items = all.filter((n) => !n.fromOwner);
    waking = waking.then(async () => {
      // The live agent loop (ctx.agents) has steer/inject/cancel; the session controller's
      // resolveAgent is the client API layer and hands back a thinner handle (followup only on the
      // desktop host) — it is the fallback that also loads a session that is not live.
      const found = await resolveLive(id);
      if (!found || 'error' in found) { audit('notification-dropped', { pkgs, why: found?.error?.message ?? 'session not found' }); return; }
      // The owner's words, exactly as typed (several messages → several lines), as human input.
      if (fromOwner.length) toOwnerAgent(found.agent, id, fromOwner);
      if (!items.length) return;
      // The people in these messages, as she remembers them (dsh-dot/memory).
      const cards = ctx.get('dotMemory')?.cardsFor?.(items) ?? '';
      found.agent.followup(createUserMessage({ content: contentFor(wakeText(items, { whileBusy, cards }), items), source: PHONE_NOTIFICATION_SOURCE }));
      bump('woke', 1);
      audit('notification-woke', { session: id, count: items.length, pkgs: [...new Set(items.map((n) => n.pkg))], whileBusy, sinceSeenMs: Date.now() - Date.parse(items[0].at), sincePostedMs: items[0].postedAt ? Date.now() - items[0].postedAt : undefined });
    }).catch((err) => { logger.warn(`wake for notification failed: ${err.message}`); audit('notification-dropped', { pkgs, why: err.message }); });
  };
  /**
   * His words into her session. Idle: a followup starts a turn, as always. In the middle of a turn:
   * steered into it, so she reads them at her next step instead of after the turn (an agent without
   * `steer` gets the followup).
   */
  let agentShapeLogged = false;
  const toOwnerAgent = (agent, id, items) => {
    const busy = turns.has(id);
    // The host's agent handle may not expose `steer`: `send(message, 'next-step', true)` is the same
    // boundary in dsh-agent's inbox API; failing both, the followup (after the turn, as before).
    const via = busy && typeof agent.steer === 'function' ? 'steer' : busy && typeof agent.send === 'function' ? 'send' : 'followup';
    if (!agentShapeLogged) {
      agentShapeLogged = true;
      const methods = [...new Set([...Object.keys(agent), ...Object.getOwnPropertyNames(Object.getPrototypeOf(agent) ?? {})])].filter((k) => typeof agent[k] === 'function');
      logger.info(`her agent handle offers: ${methods.join(', ')} (busy now: ${busy}, open turns: ${[...turns.keys()].map((k) => k.slice(0, 16)).join(' ') || 'none'})`);
      audit('agent-handle', { methods, busy, openTurns: turns.size });
    }
    const message = createUserMessage({ content: contentFor(ownerWords(items, Date.now(), { whileBusy: via !== 'followup' }), items), source: ownerSource() });
    try {
      if (via === 'steer') agent.steer(message); else if (via === 'send') agent.send(message, 'next-step', true); else agent.followup(message);
    } catch (err) { logger.warn(`${via} failed (${err.message}); followup instead`); agent.followup(message); }
    audit('owner-message', { session: id, count: items.length, whileBusy: busy, via }); bump('owner', items.length);
  };
  // The pictures in what wakes her (dsh-dot/qq saved them in the attachment store): image blocks in the
  // message, capped per message by qq's imageSeeMax and the store's imageLimits. Without a store: text only.
  let warnedImages = false;
  const contentFor = (text, items) => {
    const images = items.flatMap((n) => n.images ?? []);
    if (!images.length) return [{ type: 'text', text }];
    const store = ctx.get('attachments');
    if (!store) {
      if (!warnedImages) { warnedImages = true; logger.warn('pictures arrived but no attachment store (ctx.attachments) is mounted: she reads them as text'); }
      return [{ type: 'text', text }];
    }
    const limits = store.imageLimits ?? {};
    const content = withImages(text, images, { max: Math.min(ctx.get('dshQq')?.imageSeeMax ?? 4, limits.maxImagesPerMessage || Infinity), maxBytes: limits.maxMessageImageBytes || Infinity });
    const seen = content.filter((p) => p.type === 'image').length;
    if (seen) audit('images-in-message', { count: seen, of: images.length });
    return content;
  };
  let frozen = 0; let frozenQueue = []; // while her conversation is being handed over (dsh-dot/memory)
  const send = (id, items) => {
    if (!items.length) return;
    if (frozen && id === lastSession) { frozenQueue.push(...items); audit('notification-held', { count: items.length, why: 'handoff' }); return; }
    // That session is in the middle of a turn: hold these; the turn's end delivers everything at once, in order.
    // (His own words never come this way: they have their own buffer and are steered in, see flushOwner.)
    if (id && turns.has(id)) { held.set(id, [...(held.get(id) ?? []), ...items.map((n) => ({ heldAt: Date.now(), ...n }))]); audit('notification-held', { count: items.length, why: 'turn running', errand: isErrand(id) }); return; }
    deliverTracked(items, false, id);
  };
  const flush = () => { const items = batch; batch = []; batchTimer = null; send(lastSession, items); };
  // One batch per thread at a time: to the errand already handling that thread while its turn runs
  // (held there), else to the errand (her conversation when there is none).
  const handler = (k) => [...flight].find(([id, ns]) => turns.has(id) && ns.some((n) => threadOf(n) === k))?.[0];
  const flushThread = async (k) => {
    const { items } = threads.get(k); threads.delete(k);
    send(handler(k) ?? ((await ensureErrand()) || lastSession), items);
  };
  const queueThread = (n, ms) => {
    const k = threadOf(n), th = threads.get(k) ?? { items: [] }, due = Date.now() + ms;
    th.items.push(n); threads.set(k, th);
    if (th.due <= due) return;
    clearTimeout(th.timer); th.due = due;
    th.timer = setTimeout(() => { void flushThread(k).catch((err) => logger.warn(`thread wake failed: ${err.message}`)); }, ms); th.timer.unref?.();
  };
  // Held too long for a busy errand (an approval nobody answers, a long turn): a fresh errand takes them,
  // except what belongs to a thread that errand is handling (never two errands on one thread).
  const rerouteHeld = async (now = Date.now()) => {
    for (const [id, items] of [...held]) {
      if (!isErrand(id) || !turns.has(id) || !(cfg.heldMaxMs > 0)) continue;
      const mine = new Set((flight.get(id) ?? []).map(threadOf));
      const late = items.filter((n) => now - n.heldAt >= cfg.heldMaxMs && !mine.has(threadOf(n)));
      if (!late.length) continue;
      held.set(id, items.filter((n) => !late.includes(n)));
      retire(id);
      const e = (await ensureErrand()) || lastSession;
      audit('notification-rerouted', { from: id, to: e, count: late.length, heldMs: now - late[0].heldAt });
      deliverTracked(late, true, e);
    }
  };
  // Items held for an errand that was rotated meanwhile go to the current errand, not the archived one.
  const releaseHeld = async (id) => { const items = held.get(id); if (!items?.length) return; held.delete(id); deliverTracked(items, true, pastErrands.has(id) ? (await ensureErrand()) || lastSession : id); };
  // Interlude tasks (dshDot.task): the lowest priority, one at a time, in an errand that has nothing else to do.
  const taskQueue = []; let taskRunning = null;
  const errandsBusy = () => Boolean(taskRunning) || threads.size > 0 || [...turns.keys()].some(isErrand)
    || [...held].some(([id, ns]) => isErrand(id) && ns.length) || Boolean(flight.get(errandId)?.length); // delivered, turn not started yet
  const finishTask = (t, status, report = '', cost = null) => {
    if (t === taskRunning) taskRunning = null; else taskQueue.splice(taskQueue.indexOf(t), 1);
    audit(`task-${status}`, { kind: t.kind, key: t.key, session: t.session, waitedMs: (t.startedAt ?? Date.now()) - t.queuedAt });
    try { t.onDone?.({ status, queuedAt: t.queuedAt, startedAt: t.startedAt ?? null, doneAt: Date.now(), busyWith: t.busyWith, report, cost }); } catch (err) { logger.warn(`task onDone failed: ${err.message}`); }
  };
  const nextTask = async () => {
    const now = Date.now();
    for (const t of taskQueue.filter((x) => x.expiresAt <= now)) finishTask(t, 'expired');
    if (!taskQueue.length || errandsBusy()) return;
    const t = taskRunning = taskQueue.shift();
    t.startedAt = now;
    try {
      const id = await ensureErrand();
      const found = id && await resolveLive(id);
      if (!found || 'error' in found) throw new Error(found?.error?.message ?? 'no errand session');
      t.session = id;
      t.onStart?.(id);
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: t.text }], source: t.source }));
      audit('task-started', { kind: t.kind, key: t.key, session: id, readOnly: Boolean(t.readOnly) });
    } catch (err) { logger.warn(`task not started: ${err.message}`); finishTask(t, 'dropped'); }
  };
  const enqueueTask = ({ ttlMs = cfg.interludeTaskTtlMs, ...spec }) => {
    const now = Date.now();
    const same = spec.key && taskQueue.find((x) => x.key === spec.key);
    if (same) { same.expiresAt = now + ttlMs; audit('task-refreshed', { kind: same.kind, key: same.key }); return 'refreshed'; }
    taskQueue.push({ ...spec, queuedAt: now, expiresAt: now + ttlMs, busyWith: busyWith() });
    while (taskQueue.length > Math.max(1, cfg.interludeQueueMax)) finishTask(taskQueue[0], 'dropped');
    void nextTask();
    return 'queued';
  };
  // His messages wait for him to stop typing (see defaults.ownerQuietMs): their own buffer and timer,
  // separate from everyone else's notifications.
  let ownerBatch = [], ownerFirstAt = 0, ownerTimer = null, ownerTyping = false, ownerTypingSeen = false;
  const ownerDue = (now = Date.now()) => {
    const cap = ownerFirstAt + (ownerTypingSeen ? cfg.ownerTypingMaxMs : cfg.ownerMaxWaitMs);
    return ownerTyping ? cap : Math.min(now + cfg.ownerQuietMs, cap);
  };
  const armOwner = () => {
    clearTimeout(ownerTimer);
    const now = Date.now();
    ownerTimer = setTimeout(() => flushOwner(), Math.max(0, ownerDue(now) - now)); ownerTimer.unref?.();
  };
  /** Deliver his buffered words now. With `agent` (the qq_send gate's caller, her conversation): steered into it synchronously. */
  const flushOwner = (agent) => {
    clearTimeout(ownerTimer); ownerTimer = null;
    const items = ownerBatch; ownerBatch = []; ownerTyping = ownerTypingSeen = false;
    if (!items.length) return 0;
    const id = lastSession;
    if (frozen) { frozenQueue.push(...items); audit('notification-held', { count: items.length, why: 'handoff' }); return items.length; }
    if (agent && id && agent.session?.id === id) { lastWakeAt = Date.now(); toOwnerAgent(agent, id, items); return items.length; }
    deliverTracked(items, false, id);
    return items.length;
  };
  /** QQ says he is typing / stopped typing: while a batch of his waits, typing holds it up to ownerTypingMaxMs. */
  const ownerTypingNow = (s) => {
    if (!s?.fromOwner || !ownerBatch.length) return;
    ownerTyping = Boolean(s.typing);
    if (ownerTyping) ownerTypingSeen = true;
    armOwner();
  };
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
    if (n.fromOwner) {
      if (!ownerBatch.length) ownerFirstAt = Date.now();
      ownerBatch.push(n); ownerTyping = false; lastWakeAt = Date.now(); // he pressed send
      armOwner();
      return;
    }
    const action = isConversation(n) ? 'conversation' : notifyAction(n, cfg.notifyRules);
    if (action === 'ignore') { audit('notification-ignored', { pkg: n.pkg, title: n.title }); return; }
    if (cfg.notifyHours && !inHours(cfg.notifyHours)) { audit('notification-held', { pkg: n.pkg, why: 'outside notifyHours' }); return; }
    lastWakeAt = Date.now();
    if (action !== 'conversation') { queueThread(n, action === 'direct' ? cfg.notifyBatchMs : cfg.threadBatchMs); return; }
    batch.push(n);
    if (!batchTimer) { batchTimer = setTimeout(flush, cfg.notifyBatchMs); batchTimer.unref?.(); }
  };
  ctx.inject(['dshPhone'], (c) => c.effect(() => { c.dshPhone.setPriority?.(lastSession); return c.dshPhone.onNotification?.(wake) ?? (() => {}); }, 'dsh-dot: phone notifications'));
  // QQ messages (NapCat in the computer) take the same road as phone notifications: batch, hold while busy, group.
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onMessage?.((m) => wake({
    key: `qq:${m.kind}:${m.groupId || m.userId}`, pkg: 'qq', title: m.kind === 'group' ? `群 ${m.groupId} · ${m.who}` : `${m.who}（${m.userId}）`, text: m.text, at: m.at, postedAt: Date.parse(m.at), fromOwner: Boolean(m.fromOwner),
    ...(m.images?.length ? { images: m.images } : {}),
    handles: [`qq:${m.userId}`], platform: 'qq', name: m.who, kind: m.kind,
  })) ?? (() => {}), 'dsh-dot: qq messages'));
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onTyping?.(ownerTypingNow) ?? (() => {}), 'dsh-dot: qq typing'));
  // Read before you speak: a qq_send to him while he has said something she has not read yet (still in
  // the buffer, or steered but not reached by the model) is held back once or twice per turn; the
  // buffer goes in right away, so her next step has it.
  // Also: a loop (the same call over and over in one turn) is stopped, and an errand never talks to him.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const id = exec.agent?.session?.id;
    const args = exec.input ?? exec.args ?? exec.arguments ?? {};
    const t = turns.get(id);
    if (t && cfg.loopRepeat > 0) {
      const key = loopKey(exec.name, args), times = (t.calls ??= new Map()).get(key) ?? 0;
      if (times >= cfg.loopRepeat) { audit('loop-stopped', { session: id, tool: exec.name, times }); return { kind: 'deny', reason: prompt('dot.loop-stopped', { times }) }; }
      t.calls.set(key, times + 1);
    }
    if (exec.name !== 'qq_send' || !isOwnerTarget(args?.to, ctx.get('dshQq')?.owner)) return next();
    if (isErrand(id)) { audit('errand-owner-refused', { session: id }); return { kind: 'deny', reason: prompt('dot.errand-no-owner') }; }
    const buffered = Boolean(id) && id === lastSession && ownerBatch.length > 0;
    if (!buffered && !ownerUnread(exec.agent)) return next();
    const n = ownerDenies.get(id) ?? 0;
    if (n >= cfg.ownerDenyMax) { audit('owner-gate-passed', { session: id, denies: n }); return next(); }
    ownerDenies.set(id, n + 1);
    const flushed = buffered ? flushOwner(exec.agent) : 0;
    audit('owner-gate-denied', { session: id, flushed, deny: n + 1 });
    return { kind: 'deny', reason: ownerInterruptText() };
  });
  // 6. She picks up her phone now and then even when it did not ring: a normal turn (she may act),
  // only inside notifyHours, only when the phone is up, she is not busy, and nothing woke her lately.
  const goalActive = (agent) => { try { return ctx.get('goals')?.get(agent)?.phase === 'active'; } catch { return false; } };
  const wakeOriginal = deliver;
  deliverTracked = (items, whileBusy, id) => {
    lastWakeAt = Date.now();
    if (isErrand(id)) flight.set(id, [...(flight.get(id) ?? []), ...items]);
    wakeOriginal(items, whileBusy, id);
  };
  const phoneCheck = () => {
    const every = cfg.phoneCheckEveryMinutes * 60000;
    // The phone is one device: not while her conversation is running a turn (she may be using it).
    if (!every || !phone()?.isReady || !lastSession || turns.has(lastSession)) return;
    if ([...turns.keys()].some(isErrand)) return; // never beside another errand turn
    if (frozen) return;
    if (cfg.notifyHours && !inHours(cfg.notifyHours)) return;
    if (Date.now() - lastWakeAt < every) return;
    const controller = ctx.get('sessionController');
    if (!controller) return;
    lastWakeAt = Date.now();
    waking = waking.then(async () => {
      const main = await resolveLive(lastSession);
      // She is on a long task: the goal driver brings her back round after round; don't cut in.
      if (main && !('error' in main) && goalActive(main.agent)) { audit('phone-check-skipped', { why: 'goal active' }); return; }
      const target = (await ensureErrand()) || lastSession;
      const found = target === lastSession ? main : await resolveLive(target);
      if (!found || 'error' in found) return;
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: phoneCheckText() }], source: PHONE_CHECK_SOURCE }));
      audit('phone-check', { session: target, errand: target !== lastSession });
    }).catch((err) => logger.warn(`phone check failed: ${err.message}`));
  };
  // Turn watchdog: a turn of hers with no session event for turnStallMs is stalled (audited once).
  // A stalled errand is given up after errandStallMs — cancelled keeping its inbox, what was held for it
  // released, a note in her conversation, and the next errand gets a fresh session. Her conversation
  // is never cancelled: he is told once per turn (unless he was already told about its approval).
  const pendingApproval = (id) => { let first; for (const a of approvals.values()) if (a.session === id && (!first || a.since < first.since)) first = a; return first; };
  const doingOf = (t, a) => (a ? `等 ${shortTool(a.tool)} 的审批` : t.doing || (t.said ? t.said.replace(/\s+/g, ' ').slice(0, 60) : '') || '（不清楚）');
  const noteOrigin = (o) => (o === 'phone-notification' ? 'notification' : o || 'other');
  const abandonErrand = (id, t, idle) => {
    const doing = doingOf(t, pendingApproval(id));
    let cancelled = false;
    try {
      const agent = ctx.get('agents')?.get?.(id);
      if (typeof agent?.cancel === 'function') { agent.cancel({ kind: 'hook', reason: 'dot-watchdog' }, { keepInbox: true }); cancelled = true; }
    } catch (err) { logger.warn(`errand cancel failed: ${err.message}`); }
    turns.delete(id);
    retire(id);
    audit('errand-cancelled', { session: id, idleMs: idle, cancelled, doing });
    const r = setTimeout(() => { void releaseHeld(id); }, 50); r.unref?.();
    void noteToConversation(noteOrigin(t.origin), errandStalledText(doing, Math.round(idle / 60000)));
    if (taskRunning?.session === id) finishTask(taskRunning, 'stalled', errandStalledText(doing, Math.round(idle / 60000)), t.cost);
  };
  const turnInfo = (id, now = Date.now()) => {
    const t = turns.get(id);
    if (!t) return null;
    const a = pendingApproval(id);
    return { session: id, errand: isErrand(id), conversation: id === lastSession, startedAt: t.startedAt, lastEventAt: t.lastEventAt, doing: doingOf(t, a), ...turnState(t, { now, turnStallMs: cfg.turnStallMs, approval: a }) };
  };
  const watchTurns = (now = Date.now()) => {
    if (!(cfg.turnStallMs > 0)) return;
    for (const [id, t] of [...turns]) {
      const idle = now - (t.lastEventAt ?? t.startedAt);
      if (idle < cfg.turnStallMs) continue;
      const a = pendingApproval(id);
      if (!t.stallAudited) { t.stallAudited = true; audit('turn-stalled', { session: id, errand: isErrand(id), idleMs: idle, doing: doingOf(t, a), ...(a ? { approval: a.tool } : {}) }); }
      if (isErrand(id)) {
        // An approval still inside its own wait is left to expire first.
        const approvalDone = !a || (cfg.approvalWaitMs > 0 && now - a.since >= cfg.approvalWaitMs);
        if (cfg.errandStallMs > 0 && idle >= cfg.errandStallMs && approvalDone) abandonErrand(id, t, idle);
        continue;
      }
      if (id !== lastSession || t.ownerTold || a?.notified) continue;
      t.ownerTold = true;
      void im.send(`⏳ dot: 她这一轮 ${Math.round(idle / 60000)} 分钟没动静了（最后在做：${doingOf(t, a)}）。没替她取消；要停就在 DeepSeek Harness 里点停止。`, 'plain');
    }
  };
  ctx.effect(() => { const timer = setInterval(() => { watchTurns(); void rerouteHeld(); phoneCheck(); void nextTask(); }, 60000); return () => clearInterval(timer); }, 'dsh-dot: turn watchdog + phone check');
  phoneCheckNow = phoneCheck;
  // Doctor: what the host gives her phone and computer. Runs on /dot doctor, once a start when
  // something still has to be installed, and when a device fails; problems go to the log and his IM.
  let lastDoctor = null;
  const runDoctor = async () => {
    const items = await diagnose({ phone: phone()?.doctorInfo?.() ?? null, computer: computer()?.doctorInfo?.() ?? null, home: dshHome() });
    lastDoctor = { at: Date.now(), bad: items.filter((i) => i.level === 'bad').length, warn: items.filter((i) => i.level === 'warn').length };
    audit('doctor', { bad: lastDoctor.bad, warn: lastDoctor.warn, problems: items.filter((i) => i.level !== 'ok').map((i) => i.name) });
    return items;
  };
  const doctorTell = async (why) => {
    try {
      const items = await runDoctor();
      if (!items.some((i) => i.level === 'bad')) return;
      const text = doctorReport(items, { onlyProblems: true });
      logger.warn(`${why}\n${text}`);
      void im.send(`🩺 ${why}\n${text}\n（完整结果：在 dsh 里发 /dot doctor）`, 'plain');
    } catch (err) { logger.warn(`doctor failed: ${err.message}`); }
  };
  ctx.effect(() => {
    const t = setTimeout(() => {
      const p = phone()?.doctorInfo?.(), c = computer()?.doctorInfo?.();
      if ((p && !p.installed) || (c && !c.installed)) void doctorTell('手机/电脑还没装好，先替你查了一遍这台机器');
    }, 15_000);
    return () => clearTimeout(t);
  }, 'dsh-dot: first-run doctor');
  // When a device she was waiting for (installing or booting in this run) comes up, she tells him herself.
  const announced = new Set();
  const announceReady = (device, label) => {
    if (announced.has(device)) return;
    announced.add(device);
    audit('setup-ready', { device });
    const id = lastSession;
    if (!id) { void im.send(`✅ dot: ${label}装好了`, 'plain'); return; }
    waking = waking.then(async () => {
      const found = await resolveLive(id);
      if (!found || 'error' in found) { void im.send(`✅ dot: ${label}装好了`, 'plain'); return; }
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt('dot.setup-done', { device: label }) }], source: SETUP_SOURCE }));
    }).catch((err) => logger.warn(`setup announce failed: ${err.message}`));
  };
  const watchSetup = (device, label, waiting) => { let wasWaiting = false; return (s) => { if (waiting(s)) wasWaiting = true; else if (wasWaiting && s.state === 'ready') announceReady(device, label); }; };
  const phoneSetup = watchSetup('phone', '手机', (s) => s.state === 'needs-license' || s.state === 'downloading');
  const computerSetup = watchSetup('computer', '电脑', (s) => s.state === 'starting' && (s.stage === 'downloading' || s.stage === 'installing'));
  ctx.inject(['dshComputer'], (c) => c.effect(() => { const off = c.dshComputer.onStatus?.(computerSetup); const now = c.dshComputer.status?.(); if (now) computerSetup(now); return off ?? (() => {}); }, 'dsh-dot: computer setup watch'));
  ctx.inject(['dshPhone'], (c) => c.effect(() => c.dshPhone.onStatus?.((s) => {
    phoneSetup(s);
    if (s.state === 'error') { void im.send(`⚠️ dot: 手机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-phone.log`, 'plain'); void doctorTell('手机出错了，体检发现的问题'); }
    if (s.state === 'needs-license') void im.send('📱 dot: 手机还没装好——需要先接受 Android SDK 许可。在 dsh 里发 /phone accept（默认 16 GB 存储，要别的大小发 /phone accept 32 这样，建好后不能改）。装之前可以先发 /dot doctor 查一下这台电脑。', 'plain');
  }) ?? (() => {}), 'dsh-dot: phone status'));

  const prompts = promptsPage({ home, port: Number(cfg.promptsPort) || 7870 });
  ctx.effect(() => () => { void prompts.stop(); }, 'dsh-dot: prompts page');

  // /dot: what is waiting and what is stuck, one line each.
  const mins = (ms) => `${Math.floor(ms / 60000)} min`;
  const statusLiveness = (now = Date.now()) => {
    const who = (id) => `${isErrand(id) ? 'errand' : id === lastSession ? 'her conversation' : 'session'} ${id.slice(0, 16)}`;
    const out = [...approvals.values()].map((a) => `approval waiting: ${shortTool(a.tool)} in ${who(a.session)} · ${mins(now - a.since)}${cfg.approvalWaitMs > 0 ? ` of ${mins(cfg.approvalWaitMs)}` : ''}${a.timedOutAt ? ' · timed out' : ''}`);
    for (const id of turns.keys()) {
      const t = turnInfo(id, now);
      if (t && (t.state === 'stalled' || t.state === 'timed-out')) out.push(`stalled turn: ${who(id)} · no event for ${mins(t.idleMs)} · ${t.state === 'timed-out' ? 'after an approval timed out · ' : ''}last: ${t.doing}${t.errand ? ` · given up at ${mins(cfg.errandStallMs)}` : ' · not cancelled'}`);
    }
    return out.length ? out : [`liveness: no approval waiting, no stalled turn (approval wait ${cfg.approvalWaitMs > 0 ? mins(cfg.approvalWaitMs) : 'unlimited'}, stalled after ${mins(cfg.turnStallMs)}, errand given up after ${mins(cfg.errandStallMs)})`];
  };

  // /dot
  // The command registry can come up after dot, so register through a child that waits for it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'dot',
      description: 'dot status; "doctor" checks this machine for her phone and computer (virtualization, disk, memory, ports, downloads); "test" sends a test message to your IM; "check" makes her pick up her phone now; "memory" / "people" show what she remembers; "prompts" opens the prompt and persona editor page',
      input: { hint: '[doctor | test | check | prompts [stop | rebase <id> [--reset]] | memory [now|diary|handoff|recall [backend|key|model|rerank|mirror|rebuild|test]] | people [approve|drop <id> | forget <name>]]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        // /dot memory … and /dot people … belong to dsh-dot/memory.
        if (/^(memory|people)\b/.test(arg)) {
          const mem = ctx.get('dotMemory');
          return { kind: 'success', text: mem ? await mem.command(arg) : 'dsh-dot/memory is not loaded' };
        }
        if (arg === 'doctor') { try { return { kind: 'success', text: doctorReport(await runDoctor()) }; } catch (err) { return { kind: 'success', text: `doctor failed: ${err.message}` }; } }
        if (arg === 'prompts stop') return { kind: 'success', text: (await prompts.stop()) ? 'prompts page stopped' : 'prompts page was not running' };
        const rb = /^prompts rebase (\S+)( --reset)?$/.exec(arg);
        if (rb) { try { return { kind: 'success', text: rebase(rb[1], Boolean(rb[2])) }; } catch (err) { return { kind: 'success', text: err.message }; } }
        if (arg === 'prompts') {
          try { return { kind: 'success', text: [`提示词和人设页面：${await prompts.start()}\n（只在本机打开；/dot prompts stop 关掉）`, ...overrideNotes().map((n) => `提示词覆盖 ${n}（/dot prompts rebase <id>）`)].join('\n') }; } catch (err) { return { kind: 'success', text: `prompts page failed: ${err.message}` }; }
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
          ...(lastDoctor && (lastDoctor.bad || lastDoctor.warn) ? [`doctor: ${lastDoctor.bad} problem(s), ${lastDoctor.warn} warning(s) — /dot doctor`] : []),
          `scope: ${cfg.scope} · home: ${home} · im sessions seen: ${imSessions.size}`,
          // Where his next message goes: when she "does not answer", look here first.
          `her conversation: ${lastSession ? `${lastSession}${turns.has(lastSession) ? ' (in a turn)' : ''}` : '(none yet: say something to her in a session under home)'} · errand: ${errandId || '(none)'}`,
          `his messages: wait ${cfg.ownerQuietMs} ms of quiet, at most ${cfg.ownerMaxWaitMs} ms (${cfg.ownerTypingMaxMs} ms while typing) · mid-turn: steered · qq_send to him held ≤${cfg.ownerDenyMax}×/turn while unread${ownerBatch.length ? ` · ${ownerBatch.length} waiting` : ''}`,
          ...statusLiveness(),
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
    setSession: (id) => { if (id) setLast(id); },
    errand: ensureErrand,
    errandId: () => errandId,
    /**
     * Post an interlude task ({ kind: 'play'|'look'|'try', key, text, source, readOnly, ttlMs, onStart(sessionId), onDone(result) }):
     * run in an errand when nothing else is (see defaults.interludeQueueMax); `onDone` gets
     * { status: 'done'|'stalled'|'expired'|'dropped', queuedAt, startedAt, doneAt, busyWith, report, cost: { in, cached, out } | null }. → 'queued' | 'refreshed'
     */
    task: enqueueTask,
    /** How long a queued task waits before it expires. */
    taskTtlMs: cfg.interludeTaskTtlMs,
    /** Something she wanted to tell him while living her day: a note in her conversation; she decides. True when handed over. */
    say: (text) => noteToConversation('say', text, prompt('dot.interlude-say', { text: String(text).trim() })),
    stats,
    isErrand,
    busy: (id) => turns.has(id),
    /** One open turn as the watchdog sees it (turnState + who and what), or null. */
    turn: (id) => turnInfo(id),
    /** Every open turn of hers. */
    turns: () => [...turns.keys()].map((id) => turnInfo(id)).filter(Boolean),
    /** Approvals waiting in her sessions. */
    approvals: () => [...approvals.values()].map((a) => ({ session: a.session, tool: a.tool, reason: a.reason, since: a.since, errand: isErrand(a.session), ...(a.timedOutAt ? { timedOutAt: a.timedOutAt } : {}) })),
    /** His messages waiting in the buffer; flushOwner() delivers them now. */
    ownerPending: () => ownerBatch.length,
    flushOwner: () => flushOwner(),
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
