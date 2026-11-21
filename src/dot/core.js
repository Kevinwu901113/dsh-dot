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
import { DEFAULT_AWAKE, inHours, msUntilHours, sleepsAtAll, validHours } from '../hours.js';
import { deny } from '../refusals.js';
import { HANDS_ASK_TOOL, SAY_TOOL, PHONE_TOOL_PREFIX, PHONE_TYPE_TOOL, PHONE_ZOOM_TOOL, VM_TOOL_PREFIX, isHerTool, HER_PRESET } from '../tool-prefixes.js';
import { checkReply } from '../persona/card.js';
import { VM_SCREENSHOT, qqSpoken } from '../qq/qq.js';
import { typedText } from '../phone/phone.js';
import { BRIDGE_ID_RE } from '../compat/qq-bridge.js';
import { batchLaunch, createHowto, howtoTool } from './howto.js';
import { HANDS_SOURCE, createHands } from './hands.js';
import { createSay } from './say.js';
import { KNOWN_APPS, collectReply } from '../interlude/core.js';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mountPanel } from './panel.js';
import { doctorFor, report as doctorReport } from '../doctor.js';
import { sectionOf, setValues } from '../settings.js';
import { background, effortFor, installLlmGate, statusLine as llmGateLine, workEffort } from '../llm-gate.js';
import { configure as configurePrompts, fill, overrideNotes, prompt, rebase, table } from '../prompts.js';
import { runPendingReset } from '../reset.js';
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
/** The periodic turn: she picks up her phone the way people do between things. */
/** When a wake happened: the first item's arrival (held items keep theirs), else now. */
const firstAt = (items, now) => { const t = Date.parse(items?.[0]?.at ?? ''); return Number.isFinite(t) ? Math.min(t, now) : now; };
/**
 * His QQ words as she gets them: one stamp per batch, then exactly what he typed, one message per line;
 * `whileBusy` (steered into the turn she is in the middle of) adds one line saying so.
 */
export const ownerWords = (items, now = Date.now(), { whileBusy = false, unsent = [] } = {}) => prompt('dot.owner-words', {
  stamp: stamp(firstAt(items, now), now), text: items.map((n) => n.text).join('\n'), busy: whileBusy ? prompt('dot.owner-words.busy') : '',
  // What she wrote that never reached him (held back or cut off because he spoke first): shown to her once, with his words.
  unsent: unsent.length ? prompt('dot.owner-words.unsent', { lines: unsent.join('\n') }) : '',
});
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
/**
 * How a thing in her hands ended, as the code saw it — not as they tell it: they stopped by themselves (whether it
 * worked is in their words), they were cut (too long, she stopped them, he did), or it could not run; and what was
 * refused them on the way (words that were not hers, a line of hers sent back).
 */
export function handsStatus(r = {}, device = '') {
  const why = String(r.why ?? '');
  const base = r.status === 'done' ? prompt(device === 'web' ? 'dot.hands.status.done.web' : 'dot.hands.status.done')
    : r.status === 'cut' ? prompt(/太久|too long/.test(why) ? 'dot.hands.status.timeout' : /no answer/.test(why) ? 'dot.hands.status.unanswered' : /^他/.test(why) ? 'dot.hands.status.stopped.his' : 'dot.hands.status.stopped')
      : prompt('dot.hands.status.failed', { why: why || '没有原因' });
  const notes = [...new Set(r.notes ?? [])].map((n) => (n === 'own-words' ? prompt('dot.hands.status.own-words') : n === 'reply-check' ? prompt('dot.hands.status.reply-check') : '')).filter(Boolean);
  return [base.trim(), ...notes.map((n) => n.trim())].join('；');
}
/** A web address or a domain typed into a bar: where to go, not something said. */
const ADDRESS = /^(https?:\/\/\S+|[\w-]+(\.[\w-]+)+(\/\S*)?)$/i;
/** The lines of a text her hands are about to type that nobody gave them: not an address, and not known to `has`. */
export const ownWords = (text, has) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !ADDRESS.test(l) && !has(l));
/** What she is asked, once, when a thing of his has her words on it but nothing of her hands after them. */
export const replyCheckText = ({ hits = [] } = {}) => prompt('dot.reply-check', { why: hits.length ? prompt('dot.reply-check.phrases', { phrases: hits.slice(0, 3).map((h) => `「${h}」`).join('') }) : prompt('dot.reply-check.stage') });
/**
 * What a call is about to say, by whatever way out: her qq_send or a send action of the QQ backend's own tools
 * ({ via: 'qq', to, text }), or text typed on her phone — a message, a comment, a post ({ via: 'phone', text }).
 * null for a call that says nothing. The rules about her words hang on this, not on a tool's name.
 */
export function spokenOf(name, args) {
  const q = qqSpoken(name, args);
  if (q) return { via: 'qq', ...q };
  if (name !== PHONE_TYPE_TOOL && !String(name ?? '').startsWith(PHONE_TOOL_PREFIX)) return null;
  const text = typedText(name === PHONE_TYPE_TOOL ? name : String(name).slice(PHONE_TOOL_PREFIX.length), args);
  return text ? { via: 'phone', to: '', text } : null;
}
/**
 * Whom what she writes in answer to a message goes to, said by the message itself: 'qq' for his words over QQ (a
 * person's message, kind 'user', on the QQ channel) and for one of ours that says so (`to: 'him'` — the one asking,
 * a line handed back to her); 'desk' for his words typed anywhere else (his screen shows her answer); '' for
 * everything else (a notification, her own time, her hands coming back — also on his business, which the message
 * marks `for: 'him'`: she speaks with qq_send, so being woken is never by itself a message to him).
 */
/** Source of the short message that goes with what has just reached her (her clock, what recall found, how she talks). */
export const TURN_NOTE_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'turn-note' });
export const addressed = (src) => (src?.kind === 'user' ? (/^qq-/.test(String(src.rpcId ?? '')) ? 'qq' : 'desk') : src?.kind === 'dsh-dot' && src.to === 'him' ? 'qq' : '');
/** Is this qq_send `to` him? "owner", or his number (bare or user:/private:). */
export function isOwnerTarget(to, owner) {
  const s = String(to ?? '').trim();
  if (s === 'owner') return true;
  const m = /^(?:user|private|好友)?[:：]?\s*(\d{5,})$/i.exec(s);
  return Boolean(owner && m && m[1] === String(owner));
}
/** His words already handed to this agent for its next step, not yet read by the model (dsh `agent.inbox.nextStep`). */
export function ownerUnread(agent) {
  try { return (agent?.inbox?.nextStep ?? []).some((m) => m?.source?.kind === 'user' && String(m.source.rpcId ?? '').startsWith('qq-dot-')); } catch { return false; }
}
/**
 * What happened when she wrote to him unasked, as facts: `reaches` is [{ at, answeredAt? }] of today, oldest first.
 * → "今天你主动找过他 3 次，他回了 1 次；上一次是 14:20，他还没回。", or '' when she has not today. How often to write
 * to him is hers to learn from this — there is no cap.
 */
export function reachText(reaches = [], now = Date.now()) {
  const day = new Date(now).toDateString();
  const today = reaches.filter((r) => new Date(r.at).toDateString() === day);
  if (!today.length) return '';
  const last = today.at(-1), hhmm = (t) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return prompt('dot.reach', { n: today.length, answered: today.filter((r) => r.answeredAt).length, last: hhmm(last.at), waiting: last.answeredAt ? '' : prompt('dot.reach.waiting').trim() }).trim();
}
/** The one line that tells her what time it is, and how long since the last thing said in her conversation. */
export function nowText(now = Date.now(), lastAt = 0) {
  const t = table('dot.now');
  const since = ago(lastAt, now);
  return fill(t.line, { now: describeNow(new Date(now)), monday: mondayOf(now), since: since ? fill(t.since, { ago: since }) : '' });
}

const APP_NAMES = { qq: 'QQ', 'com.tencent.mobileqq': 'QQ', 'com.tencent.mm': '微信', 'com.max.xiaoheihe': '小黑盒', 'tv.danmaku.bili': 'B站', 'com.sina.weibo': '微博', 'com.xingin.xhs': '小红书', 'com.zhihu.android': '知乎', 'com.ss.android.ugc.aweme': '抖音', 'com.taobao.taobao': '淘宝', 'com.eg.android.AlipayGphone': '支付宝', 'org.telegram.messenger': 'Telegram', 'com.android.chrome': 'Chrome' };

const appName = (pkg) => APP_NAMES[pkg] ?? pkg;

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
export function workingRules() {
  // The keys an older override of dot.rules may still name are filled with nothing: what her phone and computer are
  // to her is said where they are introduced (phone:device, dot.computer.hers).
  return prompt('dot.rules', { computer: '', phone: '', computerRule: '', phoneRule: '', silent: SILENT });
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
  // Read before you speak, one count for every way her words go to him (her answer, a qq_send, a turn started over):
  // in a row, how often words of hers that have not reached him give way to what he just said. Past this they go out
  // first — he cannot keep her silent by talking. Anything of hers reaching him starts the count again.
  ownerPreemptMax: 2,
  phoneHomeAfterMs: 180000, // her phone goes back to its home screen this long after her last step on it (an app left open shows no notifications); 0 = never
  awakeHours: DEFAULT_AWAKE, // her usual day ('HH:MM-HH:MM', may wrap midnight): when she gets up, and from when on she falls asleep once things are quiet (see "Her sleep" below)
  sleepAfterQuietMinutes: 30, // past her usual hours, this long with nothing going on and she is asleep; anything before that (a notification, his words, a turn) reaches her as usual and the count starts over
  // Notifications from these apps are conversations (told to her as someone speaking, not as an app's news).
  loopRepeat: 5,        // the same call (digits aside) this often in one turn: further ones are refused
  // What she says to him is checked in code before it goes out (src/persona/card.js): stage directions in brackets
  // are taken out, and a phrase of <home>/persona.checks.txt sends a qq_send back to her once a turn. false: nothing is checked.
  replyCheck: true,
  // Her conversation keeps only her own tools (tool-prefixes.js HER_TOOLS): the rest of what the host offers is not
  // shown to her. It takes effect in a conversation begun after this was first on (a new segment, a new window) —
  // an older one keeps the tools its history was written with. false: every conversation sees everything, as before.
  lean: true,
  // Her devices are operated by her hands (hands.js), a whole thing at a time, from her conversation: she says what
  // she wants done, the hands do it to the end — or come back with a question that is hers to answer. A stretch of
  // theirs (the thing, or the part after an answer of hers) is cut after handsMaxMs.
  handsMaxMs: 600000,
  handsAskMs: 1800000,   // a question of theirs she has not answered for this long: the thing is let go (her hands are free again)
  // The reasoning effort her hands' requests are sent with ('' or false = whatever dsh's model selector says). They carry a
  // whole thing through by themselves now, on the same model as her; an effort the model does not offer is not sent.
  handsEffort: 'low',
  // The same for her own conversation. With none, in a conversation that had no example of it yet, she said "我去翻翻"
  // and gave her hands nothing in 19 of 25 replays (11-21); at low, 0 of 20 — and it no longer follows whatever the
  // model selector was last set to in some other conversation.
  herEffort: 'low',
  // What she says is written by a call of its own that is only her card (say.js): its reasoning effort ('' or false =
  // the model selector's), how long it may be, and how many of the last lines between her and him it is shown.
  // With thinking it wrote longer (11-21 replays), and length is what he minds most.
  sayEffort: 'off',
  sayMaxTokens: 600,
  sayLines: 12,
  // She wrote to him unasked and he has not answered for this long: noted once in her conversation, as a fact. 0 = never.
  reachUnansweredMs: 2 * 3600000,
  interludeQueueMax: 3,        // queued past this, the oldest is dropped
  interludeTaskTtlMs: 1800000, // not started within this long: given up ('expired')
  // What she learns using her phone (howto.js): each turn's steps per app are logged; a turn of
  // howtoMinSteps steps or more, or with errors, is reflected on once (a small call) and her notes for
  // that app rewritten (≤ howtoMaxChars); the first time she opens the app in a session they come along.
  howto: true,
  howtoMinSteps: 12,
  howtoMaxChars: 800,
  promptsPort: 7870,    // /dot prompts: the prompt and persona editor page (scripts/prompts.mjs) on 127.0.0.1
  // Liveness. An approval in her sessions nobody answers within approvalWaitMs is taken as rejected
  // (0 = wait for ever). A turn with no session event for turnStallMs is stalled (he is told once).
  approvalWaitMs: 600000,
  turnStallMs: 300000,
};

/** What she reads when an approval nobody answered expired (in place of dsh's "the user rejected tool"). */
export const approvalTimeoutText = (minutes) => prompt('dot.approval-timeout', { minutes });
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

/** Calls that look or scroll: the same call again is how one reads a changing screen, not a loop. */
export const LOOP_EXEMPT = /(?:mobile_list_elements_on_screen|mobile_take_screenshot|mobile_get_screen_size|mobile_get_orientation|mobile_list_apps|mobile_list_available_devices|mobile_swipe_on_screen|mobile_press_button|browser_snapshot|browser_take_screenshot|browser_scroll|screenshot)$/;
/** Source of a note left in her conversation (injected; it does not wake her). The form and the prompt ids keep the name they had when errands left them: installed overrides go by it. */
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
    lines.push(`手机：${p.state === 'off' ? '关着（他关的；要用就请他在 dot 页面打开，别自己想办法开）' : p.state === 'needs-license' ? '还没装（等他在 dsh 里发 /phone accept）' : p.state === 'downloading' ? (p.progress?.text ?? '下载中') : p.state === 'booting' ? '开机中' : p.state === 'error' ? `出错了（${p.error ?? '未知'}），/phone 看详情` : p.state}`);
  }
  const c = computerStatus;
  if (c && (c.state === 'starting' || c.state === 'error' || c.state === 'off')) {
    lines.push(`电脑：${c.state === 'off' ? '关着（他关的；要用就请他在 dot 页面打开，别自己想办法开）' : c.state === 'error' ? `出错了（${c.error ?? '未知'}），/phone doctor 或 dot 页面看详情` : COMPUTER_STAGE[c.stage] ?? '开机中'}`);
  }
  return lines.length ? prompt('dot.setup', { devices: lines.join('\n') }) : '';
}

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
/** dsh-im tags messages it relays with an rpcId of `<channel>-<uuid>`; the desktop UI does not. */
export const IM_RPC = /^(weixin|wechat|qq|feishu|lark|dingtalk|wecom|wework|telegram|discord|slack|whatsapp|email|office)-/i;
// "qq-dot-…" is our own tag (ownerSource): his QQ words relayed by dot, not a dsh-im bot session —
// counting those made her conversation an "IM bot session", which the memory handoff leaves alone
// (11-03: 456k tokens, no handoff since 10-29).
export const isImMessage = (m) => { const r = String(m?.source?.rpcId ?? ''); return IM_RPC.test(r) && !r.startsWith('qq-dot-'); };
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
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
    // format 'plain' is how the plugin's own notices are sent: not her words.
    if (t.qq) { try { return (await t.qq.send('owner', text, [], { hers: format !== 'plain' })).sent > 0; } catch (err) { logger.warn(`qq send failed: ${err.message}`); return false; } }
    try {
      // "<sep/>" (several sends in one moment) becomes separate messages.
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
  const logger = ctx.logger('dsh-dot');
  runPendingReset({ logger }); // a reset scheduled on the dot page: before any state is read (src/reset.js)
  const cfg = { ...defaults, ...setValues(config), ...sectionOf('dot', (m) => logger.warn(m)) };
  if (!validHours(cfg.awakeHours)) { logger.warn(`awakeHours "${cfg.awakeHours}" is not HH:MM-HH:MM; using ${DEFAULT_AWAKE}`); cfg.awakeHours = DEFAULT_AWAKE; }
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
  // qq-bridge's sessions (`qqb-…`, see src/compat/qq-bridge.js) are never hers, whatever the scope says.
  const isDotSession = (id, cwd) => !BRIDGE_ID_RE.test(String(id ?? '')) && (cfg.scope === 'all' || (wantHome && cwd && inside(home, cwd)) || (wantIm && imSessions.has(id)));

  // Sessions that were hers and are not any more: conversations a reset or a handover retired (src/reset.js,
  // setSession), and — read from older state files, nothing adds to it — the second session she had before there was
  // one of her. A turn ending in one of them does not make it hers again.
  const pastConversations = new Set([...(store.get('pastConversations') ?? []), ...(store.get('pastErrands') ?? []), store.get('errandSession')].filter(Boolean));
  const retired = (id) => Boolean(id) && pastConversations.has(id);
  // Her model requests share his provider key: her hands' steps on her own business are background and wait behind
  // his (src/llm-gate.js). A round they do for him is his business — he is waiting on it — and goes like her replies.
  const llmGate = installLlmGate(ctx, { name: 'dsh-dot', backgroundSessions: (id) => Boolean(hands?.isHands(id)) && !hands.doing()?.forHim });
  // Startup self-check: the remembered pointer must be a live conversation of hers. An old state file
  // can point at a retired session or at one archived since (11-03: his QQ messages went into an
  // archived session and nobody answered). What dsh cannot tell us (no registry yet, no title) is skipped.
  const staleWhy = (id) => {
    if (!id) return '';
    if (retired(id)) return 'retired';
    try { const ids = ctx.get('workspaceRegistry')?.archivedSessionIds; if ((Array.isArray(ids) || ids instanceof Set) && [...ids].includes(id)) return 'archived'; } catch (error) { void error; }
    return '';
  };
  const selfCheck = () => {
    const why = staleWhy(lastSession);
    if (!why) return;
    audit('last-session-cleared', { session: lastSession, why });
    logger.warn(`her remembered conversation ${lastSession} is ${why}: cleared (the next message to her picks a new one)`);
    setLast('');
  };
  selfCheck();
  // The registry can come up after dot: look again once it is there.
  ctx.inject?.(['workspaceRegistry'], (c) => c.effect(() => { selfCheck(); return () => {}; }, 'dsh-dot: startup self-check'));
  /** Leave a note in her conversation, without waking it; true when it got there. */
  async function noteToConversation(origin, note) {
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
  let howtoFor = () => null;  // set where her phone notes are (below)
  const expiredCalls = new Map(); // callId → minutes waited: its tool result is rewritten (tools/post-execute)
  // Her conversations that are lean (told by api.lean, which the compat layer and the prompt trim both ask). A lean
  // conversation is one made with her own agent preset (HER_PRESET): the host's tools come with a session's preset
  // and nothing a plugin can do afterwards takes them out of its requests — not tools.restrict() (it does not reach
  // what the agent's own layer registers), not llm/stream (next() takes no argument), not system-prompt/assemble
  // (0.2.2 re-attaches the tool list after the waterfall). The preset decides; the rest follows it.
  const leanIds = new Set();
  let hands = null; // her hands (hands.js), set once sessions can be made
  // The one check of what she says, whichever way it goes out (her answer, qq_send, a line her hands type). A line
  // that is handed back is followed by one that goes out as written — so a phrase list that is wrong costs one call,
  // and nothing she says can be held for good. `strict` also hands back a line that only had stage directions in it
  // (a tool's text cannot be tidied on its way out; her answer's can).
  let wordsJustBack = false;
  const handBack = (text, { strict = false } = {}) => {
    if (!cfg.replyCheck || !String(text ?? '').trim()) return null;
    const c = checkReply(text, replyChecks());
    const back = Boolean(c.hits.length || (strict && c.stripped)) && !wordsJustBack;
    wordsJustBack = back;
    return back ? c : null;
  };
  /** What her hands are on right now, as a line for her conversation ('' when they are free). */
  const handsLine = () => { const d = hands?.doing?.(); return !d ? '' : d.state === 'asking' ? prompt('dot.hands.asking', { task: d.task, question: d.question }).trim() : prompt('dot.hands.doing', { task: d.task, since: ago(d.startedAt, Date.now()) ? `（${ago(d.startedAt, Date.now())}了）` : '' }).trim(); };
  // The times she wrote to him unasked, of the last two days: [{ at, answeredAt?, noted? }] (see reachText).
  let reaches = (store.get('reaches') ?? []).filter((r) => r && Date.now() - r.at < 2 * 86400000);
  const saveReaches = () => { reaches = reaches.slice(-40); store.set('reaches', reaches); };
  const answerReaches = () => { let n = 0; for (const r of reaches) if (!r.answeredAt) { r.answeredAt = Date.now(); n++; } if (n) saveReaches(); };
  // One she wrote and he has left unanswered for reachUnansweredMs: said once, as a note in her conversation — her
  // record then holds what came of it, and what she makes of that is hers.
  const noteUnanswered = (now = Date.now()) => {
    for (const r of reaches) {
      if (r.answeredAt || r.noted || !(cfg.reachUnansweredMs > 0) || now - r.at < cfg.reachUnansweredMs) continue;
      r.noted = true; saveReaches();
      const time = new Date(r.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      audit('reach-unanswered', { at: r.at });
      void noteToConversation('other', prompt('dot.reach.unanswered', { time, hours: Math.round((now - r.at) / 3600000) }).trim());
    }
  };
  const incoming = new Set(); // sessions whose inbox holds a reminder for the next turn
  const origins = new Map(); // session id → form of the dsh-dot / dsh-interlude message waiting in its inbox (its next turn's origin)
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
      if (event.type === 'tool/call') { open.doing = shortTool(event.data?.name); open.tools = (open.tools ?? 0) + 1; }
      if (event.type === 'assistant/message' && !event.data?.interrupted) { const said = contentText(event.data?.message?.content).trim(); if (said) open.said = said; }
    }
    // Pending approvals (the log's pair; the answerer below adds the ones it sees first).
    if (event.type === 'approval/asked') {
      const key = event.data?.callId ?? event.data?.id;
      if (key && !approvals.has(key)) approvals.set(key, { session: id, tool: String(event.data?.toolName ?? ''), reason: String(event.data?.reason ?? ''), since: Date.now() });
      if (key) approvals.get(key).eventId = event.data?.id;
    }
    if (event.type === 'approval/decided') for (const [k, a] of approvals) if (a.eventId === event.data?.id) approvals.delete(k);
    if (event.type === 'turn/end' && !retired(id)) setLast(id);
    if ((event.type === 'turn/start' || event.type === 'turn/end') && id === lastSession) wakeUp('turn'); // a turn of her conversation: she is up (or stays up)
    // A reminder enters the inbox before its turn starts, and the prompt is assembled at turn
    // start, before the user/message event: note it here so the turn knows from its first step.
    if (event.type === 'agent/inbox/spliced') {
      if ((event.data?.inserted ?? []).some((m) => m?.source?.kind === 'schedule')) incoming.add(id);
      const from = (event.data?.inserted ?? []).find((m) => ['dsh-dot', 'dsh-interlude'].includes(m?.source?.kind));
      if (from) origins.set(id, from.source.form);
      return;
    }
    if (event.type === 'turn/start') {
      turns.set(id, { turn: event.data?.turn, scheduled: incoming.delete(id), origin: origins.get(id), text: '', startedAt: Date.now(), lastEventAt: Date.now() });
      origins.delete(id);
      return;
    }
    const t = turns.get(id);
    if (!t) return;
    if (event.type === 'user/message' && event.data?.source?.kind === 'schedule') { t.scheduled = true; return; }
    // His words came over his QQ: the turn's answer goes back there (unless she already sent one herself).
    if (event.type === 'user/message' && addressed(event.data?.source) === 'qq') {
      t.fromQq = true;
      if (event.data?.source?.kind === 'user' && !t.origin && !t.scheduled && !t.tools) { // a turn his own words opened
        t.his = true;
        const said = contentText(event.data?.content).replace(/^\[[^\]]*\]\s*/, '').trim();
        if (said) t.said = [t.said, said].filter(Boolean).join(' ').slice(0, 120);
      }
      return;
    }
    const ended = event.type === 'turn/end' && (event.data?.turn === undefined || event.data.turn === t.turn);
    // What woke this turn besides him (a notification, her own time) and what the turn cost: a task of hers that ran
    // in it (dshDot.task) gets its result and its cost back when the turn ends.
    if (event.type === 'user/message' && ['dsh-dot', 'dsh-interlude'].includes(event.data?.source?.kind) && event.data.source.form !== 'turn-note') t.origin ??= event.data.source.form;
    // Her hands came back on something of his: the turn is on his business (a thing she starts from it is his too),
    // and what she tells him in it she says with qq_send.
    if (event.type === 'user/message' && event.data?.source?.kind === 'dsh-dot' && event.data.source.for === 'him') t.forHim = true;
    if (event.type === 'assistant/message') {
      const u = event.data?.usage;
      if (u) { t.cost ??= { in: 0, cached: 0, out: 0 }; t.cost.in += (Number(u.inputTokens ?? 0) || 0) + (Number(u.cacheWriteTokens ?? 0) || 0); t.cost.cached += Number(u.cacheReadTokens ?? 0) || 0; t.cost.out += Number(u.outputTokens ?? 0) || 0; }
      if (!event.data?.interrupted) { const said = contentText(event.data?.message?.content); if (said.trim()) t.last = said; }
      // The words a turn closes with: its last message, when that one calls no tool (what she writes beside a tool call is thinking aloud at work).
      if (!event.data?.interrupted) { const c = event.data?.message?.content; t.closing = Array.isArray(c) && c.some((b) => b?.type === 'tool-call') ? '' : contentText(c).trim(); }
    }
    if (ended) {
      turns.delete(id); // every turn, scheduled or not: `turns` is also "is she busy right now"
      // A thing of her own (her own time) lasts as long as her hands are still on it: the turn that started it, then
      // every turn her hands come back to, until one ends with her hands free. Its cost is all of those turns'.
      if (taskRunning?.session === id && (t.origin === taskRunning.source?.form || (t.origin === 'hands-result' && !t.forHim))) {
        const c = taskRunning.cost ??= { in: 0, cached: 0, out: 0 };
        if (t.cost) { c.in += t.cost.in; c.cached += t.cost.cached; c.out += t.cost.out; }
        if (!hands?.busy()) finishTask(taskRunning, 'done', stripSilent(String(t.last ?? '').trim()), c);
      }
      // After this event settles, so the followup starts a fresh turn; held work first, then a task of her own.
      if (id === lastSession) setTimeout(() => { void releaseHeld(id).then(nextTask); }, 50);
    }
    // He spoke to her somewhere else than QQ (the desktop, an IM bot): her answer is on his screen there — said.
    if (event.type === 'user/message' && addressed(event.data?.source) === 'desk') {
      t.elsewhere = true;
      // Where he speaks to her is where her conversation is from here on (setLast at this turn's end), so it counts already.
      if (!t.scheduled && !retired(id)) { t.hisHere = true; }
    }
    // Nothing she writes leaves as she wrote it. A turn he is in that ends: the words it closes with are what she means
    // to tell him, and `say` writes the words (say.js) — unless she already said something in it herself, or wrote
    // nothing: then nothing goes out. (Left to a tool she had to remember, the first thing he said to her on 11-21 was
    // answered in her conversation and reached no one.) At her window it is on his screen as she wrote it.
    if (ended && !t.scheduled && (t.fromQq || t.hisHere || t.forHim)) {
      if (t.cancelled) { audit('owner-turn-restarted', { session: id, aborted: event.data?.reason?.kind === 'aborted' }); return; }
      const meant = !t.spoke && !(t.elsewhere && !t.fromQq) && event.data?.reason?.kind !== 'aborted' ? (t.closing ?? '') : '';
      const over = () => {
        if (!t.spoke) { preempts = 0; audit('silent', { session: id }); }
      };
      if (!meant) { over(); return; }
      void tellHim(t, { meant }).then(async (r) => {
        over();
        // What really went out is hers to know: her next turn reads it after what she wrote.
        if (r.status !== 'said') return;
        try { (await resolveLive(id))?.agent?.inject?.(createUserMessage({ content: [{ type: 'text', text: saidText(r) }], source: { kind: 'dsh-dot', form: 'said' } })); } catch (err) { logger.debug?.(`said not noted: ${err.message}`); }
      });
    }
  });

  // 2. Approvals in her sessions: he is told at once (QQ when connected, else IM), and an ask nobody
  // answers within approvalWaitMs is rejected — an unanswered one held an errand for 13 hours
  // (11-04). Prepended, so it wraps the answerers behind it (the UI); their late answer is dropped.
  const liveLink = (toolName) => {
    const vm = (String(toolName ?? '').startsWith(PHONE_TOOL_PREFIX) ? phone()?.status?.() : computer()?.status?.()) ?? {};
    return vm.publicLiveViewUrl || vm.liveViewUrl || '';
  };
  const hers = (agent) => { const s = agent?.session; return Boolean(s?.id) && (isDotSession(s.id, s.header?.cwd) || retired(s.id) || turns.has(s.id) || Boolean(hands?.isHands(s.id, s.header?.cwd))); };
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
      audit('approval-notified', { session: id, tool: req.toolName, retired: retired(id) });
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
      audit('approval-timeout', { session: id, tool: req.toolName, waitedMs: wait, retired: retired(id) });
      void im.send(`⌛ dot: ${req.toolName} 的审批 ${minutes} 分钟没人点，过期了，当拒绝处理——她放下了这步。`, 'plain');
      return 'rejected';
    } finally {
      clearTimeout(timer); req.signal?.removeEventListener?.('abort', onAbort);
      approvals.delete(key);
    }
  }, { prepend: true });
  // dsh words a rejection as "the user rejected tool …": an expired one says what happened instead.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    // Typed into her phone's QQ (a chat there, not its search or sign-in): said, as much as a qq_send is. The QQ on her
    // computer does not report what her account sends from elsewhere, so it is recorded here, where the words go in.
    if (exec?.name === PHONE_TYPE_TOOL && !result?.isError) {
      try {
        const fg = String((await phone()?.foreground?.()) ?? '');
        const text = String((exec.input ?? exec.args ?? exec.arguments)?.text ?? '').trim();
        if (text && /^com\.tencent\.mobileqq\//i.test(fg) && !/search|login|register|verify/i.test(fg)) { ctx.get('dotMemory')?.herSaid?.({ session: lastSession, text, to: '手机QQ' }); audit('said-on-phone', { chars: text.length }); }
      } catch (err) { logger.debug?.(`phone words not recorded: ${err.message}`); }
    }
    const minutes = expiredCalls.get(exec?.callId);
    const notes = [cfg.howto && exec?.name ? await howtoFor(exec, result) : null].filter(Boolean);
    const note = notes.join('\n\n');
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
  // Her phone notes (howto.js): every phone call of her sessions is a step of this turn's run; the first
  // time she is in an app in a session, her notes for it come along (in the post-execute hook above).
  const appLabels = { ...Object.fromEntries(Object.entries(KNOWN_APPS.labels).map(([label, pkg]) => [pkg, label])), 'com.tencent.mobileqq': 'QQ', 'com.tencent.mm': '微信' };
  const LAUNCHERS = /launcher|\.home$|^com\.android\.systemui$/i;
  const labelOf = (pkg) => (!pkg || LAUNCHERS.test(pkg) ? 'phone' : appLabels[pkg] ?? pkg);
  const howto = createHowto({ dir: join(home, 'her', 'howto'), minSteps: cfg.howtoMinSteps, maxChars: cfg.howtoMaxChars });
  const herSession = (s) => Boolean(s?.id && (isDotSession(s.id, s.header?.cwd) || turns.has(s.id) || (hands?.isHands(s.id, s.header?.cwd))));
  howtoFor = async (exec, result) => {
    if (!exec.name.startsWith(PHONE_TOOL_PREFIX)) return null;
    const s = exec.agent?.session;
    if (!herSession(s)) return null;
    const input = exec.arguments ?? exec.input;
    // The app this call happened in: the one in front after it (a launch, inside a batch too, says so directly).
    let pkg = input?.packageName ?? batchLaunch(input);
    try { pkg = String((await phone()?.foreground?.()) ?? '').split('/')[0] || pkg; } catch (error) { void error; }
    const app = labelOf(pkg);
    howto.step(s.id, app, exec.name, input, { isError: Boolean(result?.isError), error: contentText(result?.content ?? []) });
    if (howto.needsReview(app)) void reflectHowto({ review: true, app });
    const got = howto.take(s.id, app);
    if (!got) return null;
    audit('howto-given', { session: s.id, app });
    return prompt('dot.howto.given', { app: got.app, notes: got.notes || prompt('dot.howto.no-notes'), recent: got.recent || '—' });
  };
  const said = new Map(); // her session id → her last words this turn (for the reflection)
  ctx.on('session/event', (session, event) => {
    if (!cfg.howto || !herSession(session)) return;
    const id = session.id;
    if (event?.type === 'turn/start') { howto.turnStarted(id); return; }
    if (event?.type === 'assistant/message' && !event.data?.interrupted) { const t = contentText(event.data?.message?.content); if (t.trim()) said.set(id, t); return; }
    if (event?.type !== 'turn/end') return;
    const learn = howto.end(id, said.get(id) ?? '');
    said.delete(id);
    for (const r of learn) reflectHowto(r);
  });
  // One small call per run worth learning from: what she did (her calls and short error types, not the
  // screen's text), her notes for the app, her last runs → the notes rewritten. One app at a time:
  // a second run of the same app waits for the first reflection and reads the notes it wrote.
  const reflecting = new Map(); // app → the promise of its last reflection
  function reflectHowto(r) {
    const prev = reflecting.get(r.app) ?? Promise.resolve();
    const p = prev.then(() => reflectOnce(r)).finally(() => { if (reflecting.get(r.app) === p) reflecting.delete(r.app); });
    reflecting.set(r.app, p);
    return p;
  }
  async function reflectOnce(r) {
    try {
      if (r.review && !howto.needsReview(r.app)) return; // read over meanwhile
      // Not injected into dsh-dot (it would wait on them): taken when needed.
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
      const llm = ctx.get('llm');
      if (!sel || !llm?.stream) return;
      const effort = await workEffort(ctx, sel);
      const reply = await collectReply(llm.stream(background({
        provider: sel.provider, model: sel.model, ...(effort ? { reasoningEffort: effort } : {}),
        system: prompt(r.review ? 'dot.howto.review' : 'dot.howto.reflect', { maxChars: cfg.howtoMaxChars }), tools: [howtoTool()], maxTokens: 4000,
        messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(howto.input(r), null, 1) }], source: { kind: 'dsh-dot', form: 'howto' } })],
      })));
      const out = JSON.parse(reply.args || reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1));
      if (r.review) { if (howto.keep(r.app, { notes: out.notes })) audit('howto-reviewed', { app: r.app }); return; }
      if (howto.keep(r.app, out, r.id)) audit('howto-learned', { app: r.app, steps: r.steps, errors: r.errors.length, worked: Boolean(out.worked), ...(out.task ? { task: String(out.task).slice(0, 12) } : {}) });
    } catch (error) { logger.warn(`howto reflection (${r.app}) failed: ${error.message}`); audit('howto-failed', { app: r.app, error: String(error.message).slice(0, 200) }); }
  }
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.on('system-prompt/assemble', async (_a, c, next) => {
      const assembly = await next();
      // Her conversation when her hands hold the device tools: the tools' own instructions (the MCP servers')
      // are for whoever presses the screen. The phone says what it is to her itself (phone:device); the computer gets one line.
      let held = true;
      try { held = !ctx.get('dshDotCompat')?.hiddenFor?.('dot', [`${VM_TOOL_PREFIX}browser_click`])?.length; } catch { /* no compat */ }
      if (held || !inHome(c) || hands?.isHands(c.agent?.session?.id, c.agent?.session?.header?.cwd)) return assembly;
      const sections = assembly.sections.flatMap((sec) => (sec.name === 'mcp:dot-phone' ? [] : sec.name === 'mcp:dot-vm' ? (String(sec.text ?? '').trim() ? [{ ...sec, text: prompt('dot.computer.hers').trim() }] : []) : [sec]));
      return { ...assembly, sections };
    }), 'dsh-dot: device instructions go to the hands');
    scope.effect(() => scope.systemPrompt.section({
      name: 'dot:rules',
      order: (scope.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 0) + 2,
      text: (c) => (inHome(c) ? workingRules() : ''),
    }), 'dsh-dot: working rules section');
    // First install / boot: her phone and computer take minutes to come up; she talks meanwhile.
    scope.systemPrompt.context({
      name: 'dot:setup',
      order: 898,
      text: (c) => (inHome(c) ? setupText(phone()?.status?.(), computer()?.status?.()) : ''),
    });
  });

  // What goes with whatever has just reached her, said once per arrival: the time, what recall found for these words,
  // how she talks. dsh keeps one "runtime context" snapshot and appends the WHOLE of it again whenever any part of
  // it changes (agent-loop RuntimeContextProjection: older copies stay in the history, so the cached prefix holds).
  // Her clock changed every turn and "N 秒了" every step, so her notes — which had not changed — were appended with
  // them each time: in one conversation of hers 103 copies, 85% of all its text (11-20). The snapshot now holds only
  // what stays the same between consolidations (dot:memory, dot:setup); what belongs to this arrival is a short
  // message of ours after it, the way dsh's own time-context does it (agent/pre-step). Replay, 49 real turns + one
  // line of his: with nothing at the end she went off to operate her phone on "在干嘛" (1/6 answered); with this
  // short tail 5/6, as with the full snapshot (6/6) — the reminder of how she talks is what did the work, and it
  // has to be the last thing she reads.
  const turnNotes = [];
  const turnNote = (note) => { turnNotes.push(note); return () => { const i = turnNotes.indexOf(note); if (i >= 0) turnNotes.splice(i, 1); }; };
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next();
    const s = agent?.session, id = s?.id;
    if (!decision || decision.kind === 'reject' || signal?.aborted || !id || !messages?.length) return decision;
    if (!isDotSession(id, s.header?.cwd) || retired(id) || hands?.isHands(id, s.header?.cwd)) return decision;
    const parts = [];
    for (const n of [...turnNotes].sort((a, b) => a.order - b.order)) {
      try { const t = String(await n.text({ agent, messages }) ?? '').trim(); if (t) parts.push(t); } catch (err) { logger.debug?.(`turn note ${n.name}: ${err.message}`); }
    }
    if (!parts.length) return decision;
    return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: `<system-reminder>\n${parts.join('\n\n')}\n</system-reminder>` }], source: TURN_NOTE_SOURCE })] };
  });
  // Her clock: "since the last message" counts from the last line said before this turn began.
  turnNote({ name: 'dot:now', order: 899, text: ({ agent }) => {
    const id = agent.session.id, started = turns.get(id)?.startedAt ?? Date.now();
    return [nowText(Date.now(), ctx.get('dotMemory')?.lastSaidAt?.(started) ?? 0), id === lastSession ? reachText(reaches) : '', id === lastSession ? handsLine() : ''].filter(Boolean).join('\n');
  } });
  // What she writes here is read by no one: said once per arrival, because nothing else in front of her says it.
  turnNote({ name: 'dot:say', order: 901, text: () => prompt('dot.say.note') });
  turnNote({ name: 'dot:scheduled-turn', order: 900, text: ({ agent, messages }) => (turns.get(agent.session.id)?.scheduled || messages.some((m) => m?.source?.kind === 'schedule') ? scheduledRule() : '') });

  /** What she is busy with right now (an interlude task records it when it has to wait). */
  const busyWith = () => (turns.has(lastSession) ? prompt('dot.busy.chat') : '');

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
  // Her sleep is a state, not a time of day. awakeHours is her habit: outside it she is falling asleep, and is asleep
  // once it has been quiet for sleepAfterQuietMinutes — so a night she is still talking is a night she is still up, and
  // what arrives just as she dozes off still reaches her. Asleep, only he wakes her (his words, or any turn of her
  // conversation); what her phone and her QQ show waits. She wakes at her usual hour, or when woken; either way what
  // waited is shown to her then, and her next turn is told how long she slept — how she takes that is hers.
  let asleepSince = Number(store.get('asleepSince') || 0), lastStir = Date.now(), woke = null;
  const sleepListeners = new Set();
  const sleeps = sleepsAtAll(cfg.awakeHours);
  const awake = () => !asleepSince;
  const stir = () => { lastStir = Date.now(); };
  const wakeUp = (by) => {
    if (!asleepSince) { stir(); return; }
    woke = { by, at: Date.now(), sleptMs: Date.now() - asleepSince, untilUsualMs: msUntilHours(cfg.awakeHours) };
    asleepSince = 0; store.set('asleepSince', 0); stir();
    audit('woke', { by, sleptMs: woke.sleptMs });
    if (batch.length && !batchTimer) { batchTimer = setTimeout(flush, cfg.notifyBatchMs); batchTimer.unref?.(); }
  };
  const sleepTick = () => {
    const usual = inHours(cfg.awakeHours);
    if (asleepSince) { if (usual) wakeUp('morning'); return; }
    if (usual) return;
    if (!quiet() || Date.now() - lastStir < cfg.sleepAfterQuietMinutes * 60000) return;
    asleepSince = Date.now(); store.set('asleepSince', asleepSince); woke = null;
    audit('asleep', { quietMs: asleepSince - lastStir });
    for (const fn of sleepListeners) { try { fn(asleepSince); } catch (err) { logger.warn(`onSleep failed: ${err.message}`); } }
  };
  ctx.effect(() => { const t = setInterval(sleepTick, 30000); t.unref?.(); return () => clearInterval(t); }, 'dsh-dot: her sleep');
  const span = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`; };
  turnNote({ name: 'dot:woke', order: 898, text: ({ agent }) => {
    if (!woke || agent.session.id !== lastSession) return '';
    const w = woke; woke = null;
    if (Date.now() - w.at > 3600000) return ''; // long since: no longer "just woke"
    return w.by === 'morning' ? prompt('dot.woke.morning', { slept: span(w.sleptMs) }) : prompt('dot.woke', { slept: span(w.sleptMs), left: span(w.untilUsualMs) });
  } });
  // Her conversation and her hands think at their own effort (defaults.herEffort, handsEffort), whatever the model
  // selector was last set to. It is the session's own selection, set through the agent before anything is sent into
  // it: recorded for that session only, kept, and nothing is done when it already says so. The host fixes a step's
  // selection before the step runs and fails the whole turn when the `agent/request` waterfall proposes another
  // effort (11-17, and again 11-21: three of his messages went unanswered), so it is never changed there. A host
  // without agent.model.select, or a model that does not offer the effort: the session follows the selector.
  const thinkAt = async (agent, want) => {
    if (!want) return;
    try {
      const m = agent?.model;
      if (typeof m?.select !== 'function') return;
      const cur = (typeof m.current === 'function' ? m.current() : null) ?? ctx.get('agentDefaultModel')?.currentSelection?.();
      if (!cur?.provider || !cur?.model) return;
      const { effort, why } = await effortFor(ctx, { provider: cur.provider, model: cur.model, reasoningEffort: cur.reasoningEffort }, want);
      if (!effort || effort === cur.reasoningEffort) return;
      m.select({ provider: cur.provider, model: cur.model, reasoningEffort: effort });
      audit('effort-set', { session: agent.session?.id, model: `${cur.provider}/${cur.model}`, was: cur.reasoningEffort ?? 'default', effort, why });
    } catch (err) { logger.warn(`reasoning effort not set: ${err.message}`); }
  };
  let batch = [], batchTimer = null; // what her phone and her QQ showed (not his words): one wake for what arrives within notifyBatchMs
  const held = new Map(); // session id → items that arrived while it was running a turn (each with heldAt); delivered as one message when it ends
  let deliverTracked; // assigned below, used by flush/releaseHeld
  /**
   * Her agent for a session: the live agent loop from ctx.agents (steer/inject/cancel) when it is
   * running; otherwise the session controller's resolveAgent — the client API layer, whose handle on
   * the desktop host only offers followup — which also loads a session that is not live.
   */
  const resolveLive = async (id) => {
    const live = ctx.get('agents')?.get?.(id);
    const found = typeof live?.followup === 'function' ? { agent: live } : await ctx.get('sessionController')?.resolveAgent(id);
    if (found && !('error' in found) && !retired(id)) await thinkAt(found.agent, cfg.herEffort);
    return found;
  };
  /**
   * Make a session in her home for her conversation: with her own preset when lean is on. A host that does not know
   * the preset (the plugin's patch row did not load, an older dsh) refuses it — then the session is made as before.
   */
  const createConversation = async (controller) => {
    let made;
    if (cfg.lean) {
      try { made = await controller.create({ cwd: home, agentPreset: HER_PRESET }); audit('conversation-preset', { session: made?.sessionId, preset: made?.agentPreset ?? HER_PRESET }); }
      catch (err) { audit('conversation-preset-refused', { why: String(err?.message ?? err).slice(0, 200) }); }
    }
    made ??= await controller.create({ cwd: home });
    // Its effort is set now, whoever is first to send into it (his words typed in its window, her own time).
    try { await resolveLive(made?.sessionId); } catch (err) { logger.debug?.(`new conversation not resolved: ${err.message}`); }
    return made;
  };
  /** A new conversation of hers in her home; '' when dsh cannot make one. */
  const openConversation = async (controller) => {
    try {
      const { sessionId } = await createConversation(controller);
      try { await controller.rename?.({ sessionId, title: 'dot' }); } catch (error) { void error; }
      setLast(sessionId); audit('conversation-opened', { session: sessionId });
      return sessionId;
    } catch (err) { logger.warn(`could not open a conversation for her: ${err.message}`); return ''; }
  };
  // Her hands (hands.js): their own session, outside her home, with the device tools and nothing else of hers.
  const handsAgent = async (id) => {
    try {
      const live = ctx.get('agents')?.get?.(id);
      const found = typeof live?.followup === 'function' ? { agent: live } : await ctx.get('sessionController')?.resolveAgent(id);
      if (!found || 'error' in found) return null;
      await thinkAt(found.agent, cfg.handsEffort);
      return found.agent;
    } catch (error) { void error; return null; }
  };
  // Her phone, put down: a while after her last step on it, it is back on its home screen — an app left open in front
  // shows no notifications, and whether she is "done" is not something she has to say (she used to spend a whole
  // round of her hands on pressing HOME after everything she did). Like a screen that locks itself; a new step on the
  // phone before that keeps it where it is. The app is not closed: opened again, it is on the page it was left on.
  let phoneHomeTimer = null;
  const armPhoneHome = () => {
    clearTimeout(phoneHomeTimer); phoneHomeTimer = null;
    if (!(cfg.phoneHomeAfterMs > 0)) return;
    phoneHomeTimer = setTimeout(() => {
      phoneHomeTimer = null;
      if (hands?.busy() || !phone()?.isReady) return;
      Promise.resolve(phone().adbExec?.(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])).then(() => audit('phone-home', { afterMs: cfg.phoneHomeAfterMs })).catch((err) => logger.debug?.(`phone home: ${err.message}`));
    }, cfg.phoneHomeAfterMs);
    phoneHomeTimer.unref?.();
  };
  ctx.effect(() => () => clearTimeout(phoneHomeTimer), 'dsh-dot: phone back to its home screen');
  hands = createHands({
    dir: join(dshHome(), 'dsh-dot-hands'),
    create: async (cwd) => {
      const controller = ctx.get('sessionController');
      if (!controller) return '';
      try { const { sessionId } = await controller.create({ cwd }); try { await controller.rename?.({ sessionId, title: 'dot · 手' }); } catch (error) { void error; } return sessionId; }
      catch (err) { logger.warn(`hands session not created: ${err.message}`); return ''; }
    },
    agentFor: handsAgent,
    onEvent: (fn) => ctx.on('session/event', fn),
    message: (text) => createUserMessage({ content: [{ type: 'text', text }], source: HANDS_SOURCE }),
    textOf: contentText,
    store,
    // A session her hands are done with is put away: one per thing, so they pile up otherwise.
    retire: async (id) => { try { await ctx.get('workspaceRegistry')?.archiveSession?.(id); } catch (err) { logger.debug?.(`hands session not archived: ${err.message}`); } },
    audit, maxMs: cfg.handsMaxMs, askMs: cfg.handsAskMs,
    // The thing is over, or her hands need her: what they said, and the screen as it is now for her own eyes, come
    // to her conversation and wake her. Nothing else of theirs does. What she makes of it — and whether he hears of
    // it — is hers: on his business the message says whose it is, and she tells him with qq_send.
    onDone: (r, job) => { if (job.device === 'phone') armPhoneHome(); return handsBack(r, job); },
    onAsk: (r, job) => handsBack(r, job),
  });
  async function handsBack(r, job) {
    stir();
    try {
      await moved(); // her conversation is being handed over: it goes to the new one
      const found = lastSession && await resolveLive(lastSession);
      if (!found || 'error' in found) { audit('hands-result-dropped', { why: 'no conversation' }); return; }
      if (r.shown) { try { ctx.get('dotMemory')?.shownTo?.(lastSession, r.shown); } catch (error) { void error; } }
      const head = r.question
        ? prompt('dot.hands.ask', { stamp: stamp(Date.now(), Date.now()), task: job.task, question: r.question, text: r.text && r.text !== r.question ? r.text : '' })
        : prompt('dot.hands.result', { stamp: stamp(Date.now(), Date.now()), task: job.task, status: handsStatus(r, job.device), text: r.text || '（没说什么）' });
      const content = [{ type: 'text', text: head.trim() + (job.forHim ? `\n${prompt('dot.hands.result.his').trim()}` : '') }];
      if (r.status !== 'failed' && job.device !== 'web') { // looking something up leaves no screen to show
        try {
          const images = ctx.get('attachments');
          const png = typeof images?.saveImages !== 'function' ? null : job.device === 'phone' ? (phone()?.isReady ? await phone().screenshot() : null) : await computerScreen();
          if (png?.length) { const [image] = await images.saveImages([{ data: new Uint8Array(png), mediaType: 'image/png', name: `${job.device}-screen` }]); if (image) content.push({ type: 'text', text: prompt(job.device === 'computer' ? 'dot.hands.screen.computer' : 'dot.hands.screen').trim() }, { type: 'image', attachment: image }); }
        } catch (err) { logger.debug?.(`hands: no screenshot: ${err.message}`); }
      }
      found.agent.followup(createUserMessage({ content, source: { kind: 'dsh-dot', form: 'hands-result', ...(job.forHim ? { for: 'him' } : {}) } }));
      audit('hands-result', { session: lastSession, status: r.question ? 'asking' : r.status, forHim: Boolean(job.forHim), steps: r.steps, rounds: r.rounds });
    } catch (err) { logger.warn(`hands result not delivered: ${err.message}`); }
  }
  // A thing a restart cut off is told to her once, when her conversation can be reached.
  ctx.effect(() => { const t = setTimeout(() => { const cut = hands.interrupted(); if (cut) void handsBack({ status: 'failed', why: '重启打断了', text: '', steps: 0, rounds: 0 }, cut); }, 20000); t.unref?.(); return () => clearTimeout(t); }, 'dsh-dot: what a restart cut off');
  const deliver = (all, whileBusy, target) => {
    const controller = ctx.get('sessionController');
    const pkgs = [...new Set(all.map((n) => n.pkg))];
    if (!controller) { audit('notification-dropped', { pkgs, why: 'no sessionController' }); return; }
    const fromOwner = all.filter((n) => n.fromOwner);
    const items = all.filter((n) => !n.fromOwner);
    waking = waking.then(async () => {
      // No conversation yet (first run, or after a reset): his words open one. Anything else has nowhere to go.
      const id = target || lastSession || (fromOwner.length ? await openConversation(controller) : '');
      if (!id) { audit('notification-dropped', { pkgs, why: 'no session yet' }); return; }
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
  // ── her side of the conversation with him ──
  // Writing (a turn of his words is open, `turns`), sending (her bubbles are going out, `sendingCount`), or neither.
  // One rule for both: what has not reached him yet gives way to what he just said; what has reached him stands.
  let sending = Promise.resolve(), sendingCount = 0;
  let preempts = 0;     // her words in a row that gave way before anything of hers reached him (see defaults.ownerPreemptMax)
  /** Her transcript gets what reached him, not what she wrote (dsh-dot/memory). */
  const herSaid = (id, text) => { try { if (String(text ?? '').trim()) ctx.get('dotMemory')?.herSaid?.({ session: id, text }); } catch (err) { logger.warn(`transcript: ${err.message}`); } };
  const replyChecks = () => { try { return cfg.replyCheck ? ctx.get('dshInterlude')?.checks?.() ?? [] : []; } catch { return []; } };
  /** Has he said something she has not read — still in the buffer, or held while her conversation is being handed over? */
  const hisUnread = () => ownerBatch.length > 0 || frozenQueue.some((n) => n.fromOwner);
  /** What is in her hands, as the call that writes her words is told it: from the code, not from what she says she is doing. */
  const handsState = () => { const d = hands?.doing?.(); const since = d && ago(d.startedAt, Date.now()); return !d ? prompt('dot.say.state.none').trim() : d.state === 'asking' ? prompt('dot.say.state.asking', { task: d.task }).trim() : prompt('dot.say.state.doing', { task: d.task, since: since ? `（${since}了）` : '' }).trim(); };
  // What she says (say.js): written by a call that is only her card, checked once, and carried out from here —
  // to his QQ or anyone's (her bubbles one after another; qq.send stops between them when he speaks), to her own
  // window when that is where he is talking to her (the tool's output is what he reads there), or over the IM
  // channel when her QQ is not connected.
  const say = createSay({
    card: () => { try { return ctx.get('dshInterlude')?.cardText?.() ?? ''; } catch { return ''; } },
    call: async ({ system, text }) => {
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
      const llm = ctx.get('llm');
      if (!sel || !llm?.stream) throw new Error('no model to say it with');
      const effort = cfg.sayEffort ? (await effortFor(ctx, sel, cfg.sayEffort)).effort : sel.reasoningEffort;
      const reply = await collectReply(llm.stream({ provider: sel.provider, model: sel.model, ...(effort ? { reasoningEffort: effort } : {}), system, maxTokens: cfg.sayMaxTokens, messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-dot', form: 'say' } })] }));
      return reply.text;
    },
    recent: (n) => { try { return ctx.get('dotMemory')?.recent?.(n) ?? []; } catch { return []; } },
    state: handsState,
    stickers: () => { try { return ctx.get('dshQq')?.stickerList?.() ?? []; } catch { return []; } },
    check: (text) => (cfg.replyCheck ? checkReply(text, replyChecks()) : { lines: String(text).split('\n').map((l) => l.trim()).filter(Boolean), hits: [] }),
    unread: (to) => to === 'owner' && preempts < cfg.ownerPreemptMax && hisUnread(),
    lines: cfg.sayLines,
    audit: (event, data) => audit(event, { session: lastSession, ...data }),
    send: async ({ to, text, images }) => {
      const t = turns.get(lastSession);
      const qq = ctx.get('dshQq');
      const whole = () => ({ said: String(text).split('\n').filter(Boolean), images: [] });
      if (to === 'owner' && t?.elsewhere && !t.fromQq) { herSaid(lastSession, text); return whole(); }
      if (qq?.connected) {
        sendingCount++;
        const job = sending.then(() => qq.send(to, text, images));
        sending = job.catch(() => {});
        try { return await job; } finally { sendingCount--; }
      }
      if (to !== 'owner') throw new Error('her QQ is not connected');
      if (!(await im.send(text))) throw new Error('no way to reach him: her QQ is not connected and there is no IM target');
      herSaid(lastSession, text);
      return whole();
    },
  });
  /** What went out, told back to her: the lines and pictures as they were sent. */
  const saidText = (r) => prompt(r.interrupted ? 'dot.say.interrupted' : 'dot.say.said', { said: [...(r.said ?? []), ...(r.images ?? []).map((i) => `[${i}]`)].join('\n') || '（只发了图）', unsent: (r.unsent ?? []).join('\n') });
  /**
   * Something of hers for him, in turn `t` (the open one, or the one that just ended): what she knows that bears on it
   * (`about`, from the say tool) or what she wrote she means to tell him (`meant`, a turn's closing words). The same
   * call writes it either way; here is what the turn and the day keep of it.
   */
  async function tellHim(t, { about = '', meant = '', images = [] } = {}) {
    // Nothing of his is waiting for an answer when the turn was not opened by his words (her hands came back, a notification, her own time).
    const r = await say.speak({ to: 'owner', about, meant, images, unprompted: !(t?.fromQq || t?.elsewhere) });
    if (r.status === 'held') preempts++;
    if (r.status !== 'said') return r;
    preempts = 0; // something of hers reached him
    if (t) t.spoke = true;
    // She wrote to him in a turn he did not open: kept as a fact of the day (reachText), with what came of it.
    if (t && !t.his && !t.fromQq && !t.forHim && !t.reached) { t.reached = true; reaches.push({ at: Date.now() }); saveReaches(); audit('reached-out', { session: lastSession, origin: t.origin ?? (t.scheduled ? 'schedule' : '') }); }
    return r;
  }

  /**
   * His words into her session. Idle: a followup starts a turn, as always. In the middle of a turn:
   * steered into it, so she reads them at her next step instead of after the turn (an agent without
   * `steer` gets the followup).
   */
  let agentShapeLogged = false;
  const toOwnerAgent = (agent, id, items) => {
    const busy = turns.has(id);
    const open = turns.get(id);
    // Nothing of this turn has reached him and it has done nothing yet (a turn of his words, no tool call so far):
    // it is started over with what he just said, so the reply she writes is to all of it. A turn that has
    // used a tool is not undone; his words go into it at its next step.
    const restart = busy && open?.fromQq && !open.scheduled && !open.tools && !open.spoke && typeof agent.cancel === 'function' && preempts < cfg.ownerPreemptMax;
    // The host's agent handle may not expose `steer`: `send(message, 'next-step', true)` is the same
    // boundary in dsh-agent's inbox API; failing both, the followup (after the turn, as before).
    const via = restart ? 'restart' : busy && typeof agent.steer === 'function' ? 'steer' : busy && typeof agent.send === 'function' ? 'send' : 'followup';
    if (!agentShapeLogged) {
      agentShapeLogged = true;
      const methods = [...new Set([...Object.keys(agent), ...Object.getOwnPropertyNames(Object.getPrototypeOf(agent) ?? {})])].filter((k) => typeof agent[k] === 'function');
      logger.info(`her agent handle offers: ${methods.join(', ')} (busy now: ${busy}, open turns: ${[...turns.keys()].map((k) => k.slice(0, 16)).join(' ') || 'none'})`);
      audit('agent-handle', { methods, busy, openTurns: turns.size });
    }
    const message = createUserMessage({ content: contentFor(ownerWords(items, Date.now(), { whileBusy: via === 'steer' || via === 'send' }), items), source: ownerSource() });
    try {
      if (via === 'restart') {
        // The cancelled turn's own input stays in her history. His new words are queued in the same tick: waking
        // input submitted after an active cancellation is held by the host for the next turn and runs when the
        // aborted one has settled, so nothing waits on a promise of ours and the order is the host's inbox order.
        agent.cancel({ kind: 'hook', reason: 'dot-owner-spoke' }, { keepInbox: true });
        preempts++; open.cancelled = true; // only once the cancel is in: a turn that was not cancelled keeps its answer
        if (typeof agent.send === 'function') agent.send(message, 'next-turn', true); else agent.followup(message);
      } else if (via === 'steer') agent.steer(message); else if (via === 'send') agent.send(message, 'next-step', true); else agent.followup(message);
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
  let frozen = 0; let frozenQueue = []; let frozenWaiters = []; // while her conversation is being handed over (dsh-dot/memory)
  /** Resolves once her conversation is not being handed over (at once, when it is not). */
  const moved = () => (frozen ? new Promise((go) => frozenWaiters.push(go)) : Promise.resolve());
  const send = (id, items) => {
    if (!items.length) return;
    if (frozen && id === lastSession) { frozenQueue.push(...items); audit('notification-held', { count: items.length, why: 'handoff' }); return; }
    // That session is in the middle of a turn: hold these; the turn's end delivers everything at once, in order.
    // (His own words never come this way: they have their own buffer and are steered in, see flushOwner.)
    if (id && turns.has(id)) { held.set(id, [...(held.get(id) ?? []), ...items.map((n) => ({ heldAt: Date.now(), ...n }))]); audit('notification-held', { count: items.length, why: 'turn running', retired: retired(id) }); return; }
    deliverTracked(items, false, id);
  };
  // Asleep, what came stays here until she wakes; then it is all shown to her at once, in order.
  const flush = () => {
    batchTimer = null;
    if (!awake()) return; // waking shows it to her (wakeUp)
    const items = batch; batch = []; send(lastSession, items);
  };
  // What arrived while her conversation was in a turn goes in when the turn ends.
  const releaseHeld = async (id) => { const items = held.get(id); if (!items?.length) return; held.delete(id); deliverTracked(items, true, id); };
  // Her own things (dshDot.task: her own time): the lowest priority, one at a time, when nothing else is going on.
  const taskQueue = []; let taskRunning = null;
  // What her attention is on right now, in one place. Everything that would wake her on its own account (a thing of
  // her own, picking up her phone, the one asking) asks `quiet()`; nothing keeps a list of its own.
  const herState = () => ({
    writing: Boolean(lastSession) && turns.has(lastSession),       // a turn of her conversation is running
    sending: sendingCount > 0,                                     // her bubbles are going out
    hands: Boolean(hands?.busy()),                                 // her hands are on a round
    his: ownerBatch.length > 0 || ownerTyping,                     // he said something she has not got yet, or is typing
    moving: frozen > 0,                                            // her conversation is being handed over
    waiting: Boolean(taskRunning) || batch.length > 0 || [...held.values()].some((ns) => ns.length), // something is already on its way to her
  });
  const quiet = () => !Object.values(herState()).some(Boolean);
  const finishTask = (t, status, report = '', cost = null) => {
    if (t === taskRunning) taskRunning = null; else taskQueue.splice(taskQueue.indexOf(t), 1);
    audit(`task-${status}`, { kind: t.kind, key: t.key, session: t.session, waitedMs: (t.startedAt ?? Date.now()) - t.queuedAt });
    try { t.onDone?.({ status, queuedAt: t.queuedAt, startedAt: t.startedAt ?? null, doneAt: Date.now(), busyWith: t.busyWith, report, cost }); } catch (err) { logger.warn(`task onDone failed: ${err.message}`); }
  };
  const nextTask = async () => {
    const now = Date.now();
    for (const t of taskQueue.filter((x) => x.expiresAt <= now)) finishTask(t, 'expired');
    if (!taskQueue.length || !quiet() || !awake()) return; // her own things do not wake her
    const t = taskRunning = taskQueue.shift();
    t.startedAt = now;
    try {
      // Her own time and what her phone shows her come to her conversation: there is one of her.
      let id = lastSession;
      let found = id && await resolveLive(id);
      // No conversation of hers (a fresh start, "new conversation", or the remembered one is gone): her own time
      // opens one, as his first message would — it was dropped instead, and the day's slots with it.
      if (!found || 'error' in found) {
        const controller = ctx.get('sessionController');
        id = controller ? await openConversation(controller) : '';
        found = id && await resolveLive(id);
      }
      if (!found || 'error' in found) throw new Error(found?.error?.message ?? 'no conversation of hers and none could be opened');
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
    const task = { ...spec, queuedAt: now, expiresAt: now + ttlMs, busyWith: busyWith() };
    // What he asked for goes before her own things, after earlier asks; it is never the one dropped for room.
    if (spec.kind === 'ask') taskQueue.splice(taskQueue.filter((x) => x.kind === 'ask').length, 0, task); else taskQueue.push(task);
    while (taskQueue.filter((x) => x.kind !== 'ask').length > Math.max(1, cfg.interludeQueueMax)) finishTask(taskQueue.find((x) => x.kind !== 'ask'), 'dropped');
    void nextTask();
    return 'queued';
  };
  /** A picture of her computer's desktop right now (PNG), or null when the computer has no way to take one. */
  const computerScreen = async () => {
    const sh = computer()?.backend?.rootShell;
    if (typeof sh !== 'function') return null;
    const out = String(await sh([VM_SCREENSHOT, '[ -s $f ] && base64 -w0 $f; rm -f $f'].join('\n'))).trim().split('\n').pop() ?? '';
    return out.length > 100 ? Buffer.from(out, 'base64') : null;
  };
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'hands',
      description: prompt('dot.hands-tool'),
      parameters: { type: 'object', properties: { device: { type: 'string', enum: ['phone', 'computer', 'web'], description: 'phone / computer：在那台设备上做；web：查资料，不碰设备' }, do: { type: 'string', description: '要做成的事，说完整；要打的字原样写上。手上的事停在要你拿主意的地方时，这里写你的回答' }, say: { type: 'string', description: '这件事里要打给别人看的话（评论、回帖、在 App 里回人）：写你想说的意思，原话会替你写好、照着打上去' }, stop: { type: 'boolean', description: '手上的事不做了' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'started' ? prompt('dot.hands.started') : v?.status === 'answered' ? prompt('dot.hands.answered') : v?.status === 'busy' ? prompt('dot.hands.busy', { task: v.doing?.task ?? '' }) : v?.status === 'stopped' ? prompt('dot.hands.stopped') : v?.status === 'idle' ? prompt('dot.hands.idle') : `没开始：${v?.why ?? ''}` }] },
      async execute(args) {
        if (args?.stop) return { status: hands.stop('她叫停了') ? 'stopped' : 'idle' };
        // Words her hands are to type for someone to read are hers to mean and the card's to write (say.js): they go
        // into what her hands are given, as the words to type.
        let words = '';
        if (String(args?.say ?? '').trim()) {
          try { words = await say.compose({ about: args.say, where: String(args?.do ?? '').trim() }); } catch (err) { return { status: 'failed', why: `要打的话没写出来：${err.message}` }; }
          if (!words) return { status: 'failed', why: '这句话她不想说，没有交出去' };
        }
        const given = [String(args?.do ?? '').trim(), words ? prompt('dot.hands.words', { words }).trim() : ''].filter(Boolean).join('\n');
        // Her hands are waiting for her: what she says now is her answer, and they carry on with it.
        if (hands.asking()) {
          const his = hands.doing()?.forHim;
          const answered = hands.answer(given);
          return answered;
        }
        const device = args?.device === 'computer' ? 'computer' : args?.device === 'web' ? 'web' : 'phone';
        // Whose business this is: his (a turn his words opened, or one her hands came back to on his business) or her own.
        const t = turns.get(lastSession);
        const forHim = Boolean(t && !t.scheduled && (t.fromQq || t.elsewhere || t.forHim));
        if (device === 'phone') { clearTimeout(phoneHomeTimer); phoneHomeTimer = null; }
        const started = await hands.start({ device, task: `${prompt(device === 'computer' ? 'dot.hands.where.computer' : device === 'web' ? 'dot.hands.where.web' : 'dot.hands.where.phone').trim()}${given}`, forHim });
        return started;
      },
    }), 'dsh-dot: hands tool');
    // Her one way of saying something to anyone (say.js). She gives what she knows that bears on it — or nothing —
    // and the words are written by a call that is only her card; what went out comes back to her as the result.
    scope.effect(() => scope.tools.register({
      name: SAY_TOOL,
      description: prompt('dot.say-tool'),
      parameters: { type: 'object', properties: { to: { type: 'string', description: '说给谁：不填就是他；别人填 user:<QQ号>，群里填 group:<群号>' }, about: { type: 'string', description: '这次要让对方知道的事，一句话；只是接他的话、没有要告诉他的事，就不填' }, context: { type: 'string', description: '说给别人时：对方刚说了什么、在哪说的' }, images: { type: 'array', items: { type: 'string' }, description: '要一起发的图："phone:screen"、"computer:screen"、"phone:latest"、图片网址。表情包不用填，会自己挑' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'said' ? saidText(v) : v?.status === 'silent' ? prompt('dot.say.silent') : v?.status === 'held' ? prompt('dot.owner-interrupt') : `没说成：${v?.why ?? ''}` }] },
      async execute(args) {
        const to = String(args?.to ?? '').trim() || 'owner';
        if (isOwnerTarget(to, ctx.get('dshQq')?.owner)) return tellHim(turns.get(lastSession), { about: args?.about, images: args?.images });
        return say.speak({ to, about: args?.about, context: args?.context, images: args?.images });
      },
    }), 'dsh-dot: say tool');
    // Her hands' one way of coming back with a question (hands.js): a choice that is hers, words that have to be hers.
    // Said with a tool, so "they need her" is a fact the code has and not something read out of a report.
    scope.effect(() => scope.tools.register({
      name: HANDS_ASK_TOOL,
      description: prompt('dot.hands.ask-tool'),
      parameters: { type: 'object', properties: { question: { type: 'string', description: '要她定的事，一两句说清；她要选的东西一条一条列出来' } }, required: ['question'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: prompt(v?.status === 'asked' ? 'dot.hands.asked' : 'dot.hands.ask.idle') }] },
      async execute(args) { return { status: hands.ask(args?.question) ? 'asked' : 'idle' }; },
    }), 'dsh-dot: hands ask tool');
  });
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({ name: 'dot:hands', order: 59, text: (c) => (hands?.isHands(c.agent?.session?.id, c.agent?.session?.header?.cwd) ? prompt('dot.hands.system') : '') }), 'dsh-dot: hands section');
  });

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
    // Her bubbles are still going out: sending counts as busy. They stop at the next bubble (qq.send sees he
    // spoke); his words go in once they have, together with what was left unsent.
    if (!agent && sendingCount > 0 && ownerBatch.length) { void sending.finally(() => flushOwner()); return 0; }
    const items = ownerBatch; ownerBatch = []; ownerTyping = ownerTypingSeen = false;
    if (!items.length) return 0;
    const id = lastSession;
    if (frozen) { frozenQueue.push(...items); audit('notification-held', { count: items.length, why: 'handoff' }); return items.length; }
    if (agent && id && agent.session?.id === id) { toOwnerAgent(agent, id, items); return items.length; }
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
      ownerBatch.push(n); ownerTyping = false; // he pressed send
      wakeUp('him');
      answerReaches();
      armOwner();
      return;
    }
    // Whatever her phone or her QQ shows is shown to her as it is — which app, what it says. Whether it is worth
    // opening is hers to decide (a turn that ends in DOT_SILENT); nothing here sorts notifications by app or wording.
    batch.push(n);
    if (!awake()) { audit('notification-held', { pkg: n.pkg, why: 'asleep' }); return; }
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
  // What she said on QQ some other way than qq_send (the backend's own tools, her phone's QQ): on record all the same.
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onSelf?.((m) => {
    audit('said-elsewhere', { to: m.to, chars: m.text.length });
    try { ctx.get('dotMemory')?.herSaid?.({ session: lastSession, text: m.text, to: m.to, at: Date.parse(m.at) || Date.now() }); } catch (err) { logger.warn(`transcript: ${err.message}`); }
  }) ?? (() => {}), 'dsh-dot: her own qq messages'));
  // Read before you speak: a qq_send to him while he has said something she has not read yet (still in
  // the buffer, or steered but not reached by the model) is held back once or twice per turn; the
  // buffer goes in right away, so her next step has it.
  // Also: a loop (the same call over and over in one turn) is stopped, and an errand never talks to him.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const id = exec.agent?.session?.id;
    const args = exec.input ?? exec.args ?? exec.arguments ?? {};
    const t = turns.get(id);
    // Looking and scrolling repeat by nature (the screen changes, the call does not): never a loop.
    if (t && cfg.loopRepeat > 0 && !LOOP_EXEMPT.test(exec.name)) {
      const key = loopKey(exec.name, args), times = (t.calls ??= new Map()).get(key) ?? 0;
      if (times >= cfg.loopRepeat) { audit('loop-stopped', { session: id, tool: exec.name, times }); return deny(prompt('dot.loop-stopped', { times })); }
      t.calls.set(key, times + 1);
    }
    // hand_off is hers to use in her conversation only; and in a turn of his words she talks and hands off —
    // her phone and computer are operated by her errand, not here.
    if (exec.name === 'hands' && id !== lastSession) return deny(prompt('dot.hands.instead'));
    // Her hands: asking her is theirs alone, and once they have asked, this stretch of theirs is over — nothing more is done until she answers.
    const theirs = Boolean(hands?.isHands(id, exec.agent?.session?.header?.cwd));
    if (exec.name === HANDS_ASK_TOOL && !theirs) return deny(prompt('dot.lean.not-hers', { tool: exec.name }));
    if (theirs && exec.name !== HANDS_ASK_TOOL && hands.asked()) return deny(prompt('dot.hands.asked'));
    // A lean conversation of hers has her own tools only; one the host still answers to by name is not run.
    if (leanIds.has(id) && !isHerTool(exec.name)) { audit('lean-refused', { session: id, tool: exec.name }); return deny(prompt('dot.lean.not-hers', { tool: exec.name })); }
    // From here on it is about what she is saying, whichever way it goes out (spokenOf).
    const spoken = exec.name === SAY_TOOL ? { via: 'qq', to: String(args?.to ?? '').trim() || 'owner', text: '' } : spokenOf(exec.name, args);
    if (!spoken) return next();
    // One way out for her words: a send of the QQ backend's own tools (or qq_send, by name) from her conversation would be words nobody wrote as her.
    if (spoken.via === 'qq' && exec.name !== SAY_TOOL && isDotSession(id, exec.agent?.session?.header?.cwd)) return deny(prompt('dot.say.instead'));
    // Her hands do not write. What they type on her phone is hers (in the task she gave them) or was shown to them
    // (the screen, an account) — an address is not words. Anything else goes back to her to be said.
    const round = hands?.isHands(id, exec.agent?.session?.header?.cwd) && hands.busy() ? hands.doing() : null;
    if (round && spoken.via === 'phone') {
      const own = ownWords(spoken.text, hands.has);
      if (own.length) { hands.note('own-words'); audit('hands-own-words', { session: id, chars: own.join('').length }); return deny(prompt('dot.hands.own-words', { text: own[0].slice(0, 60) })); }
    }
    const toOwner = spoken.via === 'qq' && isOwnerTarget(spoken.to, ctx.get('dshQq')?.owner);
    // What she tells him on something her hands brought back counts as said in that turn, like her answer in a turn of his words.
    const told = () => { if (toOwner && t?.forHim && id === lastSession) t.spoke = true; return next(); };
    // Her words can still be handed back, to anyone and anywhere: him, someone else, a group, a comment typed on
    // her phone. Once a turn — a second draft goes out as it is, so a phrase list that is wrong costs one call.
    // Typed by her hands, the words are still hers: the line goes back to her, through them.
    const c = spoken.text && (round || t) ? handBack(spoken.text, { strict: true }) : null;
    if (c) {
      const why = c.hits.length ? prompt('dot.reply-check.phrases', { phrases: c.hits.slice(0, 3).map((h) => `「${h}」`).join('') }) : prompt('dot.reply-check.stage');
      if (round) hands.note('reply-check');
      audit('reply-check', { session: id, via: round ? 'hands' : exec.name === 'qq_send' ? 'qq_send' : spoken.via === 'phone' ? 'phone' : 'qq-tool', ...(toOwner ? {} : { to: spoken.to || 'app' }), stripped: c.stripped, hits: c.hits, denied: true });
      return deny(round ? prompt('dot.hands.reply-check', { why }) : replyCheckText(c));
    }
    if (round) return next();
    if (!toOwner) return next();
    const buffered = Boolean(id) && id === lastSession && ownerBatch.length > 0;
    if (!buffered && !ownerUnread(exec.agent)) return told();
    if (preempts >= cfg.ownerPreemptMax) { audit('owner-gate-passed', { session: id, preempts }); return told(); }
    const n = preempts++;
    const flushed = buffered ? flushOwner(exec.agent) : 0;
    audit('owner-gate-denied', { session: id, flushed, deny: n + 1 });
    return deny(ownerInterruptText());
  });
  deliverTracked = deliver;
  // Turn watchdog: a turn of hers with no session event for turnStallMs is stalled (audited once).
  // Her conversation is never cancelled: he is told once per turn (unless he was already told about its approval).
  const pendingApproval = (id) => { let first; for (const a of approvals.values()) if (a.session === id && (!first || a.since < first.since)) first = a; return first; };
  const doingOf = (t, a) => (a ? `等 ${shortTool(a.tool)} 的审批` : t.doing || (t.said ? t.said.replace(/\s+/g, ' ').slice(0, 60) : '') || '（不清楚）');
  const turnInfo = (id, now = Date.now()) => {
    const t = turns.get(id);
    if (!t) return null;
    const a = pendingApproval(id);
    return { session: id, retired: retired(id), conversation: id === lastSession, startedAt: t.startedAt, lastEventAt: t.lastEventAt, doing: doingOf(t, a), ...turnState(t, { now, turnStallMs: cfg.turnStallMs, approval: a }) };
  };
  const watchTurns = (now = Date.now()) => {
    if (!(cfg.turnStallMs > 0)) return;
    for (const [id, t] of [...turns]) {
      const idle = now - (t.lastEventAt ?? t.startedAt);
      if (idle < cfg.turnStallMs) continue;
      const a = pendingApproval(id);
      if (!t.stallAudited) { t.stallAudited = true; audit('turn-stalled', { session: id, retired: retired(id), idleMs: idle, doing: doingOf(t, a), ...(a ? { approval: a.tool } : {}) }); }
      if (id !== lastSession || t.ownerTold || a?.notified) continue;
      t.ownerTold = true;
      void im.send(`⏳ dot: 她这一轮 ${Math.round(idle / 60000)} 分钟没动静了（最后在做：${doingOf(t, a)}）。没替她取消；要停就在 DeepSeek Harness 里点停止。`, 'plain');
    }
  };
  ctx.effect(() => { const timer = setInterval(() => { watchTurns(); noteUnanswered(); void nextTask(); }, 60000); return () => clearInterval(timer); }, 'dsh-dot: turn watchdog');
  // Doctor: what the host gives her phone and computer. Runs on /dot doctor, once a start when
  // something still has to be installed, and when a device fails; problems go to the log and his IM.
  let lastDoctor = null;
  const runDoctor = async () => {
    const items = await doctorFor({ phone: phone(), computer: computer(), compat: ctx.get('dshDotCompat'), home: dshHome() });
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
      void im.send(`🩺 ${why}\n${text}\n（完整结果：在 dsh 里发 /phone doctor，或打开左侧栏的 dot 页面）`, 'plain');
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
    const who = (id) => `${retired(id) ? 'retired' : id === lastSession ? 'her conversation' : 'session'} ${id.slice(0, 16)}`;
    const out = [...approvals.values()].map((a) => `approval waiting: ${shortTool(a.tool)} in ${who(a.session)} · ${mins(now - a.since)}${cfg.approvalWaitMs > 0 ? ` of ${mins(cfg.approvalWaitMs)}` : ''}${a.timedOutAt ? ' · timed out' : ''}`);
    for (const id of turns.keys()) {
      const t = turnInfo(id, now);
      if (t && (t.state === 'stalled' || t.state === 'timed-out')) out.push(`stalled turn: ${who(id)} · no event for ${mins(t.idleMs)} · ${t.state === 'timed-out' ? 'after an approval timed out · ' : ''}last: ${t.doing} · not cancelled`);
    }
    return out.length ? out : [`liveness: no approval waiting, no stalled turn (approval wait ${cfg.approvalWaitMs > 0 ? mins(cfg.approvalWaitMs) : 'unlimited'}, stalled after ${mins(cfg.turnStallMs)})`];
  };

  // /dot
  // The command registry can come up after dot, so register through a child that waits for it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'dot',
      description: 'dot status; "doctor" checks this machine for her phone and computer (virtualization, disk, memory, ports, downloads); "test" sends a test message to your IM; "memory" / "people" show what she remembers; "prompts" opens the prompt and persona editor page; "howto" shows what she has learned in each app and how many steps it takes her ("howto <app>" her notes for it)',
      input: { hint: '[stop | doctor | test | check | howto [<app>] | prompts [stop | rebase <id> [--reset]] | memory [now|diary|handoff|recall [backend|key|model|rerank|mirror|rebuild|test]] | people [approve|drop <id> | forget <name>]]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        // His stop is a command, not a message she gets round to: what is in her hands ends now, and she is told it was him.
        if (arg === 'stop') { const d = hands?.doing?.(); return { kind: 'success', text: hands?.stop('他叫停了') ? `停下了：${d?.task ?? ''}` : '她手上现在没有事' }; }
        // /dot memory … and /dot people … belong to dsh-dot/memory.
        if (/^(memory|people)\b/.test(arg)) {
          const mem = ctx.get('dotMemory');
          return { kind: 'success', text: mem ? await mem.command(arg) : 'dsh-dot/memory is not loaded' };
        }
        if (/^howto\b/.test(arg)) {
          const app = arg.slice(5).trim();
          if (app) return { kind: 'success', text: `${app}\n${howto.notes(app) || '(no notes yet)'}${howto.needsReview(app) ? '\n(old notes: read over before she is given them again)' : ''}\n\nsteps per task, oldest first: ${howto.tasks(app).map((t) => `${t.task} ${t.steps.join(' → ')}`).join(' · ') || '-'}\nlast runs: ${howto.recent(app, 10).map((r) => `${r.steps}${r.errors ? `(${r.errors}✗)` : ''}${r.worked === false ? '✗' : ''}`).join(' → ') || '-'}` };
          const rows = howto.apps().map((a) => { const r = howto.recent(a, 10); return `${a}: ${r.map((x) => x.steps).join(' → ') || '-'}${howto.notes(a) ? ' · notes' : ''}`; });
          return { kind: 'success', text: `steps per run, oldest first (notes in ${howto.dir})\n${rows.join('\n') || '(nothing yet)'}` };
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
        const vm = computer()?.status?.();
        const ph = phone()?.status?.();
        const lines = [
          `computer: ${vm ? `${vm.state}${vm.publicLiveViewUrl ? ` · ${vm.publicLiveViewUrl}` : ''}` : 'not installed (optional)'} · phone: ${ph ? `${ph.state}${ph.error ? ` (${ph.error})` : ''}` : 'not installed (optional)'}`,
          `IM: ${t.error ? `not ready (${t.error})` : `${t.name ?? t.target} via ${t.bot}`}`,
          ...(lastDoctor && (lastDoctor.bad || lastDoctor.warn) ? [`doctor: ${lastDoctor.bad} problem(s), ${lastDoctor.warn} warning(s) — /dot doctor`] : []),
          `scope: ${cfg.scope} · home: ${home} · im sessions seen: ${imSessions.size}`,
          // Where his next message goes: when she "does not answer", look here first.
          `her conversation: ${lastSession ? `${lastSession}${turns.has(lastSession) ? ' (in a turn)' : ''}` : '(none yet: say something to her in a session under home)'}`,
          `his messages: wait ${cfg.ownerQuietMs} ms of quiet, at most ${cfg.ownerMaxWaitMs} ms (${cfg.ownerTypingMaxMs} ms while typing) · mid-turn: steered · her words give way to his unread ones ≤${cfg.ownerPreemptMax}× in a row${ownerBatch.length ? ` · ${ownerBatch.length} waiting` : ''}`,
          ...statusLiveness(),
          `budget: ${ctx.get('budget') ? (blocked.length ? `BLOCKED (${blocked.join(', ')})` : 'ok') : 'not installed (optional)'}`,
          (() => { try { return llmGateLine(llmGate?.status()); } catch (err) { return `model requests: ${err.message}`; } })(),
          `schedule: ${ctx.get('schedule') ? 'ok' : 'not installed'}`,
        ];
        return { kind: 'success', text: lines.join('\n') + test };
      },
    }), 'dsh-dot: /dot command');
  });

  // Other components (interlude, memory) need to know which session is her conversation.
  ctx.provide?.('dshDot', {
    home,
    session: () => lastSession,
    // Her conversation moves on (memory's handoff): the one she leaves is retired, so a turn still running in it
    // — his words restarted there a moment ago, a reminder set there — does not make it hers again when it ends.
    /** Does this conversation of hers start lean (see defaults.lean)? One begun at or after the moment lean was first on. */
    lean: (id, preset) => { const yes = Boolean(cfg.lean) && Boolean(id) && !retired(id) && preset === HER_PRESET; if (yes) leanIds.add(id); return yes; },
    /** A new conversation of hers, made with her own preset when lean is on (and this host knows the preset). → { sessionId } */
    createConversation: (controller) => createConversation(controller),
    setSession: (id) => {
      if (!id || id === lastSession) return;
      if (lastSession) {
        pastConversations.add(lastSession); store.set('pastConversations', [...pastConversations].slice(-50));
        // The one she leaves stops here: a turn still running in it and whatever waits in its inbox are not carried on
        // by a second her (11-20: it went on for two minutes — 38 turns, 16 messages to him — after she had moved).
        // What is in her hands is not its: that comes back to wherever she is (handsBack).
        try { ctx.get('agents')?.get?.(lastSession)?.cancel?.({ kind: 'hook', reason: 'dot: her conversation moved on' }); audit('conversation-left', { session: lastSession }); } catch (err) { logger.debug?.(`leaving ${lastSession}: ${err.message}`); }
      }
      pastConversations.delete(id);
      setLast(id);
    },
    /**
     * Post a thing of her own ({ kind: 'free', key, text, source, ttlMs, onStart(sessionId), onDone(result) }): it runs in her
     * conversation when nothing else is going on (see defaults.interludeQueueMax); `onDone` gets
     * { status: 'done'|'stalled'|'expired'|'dropped', queuedAt, startedAt, doneAt, busyWith, report, cost: { in, cached, out } | null }. → 'queued' | 'refreshed'
     */
    task: enqueueTask,
    /** How long a queued task waits before it expires. */
    taskTtlMs: cfg.interludeTaskTtlMs,
    /** Her day and her sleep: her usual hours, whether she is awake, since when she is asleep (0 = awake), and a call when she falls asleep. `sleeps` is false when her hours are the whole day. */
    awakeHours: cfg.awakeHours,
    sleeps,
    awake,
    get asleepSince() { return asleepSince; },
    onSleep: (fn) => { sleepListeners.add(fn); return () => sleepListeners.delete(fn); },
    stats,
    retired,
    /** Is this session hers (her conversation, an IM-opened one, one that was hers): what compat asks before letting it see her tools. */
    hers: (id, cwd) => isDotSession(id, cwd) || retired(id),
    /** Her hands' session (hands.js): the device tools, nothing else of hers. */
    isHands: (id, cwd) => Boolean(hands?.isHands(id, cwd)),
    busy: (id) => turns.has(id),
    /** Add a part to the short message that goes with what has just reached her ({ name, order, text({ agent, messages }) → string | Promise }); returns its disposer. */
    turnNote,
    /** What her attention is on right now ({ writing, sending, hands, his, moving, waiting }), and whether none of it is. */
    state: () => herState(),
    quiet: () => quiet(),
    /** One open turn as the watchdog sees it (turnState + who and what), or null. */
    turn: (id) => turnInfo(id),
    /** Every open turn of hers. */
    turns: () => [...turns.keys()].map((id) => turnInfo(id)).filter(Boolean),
    /** Approvals waiting in her sessions. */
    approvals: () => [...approvals.values()].map((a) => ({ session: a.session, tool: a.tool, reason: a.reason, since: a.since, retired: retired(a.session), ...(a.timedOutAt ? { timedOutAt: a.timedOutAt } : {}) })),
    /** His messages waiting in the buffer; flushOwner() delivers them now. */
    ownerPending: () => ownerBatch.length,
    /** Her bubbles to him are going out right now. */
    sending: () => sendingCount > 0,
    flushOwner: () => flushOwner(),
    isIm: (id) => imSessions.has(id),
    /** The model-request gate's status (src/llm-gate.js): per provider, requests in the last minute, background cap, cooldown, waiting. */
    llmGate: () => llmGate?.status() ?? null,
    /** Hold deliveries to her conversation (a handoff is moving it); the returned function releases them to the new one. */
    freeze() {
      frozen++;
      let done = false;
      return () => {
        if (done) return; done = true;
        frozen = Math.max(0, frozen - 1);
        if (!frozen) { const waiting = frozenWaiters; frozenWaiters = []; for (const go of waiting) go(); }
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
