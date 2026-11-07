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
// continuity snapshot (state.json), intents; slow change in who she is lives in dsh-dot/memory's self bank
// (intents.json). Not ported: long-term facts with retrieval, Alter (mood drift), Perspective,
// multi-participant stories, seen/delayed replies inside a conversation.
import { VM_TOOL_PREFIX, PHONE_TOOL_PREFIX, PHONE_ZOOM_TOOL, QQ_TOOL_PREFIX } from '../tool-prefixes.js';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { sectionOf, setValues } from '../settings.js';
import { prompt, table } from '../prompts.js';
import { describeNow, stamp } from '../clock.js';
import { createDoings, tokensOf } from './doings.js';
import { createGrowth, growthTool } from './growth.js';

export const name = 'dot-interlude';
export const inject = ['llm', 'agentDefaultModel'];

/** Social apps she might install, by site and by name — nothing is installed for her; only what is on her phone counts. */
export const KNOWN_APPS = {
  sites: { 'xiaoheihe.cn': 'com.max.xiaoheihe', 'bilibili.com': 'tv.danmaku.bili', 'weibo.com': 'com.sina.weibo', 'weibo.cn': 'com.sina.weibo', 'xiaohongshu.com': 'com.xingin.xhs', 'zhihu.com': 'com.zhihu.android', 'douyin.com': 'com.ss.android.ugc.aweme', 'coolapk.com': 'com.coolapk.market', 'tieba.baidu.com': 'com.baidu.tieba', 'douban.com': 'com.douban.frodo', 'qzone.qq.com': 'com.tencent.mobileqq' },
  labels: { 小黑盒: 'com.max.xiaoheihe', B站: 'tv.danmaku.bili', 微博: 'com.sina.weibo', 小红书: 'com.xingin.xhs', 知乎: 'com.zhihu.android', 抖音: 'com.ss.android.ugc.aweme', 酷安: 'com.coolapk.market', 贴吧: 'com.baidu.tieba', 豆瓣: 'com.douban.frodo', QQ空间: 'com.tencent.mobileqq' },
};

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
  // HDSI browsing (the character's browserIntent runs after the round). Two ways to look:
  //   web — dsh's `web` service: anonymous, read-only, cheap, invisible. Curiosity.
  //   vm  — a read-only turn in the character's own session using dsh-computer's VM browser: her
  //         logins, her tabs, visible in the live view. Nothing is approved in that turn: tools
  //         outside `vmObservationTools` are refused outright, so it can only look.
  // 'auto' = web first; vm when the host is in `vmSites`, or when the web result came back thin or
  // blocked. 'web' / 'vm' force one way; 'disabled' turns browsing off. ('deferred' = 'auto'.)
  browser: 'auto',
  browseDailyCap: 6,          // observations per day, both ways together
  vmSites: [],                // hosts (suffix match) observed only in the VM — the sites she is logged into
  vmDailyCap: 2,              // VM observations per day
  // Her phone (dsh-dot/phone): hosts whose app she opens instead of the website, as { host: package }.
  // e.g. { 'xiaoheihe.cn': 'com.max.xiaoheihe', 'bilibili.com': 'tv.danmaku.bili' }. Same rules as
  // vmSites: never read anonymously, read-only, no approvals; phone and VM share `vmDailyCap`.
  phoneApps: KNOWN_APPS.sites,
  phonePreferred: true,       // when both phone and VM could take a thin/blocked web result, the phone goes first
  vmTimeoutMinutes: 5,        // give up waiting for an observation turn after this long
  vmSession: '',              // session id to observe in; default: the character's most recent act
  phoneObservationTools: ['mobile_list_available_devices', 'mobile_get_screen_size', 'mobile_get_orientation', 'mobile_list_apps', 'mobile_launch_app', 'mobile_take_screenshot', 'mobile_list_elements_on_screen', 'mobile_click_on_screen_at_coordinates', 'mobile_swipe_on_screen', 'mobile_press_button'],
  vmObservationTools: ['browser_navigate', 'browser_go_back', 'browser_scroll', 'browser_screenshot', 'browser_vision_screen_capture', 'browser_get_markdown', 'browser_get_text', 'browser_get_clickable_elements', 'browser_read_links', 'browser_tab_list', 'browser_new_tab', 'browser_switch_tab', 'browser_close_tab'],
  webContextLimit: 4,         // observations later rounds see
  identityFile: '',           // optional extra Canon text file; not read unless set
  idleMinutes: 10,            // follow-up round this long after a conversation goes quiet
  advanceEveryMinutes: 90,    // independent life progression; 0 disables
  activeHours: '08:00-23:00', // outside this, no advance rounds and no proactive contact
  maxRoundsPerDay: 20,
  // DeepSeek's reasoning shares this budget with the reply; 1400 cut half the rounds off before the JSON closed.
  maxTokens: 16384,
  digestChars: 6000,
  scriptEntriesInPrompt: 2,   // recent script excerpts later acts see
  // 玩: social actions on her own accounts, on her phone — like, comment, follow, collect, post (DM/pay
  // never, by construction). Executed as an errand turn (approvals apply), gated like contact: active
  // hours, willingness, daily cap. The behaviour rules are Moltbook's agent-social rulebook
  // (heartbeat.md / rules.md), translated — not written here. Only in apps she installed herself
  // (playApps is narrowed to what is on her phone), and only these actions; drop 'post' to keep her
  // from posting anything new.
  play: true,
  playActions: ['like', 'comment', 'follow', 'collect', 'post'], // collect = save stickers she likes (qq_sticker_keep)
  maxPlaysPerDay: 0,          // 0 = no cap: how often she plays is her own habit (her self notes); a round yields at most one play, so ≤ maxRoundsPerDay
  postDailyCap: 1,            // new posts per day (a post is public and stays); 0 = none
  // 试: something she has not done before, on her phone or her computer — an open errand inside hard
  // limits (no money, no account changes, no strangers' DMs, approvals apply). What it cost and what
  // he said about it come back to her in `yourDoings`.
  tries: true,
  tryDailyCap: 3,
  // Yuan per million tokens ({ in, cached, out }) so she sees cost in money too; null = tokens only.
  price: null,
  // 自己的时间: a few times a day her errand self is woken with nothing to do but her own time — all her
  // tools, her own folder (<home>/her), no list of what to do. Limits live in the gates (approvals, QQ
  // refused, typing in social apps asks) and in the token budget, which ends the turn when it runs out.
  freeTimesPerDay: 2,         // 0 = off; needs dsh-dot (her errands)
  freeTokenCap: 150000,       // per free time; past 80% she is told to wrap up, at 100% the turn is stopped
  freeDailyTokens: 300000,    // all free time in a day
  // 成长: once a week she rewrites her own portrait ("她现在的样子", a system-prompt section after the
  // Canon), changing at most portraitMaxChange of it; every version kept in <home>/interlude/growth.
  growth: true,
  growthAt: 'Sun 21:00',
  portraitMaxChars: 900,
  portraitMaxChange: 0.35,
  playApps: KNOWN_APPS.labels, // app label → package she may act in; {} = none
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

/**
 * How she behaves on a social app — Moltbook's rulebook for agents living on a social network
 * (https://www.moltbook.com/heartbeat.md and /rules.md), translated and stripped of its API; the
 * priorities and the restraint are theirs. Used in the interlude prompt when `play` is on and in the
 * turn that carries a play intent out.
 */
export const playRules = () => prompt('interlude.play-rules');

/** Source of the message that opens an observation turn; such turns are never acts. */
export const OBSERVATION_SOURCE = Object.freeze({ kind: 'dsh-interlude', form: 'observation' });
/** Source of the message that carries a play intent out: a normal turn (she acts; approvals apply). */
export const PLAY_SOURCE = Object.freeze({ kind: 'dsh-interlude', form: 'play' });
/** Source of the message that carries a try out: something new she wanted to do (approvals apply). */
export const TRY_SOURCE = Object.freeze({ kind: 'dsh-interlude', form: 'try' });
/** Source of the message that opens her own time. */
export const FREE_SOURCE = Object.freeze({ kind: 'dsh-interlude', form: 'free' });
/** Phone apps where typing could post, comment or message someone: the social ones, QQ and WeChat. */
export const SOCIAL_PACKAGES = [...new Set([...Object.values(KNOWN_APPS.labels), 'com.tencent.mobileqq', 'com.tencent.mm'])];
/** A phone call that would type in the foreground app (as dsh-dot/phone's typesText). */
const typesText = (tool, input) => tool === 'mobile_type_keys' || (['mobile_press_button', 'mobile_batch_commands'].includes(tool) && /ENTER|type_keys/i.test(JSON.stringify(input ?? '')));

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
export function freePrompt({ budget, left, place, listing = [], tidy = [], context = {} }, now = Date.now()) {
  return prompt('interlude.free', {
    stamp: stamp(now, now), budget, left, place,
    listing: listing.length ? listing.map((l) => `- ${l}`).join('\n') : '（空的）',
    tidy: tidy.length ? `${prompt('interlude.free.tidy', { items: tidy.map((t) => `「${t}」`).join('、') })}\n` : '',
    context: JSON.stringify(context, null, 1),
  });
}

/** The message that asks her to go and try the new thing she wanted to. */
export function tryPrompt(x, now = Date.now()) {
  const on = table('interlude.try.on');
  return prompt('interlude.try', { stamp: stamp(now, now), on: on[x.on] ?? on.either ?? '', what: x.what, why: x.why ? `因为${x.why}。` : '', phonePrefix: PHONE_TOOL_PREFIX, vmPrefix: VM_TOOL_PREFIX });
}

/** The message that asks her to go and do the small thing she wanted to do on her phone. */
export function playPrompt(p, pkg, now = Date.now()) {
  const parts = table('interlude.play.parts', { text: p.text, why: p.why });
  const common = { stamp: stamp(now, now), app: p.app, pkg: pkg ? `（${pkg}）` : '', why: p.why ? parts.why : '', phonePrefix: PHONE_TOOL_PREFIX, rules: playRules() };
  if (p.action === 'collect') return prompt('interlude.play.collect', { ...common, target: p.target && p.target !== '表情包' ? `「${p.target}」` : '' });
  if (p.action === 'post') return prompt('interlude.play.post', { ...common, target: p.target ? `「${p.target}」` : '', text: p.text });
  const verbs = table('interlude.play.verbs');
  return prompt('interlude.play', { ...common, target: p.target, verb: Object.hasOwn(verbs, p.action) ? verbs[p.action] : p.action, said: p.text ? parts.said : '' });
}

/** Is `url` on one of the character's own sites (host suffix match: "x.com" covers "www.x.com")? */
export function onVmSite(url, sites = []) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch (error) { void error; return false; }
  return sites.some((s) => { const site = String(s).toLowerCase().replace(/^\*?\./, ''); return host === site || host.endsWith(`.${site}`); });
}

/** Why a web result looks thin or blocked (the sign a site wants a real browser), or '' when it reads fine. */
export function thinWhy(content) {
  const text = String(content ?? '').trim();
  if (text.length < 160) return 'too short';
  if (/enable javascript|just a moment|access denied|forbidden|too many requests|verify you are human|captcha|cloudflare|请开启 ?javascript|请完成验证|安全验证|访问受限|登录后查看|请先登录|sign in to continue|log in to see/i.test(text)) return 'blocked or login wall';
  return '';
}

/** The app package for `url`'s host in `apps` ({ host: package }, host suffix match), or ''. */
export function appFor(url, apps = {}) {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch (error) { void error; return ''; }
  for (const [site, pkg] of Object.entries(apps)) { const h = String(site).toLowerCase().replace(/^\*?\./, ''); if (host === h || host.endsWith(`.${h}`)) return String(pkg); }
  return '';
}

/** The message that asks the character to go and look herself — in her own browser (vm) or on her phone. */
export function observationPrompt(b, device = 'vm', app = '', now = Date.now()) {
  const w = table('interlude.observation.where', { app, what: b.purpose || b.query || b.url, url: b.url, query: b.query });
  const where = device === 'phone' ? (app ? w['phone-app'] : b.mode === 'visit' ? w['phone-visit'] : w['phone-search']) : (b.mode === 'visit' ? w['vm-visit'] : w['vm-search']);
  const tools = device === 'phone' ? prompt('interlude.observation.phone', { phonePrefix: PHONE_TOOL_PREFIX }) : prompt('interlude.observation.vm', { vmPrefix: VM_TOOL_PREFIX });
  return prompt('interlude.observation', { stamp: stamp(now, now), purpose: b.purpose ? `「${b.purpose}」` : '', where, tools });
}

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

export { describeNow };

/** Milliseconds until `spec`'s window ends ('HH:MM-HH:MM'), 0 outside it, Infinity for an empty spec. */
export function msLeftInHours(spec, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!m) return Infinity;
  if (!inHours(spec, date)) return 0;
  const end = new Date(date); end.setHours(+m[3], +m[4], 0, 0);
  if (end <= date) end.setDate(end.getDate() + 1);
  return end - date;
}

// ── The round's system prompt is one file, src/prompts/interlude.round.txt (overridable whole from
// <home>/prompts/). Its rules are HDS-Interlude's (1.0.1-rc57, src/narrator.ts and src/specialization.ts,
// AGPL-3.0 © MOMOR1A/MomoiCore), translated into Chinese and merged, in the order HDSI's "lite" tier
// assembles them, with this plugin's own lines (the observed ledger, her own life, the <contact/>
// marker, playing, the field list). What varies per round is a small file filled into a placeholder.

/** What the <contact/> marker becomes once the host knows whether her message went out ('handed': her conversation decides). */
export function fillContact(script, contact, said) {
  const text = String(contact?.text ?? '').replace(/<sep\s*\/>/gi, ' / ').trim();
  const sent = said && text ? (said === 'handed' ? `（想跟他说「${text}」，等聊天那边看合不合适再说）` : `「${text}」`) : '';
  const kept = text ? '（打了几个字，最后没发出去）' : '（想了想，没发）';
  const filled = String(script ?? '').replace(/<contact\s*\/>/gi, () => (sent || kept));
  return { script: filled, marked: filled !== String(script ?? '') };
}

/** HDSI's model-family detection (specialization.ts): the length block differs per family. */
export function lengthBlockFor(model = '') {
  const m = String(model).toLowerCase();
  if (/deepseek/.test(m)) return prompt('interlude.round.length.deepseek');
  if (/claude/.test(m)) return prompt('interlude.round.length.claude');
  if (/gemini/.test(m) && /flash|lite|mini/.test(m)) return prompt('interlude.round.length.gemini-flash');
  if (/gpt|o\d/.test(m)) return prompt('interlude.round.length.gpt');
  return prompt('interlude.round.length');
}

const PHASES = { 'follow-up': 'interlude.round.phase.follow-up', intent: 'interlude.round.phase.intent', advance: 'interlude.round.phase.advance' };

/** The round's prompt: interlude.round.txt with this round's variants filled in. `entries` are recentScript items with owner labels. */
export function buildPrompt({ phase, identity, state, script, digest, cursor, now, intent, speak, model = '', style = '', entries = [], lastHalfHour = [], browser = 'disabled', webContext = [], play = false, playApps = [], playActions = [], stickers = -1, memories = [], herLife = [], returned = [], doings = null, trying = false }) {
  const playing = Boolean(play && playApps.length);
  const system = prompt('interlude.round', {
    canon: identity ? prompt('interlude.round.canon', { identity: identity.trim() }) : '',
    length: lengthBlockFor(model),
    phase: prompt(PHASES[phase] ?? PHASES.advance), // seed writes like an advance round
    herLife: herLife.length ? prompt('interlude.round.her-life') : '',
    returned: returned.length ? prompt('interlude.round.returned') : '',
    contactRule: speak ? prompt('interlude.round.contact-rule') : prompt('interlude.round.contact-rule.off'),
    browsing: browser === 'disabled' ? prompt('interlude.round.browsing.disabled') : prompt('interlude.round.browsing.deferred'),
    agency: speak && phase !== 'follow-up' ? prompt('interlude.round.agency') : '',
    play: playing ? prompt('interlude.round.play', { playRules: playRules(), playApps: playApps.join('、'), collect: playActions.includes('collect') && stickers >= 0 && stickers < 5 ? prompt('interlude.round.play.collect', { stickers }) : '' }) : '',
    free: prompt('interlude.round.free'),
    doings: doings ? prompt('interlude.round.doings') : '',
    glm: /glm/i.test(String(model)) ? prompt('interlude.round.glm') : '',
    style: style?.trim() || prompt('interlude.round.style.none'),
    // The field list travels as the arguments of one `interval` tool call, so the provider guarantees
    // their shape; a reply that is prose only is still accepted (the host fills the rest afterwards).
    seed: phase === 'seed' ? prompt('interlude.round.seed') : '',
    playIntents: playing ? prompt('interlude.round.play-intents', { playApps: playApps.join('/'), playActions: playActions.join('|') }) : prompt('interlude.round.play-intents.off'),
    tries: trying ? prompt('interlude.round.tries') : prompt('interlude.round.tries.off'),
    contact: speak ? prompt('interlude.round.contact') : prompt('interlude.round.contact.off'),
  });
  const payload = {
    interval: { from: cursor ? describeNow(new Date(cursor)) : null, nowLocal: describeNow(now) },
    continuitySnapshot: state ?? null,
    recentScript: [
      // readScript() lines are "<header>：<body>"; the header is a time stamp, not prose.
      ...(script ? String(script).split('\n').filter(Boolean).map((line) => { const i = line.indexOf('：'); return i > 0 ? { owner: 'narrator', at: line.slice(0, i).replace(/ · \w[\w-]*$/, ''), content: line.slice(i + 1) } : { owner: 'narrator', content: line }; }) : []),
      ...entries,
    ],
    // What she really did in the last half hour, already woven into earlier rounds: where she is now follows from it.
    lastHalfHour,
    dueIntents: intent ? [{ kind: intent.kind, text: intent.text, at: describeNow(new Date(intent.at)) }] : [],
    webContext,
    // What she knows to be true (dsh-dot/memory): established past, like recentScript.
    memories,
    // Her own notes (dsh-dot/memory's self bank): what she does these days and what she has learned.
    herLife,
    // What she handed to her errands earlier, now back: what she wanted, what she was busy with, when it happened (or not).
    returned,
    // What she did on her own lately, what each cost, and what he said about it (doings.js).
    ...(doings ? { yourDoings: doings } : {}),
    currentEvent: { type: 'none' },
    output: 'one `interval` tool call: script, continuity, intents, browserIntents, playIntents, tries, reflect, contact',
  };
  void digest;
  return { system, user: JSON.stringify(payload, null, 1), tools: [intervalTool({ play: playing, playApps, playActions, speak, trying })] };
}

/** The round's fields as a tool: the provider validates the arguments, so a call is always JSON. */
export function intervalTool({ play = false, playApps = [], playActions = [], speak = false, trying = false } = {}) {
  const str = { type: 'string' };
  const strs = { type: 'array', items: str };
  const willingness = { type: 'number', minimum: 0, maximum: 1 };
  return {
    name: 'interval',
    description: 'Write this interval of her life: the passage (script) and the fields the host keeps. Call it exactly once per round.',
    parameters: {
      type: 'object',
      properties: {
        script: { ...str, description: 'The passage for this interval, Chinese prose, third person.' },
        continuity: { type: 'object', properties: { current: str, recent: strs, salient: strs }, required: ['current', 'recent', 'salient'] },
        intents: { type: 'array', items: { type: 'object', properties: { at: { ...str, description: 'ISO-8601, strictly after now' }, kind: { type: 'string', enum: ['reminder', 'reply', 'contact'] }, text: str, willingness }, required: ['at', 'kind', 'text'] } },
        browserIntents: { type: 'array', items: { type: 'object', properties: { mode: { type: 'string', enum: ['search', 'visit'] }, query: str, url: str, purpose: str }, required: ['mode'] } },
        playIntents: play
          ? { type: 'array', maxItems: 1, items: { type: 'object', properties: { app: { type: 'string', enum: playApps }, action: { type: 'string', enum: playActions }, target: str, text: str, why: str, willingness }, required: ['app', 'action', 'target'] } }
          : { type: 'array', maxItems: 0, items: {} },
        tries: trying
          ? { type: 'array', maxItems: 1, items: { type: 'object', properties: { what: str, on: { type: 'string', enum: ['phone', 'computer', 'either'] }, why: str, willingness }, required: ['what'] } }
          : { type: 'array', maxItems: 0, items: {} },
        reflect: { type: 'array', maxItems: 2, items: { type: 'object', properties: { id: str, text: str }, required: ['text'] } },
        contact: speak
          ? { anyOf: [{ type: 'null' }, { type: 'object', properties: { content: str, willingness, reason: str }, required: ['content'] }] }
          : { type: 'null' },
      },
      required: ['script', 'continuity', 'intents', 'browserIntents', 'playIntents', 'contact'],
    },
  };
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
      const ctext = o.contact && typeof o.contact === 'object' ? str(o.contact.content ?? o.contact.text) : '';
      const contact = ctext ? { text: ctext, willingness: num(o.contact.willingness, 0), reason: str(o.contact.reason) } : null;
      const cont = o.continuity ?? o.state ?? {};
      return {
        script: str(o.script),
        // HDSI continuity snapshot: current / recent / salient (older replies' mood/now/next/threads are folded in).
        state: {
          current: str(cont.current ?? cont.now ?? cont.mood),
          recent: [].concat(cont.recent ?? cont.next ?? []).map(str).filter(Boolean).slice(0, 5),
          salient: [].concat(cont.salient ?? cont.threads ?? []).map(str).filter(Boolean).slice(0, 5),
        },
        intents, contact,
        browserIntents: [].concat(o.browserIntents ?? []).map((b) => ({
          mode: b?.mode === 'visit' ? 'visit' : 'search', query: str(b?.query), url: str(b?.url), purpose: str(b?.purpose),
        })).filter((b) => (b.mode === 'visit' ? /^https?:\/\//.test(b.url) : b.query)).slice(0, 1),
        playIntents: [].concat(o.playIntents ?? []).map((p) => ({
          app: str(p?.app), action: str(p?.action).toLowerCase(), target: str(p?.target), text: str(p?.text), why: str(p?.why),
          willingness: Math.max(0, Math.min(1, Number(p?.willingness ?? 0) || 0)),
        })).filter((p) => p.app && p.action && (p.target || p.action === 'post')).slice(0, 1),
        tries: [].concat(o.tries ?? []).map((x) => ({
          what: str(x?.what), on: ['phone', 'computer'].includes(x?.on) ? x.on : 'either', why: str(x?.why), willingness: num(x?.willingness, 0),
        })).filter((x) => x.what).slice(0, 1),
        reflect: [].concat(o.reflect ?? []).map((x) => ({ id: str(x?.id), text: str(x?.text) })).filter((x) => x.text).slice(0, 2),
      };
    } catch (error) { void error; }
  }
  // A reply cut off by the token limit is not JSON any more; keep at least the script.
  const m = /"script"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (m) {
    try { return { script: JSON.parse(`"${m[1]}"`), state: null, intents: [], contact: null, truncated: true }; } catch (error) { void error; }
  }
  return null;
}

/** Render the context later acts see: HDSI's continuity fields as data, no added prose. */
export function renderContext({ state, entries, intents, cursor, restarted, now = Date.now() }) {
  if (!state && !entries.length) return '';
  const upcoming = intents.filter((i) => Date.parse(i.at) <= now + 24 * 3600000).map((i) => ({ at: describeNow(new Date(i.at)), kind: i.kind, text: i.text }));
  const payload = {
    continuitySnapshot: state ? { current: state.current ?? state.now ?? state.mood ?? '', recent: state.recent ?? (state.next ? [state.next] : []), salient: state.salient ?? state.threads ?? [] } : null,
    continuitySnapshotAgeMinutes: cursor ? Math.round((now - cursor) / 60000) : null,
    hostRestartedSinceSnapshot: Boolean(restarted),
    recentScript: entries.map((content) => ({ owner: 'narrator', content })),
    upcomingPlans: upcoming,
  };
  return clip(`<interlude>\n${JSON.stringify(payload, null, 1)}\n</interlude>`, 2400);
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
  return { text, args, usage };
}

/** Collect the model reply text from an llm stream. */
export async function collectText(stream) { return (await collectReply(stream)).text; }

/** Token usage of one call, as the ledger records it (dsh-llm's TokenUsage, or null when the provider gave none). */
export const usageOf = (u) => (u ? { in: Number(u.inputTokens ?? 0), out: Number(u.outputTokens ?? 0), cached: Number(u.cacheReadTokens ?? 0) } : null);

/** Which device a tool call uses: 'phone', 'vm' (her computer), or '' for neither. */
export const deviceOf = (name = '') => (name.startsWith(PHONE_TOOL_PREFIX) ? 'phone' : name.startsWith(VM_TOOL_PREFIX) ? 'vm' : '');

/** Names in the Canon's supporting cast, parsed conservatively: 「名叫X」「叫做X」, a segment opening with 「X：」, or a bare list of names. */
export function castNames(canon) {
  const cast = String(canon?.storyDefaults?.supportingCast ?? '').trim();
  const name = '[\\u4e00-\\u9fff]{2,4}';
  if (new RegExp(`^${name}([、，,\\s]+${name})*$`).test(cast)) return cast.split(/[、，,\s]+/);
  return [...new Set([...cast.matchAll(new RegExp(`(?:名叫|叫做|名字是)(${name})|(?:^|[\\n；;。])\\s*(${name})\\s*[：:]`, 'g'))].map((m) => m[1] || m[2]))];
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
  const logger = ctx.logger('dsh-interlude');
  const cfg = { ...defaults, ...setValues(config), ...sectionOf('interlude', (m) => logger.warn(m)) };
  if (cfg.enabled === false) { logger.info('off (dsh-dot.json: interlude.enabled = false)'); return; }
  const home = cfg.home || join(homedir(), 'dot');
  const dir = join(home, 'interlude');
  const files = {
    script: join(dir, 'script.md'), state: join(dir, 'state.json'),
    intents: join(dir, 'intents.json'), pending: join(dir, 'pending.jsonl'), calls: join(dir, 'calls.jsonl'), meta: join(dir, 'meta.json'),
    canon: join(dir, 'canon.json'), web: join(dir, 'web-context.jsonl'), doings: join(dir, 'doings.json'),
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
  const doings = createDoings(files.doings);
  // Outside her own folder: only the weekly review changes her portrait (she could rewrite a file in <home>/her).
  const growth = cfg.growth ? createGrowth({ dir: join(dir, 'growth'), at: cfg.growthAt, maxChars: cfg.portraitMaxChars, maxChange: cfg.portraitMaxChange }) : null;
  const portraitSection = () => { const p = growth?.portrait(); return p ? prompt('interlude.growth.section', { portrait: p }) : ''; };
  const herPlace = join(home, 'her');
  mkdirSync(herPlace, { recursive: true });
  // Today's rounds (writing her life) as a cost record: dayTokensIn counts the cached reads too.
  const roundCost = () => ({ in: Math.max(0, (meta.dayTokensIn ?? 0) - (meta.dayTokensCached ?? 0)), cached: meta.dayTokensCached ?? 0, out: meta.dayTokensOut ?? 0 });

  let state = readJson(files.state, null);
  let intents = readJson(files.intents, []);
  const meta = { cursor: 0, count: 0, day: dayOf(), dayRounds: 0, dayContacts: 0, dayBrowses: 0, dayVm: 0, dayPlays: 0, dayPosts: 0, dayTries: 0, lastAdvance: 0, ...readJson(files.meta, {}) };
  if (!meta.lastAdvance) meta.lastAdvance = startedAt; // the first life round comes one interval after boot
  const rollDay = () => { if (meta.day !== dayOf()) { meta.day = dayOf(); meta.dayRounds = 0; meta.dayContacts = 0; meta.dayBrowses = 0; meta.dayVm = 0; meta.dayPlays = 0; meta.dayPosts = 0; meta.dayTries = 0; meta.dayTokensIn = 0; meta.dayTokensCached = 0; meta.dayTokensOut = 0; meta.dayFreeTokens = 0; meta.dayFrees = 0; } };
  const saveMeta = () => { try { writeFileSync(files.meta, JSON.stringify(meta, null, 2)); } catch (error) { void error; } };
  const saveIntents = () => { try { writeFileSync(files.intents, JSON.stringify(intents, null, 2)); } catch (error) { void error; } };

  // 1. 幕前: watch the acts in <home>.
  const turns = new Map();
  const homeSessions = new Set(); // sessions that are acts: cwd inside home, or opened from an IM bot
  const wantHome = cfg.scope === 'all' || String(cfg.scope).includes('home');
  const wantIm = cfg.scope === 'all' || String(cfg.scope).includes('im');
  let lastActivity = 0;
  let running = 0;
  let lastActSession = meta.lastSession || ''; // the character's most recent act: where observations happen (remembered across restarts)
  const observing = new Map(); // session id → resolve(assistant text) while an observation turn runs
  const looked = new Map(); // session id → the device ('phone' | 'vm') an observation turn really used
  // With dsh-dot, plays and device looks are tasks its errands take when free; what comes back
  // (and how long it waited, behind what) is plot for the next round.
  const dshDot = () => ctx.get('dshDot');
  const at = (ms) => (ms ? describeNow(new Date(ms)) : null);
  const remember = (kind, wanted, r, doing = '') => {
    if (doing) doings.settle(doing, { status: r.status, result: r.report, usage: r.cost, doneAt: r.doneAt });
    const tokens = r.cost ? tokensOf(r.cost) : undefined;
    meta.returned = [...(meta.returned ?? []), { kind, wanted, status: r.status, queuedAt: at(r.queuedAt), busyWith: r.busyWith || '', startedAt: at(r.startedAt), doneAt: at(r.doneAt), report: clip(String(r.report ?? ''), 400), ...(doing ? { id: doing } : {}), ...(tokens !== undefined ? { tokens } : {}) }].slice(-5);
    saveMeta();
    audit('task-returned', { kind, status: r.status });
  };
  const errandSession = async () => { try { return (await ctx.get('dshDot')?.errand?.()) || ''; } catch (error) { void error; return ''; } };
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
        if (event.data?.source?.kind === OBSERVATION_SOURCE.kind && event.data?.source?.form === 'observation') t.origin = 'observation';
        if (event.data?.source?.kind === PLAY_SOURCE.kind && event.data?.source?.form === 'play') { t.origin = 'play'; t.user ||= contentText(event.data?.content).split('\n')[0]; }
        if (event.data?.source?.kind === TRY_SOURCE.kind && event.data?.source?.form === 'try') { t.origin = 'try'; t.user ||= contentText(event.data?.content).split('\n')[0]; }
        if (event.data?.source?.kind === FREE_SOURCE.kind && event.data?.source?.form === 'free') { t.origin = 'free'; t.user ||= '（她自己的时间）'; }
        if (event.data?.source?.kind === 'dsh-dot' && event.data?.source?.form === 'phone-notification') { t.origin = 'notification'; t.user ||= contentText(event.data?.content).split('\n')[0]; }
        if (event.data?.source?.kind === 'dsh-dot' && event.data?.source?.form === 'phone-check') { t.origin = 'phone-check'; t.user ||= '（拿起手机看了一眼）'; }
        if (['user', 'schedule'].includes(event.data?.source?.kind)) t.user ||= contentText(event.data?.content);
        return;
      case 'assistant/message': { if (!t || event.data?.interrupted) return; const text = contentText(event.data?.message?.content); if (text.trim()) t.assistant = text; return; }
      case 'tool/call': if (t) { t.tools++; t.on = deviceOf(event.data?.name) || t.on; } return;
      case 'approval/asked': if (t) t.approvals++; return;
      case 'turn/end': {
        running = Math.max(0, running - 1);
        if (!t) return;
        turns.delete(id);
        // An observation turn is the character looking, not an act: hand the text back, keep it out of the script.
        if (t.origin === 'observation') { observing.get(id)?.(t.assistant); return; }
        if (t.origin === 'try' && !dshDot()?.task) trying.delete(id);
        lastActivity = Date.now();
        // Her errand session (dsh-dot) is not where she lives: it never becomes the act session.
        if (lastActSession !== id && !ctx.get('dshDot')?.isErrand?.(id)) { lastActSession = id; meta.lastSession = id; saveMeta(); }
        const quiet = ['schedule', 'phone-check', 'notification', 'play', 'try'].includes(t.origin) && /^[`*\s]*DOT_SILENT[`*\s。.]*$/.test(t.assistant);
        const line = JSON.stringify({ ts: new Date().toISOString(), session: id, origin: t.origin, user: clip(t.user, 400), assistant: clip(t.assistant, 600), tools: t.tools, approvals: t.approvals, quiet, on: t.on || undefined });
        try { appendFileSync(files.pending, `${line}\n`); } catch (error) { logger.warn(`pending write failed: ${error.message}`); }
        return;
      }
      default:
    }
  });

  // Web observations (HDSI webContext), bounded; the newest cfg.webContextLimit are shown.
  const readWebContext = () => {
    let lines = [];
    try { lines = readFileSync(files.web, 'utf8').split('\n').filter(Boolean); } catch (error) { void error; }
    return lines.slice(-cfg.webContextLimit).map((l) => { try { return JSON.parse(l); } catch (error) { void error; return null; } }).filter(Boolean);
  };
  const browserMode = () => (cfg.browser === 'deferred' ? 'auto' : cfg.browser);
  const webOpen = () => ['auto', 'web'].includes(browserMode()) && Boolean(ctx.get('web'));
  // "Go and look yourself" needs a session to wake and a device: the VM (dsh-computer) or the phone
  // (dsh-dot/phone, when it is ready). Both count against vmDailyCap.
  const selfOpen = () => { rollDay(); return ['auto', 'vm'].includes(browserMode()) && Boolean(ctx.get('sessionController')) && meta.dayVm < cfg.vmDailyCap; };
  const phoneReady = () => Boolean(ctx.get('dshPhone')?.isReady);
  const vmOpen = () => selfOpen() && (Boolean(ctx.get('dshComputer')) || phoneReady());
  const deviceFor = (b) => {
    const app = b.mode === 'visit' ? appFor(b.url, cfg.phoneApps) : '';
    if (app && phoneReady()) return { device: 'phone', app };
    if (b.mode === 'visit' && onVmSite(b.url, cfg.vmSites) && ctx.get('dshComputer')) return { device: 'vm', app: '' };
    if (cfg.phonePreferred && phoneReady()) return { device: 'phone', app: '' };
    if (ctx.get('dshComputer')) return { device: 'vm', app: '' };
    return phoneReady() ? { device: 'phone', app: '' } : null;
  };
  const browsingOpen = () => { rollDay(); return browserMode() !== 'disabled' && (webOpen() || vmOpen()) && meta.dayBrowses < cfg.browseDailyCap; };
  const record = (phase, observed) => {
    appendFileSync(files.web, `${JSON.stringify({ at: describeNow(new Date()), ...observed })}\n`);
    meta.dayBrowses++; if (observed.via !== 'web') meta.dayVm++;
    saveMeta();
    audit('browse', { phase, via: observed.via, mode: observed.mode, query: observed.query || observed.url, thin: Boolean(observed.thin) });
  };
  /** Which way this intent is observed: 'vm' for the sites she is logged into, else web first (auto). */
  const routeOf = (b) => {
    const mode = browserMode();
    if (mode === 'web' || mode === 'vm') return mode;
    return b.mode === 'visit' && (onVmSite(b.url, cfg.vmSites) || appFor(b.url, cfg.phoneApps)) ? 'vm' : 'web';
  };
  async function browse(b, phase) {
    if (!browsingOpen()) { audit('browse-held', { phase, why: browserMode() === 'disabled' ? 'disabled' : meta.dayBrowses >= cfg.browseDailyCap ? 'daily cap' : 'no web service and no VM' }); return false; }
    let route = routeOf(b);
    if (route === 'web' && !webOpen()) route = vmOpen() ? 'vm' : route;
    if (route === 'vm' && !vmOpen()) {
      // Her sites are never read anonymously: if the VM is not available today, this intent waits.
      audit('browse-held', { phase, why: ctx.get('dshComputer') || phoneReady() ? 'vm daily cap' : 'no VM and no phone', route: 'vm', query: b.query || b.url });
      return false;
    }
    let lookId = '';
    try {
      if (route === 'web') {
        const observed = await observeOnWeb(b);
        // A thin or blocked page is the usual sign that the site wants a real browser (or a login):
        // in auto mode the character goes to look herself, once, if the VM has room today.
        if (observed.thin && browserMode() === 'auto' && vmOpen()) {
          audit('browse-upgrade', { phase, why: observed.thin, query: b.query || b.url });
          route = 'vm';
        } else { record(phase, observed); settleLook(doings.add({ kind: 'look', device: 'web', what: b.purpose || b.query || b.url }), observed); return true; }
      }
      const target = deviceFor(b);
      if (!target) { audit('browse-held', { phase, why: 'no device', route: 'vm' }); return false; }
      if (dshDot()?.task) return lookLater(b, target, phase);
      lookId = doings.add({ kind: 'look', device: target.device, what: b.purpose || b.query || b.url });
      const observed = await observeInVm(b, target);
      if (!observed) { doings.settle(lookId, { status: 'dropped' }); return false; }
      record(phase, observed);
      settleLook(lookId, observed);
      return true;
    } catch (error) {
      if (lookId) doings.settle(lookId, { status: 'dropped', result: error.message }); logger.warn(`browse failed: ${error.message}`); audit('browse-failed', { phase, route, error: clip(error.message, 200) }); return false; }
  }
  function settleLook(id, observed) {
    const got = observed.sources?.length ? observed.sources.map((x) => x.title).filter(Boolean).slice(0, 3).join('；') : observed.content;
    doings.settle(id, { status: observed.thin ? 'thin' : 'done', result: got });
  }
  async function observeOnWeb(b) {
    const web = ctx.get('web');
    if (b.mode === 'visit') {
      const r = await web.fetch({ url: b.url });
      const content = String(r?.content ?? r?.text ?? '');
      return { via: 'web', mode: 'visit', url: b.url, purpose: b.purpose, content: clip(content, 1200), thin: thinWhy(content) };
    }
    const r = await web.search({ query: b.query, maxResults: 5 });
    const sources = (r?.sources ?? []).slice(0, 5).map((x) => ({ title: x.title, url: x.url, snippet: clip(String(x.snippet ?? ''), 200) }));
    const content = String(r?.content ?? '');
    return { via: 'web', mode: 'search', query: b.query, purpose: b.purpose, content: clip(content, 600), sources, thin: sources.length || content.trim() ? thinWhy(content + sources.map((s) => s.snippet).join(' ')) : 'no results' };
  }
  /**
   * The character looks herself: one read-only turn in her own session, through the VM browser
   * (dsh-computer). No approvals happen in that turn — `tools/pre-execute` below refuses anything
   * outside cfg.vmObservationTools — so the worst she can do is look at a page she is logged into.
   * The turn's final reply is the observation; the turn is not an act and leaves no script entry.
   */
  async function observeInVm(b, { device = 'vm', app = '' } = {}) {
    // Looking and playing run in her errand session when dsh-dot has one: never in the middle of a conversation.
    const sessionId = cfg.vmSession || (await errandSession()) || lastActSession;
    if (!sessionId) { audit('browse-held', { why: 'no session to observe in yet', route: 'vm' }); return null; }
    if (observing.has(sessionId)) { audit('browse-held', { why: 'observation already running', route: 'vm' }); return null; }
    const controller = ctx.get('sessionController');
    const found = await controller.resolveAgent(sessionId);
    looked.delete(sessionId);
    if (!found || 'error' in found) throw new Error(`session ${sessionId}: ${found?.error?.message ?? 'not found'}`);
    const { agent } = found;
    try { if (ctx.get('goals')?.get(agent)?.phase === 'active') { audit('browse-held', { why: 'goal active', route: 'vm' }); return null; } } catch (error) { void error; }
    const text = await new Promise((resolve) => {
      const timer = setTimeout(() => { observing.delete(sessionId); resolve(null); }, cfg.vmTimeoutMinutes * 60000);
      timer.unref?.(); // a pending observation must not hold dsh open for minutes at shutdown
      observing.set(sessionId, (t) => { clearTimeout(timer); observing.delete(sessionId); resolve(t ?? ''); });
      agent.followup(createUserMessage({ content: [{ type: 'text', text: observationPrompt(b, device, app) }], source: OBSERVATION_SOURCE }));
    });
    try { await ctx.get('sessions')?.flush?.(agent.session); } catch (error) { void error; }
    if (text === null) { audit('browse-failed', { route: 'vm', error: 'timed out' }); return null; }
    // The device she really looked with (a refused phone call that ended on the computer is 'vm').
    const via = looked.get(sessionId) || device;
    return { via, app: (via === device && app) || undefined, mode: b.mode, url: b.url, query: b.query, purpose: b.purpose, content: clip(text.trim(), 1200), session: sessionId };
  }
  /** The same look as a dsh-dot task: the round goes on; the observation lands in webContext and `returned` when it is done. */
  function lookLater(b, { device, app }, phase) {
    let sid = '', doing = '';
    const release = () => { if (sid) observing.delete(sid); };
    const queued = dshDot().task({
      kind: 'look', key: `look|${device}|${b.url || b.query}`, text: observationPrompt(b, device, app), source: OBSERVATION_SOURCE, readOnly: true,
      onStart: (id) => { sid = id; looked.delete(id); observing.set(id, release); },
      onDone: (r) => {
        const via = looked.get(sid) || device;
        release();
        if (r.status === 'done' && r.report) record(phase, { via, app: (via === device && app) || undefined, mode: b.mode, url: b.url, query: b.query, purpose: b.purpose, content: clip(r.report, 1200), session: sid });
        remember('look', b.purpose || b.query || b.url, r, doing);
      },
    });
    if (queued !== 'refreshed') doing = doings.add({ kind: 'look', device, what: b.purpose || b.query || b.url });
    audit('browse-queued', { phase, device, query: b.query || b.url });
    return true;
  }
  // Observation turns: read-only, and nothing to approve. Registered ahead of dsh-computer's gate
  // so no `ask` is ever produced; everything the allowlist does not name is refused with a reason
  // the model can read, and it moves on.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = exec.agent?.session?.id;
    if (!sessionId || !observing.has(sessionId)) return next();
    const vmTool = exec.name.startsWith(VM_TOOL_PREFIX) ? exec.name.slice(VM_TOOL_PREFIX.length) : '';
    const phoneTool = exec.name.startsWith(PHONE_TOOL_PREFIX) ? exec.name.slice(PHONE_TOOL_PREFIX.length) : '';
    if ((vmTool && cfg.vmObservationTools.includes(vmTool)) || (phoneTool && cfg.phoneObservationTools.includes(phoneTool)) || exec.name === PHONE_ZOOM_TOOL) {
      if (deviceOf(exec.name)) looked.set(sessionId, deviceOf(exec.name));
      // Answering here skips the phone's own hook: take its lease (one session drives the phone at a time).
      const busy = phoneTool || exec.name === PHONE_ZOOM_TOOL ? await ctx.get('dshPhone')?.lease?.(sessionId, phoneTool || exec.name) : null;
      return busy ? { kind: 'deny', reason: busy } : { kind: 'allow' };
    }
    audit('observation-refused', { session: sessionId, tool: exec.name });
    return { kind: 'deny', reason: `dsh-interlude: this is an observation — looking only, nothing to approve. "${exec.name}" is not available here; look with ${cfg.vmObservationTools.slice(0, 2).join(', ')}, ${cfg.phoneObservationTools.slice(5, 7).join(', ')}… or write down what you saw.` };
  }, { prepend: true });

  // 2. 幕间: one round.
  function digest() {
    let lines = [];
    try { lines = readFileSync(files.pending, 'utf8').split('\n').filter(Boolean); } catch (error) { void error; }
    const items = lines.map((l) => { try { return JSON.parse(l); } catch (error) { void error; return null; } }).filter(Boolean);
    const text = items.map((i) => `[${i.ts.slice(5, 16).replace('T', ' ')}${i.origin === 'schedule' ? ' 定时任务' : ' 用户'}]${i.approvals ? `（有 ${i.approvals} 次审批）` : ''}\n用户/任务：${i.user || '（无）'}\n我：${i.assistant || '（无回复）'}`).join('\n\n');
    return { items, text: text.length > cfg.digestChars ? `…${text.slice(-cfg.digestChars)}` : text };
  }
  let busy = false, fails = 0, pausedUntil = 0;
  async function round(phase, intent = null) {
    if (busy) return { skipped: 'busy' };
    // After a failed round (model down, balance empty) the next one waits 5, 10, 20 … up to 60 minutes.
    if (Date.now() < pausedUntil) return { skipped: 'paused after failures' };
    rollDay();
    if (meta.dayRounds >= cfg.maxRoundsPerDay) return { skipped: 'daily cap' };
    const { items, text } = digest();
    if (phase === 'follow-up' && !items.some((i) => !i.quiet)) return { skipped: 'nothing happened' };
    if (phase === 'seed' && readScript(files.script, 1).length) return { skipped: 'script already has entries (seed only opens an empty script)' };
    busy = true;
    const now = Date.now();
    try {
      const identity = [canonText(), portraitSection()].filter(Boolean).join('\n\n');
      const sel = ctx.agentDefaultModel.currentSelection();
      // Acts become recentScript entries with HDSI ownership labels.
      const entries = items.flatMap((i) => [
        i.user ? { owner: i.origin === 'schedule' ? 'scheduled-task' : i.origin === 'notification' ? 'phone' : ['phone-check', 'play', 'try', 'free'].includes(i.origin) ? 'character' : 'user', at: i.ts.slice(5, 16).replace('T', ' '), content: i.user } : null,
        i.assistant ? { owner: 'character', ...(i.on ? { on: i.on } : {}), content: i.assistant } : null,
      ]).filter(Boolean);
      const back = meta.returned ?? [];
      const lastHalfHour = (meta.recentActs ?? []).filter((a) => Date.parse(a.ts) >= now - 30 * 60000);
      const mem = ctx.get('dotMemory');
      // She plays only in apps she has installed herself: playApps narrowed to what is on her phone.
      const onPhone = await (ctx.get('dshPhone')?.apps?.() ?? []);
      const playApps = Object.keys(cfg.playApps).filter((label) => onPhone.includes(cfg.playApps[label]));
      const view = doings.view({ rounds: roundCost(), apps: playApps, price: cfg.price });
      const { system, user, tools } = buildPrompt({
        phase, identity: clip(identity, 6000), state, script: readScript(files.script, cfg.scriptEntriesInPrompt).join('\n'),
        digest: text, cursor: meta.cursor, now, intent, speak: cfg.speak, model: sel.model, style: canon?.storyDefaults?.style ?? '', entries,
        lastHalfHour: lastHalfHour.map((a) => ({ at: a.ts.slice(5, 16).replace('T', ' '), on: a.on, did: a.did })),
        browser: browsingOpen() ? 'deferred' : 'disabled', webContext: readWebContext(),
        play: cfg.play && Boolean(ctx.get('dshPhone')?.isReady), playApps, playActions: cfg.playActions, stickers: ctx.get('dshQq')?.connected ? ctx.get('dshQq').stickerCount?.() ?? -1 : -1,
        memories: mem?.forInterlude?.() ?? [], herLife: mem?.herLife?.() ?? [], returned: back,
        doings: view, trying: tryOpen(),
      });
      const options = { provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}), system, tools, maxTokens: cfg.maxTokens,
        messages: [createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'dsh-interlude' } })] };
      const r1 = await collectReply(ctx.llm.stream(options));
      const spent = [usageOf(r1.usage)];
      // The `interval` tool call carries the fields; a bare JSON reply is accepted too.
      const reply = r1.args || r1.text;
      let parsed = parseReply(reply, now);
      const script = parsed?.script || r1.text.trim();
      if (!script) throw new Error('empty script');
      // Prose without the fields (the model wrote the passage as text, or was cut off): a second
      // call over the script just written fills every other field — HDSI's post-commit continuity
      // refresh, widened so nothing the round should have produced is lost.
      if (!parsed?.state) {
        const r2 = await collectReply(ctx.llm.stream({
          ...options, maxTokens: 2000,
          system: prompt('interlude.round.refresh'),
          messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify({ interval: { nowLocal: describeNow(now) }, previousContinuity: state ?? null, script }, null, 1) }], source: { kind: 'dsh-interlude' } })],
        })).catch((error) => { logger.warn(`continuity refresh failed: ${error.message}`); return { text: '', args: '', usage: null }; });
        spent.push(usageOf(r2.usage));
        const refresh = r2.args || r2.text;
        const p2 = parseReply(refresh.includes('"script"') ? refresh : `{"script":"x",${refresh.replace(/^[^{]*\{/, '')}`, now);
        try { appendFileSync(files.calls, `${JSON.stringify({ ts: new Date().toISOString(), phase: `${phase}:refresh`, usage: usageOf(r2.usage), reply: clip(refresh, 1500) })}\n`); } catch (error) { void error; }
        if (p2?.state) parsed = { ...p2, script, intents: p2.intents?.length ? p2.intents : parsed?.intents ?? [], contact: p2.contact ?? parsed?.contact ?? null };
        audit('continuity-refresh', { phase, recovered: Boolean(p2?.state) });
      }
      if (phase === 'seed') {
        // "[MM-DD HH:MM] ..." segments become dated entries; anything untagged keeps the current time.
        const segs = script.split(/\n(?=\[\d{1,2}-\d{1,2} \d{1,2}:\d{2}\])/).map((t) => t.trim()).filter(Boolean);
        const year = new Date(now).getFullYear();
        for (const seg of segs) {
          const m = /^\[(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})\]\s*/.exec(seg);
          const at = m ? new Date(year, +m[1] - 1, +m[2], +m[3], +m[4]) : new Date(now);
          appendFileSync(files.script, `## ${describeNow(at)} · seed\n${m ? seg.slice(m[0].length) : seg}\n\n`);
        }
      }
      // Her message to the user goes out (or not) before the passage is written down, so the
      // <contact/> marker becomes what really happened.
      let said = false;
      if (parsed?.contact) said = await contact(parsed.contact, phase);
      if (phase !== 'seed') {
        const filled = fillContact(script, parsed?.contact, said);
        const sentLine = said === true && !filled.marked ? `（主动联系：${parsed.contact.text.replace(/<sep\s*\/>/gi, ' / ')}）\n\n` : '';
        appendFileSync(files.script, `## ${describeNow(new Date(now))} · ${phase}\n${filled.script}\n\n${sentLine}`);
      }
      if (parsed?.truncated) logger.warn('interlude reply was cut off; kept the script only (raise maxTokens?)');
      if (parsed && parsed.state) {
        state = { ...parsed.state, updatedAt: new Date(now).toISOString() };
        writeFileSync(files.state, JSON.stringify(state, null, 2));
        if (intent) intents = intents.filter((i) => i.id !== intent.id);
        // An intent round settles the intent that woke it; it does not plant the next one, or the
        // character keeps waking herself all day. New intents come from follow-up and advance rounds.
        // People who live only in the Canon never wake her for something no real app can show.
        const fictional = castNames(canon).filter((n) => !mem?.knows?.(n));
        if (phase !== 'intent') for (const i of parsed.intents) {
          if (fictional.some((n) => i.text.includes(n))) { audit('intent-dropped', { why: 'fictional person', text: i.text }); continue; }
          intents.push({ id: `${now.toString(36)}-${intents.length}`, ...i, createdAt: new Date(now).toISOString() });
        }
        intents = intents.slice(-20);
        saveIntents();
      }
      try { appendFileSync(files.calls, `${JSON.stringify({ ts: new Date(now).toISOString(), phase, acts: items.length, model: `${sel.provider}/${sel.model}`, usage: spent[0], viaTool: Boolean(r1.args), reply: clip(reply, 2000) })}\n`); } catch (error) { void error; }
      writeFileSync(files.pending, '');
      meta.cursor = now; meta.count++; meta.dayRounds++;
      meta.returned = (meta.returned ?? []).filter((r) => !back.includes(r)); // digested; what came back meanwhile waits for the next round
      meta.recentActs = [...lastHalfHour, ...items.map((i) => ({ ts: i.ts, on: i.on, did: clip([i.user, i.assistant].filter(Boolean).join(' → '), 160) }))];
      // The ledger: tokens this round, added to today's count (/interlude shows it).
      for (const u of spent) if (u) { meta.dayTokensIn = (meta.dayTokensIn ?? 0) + u.in + u.cached; meta.dayTokensCached = (meta.dayTokensCached ?? 0) + u.cached; meta.dayTokensOut = (meta.dayTokensOut ?? 0) + u.out; }
      if (phase === 'advance') meta.lastAdvance = now;
      saveMeta();
      // HDSI deferred browsing: the character's browserIntent runs now through dsh's web service;
      // the observation is evidence for later rounds (webContext), never for this script.
      for (const b of parsed?.browserIntents ?? []) await browse(b, phase);
      for (const p of parsed?.playIntents ?? []) await playOut(p, phase);
      for (const x of parsed?.tries ?? []) await tryOut(x, phase);
      // Her own afterthoughts on things she did: kept beside his reactions.
      for (const r of parsed?.reflect ?? []) if (r.id && doings.feedback(r.id, r.text, 'her', { exact: true })) audit('reflected', { id: r.id });
      audit('round', { phase, acts: items.length, intents: intents.length, browsed: (parsed?.browserIntents ?? []).length, played: (parsed?.playIntents ?? []).length, tried: (parsed?.tries ?? []).length, contact: Boolean(parsed?.contact), said });
      logger.info(`interlude #${meta.count} (${phase}): ${items.length} act(s)${said ? ' + contact' : ''}`);
      fails = 0;
      return { ok: true, script, contact: parsed?.contact ?? null, said };
    } catch (error) {
      pausedUntil = Date.now() + Math.min(60, 5 * 2 ** fails++) * 60_000;
      logger.warn(`interlude ${phase} failed: ${error.message}`);
      audit('round-failed', { phase, error: clip(error.message, 200) });
      return { error: error.message };
    } finally { busy = false; }
  }

  // 玩: a play intent becomes one normal turn in her latest session (she acts on her phone; the
  // phone gate's approvals apply). Gated like contact; actions outside playActions are dropped.
  async function playOut(p, phase) {
    const held = (why) => { audit('play-held', { phase, why, app: p.app, action: p.action, target: p.target }); return false; };
    if (!cfg.play) return held('disabled');
    if (!cfg.playActions.includes(p.action)) return held(`action ${p.action} not allowed`);
    const pkg = cfg.playApps[p.app];
    if (!pkg) return held(`app ${p.app} not in playApps`);
    if (!inHours(cfg.activeHours)) return held('outside active hours');
    if (p.willingness < cfg.willingnessThreshold) return held('willingness');
    rollDay();
    if (cfg.maxPlaysPerDay > 0 && meta.dayPlays >= cfg.maxPlaysPerDay) return held('daily cap');
    if (p.action === 'post' && (meta.dayPosts ?? 0) >= cfg.postDailyCap) return held('post daily cap');
    if (p.action === 'post' && !p.text) return held('post without text');
    const phone = ctx.get('dshPhone');
    if (!phone?.isReady) return held('phone not ready');
    if (!(await phone.apps?.().catch(() => []) ?? []).includes(pkg)) return held(`${p.app} is not on her phone`);
    const counted = () => { meta.dayPlays++; if (p.action === 'post') meta.dayPosts = (meta.dayPosts ?? 0) + 1; saveMeta(); };
    const entry = { kind: 'play', app: p.app, action: p.action, what: [p.target, p.text].filter(Boolean).join('：'), why: p.why };
    if (dshDot()?.task) {
      let doing = '';
      // A post's key carries its text, so two different posts to one board are two tasks.
      const key = `play|${p.app}|${p.action}|${p.target}${p.action === 'post' ? `|${p.text}` : ''}`;
      const r = dshDot().task({ kind: 'play', key, text: playPrompt(p, pkg), source: PLAY_SOURCE, ttlMs: ttlInHours(), onDone: (res) => remember('play', `${p.app} ${p.action}：${p.target}`, res, doing) });
      if (r === 'refreshed') { audit('play-merged', { phase, app: p.app, action: p.action }); return false; } // the same one is already waiting
      doing = doings.add(entry);
      counted();
      audit('play-queued', { phase, app: p.app, action: p.action, target: p.target });
      return true;
    }
    // Looking and playing run in her errand session when dsh-dot has one: never in the middle of a conversation.
    const sessionId = cfg.vmSession || (await errandSession()) || lastActSession;
    const controller = ctx.get('sessionController');
    if (!sessionId || !controller) return held('no session');
    try {
      const found = await controller.resolveAgent(sessionId);
      if (!found || 'error' in found) return held(found?.error?.message ?? 'session not found');
      try { if (ctx.get('goals')?.get(found.agent)?.phase === 'active') return held('goal active'); } catch (error) { void error; }
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: playPrompt(p, pkg) }], source: PLAY_SOURCE }));
      counted(); doings.settle(doings.add(entry), { status: 'sent' });
      audit('play', { phase, app: p.app, action: p.action, target: p.target, why: p.why, session: sessionId });
      return true;
    } catch (error) { return held(error.message); }
  }
  /** A task queued now expires when her active hours end (or at dot's own TTL, whichever is first). */
  const ttlInHours = () => { const left = msLeftInHours(cfg.activeHours); return Number.isFinite(left) ? Math.max(60000, Math.min(left, dshDot()?.taskTtlMs ?? 1800000)) : undefined; };

  // 试: something new she wanted to do, on her phone or her computer — an errand turn with hard limits
  // in its prompt (interlude.try.txt) and the phone / computer gates' approvals on every act.
  const tryDevices = () => [phoneReady() ? 'phone' : '', ctx.get('dshComputer') ? 'computer' : ''].filter(Boolean);
  const tryOpen = () => {
    rollDay();
    if (!cfg.tries || !inHours(cfg.activeHours) || (meta.dayTries ?? 0) >= cfg.tryDailyCap) return false;
    // Only in an errand (or a session set aside for this): never in the middle of her conversation.
    if (!dshDot()?.task && !(cfg.vmSession && ctx.get('sessionController'))) return false;
    return tryDevices().length > 0;
  };
  // Sessions running a try right now: the tools that would speak for her elsewhere are refused there.
  const trying = new Set();
  async function tryOut(x, phase) {
    const held = (why) => { audit('try-held', { phase, why, what: x.what }); return false; };
    if (!tryOpen()) return held(!cfg.tries ? 'disabled' : (meta.dayTries ?? 0) >= cfg.tryDailyCap ? 'daily cap' : !inHours(cfg.activeHours) ? 'outside active hours' : 'no errand or no device');
    if (x.willingness < cfg.willingnessThreshold) return held('willingness');
    if (x.on !== 'either' && !tryDevices().includes(x.on)) return held(`no ${x.on}`);
    const entry = { kind: 'try', what: x.what, why: x.why, device: x.on };
    const started = () => { meta.dayTries = (meta.dayTries ?? 0) + 1; saveMeta(); audit('try', { phase, what: x.what, on: x.on, why: x.why }); };
    if (dshDot()?.task) {
      let doing = '', sid = '';
      const r = dshDot().task({
        kind: 'try', key: `try|${x.what}`, text: tryPrompt(x), source: TRY_SOURCE, ttlMs: ttlInHours(),
        onStart: (id) => { sid = id; trying.add(id); },
        onDone: (res) => { if (sid) trying.delete(sid); remember('try', x.what, res, doing); },
      });
      if (r === 'refreshed') { audit('try-merged', { phase, what: x.what }); return false; }
      doing = doings.add(entry); started();
      return true;
    }
    const controller = ctx.get('sessionController');
    try {
      const found = await controller.resolveAgent(cfg.vmSession);
      if (!found || 'error' in found) throw new Error(found?.error?.message ?? 'session not found');
      try { if (ctx.get('goals')?.get(found.agent)?.phase === 'active') return held('goal active'); } catch (error) { void error; }
      trying.add(cfg.vmSession);
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: tryPrompt(x) }], source: TRY_SOURCE }));
      doings.settle(doings.add(entry), { status: 'sent' }); started();
      return true;
    } catch (error) { return held(error.message); }
  }
  // A try is hers to do on her phone and computer, not a way to talk: sending on QQ (to him or
  // anyone) and the ledger tool are refused in that turn. Contact has its own gates (speak, caps).
  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = exec.agent?.session?.id;
    // The ledger takes his reactions in her conversation with him only: not an errand, not a chat with someone else.
    if (exec.name === 'doings' && sessionId && dshDot() && (dshDot().isErrand?.(sessionId) || (dshDot().session?.() && dshDot().session() !== sessionId))) {
      return { kind: 'deny', reason: prompt('interlude.doings-tool.elsewhere') };
    }
    if (!sessionId || !trying.has(sessionId)) return next();
    if (exec.name === 'qq_send' || exec.name.startsWith(QQ_TOOL_PREFIX) || exec.name === 'doings') {
      audit('try-refused', { session: sessionId, tool: exec.name });
      return { kind: 'deny', reason: prompt('interlude.try.refused', { tool: exec.name }) };
    }
    return next();
  });


  // 成长: the weekly review (growth.js). One call; a portrait that changed too much is asked for again once.
  let reviewing = false;
  async function reviewGrowth({ force = false } = {}) {
    if (!growth) return { skipped: 'growth off' };
    if (reviewing) return { skipped: 'busy' };
    reviewing = true;
    try {
      const mem = ctx.get('dotMemory');
      let diaryText = '';
      try { diaryText = readFileSync(join(home, 'memory', 'diary.md'), 'utf8'); } catch (error) { void error; }
      const input = growth.input({ canon: canonText(), herLife: mem?.herLife?.() ?? [], owner: mem?.forInterlude?.() ?? [], diaryText, doings: doings.view({ rounds: roundCost(), price: cfg.price, recent: 20 }) });
      if (!input.diaryThisWeek.length && !input.yourDoings.last7Days.length) { growth.skip('nothing this week'); audit('growth-skipped', { why: 'nothing this week' }); return { skipped: 'nothing this week' }; }
      const sel = ctx.agentDefaultModel.currentSelection();
      const system = prompt('interlude.growth.system', { name: canon?.storyDefaults?.characterName ?? 'dot', maxChars: cfg.portraitMaxChars, change: `${Math.round(cfg.portraitMaxChange * 100)}%` });
      const messages = [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(input, null, 1) }], source: { kind: 'dsh-interlude' } })];
      const call = async (msgs) => {
        const r = await collectReply(ctx.llm.stream({ provider: sel.provider, model: sel.model, ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}), system, tools: [growthTool()], maxTokens: cfg.maxTokens, messages: msgs }));
        const u = usageOf(r.usage);
        if (u) { meta.dayTokensIn = (meta.dayTokensIn ?? 0) + u.in + u.cached; meta.dayTokensCached = (meta.dayTokensCached ?? 0) + u.cached; meta.dayTokensOut = (meta.dayTokensOut ?? 0) + u.out; saveMeta(); }
        try { appendFileSync(files.calls, `${JSON.stringify({ ts: new Date().toISOString(), phase: 'growth', usage: u, reply: clip(r.args || r.text, 3000) })}\n`); } catch (error) { void error; }
        try { return JSON.parse(r.args || r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch (error) { void error; return null; }
      };
      let out = await call(messages);
      let kept = growth.keep(out ?? {}, { force });
      if (!kept.ok && ['changed too much', 'too long'].includes(kept.why)) {
        const again = kept.why === 'too long'
          ? prompt('interlude.growth.too-long', { length: kept.length, maxChars: cfg.portraitMaxChars })
          : prompt('interlude.growth.too-much', { ratio: `${Math.round(kept.ratio * 100)}%`, change: `${Math.round(cfg.portraitMaxChange * 100)}%` });
        out = await call([...messages, createUserMessage({ content: [{ type: 'text', text: again }], source: { kind: 'dsh-interlude' } })]);
        kept = growth.keep(out ?? {}, { force });
      }
      if (!kept.ok) { growth.skip(kept.why); audit('growth-refused', { why: kept.why, ratio: kept.ratio }); return { error: kept.why }; }
      audit('growth', { week: kept.week, ratio: Math.round(kept.ratio * 100) / 100, tidy: growth.tidy().length });
      logger.info(`growth ${kept.week}: portrait rewritten (${Math.round(kept.ratio * 100)}% changed)`);
      return { ok: true, week: kept.week, changes: String(out?.changes ?? '') };
    } catch (error) {
      // Model down: try again in an hour, not every minute.
      meta.growthFailedAt = Date.now(); saveMeta();
      logger.warn(`growth review failed: ${error.message}`); audit('growth-failed', { error: clip(error.message, 200) }); return { error: error.message };
    } finally { reviewing = false; }
  }

  // 自己的时间: a few times a day, at random moments in her active hours, her errand self gets time of her own.
  const free = new Map(); // session id → { cost, budget, warned, stopped }
  let freeQueued = false; // one free time at a time, from queued to done
  const freeLeft = () => Math.max(0, cfg.freeDailyTokens - (meta.dayFreeTokens ?? 0));
  const planFree = (now = Date.now()) => {
    const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(cfg.activeHours || '').trim());
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
    if (!dshDot()?.task) return held('needs her errands (dsh-dot)');
    if (free.size || freeQueued) return held('already running');
    if (freeLeft() < Math.min(cfg.freeTokenCap, 20000)) return held('daily budget used');
    const budget = Math.min(cfg.freeTokenCap, freeLeft());
    const mem = ctx.get('dotMemory');
    const context = {
      now: describeNow(new Date()),
      yourNotes: mem?.herLife?.() ?? [],
      yourDoings: doings.view({ rounds: roundCost(), price: cfg.price, recent: 10 }),
      lately: state?.current ?? null,
    };
    let doing = '', sid = '', f = null;
    const text = freePrompt({ budget, left: freeLeft(), place: herPlace, listing: listPlace(herPlace), tidy: growth?.tidy() ?? [], context });
    const r = dshDot().task({
      kind: 'free', key: `free|${dayOf()}|${meta.dayFrees ?? 0}`, text, source: FREE_SOURCE, ttlMs: ttlInHours(),
      onStart: (id) => { sid = id; f = { cost: 0, budget, warned: false, stopped: false }; free.set(id, f); },
      onDone: (res) => {
        freeQueued = false;
        if (sid && free.get(sid) === f) free.delete(sid);
        const status = f?.stopped ? 'stopped' : res.status;
        remember('free', '自己的时间', { ...res, status }, doing);
        audit('free-done', { status, tokens: res.cost ? tokensOf(res.cost) : 0 });
      },
    });
    if (r === 'refreshed') return held('already queued');
    freeQueued = true;
    doing = doings.add({ kind: 'free', what: '自己的时间' });
    meta.dayFrees = (meta.dayFrees ?? 0) + 1; saveMeta();
    growth?.clearTidy();
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
  // In her own time: no QQ (he is reached through tell_him), no ledger tool, and typing in a social app asks first.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = exec.agent?.session?.id;
    if (exec.name === 'tell_him') return sessionId && free.has(sessionId) ? next() : { kind: 'deny', reason: prompt('interlude.tell-him.elsewhere') };
    if (!sessionId || !free.has(sessionId)) return next();
    if (free.get(sessionId).stopped) return { kind: 'deny', reason: prompt('interlude.free.over') };
    if (exec.name === 'qq_send' || exec.name.startsWith(QQ_TOOL_PREFIX) || exec.name === 'doings') {
      audit('free-refused', { session: sessionId, tool: exec.name });
      return { kind: 'deny', reason: prompt('interlude.free.refused', { tool: exec.name }) };
    }
    const tool = exec.name.startsWith(PHONE_TOOL_PREFIX) ? exec.name.slice(PHONE_TOOL_PREFIX.length) : '';
    const input = exec.input ?? exec.args ?? exec.arguments;
    if (tool && typesText(tool, input)) {
      const phone = ctx.get('dshPhone');
      // The phone first (one session drives it at a time), then which app is in front.
      const busyPhone = await phone?.lease?.(sessionId, tool);
      if (busyPhone) return { kind: 'deny', reason: busyPhone };
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

  // Agency, simplified from HDSI: speak enabled, active hours, willingness, daily cap.
  async function contact(c, phase) {
    if (!cfg.speak) return false;
    if (!inHours(cfg.activeHours)) { audit('contact-held', { phase, why: 'outside active hours' }); return false; }
    if (c.willingness < cfg.willingnessThreshold) { audit('contact-held', { phase, why: 'willingness' }); return false; }
    if (meta.dayContacts >= cfg.maxContactsPerDay) { audit('contact-held', { phase, why: 'daily cap' }); return false; }
    // One voice: with dsh-dot her conversation says it (or not), in its own words.
    if (dshDot()?.say) {
      const handed = await dshDot().say(c.text.replace(/<sep\s*\/>/gi, '\n'));
      if (handed) { meta.dayContacts++; saveMeta(); }
      audit(handed ? 'contact-handed' : 'contact-held', { phase, ...(handed ? {} : { why: 'not handed over' }) });
      return handed ? 'handed' : false;
    }
    const q = ctx.get('dshQq');
    if (q?.connected && q.owner) {
      try {
        const r = await q.send('owner', c.text);
        if (r.sent) { meta.dayContacts++; saveMeta(); }
        return r.sent > 0;
      } catch (error) { logger.warn(`contact via qq failed: ${error.message}`); return false; }
    }
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
      if (ok) { meta.dayContacts++; saveMeta(); }
      return ok;
    } catch (error) { logger.warn(`contact failed: ${error.message}`); return false; }
  }

  // 3. Scheduling: follow-up after quiet, advance on an interval, intents when due.
  function tick() {
    if (busy || running > 0) return;
    const now = Date.now();
    rollDay();
    // The weekly review runs beside the rounds, never instead of them.
    if (growth && !reviewing && growth.due(now) && now - (meta.growthFailedAt ?? 0) >= 3600000) void reviewGrowth();
    if (cfg.freeTimesPerDay > 0 && dshDot()?.task) {
      if (meta.freeDay !== dayOf(new Date(now))) planFree(now);
      if ((meta.freeAt ?? []).length && meta.freeAt[0] <= now && inHours(cfg.activeHours) && (!lastActivity || now - lastActivity >= cfg.idleMinutes * 60000)) {
        meta.freeAt = meta.freeAt.slice(1); saveMeta();
        void freeTime('scheduled'); return;
      }
    }
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
    // Who she is now, in her own words (growth.js): right after the Canon; it changes once a week, so the cached prefix holds.
    scope.effect(() => scope.systemPrompt.section({
      name: 'interlude:growth',
      order: (scope.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') + 1 || 1) + 0.5,
      text: (c) => (inHome(c) ? portraitSection() : ''),
    }), 'dsh-interlude: growth section');
    // Drop dsh's own openers for the character's sessions so the Canon is the first thing the model
    // reads; other sessions are untouched. (A `complete` section cannot do this per session.)
    const keep = (name) => name === 'interlude:canon' || name === 'interlude:growth' || name === 'dot:rules' || name.startsWith('mcp:');
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
        return renderContext({ state, entries: readScript(files.script, cfg.scriptEntriesInPrompt), intents, cursor: meta.cursor, restarted: meta.cursor > 0 && meta.cursor < startedAt });
      },
    });
  });

  // 4b. Her own hands on the ledger: in her conversation, when he reacts to something she did on her own.
  const doingsLine = (d) => `#${d.id} ${new Date(d.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} ${d.kind} ${d.app ? `${d.app} ${d.action} ` : ''}${d.what} → ${d.status}${d.result ? `：${clip(d.result, 80)}` : ''}${d.cost ? ` · ${tokensOf(d.cost)} token` : ''}${(d.feedback ?? []).map((f) => ` ｜${f.from === 'owner' ? '他' : '我'}：${f.text}`).join('')}`;
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'doings',
      description: prompt('interlude.doings-tool'),
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'feedback'] }, about: { type: 'string' }, text: { type: 'string' }, from: { type: 'string', enum: ['owner', 'her'] } }, required: ['action'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.ok ? (v.list ?? `doings: ${v.note ?? 'ok'}`) : `doings error: ${v?.error}` }] },
      async execute(args) {
        if (args.action === 'list') return { ok: true, list: doings.all().slice(-10).map(doingsLine).join('\n') || '（还没有）' };
        const d = doings.feedback(args.about, args.text, args.from === 'her' ? 'her' : 'owner');
        if (!d) return { ok: false, error: args.text ? `没找到「${args.about ?? ''}」` : 'text is empty' };
        audit('feedback', { id: d.id, from: args.from === 'her' ? 'her' : 'owner' });
        return { ok: true, note: `记在 #${d.id}（${d.what}）` };
      },
    }), 'dsh-interlude: doings tool');
    scope.effect(() => scope.tools.register({
      name: 'tell_him',
      description: prompt('interlude.tell-him'),
      parameters: { type: 'object', properties: { text: { type: 'string' }, why: { type: 'string' } }, required: ['text'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.note ?? '' }] },
      async execute({ text, why = '' }) {
        const said = await contact({ text: String(text ?? ''), willingness: 1, reason: String(why) }, 'free');
        const id = doings.add({ kind: 'say', what: String(text ?? ''), why });
        doings.settle(id, { status: said ? 'handed' : 'kept' });
        return { ok: true, handed: Boolean(said), note: said ? '交给和他的对话了，说不说由那边的你决定。' : '记下了，这会儿不发（主动联系关着、今天次数到了或者不在活跃时间）。' };
      },
    }), 'dsh-interlude: tell_him tool');
  });

  // 5. /interlude
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'interlude',
      description: '幕间 status; "now" runs a follow-up round, "advance" a life round, "seed" opens an empty script with the last day of life, "preset <share code>" imports a Canon from the HDSI hub, "canon" shows it, "doings" lists what she did on her own and what it cost, "feedback [#id] <text>" tells her what you think of one (the latest without #id), "free" gives her own time now, "growth" shows her portrait and its history ("growth now" reviews this week, "growth <week>" shows one, "growth rollback <week>" goes back to it)',
      input: { hint: '[now | advance | seed | preset <code> | canon | doings | feedback [#id] <text> | free | growth [now | <week> | rollback <week>]]' },
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
        } else if (/^growth(\s|$)/.test(arg)) {
          const [, sub = '', week = ''] = arg.split(/\s+/);
          if (!growth) result = '\ngrowth is off (interlude.growth = false)';
          else if (sub === 'now') { const r = await reviewGrowth({ force: true }); result = r.ok ? `\nreviewed ${r.week}: ${r.changes}` : `\nnot reviewed: ${r.skipped ?? r.error}`; }
          else if (sub === 'rollback') result = growth.rollback(week) ? `\nportrait is ${week}'s again` : `\nno portrait for ${week || '(week?)'}`;
          else if (/^\d{4}-W\d{2}$/.test(sub)) { const h = growth.history().find((x) => x.week === sub); result = h ? `\n${sub}\n${h.portrait}\n\n这周变了什么：${h.changes}` : `\nno portrait for ${sub}`; }
          else result = `\n${growth.portrait() || '(no portrait yet: the first review writes one; /interlude growth now)'}\n\n${growth.history().map((h) => `${h.week}：${clip(h.changes.replace(/\s+/g, ' '), 120)}`).join('\n') || '(no history yet)'}`;
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
        } else if (arg === 'now' || arg === 'advance' || arg === 'seed') {
          const r = await round(arg === 'now' ? 'follow-up' : arg);
          result = r.ok ? `\nran: ${clip(r.script, 200)}${r.contact ? `\ncontact: ${r.contact.text} (${r.said ? 'sent' : 'held'})` : ''}` : `\nnot run: ${r.skipped ?? r.error}`;
        }
        const { items } = digest();
        rollDay();
        const lines = [
          `home: ${home} · scope: ${cfg.scope}`,
          `canon: ${canon ? `${canon.storyDefaults.characterName}${canon.source?.title ? ` ← ${canon.source.title} (@${canon.source.author}, ${canon.source.shareCode})` : ` (${canon.source?.kind ?? 'canon.json'})`}` : '(none) — /interlude preset <share code>'}`,
          `continuity: ${state?.current || state?.mood || '(none yet)'}`,
          `script: ${readScript(files.script, 10000).length} entries · intents: ${intents.length} · today ${meta.dayTokensIn ?? 0} in / ${meta.dayTokensOut ?? 0} out tokens`,
          `cursor: ${meta.cursor ? describeNow(new Date(meta.cursor)) : 'never'} · today ${meta.dayRounds}/${cfg.maxRoundsPerDay} rounds, ${meta.dayContacts}/${cfg.maxContactsPerDay} contacts`,
          `pending acts: ${items.length} · idle ${lastActivity ? Math.round((Date.now() - lastActivity) / 60000) : '-'} min (follow-up after ${cfg.idleMinutes}) · advance every ${cfg.advanceEveryMinutes} min in ${cfg.activeHours}`,
          `speak: ${cfg.speak ? 'on' : 'off'} · play: ${cfg.play ? `on (${Object.keys(cfg.playApps).join(', ') || 'no playApps'}; today ${meta.dayPlays}${cfg.maxPlaysPerDay > 0 ? `/${cfg.maxPlaysPerDay}` : ''}, posts ${meta.dayPosts ?? 0}/${cfg.postDailyCap})` : 'off'} · tries: ${cfg.tries ? `on (today ${meta.dayTries ?? 0}/${cfg.tryDailyCap})` : 'off'} · free time: ${cfg.freeTimesPerDay > 0 ? `${meta.dayFrees ?? 0}/${cfg.freeTimesPerDay} today, ${meta.dayFreeTokens ?? 0}/${cfg.freeDailyTokens} tokens, next ${(meta.freeAt ?? [])[0] ? describeNow(new Date(meta.freeAt[0])) : '-'}${dshDot()?.task ? '' : ' (needs dsh-dot)'}` : 'off'} · growth: ${growth ? (growth.lastWeek() || 'no review yet') : 'off'} · browser: ${browserMode()}${ctx.get('web') ? '' : ' (no web service)'}${ctx.get('dshComputer') ? '' : ' (no VM)'}${phoneReady() ? '' : ' (no phone)'} · today ${meta.dayBrowses}/${cfg.browseDailyCap} (self ${meta.dayVm}/${cfg.vmDailyCap}) · vmSites: ${cfg.vmSites.length ? cfg.vmSites.join(', ') : '(none)'} · phoneApps: ${Object.keys(cfg.phoneApps).length ? Object.keys(cfg.phoneApps).join(', ') : '(none)'} · observe in: ${cfg.vmSession || lastActSession || '(no act yet)'} · webContext: ${readWebContext().length}`,
        ];
        return { kind: 'success', text: lines.join('\n') + result };
      },
    }), 'dsh-interlude: /interlude command');
  });

  // For the panel (dsh-dot/dot): where her life stands, as data.
  ctx.provide?.('dshInterlude', {
    /** One line on who she is (for the QQ group scorer): name + the character profile. */
    who() { const sd = canon?.storyDefaults ?? {}; return `${sd.characterName ?? 'dot'}：${String(sd.characterProfile ?? '').replace(/\s+/g, ' ').slice(0, 240)}`; },
    status() {
      rollDay();
      const script = (() => { let t = ''; try { t = readFileSync(files.script, 'utf8'); } catch (error) { void error; } return t.split(/^## /m).filter((x) => x.trim()).slice(-2).map((x) => { const [head, ...body] = x.split('\n'); return { head: head.trim(), text: body.join('\n').trim() }; }); })();
      return {
        name: canon?.storyDefaults?.characterName ?? 'dot',
        state, cursor: meta.cursor, lastAdvance: meta.lastAdvance, rounds: meta.count,
        today: { rounds: meta.dayRounds, maxRounds: cfg.maxRoundsPerDay, contacts: meta.dayContacts, browses: meta.dayBrowses, plays: meta.dayPlays, tries: meta.dayTries ?? 0, tokensIn: meta.dayTokensIn ?? 0, tokensOut: meta.dayTokensOut ?? 0 },
        doings: doings.view({ rounds: roundCost(), price: cfg.price, recent: 5 }),
        free: { today: meta.dayFrees ?? 0, perDay: cfg.freeTimesPerDay, tokens: meta.dayFreeTokens ?? 0, dailyTokens: cfg.freeDailyTokens, next: (meta.freeAt ?? [])[0] ?? null },
        growth: growth ? { portrait: growth.portrait(), week: growth.lastWeek(), history: growth.history().map((h) => ({ week: h.week, changes: h.changes })) } : null,
        intents: intents.map((i) => ({ at: i.at, kind: i.kind, text: i.text })),
        script,
        speak: cfg.speak, play: cfg.play, activeHours: cfg.activeHours, advanceEveryMinutes: cfg.advanceEveryMinutes,
        nextAdvanceAt: cfg.advanceEveryMinutes > 0 ? Math.max(meta.cursor, meta.lastAdvance) + cfg.advanceEveryMinutes * 60000 : null,
      };
    },
  });

  logger.info(`interlude ready — ${dir}`);
}
