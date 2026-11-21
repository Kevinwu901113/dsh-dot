// What dot says in its own words to her and to him, and the small readings of a message it rests on: no state, no host.
// (Taken out of core.js as it was; core.js re-exports these names.)
import { PHONE_TOOL_PREFIX, PHONE_TYPE_TOOL } from '../tool-prefixes.js';
import { qqSpoken } from '../qq/qq.js';
import { typedText } from '../phone/phone.js';
import { fill, prompt, table } from '../prompts.js';
import { ago, describeNow, mondayOf, stamp } from '../clock.js';

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
  const base = r.status === 'stuck' ? prompt('dot.hands.status.stuck') : r.status === 'done' ? prompt(device === 'web' ? 'dot.hands.status.done.web' : 'dot.hands.status.done')
    : r.status === 'cut' ? prompt(/太久|too long/.test(why) ? 'dot.hands.status.timeout' : /^他/.test(why) ? 'dot.hands.status.stopped.his' : 'dot.hands.status.stopped')
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
/** What her phone showed that no one sent her (an app's own push): held, and shown with whatever reaches her next. */
export function pushesText(items) {
  const lines = groupNotifications(items).map((g) => `· ${appName(g.pkg)}${g.title ? ` · ${g.title}` : ''}：${g.texts.slice(-3).join(' / ') || '（无内容）'}`);
  return lines.length ? prompt('dot.pushes', { list: lines.join('\n') }) : '';
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
