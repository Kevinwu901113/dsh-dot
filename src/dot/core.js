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
//   2. what of hers needs him (gates.js) is asked of him in her words, never with a button; his yes is kept (consent.js);
//   3. dsh-budget blocks are announced on IM, and the `daily` block is lifted at local midnight;
//   4. VM failures are announced on IM; /dot shows the status.
import { DEFAULT_AWAKE, sleepsAtAll, validHours } from '../hours.js';
import { deny } from '../refusals.js';
import { HANDS_ASK_TOOL, HANDS_DONE_TOOL, HIS_OK_TOOL, SAY_TOOL, PHONE_TOOL_PREFIX, PHONE_TYPE_TOOL, VM_TOOL_PREFIX, isHerTool, HER_PRESET, HANDS_PRESET, HANDS_WAIT_TOOL, PHONE_LOOK_TOOLS } from '../tool-prefixes.js';
import { checkReply } from '../persona/card.js';
import { VM_SCREENSHOT } from '../qq/qq.js';
import { BRIDGE_ID_RE } from '../compat/qq-bridge.js';
import { batchLaunch, createHowto, errorType, howtoTool, isRefusal, placeName } from './howto.js';
import { HANDS_SOURCE, createHands } from './hands.js';
import { createLedger, headTail } from './ledger.js';
import { checkInput, checkTool, settle as settleCheck, report as checkReport, hashOf } from './nightcheck.js';
import { approvalKind, classify, classifyComputer, classifyHost, KINDS, HIM_KINDS } from './gates.js';
import { createConsent } from './consent.js';
import { createSay } from './say.js';
import { createOutlet } from './outlet.js';
import { KNOWN_APPS, collectReply } from '../interlude/core.js';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { mountPanel } from './panel.js';
import { watchBudget } from './budget.js';
import { createSleep } from './sleep.js';
import { createCheckup } from './checkup.js';
import { dotCommand } from './command.js';
import { sectionOf, setValues } from '../settings.js';
import { background, effortFor, installLlmGate, statusLine as llmGateLine, workEffort } from '../llm-gate.js';
import { configure as configurePrompts, prompt } from '../prompts.js';
import { drift } from '../integrity.js';
import { runPendingReset } from '../reset.js';
import { ago, stamp, today, unstamp } from '../clock.js';
import { ownerSaid } from '../said.js';
import { head } from '../cut.js';
import { lexTokens } from '../memory/recall.js';
import { screenLines } from '../phone/typing.js';
import { PHONE_NOTIFICATION_SOURCE, ownerSource, ownerWords, withImages, ownerInterruptText, handsStatus, voiceHow, ownWords, replyCheckText, spokenOf, pushesText, TURN_NOTE_SOURCE, addressed, isOwnerTarget, ownerUnread, reachText, nowText, loopKey, conversationTitle, wakeText, scheduledRule, workingRules, contentText, stripSilent, SILENT } from './text.js';
export * from './text.js';

export const name = 'dsh-dot';
// Devices are optional components: the computer (dshComputer) and the phone (dshPhone). dot works
// with either; with neither it still relays, but says so in /dot.
export const inject = [];

export const defaults = {
  home: '',             // default ~/dot
  scope: 'home+im',     // which sessions are dot's: 'home' (cwd inside home), 'im' (opened from an IM bot), 'home+im', 'all'
  imBot: '',            // dsh-im Bot ID; default: the first bot that has a saved delivery target
  imTarget: '',         // dsh-im Target ID; default: that bot's first saved target
  budgetPollSeconds: 15,
  autoUnblockDaily: true,
  notifyBatchMs: 1000,  // notifications arriving within this window wake her once, together
  gateScreenMs: 5000,   // a tap of her hands is judged by the screen as read within this long (else it is read again first)
  ackHoldMs: 15000,    // his words opened a thing: the answer waits this long, so a quick thing is answered once, with its result; 0 = at once
  pushesKept: 12,      // an app's own pushes (not a person writing) wake no one: the latest this many are shown with what reaches her next
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
  // wait_for (her hands waiting for the screen or a notification): the longest one wait lasts, and how often the code looks.
  awaitMs: 86400000,    // an answer someone owes a thing is waited for this long (it is a record in the book, not her hands' time)
  waitMaxMs: 120000,
  waitPollMs: 2000,
  handsStuckHoldMs: 1800000, // a thing that ended stuck leaves the phone on its page this long (the next thing carries on from there), then it goes home
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
  sayDetailChars: 800,
  sameErrorNudge: 3, // her hands hit the same error this many times in a row: told to change course or end it (not reached)
  sameErrorStop: 6,  // … this many: the code ends the thing as failed (same-error); 0 = never // a thing's details as the voice gets them (the book is where results come from; her own words carry her stance)
  sayLines: 12,
  // She wrote to him unasked and he has not answered for this long: noted once in her conversation, as a fact. 0 = never.
  reachUnansweredMs: 2 * 3600000,
  interludeQueueMax: 3,        // queued past this, the oldest is dropped
  interludeTaskTtlMs: 1800000, // not started within this long: given up ('expired')
  // The know-how book (howto.js): each thing's steps per place (an app, the phone itself, the computer) are logged
  // with the thing's outcome, time and cost; a place with errors, a run that broke off, or clearly more steps than
  // usual (≥ howtoMinSteps) is reflected on once (a small call) and its notes rewritten (≤ howtoMaxChars); the first
  // time her hands are there in a thing, they come along.
  howto: true,
  howtoMinSteps: 12,
  howtoMaxChars: 800,
  nightcheck: true,      // when she falls asleep her notes are held against the records and amended (nightcheck.js); false: only on /dot nightcheck
  promptsPort: 7870,    // /dot prompts: the prompt and persona editor page (scripts/prompts.mjs) on 127.0.0.1
  // Liveness: a turn with no session event for turnStallMs is stalled (he is told once).
  turnStallMs: 300000,
  // His words were handed to her conversation and no turn of hers has taken them after this long (and none is running): they are counted as lost, and he is told.
  ownerLostMs: 45000,
  // He is told of a turn that failed at most once in this long (a broken install fails every turn the same way).
  failureNoticeMs: 600000,
  // What one thing of her hands may cost before it stops and he is asked (tokens: new input + output + a tenth of the
  // cached input, as DeepSeek prices them). 0: no limit.
  thingCostCap: 1500000,
};

/** Tool name without its MCP server prefix (mcp__dot-vm__browser_click → browser_click). */
export const shortTool = (name) => String(name ?? '').replace(/^mcp__.+?__/, '');
/** An open turn as the panel and /dot show it: 'stalled' (no session event for turnStallMs) or 'running'. */
export function turnState(t, { now = Date.now(), turnStallMs = defaults.turnStallMs } = {}) {
  const idleMs = Math.max(0, now - (t.lastEventAt ?? t.startedAt ?? now));
  return { state: turnStallMs > 0 && idleMs >= turnStallMs ? 'stalled' : 'running', idleMs };
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
  // Every line is kind 'dot' (the activity view sorts by it); a `kind` of the thing recorded is kept as `of`.
  const audit = (event, { kind, ...data } = {}) => (computer()?.audit ?? phone()?.audit)?.({ kind: 'dot', event, ...data, ...(kind !== undefined ? { of: kind } : {}) });
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

  // 1. Her turns.
  const turns = new Map(); // session id → { turn, scheduled, text, startedAt, lastEventAt, doing, said }
  let howtoFor = () => null;  // set where her phone notes are (below)
  const askedCalls = new Map(); // callId → what of it needs his yes: its tool result says so (tools/post-execute)
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
  // A thing that was sent to someone and is done as far as her hands go can still be owed an answer (a text to a
  // service number, a message, a request). That is a record on the thing — who is to answer, since when, until when —
  // not hands kept on the page: 11-23 a text to 10086 took 169 s, 135 of them her hands watching for the reply, and
  // a reply that came later was tied to nothing. When someone by that name writes, the code marks it answered and
  // wakes her with it as that thing's — his business when the thing was his.
  const sameName = (a, b) => { const x = String(a ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(), y = String(b ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(); return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)); };
  const awaited = (now = Date.now()) => ledger.recent(40).filter((e) => e.awaiting?.from && !e.awaiting.answeredAt && now < (e.awaiting.until ?? 0));
  /** Is this message the answer a thing is waiting for? → the thing, marked answered, or null. */
  const answerTo = (n) => {
    const e = awaited().find((x) => sameName(x.awaiting.from, n?.name) || sameName(x.awaiting.from, conversationTitle(n?.title)));
    if (!e) return null;
    ledger.note(e.id, { awaiting: { ...e.awaiting, answeredAt: Date.now(), text: head(String(n?.text ?? ''), 300) } });
    audit('awaited-answer', { thing: e.id, from: e.awaiting.from, pkg: n?.pkg ?? '', forHim: e.asker === 'him' });
    return ledger.get(e.id);
  };
  /** What her hands are on right now, as a line for her conversation ('' when they are free). */
  // What the book holds that bears on what she decides now, one line a thing with what to do about it (cf. DeerFlow's
  // delegation ledger): what is under way and waits, and what ended in the last hour that is not just "done".
  const thingsLines = (now = Date.now()) => {
    const title = (task) => { const t = String(task ?? '').split(/[。\n]/)[0].trim(); return t.length > 40 ? `${head(t, 40)}…` : t; };
    const lines = ledger.unfinished().map((e) => prompt(e.state === 'running' ? 'dot.things.running' : 'dot.things.queued', { what: title(e.task), since: ago(e.startedAt ?? e.openedAt, now) || '刚' }).trim());
    const recent = ledger.recent(10), takenUp = new Set(recent.map((e) => e.after).filter(Boolean)); // a later thing carries on from it
    for (const e of recent) {
      if (e.state !== 'ended' || now - (e.endedAt ?? 0) > 3600000 || takenUp.has(e.id)) continue;
      if (e.outcome === 'stopped' && e.by === 'him') lines.push(prompt('dot.things.stopped.his', { what: title(e.task) }).trim());
      else if (e.outcome === 'stuck') lines.push(prompt('dot.things.stuck', { what: title(e.task), question: e.question ?? '' }).trim());
    }
    for (const e of awaited(now)) lines.push(prompt('dot.things.awaiting', { what: title(e.task), from: e.awaiting.from, since: ago(e.awaiting.since, now) || '刚' }).trim());
    for (const a of consent.asking()) lines.push(prompt('dot.things.asking', { what: a.what }).trim());
    return lines.join('\n');
  };
  // Where a thing is done is hers to judge, and to learn: the book already has where each thing was done and what came
  // of it. Things like what he is asking for now (by the words they share) are put before her as they were recorded —
  // the place, the outcome, the steps, whether it stopped to ask him, whether it had been moved from another place.
  // Nothing here says where to go: these are records, and the judging is hers.
  const likeTokens = (text) => new Set(lexTokens(text).filter((x) => x.length >= 2));
  const thingsLike = (words, max = 3) => {
    const q = likeTokens(words);
    if (q.size < 2) return '';
    const title = (task) => { const t = String(task ?? '').replace(/^（[^）]*）/, '').split(/[。\n]/)[0].trim(); return t.length > 40 ? `${head(t, 40)}…` : t; };
    const all = ledger.recent(100);
    const scored = [];
    for (const e of all) {
      if (e.state !== 'ended' || !e.device || e.outcome === 'stopped' || e.cause === 'restart') continue;
      let shared = 0; for (const x of likeTokens(title(e.task))) if (q.has(x)) shared++;
      if (shared >= 2) scored.push([shared, e]);
    }
    scored.sort((a, b) => b[0] - a[0] || (b[1].endedAt ?? 0) - (a[1].endedAt ?? 0));
    return scored.slice(0, max).map(([, e]) => {
      const from = e.after ? all.find((x) => x.id === e.after) : null;
      const more = `${e.ask?.for === 'him' ? prompt('dot.things.like.asked').trim() : ''}${from?.device && from.device !== e.device ? prompt('dot.things.like.moved', { from: from.device }).trim() : ''}`;
      return e.outcome === 'done'
        ? prompt('dot.things.like.done', { what: title(e.task), device: e.device, steps: e.steps ?? 0, more }).trim()
        : prompt('dot.things.like.not', { what: title(e.task), device: e.device, why: head(String(e.question || e.summary || e.cause || e.outcome || ''), 40), steps: e.steps ?? 0, more }).trim();
    }).join('\n');
  };
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
  // What became of his words. Each message of his ends one of three ways: she answered, she chose not to, or it
  // failed — the turn broke, the call that writes her words failed, or no turn ever took his words. The third is told
  // to him by the plugin in its own name (never written as her), shown as failed, and said in /dot; until 11-22 it
  // did not exist: a broken turn looked like her silence on his side and like "done" on the panel.
  let owed = null;        // his words handed to her conversation and not yet taken by a turn: { session, timer }
  let lastFailure = null; // { at, session, error, lost }
  let failureTold = 0, driftTold = false;
  const driftLine = () => { const d = drift(); return d ? prompt('dot.drift', { loaded: d.loaded || '?', disk: d.disk || '?', missing: d.missing.length }).trim() : ''; };
  const turnFailed = (id, why, { lost = false, his = true } = {}) => {
    const error = String(why ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || '没有说原因';
    lastFailure = { at: Date.now(), session: id, error, lost };
    audit('turn-failed', { session: id, error, lost, his });
    if (!his || Date.now() - failureTold < cfg.failureNoticeMs) return;
    failureTold = Date.now();
    void im.send(prompt(lost ? 'dot.turn-lost' : 'dot.turn-failed', { error, hint: driftLine() }), 'plain');
  };
  const taken = (id) => { if (owed?.session === id) { clearTimeout(owed.timer); owed = null; } };
  const owe = (id) => {
    if (!(cfg.ownerLostMs > 0)) return;
    clearTimeout(owed?.timer);
    const mine = { session: id, timer: null };
    const check = () => {
      if (owed !== mine) return;
      // A turn of hers is running: his words are read at its next step, or by the turn after it.
      if (turns.has(id)) { mine.timer = setTimeout(check, cfg.ownerLostMs); mine.timer.unref?.(); return; }
      owed = null;
      turnFailed(id, '她的对话没有接到这句话', { lost: true });
    };
    mine.timer = setTimeout(check, cfg.ownerLostMs); mine.timer.unref?.();
    owed = mine;
  };
  ctx.effect(() => () => clearTimeout(owed?.timer), 'dsh-dot: his words not yet taken');
  // The plugin's files replaced under the running dsh (integrity.js): said once, before he finds out by her going quiet.
  const watchDrift = () => { if (driftTold) return; const line = driftLine(); if (!line) return; driftTold = true; audit('plugin-drift', drift() ?? {}); void im.send(`⚠️ dot：${line}`, 'plain'); };

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
    if (event.type === 'turn/end' && !retired(id)) setLast(id);
    if ((event.type === 'turn/start' || event.type === 'turn/end') && id === lastSession) wakeUp('turn'); // a turn of her conversation: she is up (or stays up)
    // A reminder enters the inbox before its turn starts, and the prompt is assembled at turn
    // start, before the user/message event: note it here so the turn knows from its first step.
    if (event.type === 'agent/inbox/spliced') {
      if ((event.data?.inserted ?? []).some((m) => m?.source?.kind === 'user' && addressed(m.source) === 'qq')) taken(id); // his words are in her inbox's turn
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
      if (event.data?.source?.kind === 'user') taken(id);
      if (event.data?.source?.kind === 'user' && !t.origin && !t.scheduled && !t.tools) { // a turn his own words opened
        t.his = true;
        const said = ownerSaid(unstamp(contentText(event.data?.content))).trim();
        if (said) t.said = [t.said, said].filter(Boolean).join(' ').slice(0, 120);
      }
      // His own words of this turn, as he typed them (t.said goes on to hold what she last wrote): what a yes of his is kept with.
      if (event.data?.source?.kind === 'user') { const words = ownerSaid(unstamp(contentText(event.data?.content))).trim(); if (words) t.hisWords = [t.hisWords, words].filter(Boolean).join(' ').slice(-200); }
      return;
    }
    const ended = event.type === 'turn/end' && (event.data?.turn === undefined || event.data.turn === t.turn);
    // What woke this turn besides him (a notification, her own time) and what the turn cost: a task of hers that ran
    // in it (dshDot.task) gets its result and its cost back when the turn ends.
    if (event.type === 'user/message' && ['dsh-dot', 'dsh-interlude'].includes(event.data?.source?.kind) && event.data.source.form !== 'turn-note') t.origin ??= event.data.source.form;
    // Her hands came back on something of his: the turn is on his business (a thing she starts from it is his too),
    // and what she tells him in it she says with qq_send.
    if (event.type === 'user/message' && event.data?.source?.kind === 'dsh-dot' && event.data.source.for === 'him') { t.forHim = true; if (event.data.source.thing) t.thing = event.data.source.thing; }
    if (event.type === 'assistant/message') {
      const u = event.data?.usage;
      if (u) { t.cost ??= { in: 0, cached: 0, out: 0 }; t.cost.in += (Number(u.inputTokens ?? 0) || 0) + (Number(u.cacheWriteTokens ?? 0) || 0); t.cost.cached += Number(u.cacheReadTokens ?? 0) || 0; t.cost.out += Number(u.outputTokens ?? 0) || 0; }
      if (!event.data?.interrupted) { const said = contentText(event.data?.message?.content); if (said.trim()) t.last = said; }
    }
    // The turn broke (the model call failed, a prompt could not be put together): not her silence. Nothing is written
    // in her name about a turn that did not happen; he is told by the plugin when the turn was his.
    const broke = ended && event.data?.reason?.kind === 'error';
    if (broke) {
      const lost = owed?.session === id && !t.fromQq;
      taken(id);
      turnFailed(id, event.data.reason.error?.message ?? event.data.reason.message, { lost, his: Boolean(lost || ((t.fromQq || t.hisHere || t.forHim) && !t.scheduled)) });
    }
    // A question of hers to him is waiting until his next words have been read: the turn they open either keeps his
    // yes (his_ok) or does not — said no, said something else — and after it the question is not waiting any more
    // (11-23: a yes was matched to yesterday's text message he had called off).
    if (ended && t.his && !broke) {
      for (const e of ledger.recent(10)) if (e.outcome === 'stuck' && e.ask?.for === 'him' && !e.askSettled && (e.told ?? e.endedAt ?? 0) < t.startedAt) ledger.note(e.id, { askSettled: Date.now() });
      consent.settle(t.startedAt);
    }
    if (ended) {
      turns.delete(id); // every turn, scheduled or not: `turns` is also "is she busy right now"
      // A thing of her own (her own time) lasts as long as her hands are still on it: the turn that started it, then
      // every turn her hands come back to, until one ends with her hands free. Its cost is all of those turns'.
      if (taskRunning?.session === id && (t.origin === taskRunning.source?.form || (t.origin === 'hands-result' && !t.forHim))) {
        const c = taskRunning.cost ??= { in: 0, cached: 0, out: 0 };
        if (t.cost) { c.in += t.cost.in; c.cached += t.cost.cached; c.out += t.cost.out; }
        // What came of her own time is what the book has of the things she did in it — not what she wrote about it.
        if (!hands?.busy()) finishTask(taskRunning, 'done', ledger.recent(20).filter((e) => e.asker === 'her' && e.state === 'ended' && (e.endedAt ?? 0) >= (taskRunning.startedAt ?? 0)).reverse().map((e) => `${titleOf(e.task)}：${[e.outcome === 'done' ? '' : handsStatus(e, e.device), e.summary].filter(Boolean).join('。') || '没有留下结果'}`).join('\n'), c);
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
    // Nothing she writes leaves, and nothing she writes is read: a turn he is in that ends — his words, or a thing of
    // his that came to its end — is answered by the voice (say.js) from their conversation and the facts of the book.
    // What she herself has for him (a view, a question, something that does not match the picture) she gives with
    // say's `about`, a field, in that turn. Until 11-23 the turn's closing words were passed on as "what she knows":
    // she was asked to write them every turn, wrote "发出去了" before her hands had moved, and 0.25.1 then had to drop
    // them whenever a thing had just ended — taking her real questions with them.
    // (At her window what she wrote is on his screen as it is; nothing more goes out from here.)
    if (ended && !t.scheduled && (t.fromQq || t.hisHere || t.forHim)) {
      if (t.cancelled) { audit('owner-turn-restarted', { session: id, aborted: event.data?.reason?.kind === 'aborted' }); return; }
      if (broke) return;
      // A thing of his that came back and that she took further in this turn (gave her hands the next part, answered
      // them) is not at its end: there is nothing to tell him yet.
      const further = !t.fromQq && Boolean(t.opened?.length || t.answered);
      const speak = !t.spoke && !further && !(t.elsewhere && !t.fromQq) && event.data?.reason?.kind !== 'aborted';
      const over = () => { if (!t.spoke) { preempts = 0; audit('silent', { session: id }); } };
      // The call that writes her words failed: that is not her choosing to say nothing.
      const told = (r) => { if (r?.status === 'failed') { preempts = 0; turnFailed(id, `替她写话的那次调用没成：${r.why ?? ''}`); } else over(); };
      if (!speak) { over(); return; }
      // His words opened a thing: the answer waits a moment (ackHoldMs). When nothing of his is under way by then, what
      // came of it is told once, by the turn its end wakes; while something is, he gets word that it is under way.
      // His next words call the wait off (that turn answers all of it).
      if (t.fromQq && t.opened?.length && cfg.ackHoldMs > 0) {
        dropAck('another turn');
        const ack = { timer: null };
        ack.timer = setTimeout(() => {
          if (ackHold !== ack) return;
          ackHold = null;
          if (!hisUnderWay()) { audit('ack-folded', { session: id }); return; } // told by the turn the result woke
          void tellHim(t).then(told, over);
        }, cfg.ackHoldMs);
        ack.timer.unref?.();
        ackHold = ack;
        audit('ack-held', { session: id, things: t.opened });
        return;
      }
      void tellHim(t).then(told, over);
    }
  });

  // 2. What of hers needs him (gates.js): nothing waits on a button. A request the host or a plugin gates in her
  // sessions is let through when his yes covers it (consent.js), and otherwise refused at once: in her hands' session
  // the thing ends there as a question for him; in her conversation she is told to ask him first.
  const hers = (agent) => { const s = agent?.session; return Boolean(s?.id) && (isDotSession(s.id, s.header?.cwd) || retired(s.id) || turns.has(s.id) || Boolean(hands?.isHands(s.id, s.header?.cwd))); };
  ctx.on('approval/request', async (req, next) => {
    if (!hers(req.agent)) return next();
    const s = req.agent.session;
    const k = approvalKind(req.toolName, req.reason);
    const theirs = Boolean(hands?.isHands(s.id, s.header?.cwd));
    const thing = theirs ? hands.doing()?.id ?? '' : '';
    if (consent.allows({ kind: k.kind, subject: k.subject, thing })) { audit('consent-used', { session: s.id, kind: k.kind, thing }); return 'approved'; }
    if (theirs) hands.ask(prompt('dot.gates.ask.q', { what: k.what }), { for: 'him', kind: k.kind, subject: k.subject, tier: 'ask', what: k.what });
    else consent.ask(k);
    if (req.callId !== undefined) askedCalls.set(req.callId, { what: k.what, theirs });
    audit('consent-asked', { session: s.id, kind: k.kind, tool: req.toolName, thing });
    return 'rejected';
  }, { prepend: true });
  // dsh words a refusal as "the user rejected tool …": one that waits for his yes says so instead.
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
    const asked = askedCalls.get(exec?.callId);
    const notes = [cfg.howto && exec?.name ? await howtoFor(exec, result) : null, exec?.name ? sameErrorFor(exec, result) : null, exec?.name ? sameScreenFor(exec, result) : null].filter(Boolean);
    const note = notes.join('\n\n');
    if (asked === undefined && !note) return next();
    if (asked !== undefined) askedCalls.delete(exec.callId);
    const d = await next();
    const contexts = [...(d?.additionalContexts ?? []), ...(note ? [createUserMessage({ content: [{ type: 'text', text: note }], source: { kind: 'dsh-dot', form: 'manual' } })] : [])];
    const out = asked !== undefined ? { kind: 'block', feedback: [{ type: 'text', text: prompt(asked.theirs ? 'dot.gates.ask' : 'dot.gates.asked.her', { what: asked.what }) }] } : { ...d };
    if (contexts.length) out.additionalContexts = contexts; else delete out.additionalContexts;
    return out;
  });

  // Working rules are a system-prompt section for sessions in <home> (static per session, so the
  // cached prefix holds). The silence rule is additionally put in front of the model on the turn a
  // schedule wakes, as a dynamic context; only those turns get it.
  const inHome = (c) => { const s = c.agent?.session; return isDotSession(s?.id, s?.header?.cwd) || turns.has(s?.id); };
  // The know-how book (howto.js): every device call her hands make while a thing runs is a step of that thing, in
  // the place it happened; the first time they are in a place in that thing, its notes come along (in the
  // post-execute hook above). The thing's end (hands onDone, below) logs it and picks what is worth learning from.
  const appLabels = { ...Object.fromEntries(Object.entries(KNOWN_APPS.labels).map(([label, pkg]) => [pkg, label])), 'com.tencent.mobileqq': 'QQ', 'com.tencent.mm': '微信' };
  // The phone itself: the home screen, settings, the shade, the keyboard, the system's own dialogs.
  const SYSTEM = /launcher|\.home$|^com\.android\.(systemui|settings|packageinstaller|permissioncontroller|documentsui|intentresolver)$|^com\.google\.android\.(permissioncontroller|packageinstaller|documentsui|inputmethod\..*)$|inputmethod|keyboard/i;
  const labelOf = (pkg) => (!pkg || SYSTEM.test(pkg) ? 'phone' : appLabels[pkg] ?? pkg);
  const howto = createHowto({ dir: join(home, 'her', 'howto'), minSteps: cfg.howtoMinSteps, maxChars: cfg.howtoMaxChars });
  howtoFor = async (exec, result) => {
    const onPhone = exec.name.startsWith(PHONE_TOOL_PREFIX) || exec.name === PHONE_TYPE_TOOL;
    if (!onPhone && !exec.name.startsWith(VM_TOOL_PREFIX)) return null;
    const s = exec.agent?.session;
    if (!s?.id || hands?.doing()?.session !== s.id) return null; // a late result of a thing that is over
    const input = exec.arguments ?? exec.input;
    let app = 'computer';
    if (onPhone) {
      // The app this call happened in: the one in front after it (a launch, inside a batch too, says so directly).
      let pkg = input?.packageName ?? batchLaunch(input);
      try { pkg = String((await phone()?.foreground?.()) ?? '').split('/')[0] || pkg; } catch (error) { void error; }
      app = labelOf(pkg);
    }
    howto.step(s.id, app, exec.name, input, { isError: Boolean(result?.isError), error: contentText(result?.content ?? []) });
    const given = [];
    for (const place of onPhone && app !== 'phone' ? ['phone', app] : [app]) {
      if (howto.needsReview(place)) { void reflectHowto({ review: true, app: place }); continue; }
      const got = howto.take(s.id, place);
      if (!got) continue;
      audit('howto-given', { session: s.id, app: place });
      given.push(prompt('dot.howto.given', { app: placeName(place), notes: got.notes, recent: got.recent || '—' }).trim());
    }
    return given.join('\n\n') || null;
  };
  // The same error over and over (11-22: nine tries at a page the browser could not reach): counted by code, per thing,
  // by its type (addresses left out); anything that goes through, or a refusal of ours, starts the count again. At
  // sameErrorNudge the hands are told to change course or end it as not reached; at sameErrorStop the code ends it.
  const errorRuns = new Map(); // thing id → { type, n }
  const sameErrorFor = (exec, result) => {
    const t = hands?.doing(), sid = exec.agent?.session?.id;
    if (!t || !sid || t.session !== sid || exec.name === HANDS_DONE_TOOL || exec.name === HANDS_ASK_TOOL) return null;
    const raw = result?.isError ? contentText(result?.content ?? []) || String(result?.error?.message ?? result?.error ?? '') : '';
    const type = raw && !isRefusal(raw) ? errorType(raw) : '';
    if (!type) { errorRuns.delete(t.id); return null; }
    const before = errorRuns.get(t.id), run = { type, n: before?.type === type ? before.n + 1 : 1 };
    errorRuns.set(t.id, run);
    if (cfg.sameErrorStop > 0 && run.n >= cfg.sameErrorStop) {
      errorRuns.delete(t.id);
      audit('same-error-stop', { session: sid, thing: t.id, n: run.n, error: type });
      hands.fail({ cause: 'same-error', error: type });
      return null;
    }
    if (cfg.sameErrorNudge > 0 && run.n === cfg.sameErrorNudge) {
      audit('same-error-nudge', { session: sid, thing: t.id, n: run.n, error: type });
      return prompt('dot.hands.same-error', { n: run.n, error: type, max: Math.max(1, cfg.sameErrorStop - run.n) });
    }
    return null;
  };
  // Looking again at a screen that has not changed (11-23: 24 of a thing's 39 steps were looks, waiting for a text
  // message to be answered): counted by code, per thing. A look that shows what the look before it showed, with no
  // action in between, is told so — to wait with wait_for, or to end the thing if what it waits for is someone's answer.
  const lookRuns = new Map(); // thing id → { seen: { tool: text }, n }
  let handsActedAt = 0;       // when her hands last did something (wait_for counts notifications from then on)
  const sameScreenFor = (exec, result) => {
    const t = hands?.doing(), sid = exec.agent?.session?.id;
    if (!t || !sid || t.session !== sid) return null;
    const name = shortTool(exec.name);
    if (!PHONE_LOOK_TOOLS.includes(name) || name === 'phone_zoom') { if (exec.name !== HANDS_WAIT_TOOL) handsActedAt = Date.now(); lookRuns.delete(t.id); return null; }
    const text = result?.isError ? '' : contentText(result?.content ?? []);
    const run = lookRuns.get(t.id) ?? { seen: {}, n: 0 };
    run.n = text && run.seen[name] === text ? run.n + 1 : 0;
    run.seen[name] = text;
    lookRuns.set(t.id, run);
    if (run.n < 1) return null;
    audit('same-screen', { session: sid, thing: t.id, tool: name, n: run.n + 1 });
    return prompt('dot.hands.same-screen', { n: run.n + 1 });
  };
  /** The thing in her hands is over: its steps go into the book, with what the ledger has of it. */
  const learnFrom = (job) => {
    if (!cfg.howto || !job?.session) return;
    const e = ledger.get(job.id);
    for (const r of howto.end(job.session, { thing: job.id, task: job.task, name: e?.name ?? '', outcome: e?.outcome ?? '', ms: (e?.endedAt ?? Date.now()) - (e?.startedAt ?? e?.openedAt ?? Date.now()), tokens: costOf(e) })) reflectHowto(r);
  };
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
    let seen = null; // what the call gave back, for the audit when it cannot be read
    try {
      if (r.review && !howto.needsReview(r.app)) return; // read over meanwhile
      // Not injected into dsh-dot (it would wait on them): taken when needed.
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
      const llm = ctx.get('llm');
      if (!sel || !llm?.stream) return;
      const effort = await workEffort(ctx, sel);
      const reply = await collectReply(llm.stream(background({
        provider: sel.provider, model: sel.model, ...(effort ? { reasoningEffort: effort } : {}),
        system: prompt(r.review ? 'dot.howto.review' : 'dot.howto.reflect', { maxChars: cfg.howtoMaxChars }), tools: [howtoTool()], maxTokens: 12000, // thinking counts too: cut short, the notes came back as half a JSON (howto-failed, "Unexpected end of JSON input")
        messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(howto.input(r), null, 1) }], source: { kind: 'dsh-dot', form: 'howto' } })],
      })));
      seen = { text: String(reply.text ?? ''), args: String(reply.args ?? '') };
      const out = JSON.parse(reply.args || reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1));
      if (r.review) { if (howto.keep(r.app, { notes: out.notes })) audit('howto-reviewed', { app: r.app }); return; }
      if (howto.keep(r.app, out, r.id)) audit('howto-learned', { app: r.app, steps: r.steps, errors: r.errors.length, outcome: r.outcome, ...(out.task ? { task: String(out.task).slice(0, 12) } : {}) });
    } catch (error) { logger.warn(`howto reflection (${r.app}) failed: ${error.message}`); audit('howto-failed', { app: r.app, error: String(error.message).slice(0, 200), ...(seen ? { chars: seen.text.length, args: seen.args.length } : {}) }); }
  }
  // Her notes held against the records (nightcheck.js). The check writes what it would do to a file and changes
  // nothing; applying is asked for separately, and only where the notes are still the ones that were checked.
  const nightFile = () => join(howto.dir, '_nightcheck.json');
  async function nightcheck({ apply = false } = {}) {
    if (apply) {
      let last = null;
      try { last = JSON.parse(readFileSync(nightFile(), 'utf8')); } catch (error) { void error; }
      if (!last?.places?.length) return '还没有核对过：先 /dot nightcheck';
      const done = [];
      for (const p of last.places) {
        if (!p.changed) continue;
        if (hashOf(howto.notes(p.app)) !== p.hash) { done.push(`${p.app}：笔记在核对之后变过，没动（再核对一次）`); continue; }
        howto.amend(p.app, p.notes);
        audit('nightcheck-applied', { app: p.app, ops: p.ops.length });
        done.push(`${p.app}：改了 ${p.ops.length} 条`);
      }
      return done.length ? done.join('\n') : '上次核对没有要改的';
    }
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
    const llm = ctx.get('llm');
    const places = [], said = [];
    for (const app of howto.apps()) {
      const notes = howto.notes(app);
      if (!notes || app.startsWith('_')) continue; // files of the book's own keeping are not places
      const records = howto.records(app), input = checkInput({ place: placeName(app), notes, records });
      let judged = [], failed = '', seen = null; // seen: what the call gave back, said when it cannot be read
      if (input.lessons.length && sel && llm?.stream) {
        try {
          const effort = await workEffort(ctx, sel);
          const reply = await collectReply(llm.stream(background({
            provider: sel.provider, model: sel.model, ...(effort ? { reasoningEffort: effort } : {}),
            system: prompt('dot.howto.nightcheck'), tools: [checkTool()], maxTokens: 12000, // what it thinks counts too: at 4000 the answer for a place with eight lessons was cut mid-JSON
            messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(input, null, 1) }], source: { kind: 'dsh-dot', form: 'nightcheck' } })],
          })));
          seen = { finish: reply.finish?.kind ?? '', text: String(reply.text ?? '').length, args: String(reply.args ?? '').length, out: reply.usage?.outputTokens ?? 0 };
          const out = JSON.parse(reply.args || reply.text.slice(reply.text.indexOf('{'), reply.text.lastIndexOf('}') + 1));
          judged = Array.isArray(out?.lines) ? out.lines : [];
        } catch (error) { failed = `${String(error.message).slice(0, 120)}${seen ? `（finish ${seen.finish || '?'}，正文 ${seen.text} 字，参数 ${seen.args} 字，输出 ${seen.out} token）` : ''}`; }
      }
      const r = settleCheck({ notes, judged, records });
      places.push({ app, hash: hashOf(notes), changed: r.changed, ops: r.ops, notes: r.notes, ...(failed ? { failed } : {}) });
      audit('nightcheck', { app, lessons: input.lessons.length, records: records.length, judged: judged.length, reword: r.ops.filter((o) => o.op === 'reword').length, drop: r.ops.filter((o) => o.op === 'drop').length, unsupported: r.unsupported, ...(failed ? { failed } : {}) });
      said.push(checkReport(app, r) + (failed ? `\n  （这一处的教训没判成：${failed}）` : ''));
    }
    try { writeFileSync(nightFile(), `${JSON.stringify({ at: Date.now(), places }, null, 1)}\n`); } catch (error) { logger.warn(`nightcheck not written: ${error.message}`); }
    return places.length ? `${said.join('\n')}\n\n什么都还没改：这是会做的改动，记在 ${nightFile()}。要照着改：/dot nightcheck apply` : '手艺簿里还没有笔记';
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
    return [nowText(Date.now(), ctx.get('dotMemory')?.lastSaidAt?.(started) ?? 0), id === lastSession ? reachText(reaches) : '', id === lastSession ? thingsLines() : '', id === lastSession ? thingsLike(turns.get(id)?.hisWords ?? '') : ''].filter(Boolean).join('\n');
  } });
  // What she writes here is read by no one: said once per arrival, because nothing else in front of her says it.
  turnNote({ name: 'dot:say', order: 901, text: () => prompt('dot.say.note') });
  // What went out to him since she was last up, as it was sent: the voice's words, not hers.
  turnNote({ name: 'dot:said', order: 897, text: ({ agent }) => { if (!saidNote || agent.session.id !== lastSession) return ''; const n = saidNote; saidNote = ''; return n; } });
  // Her phone's pushes held since she was last up (see wake): once, with whatever woke her.
  turnNote({ name: 'dot:pushes', order: 898, text: ({ agent }) => { if (!pushes.length || agent.session.id !== lastSession) return ''; const t = pushesText(pushes); pushes = []; audit('pushes-shown', { count: t ? t.split('\n').length - 2 : 0 }); return t; } });
  turnNote({ name: 'dot:scheduled-turn', order: 900, text: ({ agent, messages }) => (turns.get(agent.session.id)?.scheduled || messages.some((m) => m?.source?.kind === 'schedule') ? scheduledRule() : '') });

  /** What she is busy with right now (an interlude task records it when it has to wait). */
  const busyWith = () => (turns.has(lastSession) ? prompt('dot.busy.chat') : '');

  // 3. Budget (budget.js).
  const budget = watchBudget({ ctx, cfg, store, audit, im, logger });

  // 4. Device health (whichever devices are installed; they may come up after dot).
  ctx.inject(['dshComputer'], (c) => c.effect(() => c.dshComputer.onStatus?.((s) => {
    if (s.state === 'error') void im.send(`⚠️ dot: 虚拟机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-computer.log`, 'plain');
  }) ?? (() => {}), 'dsh-dot: computer status'));
  // 5. Her phone rings: a new notification wakes her in her latest session. She reads and answers in
  // the app herself; the dsh reply is not relayed anywhere.
  let waking = Promise.resolve();
  // Her sleep (sleep.js): asleep, only he wakes her; what her phone and her QQ show waits, and is shown when she wakes.
  const sleep = createSleep({ cfg, store, audit, logger, effect: (fn, label) => ctx.effect(fn, label), quiet: () => quiet(),
    onWake: () => { if (batch.length && !batchTimer) { batchTimer = setTimeout(flush, cfg.notifyBatchMs); batchTimer.unref?.(); } } });
  // The voice, run again on inputs kept in a file: what it says of the same facts, several times over — how often it
  // says more than the facts do is measured this way, not guessed from one message (11-24: "发了" of a thing just
  // begun). The file: { times, cases: [{ name, text }] }; what came back is written beside it (.out.json). Nothing is sent.
  async function voicetest(file) {
    const f = isAbsolute(file) ? file : join(dshHome(), 'dot-replay', file);
    const spec = JSON.parse(readFileSync(f, 'utf8'));
    const system = String(ctx.get('dshInterlude')?.cardText?.() ?? '').trim();
    const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
    const llm = ctx.get('llm');
    if (!system || !sel || !llm?.stream) return 'no card or no model';
    const effort = cfg.sayEffort ? (await effortFor(ctx, sel, cfg.sayEffort)).effort : sel.reasoningEffort;
    const out = [];
    for (const k of spec.cases ?? []) {
      const said = await Promise.all(Array.from({ length: Math.min(20, spec.times ?? 5) }, async () => {
        try { const e = k.effort ? (await effortFor(ctx, sel, k.effort)).effort : effort; return (await collectReply(llm.stream({ provider: sel.provider, model: sel.model, ...(e ? { reasoningEffort: e } : {}), system: k.system || system, maxTokens: k.effort ? 4000 : cfg.sayMaxTokens, messages: [createUserMessage({ content: [{ type: 'text', text: k.text }], source: { kind: 'dsh-dot', form: 'say-test' } })] }))).text; } catch (error) { return `!! ${error.message}`; }
      }));
      out.push({ name: k.name, said });
    }
    writeFileSync(`${f}.out.json`, `${JSON.stringify({ at: Date.now(), model: `${sel.provider}/${sel.model}`, effort: effort ?? '', out }, null, 1)}\n`);
    audit('voicetest', { file: f, cases: out.length });
    return `${out.length} case(s) → ${f}.out.json`;
  }
  // Each night, once she is asleep: checked, then amended where the check would change something. What was there
  // before stays in the check's file (each op carries the line as it was), and every change is in the audit log.
  ctx.effect(() => sleep.onSleep(() => {
    if (!cfg.nightcheck) return;
    void (async () => { try { await nightcheck(); const done = await nightcheck({ apply: true }); audit('nightcheck-night', { done: String(done).slice(0, 300) }); } catch (error) { logger.warn(`nightcheck failed: ${error.message}`); audit('nightcheck-failed', { error: String(error.message).slice(0, 200) }); } })();
  }), 'dsh-dot: nightcheck when she falls asleep');
  const awake = sleep.awake, wakeUp = sleep.wakeUp, stir = sleep.stir;
  const sleeps = sleepsAtAll(cfg.awakeHours);
  turnNote({ name: 'dot:woke', order: 898, text: ({ agent }) => (agent.session.id === lastSession ? sleep.wokeNote() : '') });
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
  let pushes = []; // her phone's pushes that no one sent (see wake): shown with the next thing that reaches her
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
  const armPhoneHome = (afterMs = cfg.phoneHomeAfterMs) => {
    clearTimeout(phoneHomeTimer); phoneHomeTimer = null;
    if (!(cfg.phoneHomeAfterMs > 0)) return;
    phoneHomeTimer = setTimeout(() => {
      phoneHomeTimer = null;
      if (hands?.busy() || !phone()?.isReady) return;
      Promise.resolve(phone().adbExec?.(['shell', 'input', 'keyevent', 'KEYCODE_HOME'])).then(() => audit('phone-home', { afterMs })).catch((err) => logger.debug?.(`phone home: ${err.message}`));
    }, afterMs);
    phoneHomeTimer.unref?.();
  };
  ctx.effect(() => () => clearTimeout(phoneHomeTimer), 'dsh-dot: phone back to its home screen');
  // The book of things (ledger.js): every thing she gives her hands, and what came of it.
  const ledger = createLedger({ store });
  // What he said yes to (consent.js).
  const consent = createConsent({ store });
  const costOf = (e) => (Number(e?.tokens?.in) || 0) + (Number(e?.tokens?.out) || 0) + 0.1 * (Number(e?.tokens?.cached) || 0);
  // Which device each of her hands' sessions is for: they are offered that device's tools and no other's (compat).
  const handsDevices = new Map(); let handsMaking = '';
  // A thing on this machine itself (device 'host') is done from its own folder under the hands': a command is routed by
  // the folder it comes from (computer/subprocess.js), and that folder says "here, not in her computer".
  const handsHostDir = resolve(join(dshHome(), 'dsh-dot-hands', 'host'));
  const atHandsHost = (cwd) => { if (!cwd) return false; const p = resolve(String(cwd)); return p === handsHostDir || p.startsWith(handsHostDir + sep); };
  const handsPlace = (id, cwd) => (atHandsHost(cwd) ? 'host' : id ? handsDevices.get(id) ?? handsMaking : '');
  hands = createHands({
    dir: join(dshHome(), 'dsh-dot-hands'),
    create: async (dir, device = '') => {
      const cwd = device === 'host' ? handsHostDir : dir;
      if (device === 'host') { try { mkdirSync(cwd, { recursive: true }); } catch (error) { void error; } }
      const controller = ctx.get('sessionController');
      if (!controller) return '';
      handsMaking = device; // the session being made now is for this device (compat asks, before its id is known here)
      // With their own preset (only the host tools doing takes); a host that does not know it refuses it — then as before.
      let made = null;
      try { made = await controller.create({ cwd, agentPreset: HANDS_PRESET }); } catch (err) { audit('hands-preset-refused', { why: String(err?.message ?? err).slice(0, 200) }); }
      try { made ??= await controller.create({ cwd }); } catch (err) { logger.warn(`hands session not created: ${err.message}`); return ''; }
      const { sessionId } = made ?? {};
      try { await controller.rename?.({ sessionId, title: 'dot · 手' }); } catch (error) { void error; }
      if (sessionId) { handsDevices.set(sessionId, device); if (handsDevices.size > 40) handsDevices.delete(handsDevices.keys().next().value); }
      handsMaking = '';
      return sessionId ?? '';
    },
    agentFor: handsAgent,
    onEvent: (fn) => ctx.on('session/event', fn),
    message: (text) => createUserMessage({ content: [{ type: 'text', text }], source: HANDS_SOURCE }),
    textOf: contentText,
    store, ledger,
    done: () => prompt('dot.hands.done-missing'),
    overCap: (e) => (cfg.thingCostCap > 0 && costOf(e) > cfg.thingCostCap && !consent.allows({ kind: 'spend', thing: e.id }) ? prompt('dot.gates.spend.q', { tokens: Math.round(costOf(e) / 1000) }) : ''),
    // A session her hands are done with is put away: one per thing, so they pile up otherwise.
    retire: async (id) => { try { await ctx.get('workspaceRegistry')?.archiveSession?.(id); } catch (err) { logger.debug?.(`hands session not archived: ${err.message}`); } },
    audit, maxMs: cfg.handsMaxMs,
    // The thing is over, or her hands need her: what they said, and the screen as it is now for her own eyes, come
    // to her conversation and wake her. Nothing else of theirs does. What she makes of it — and whether he hears of
    // it — is hers: on his business the message says whose it is, and she tells him with qq_send.
    // A thing stopped on someone's word wakes nobody: whoever said stop knows, and the ledger has how far it got.
    onDone: (r, job) => {
      learnFrom(job);
      if (job.device === 'phone') armPhoneHome(r.outcome === 'stuck' ? cfg.handsStuckHoldMs : cfg.phoneHomeAfterMs);
      if (r.outcome !== 'stopped') return handsBack(r, job);
      audit('hands-result', { thing: job.id, status: 'stopped', forHim: Boolean(job.forHim), steps: r.steps, rounds: r.rounds, woke: false });
      // He stopped it from outside her conversation (/dot stop): she finds a line about it the next time she is up, no more.
      if (r.cause === 'command') void noteToConversation('hands-stopped', `${prompt('dot.hands.result', { stamp: stamp(Date.now(), Date.now()), task: job.task, status: handsStatus(r, job.device), text: resultText(r) }).trim()}`);
      return undefined;
    },
  });
  /** What came of a thing, for her: the hands' summary, then their details. */
  const resultText = (r) => [r.summary, r.detail].map((x) => String(x ?? '').trim()).filter(Boolean).join('\n') || '（没说什么）';
  async function handsBack(r, job) {
    stir();
    try {
      await moved(); // her conversation is being handed over: it goes to the new one
      const found = lastSession && await resolveLive(lastSession);
      if (!found || 'error' in found) { audit('hands-result-dropped', { why: 'no conversation' }); return; }
      if (r.shown) { try { ctx.get('dotMemory')?.shownTo?.(lastSession, r.shown); } catch (error) { void error; } }
      const lead = r.question && r.ask?.for === 'him'
        ? prompt('dot.hands.ask.him', { stamp: stamp(Date.now(), Date.now()), task: job.task, question: r.question, text: r.detail && r.detail !== r.question ? r.detail : '' })
        : r.question
        ? prompt('dot.hands.ask', { stamp: stamp(Date.now(), Date.now()), task: job.task, question: r.question, text: r.detail && r.detail !== r.question ? r.detail : '' })
        : prompt('dot.hands.result', { stamp: stamp(Date.now(), Date.now()), task: job.task, status: handsStatus(r, job.device), text: resultText(r) });
      const owed = job.id ? ledger.get(job.id)?.awaiting : null;
      const owes = !owed?.from ? '' : `\n${prompt(owed.answeredAt ? 'dot.hands.result.answered' : 'dot.hands.result.awaiting', { from: owed.from, text: owed.text ?? '' }).trim()}`;
      const content = [{ type: 'text', text: lead.trim() + owes + (job.forHim && r.ask?.for !== 'him' ? `\n${prompt(r.question ? 'dot.hands.ask.his' : 'dot.hands.result.his').trim()}` : '') }];
      if (r.outcome !== 'failed' && job.device !== 'web' && job.device !== 'host') { // looking something up, or a shell on this machine, leaves no screen to show
        try {
          const images = ctx.get('attachments');
          const png = typeof images?.saveImages !== 'function' ? null : job.device === 'phone' ? (phone()?.isReady ? await phone().screenshot() : null) : await computerScreen();
          if (png?.length && job.id) { try { const dir = join(dshHome(), 'dsh-dot-things'); mkdirSync(dir, { recursive: true }); const shot = join(dir, `${job.id}.png`); writeFileSync(shot, png); ledger.note(job.id, { shot }); const kept = new Set(ledger.recent(100).map((e) => `${e.id}.png`)); for (const f of readdirSync(dir)) if (!kept.has(f)) rmSync(join(dir, f), { force: true }); } catch (err) { logger.debug?.(`thing ${job.id}: screen not kept: ${err.message}`); } }
          if (png?.length) { const [image] = await images.saveImages([{ data: new Uint8Array(png), mediaType: 'image/png', name: `${job.device}-screen` }]); if (image) content.push({ type: 'text', text: prompt(job.device === 'computer' ? 'dot.hands.screen.computer' : 'dot.hands.screen').trim() }, { type: 'image', attachment: image }); }
        } catch (err) { logger.debug?.(`hands: no screenshot: ${err.message}`); }
      }
      found.agent.followup(createUserMessage({ content, source: { kind: 'dsh-dot', form: 'hands-result', ...(job.forHim ? { for: 'him' } : {}), ...(job.id ? { thing: job.id } : {}) } }));
      if (job.id) ledger.note(job.id, { told: Date.now() });
      audit('hands-result', { thing: job.id, session: lastSession, outcome: r.outcome, forHim: Boolean(job.forHim), steps: r.steps, rounds: r.rounds });
    } catch (err) { logger.warn(`hands result not delivered: ${err.message}`); }
  }
  // A thing a restart cut off is told to her once, when her conversation can be reached.
  ctx.effect(() => { const t = setTimeout(() => { for (const cut of hands.interrupted()) void handsBack({ outcome: 'failed', by: 'code', cause: 'restart', steps: 0, rounds: 0 }, { id: cut.id, device: cut.device, task: cut.task, forHim: cut.asker === 'him' }); }, 20000); t.unref?.(); return () => clearTimeout(t); }, 'dsh-dot: what a restart cut off');
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
      // An answer a thing of his was waiting for makes this turn his business: what comes of it is told to him.
      const answer = items.find((n) => n.answers);
      const noted = answer ? `\n${prompt('dot.notification.awaited', { task: head(String(answer.answersTask ?? '').split(/[。\n]/)[0], 60) }).trim()}${answer.forHim ? `\n${prompt('dot.hands.result.his').trim()}` : ''}` : '';
      const content = contentFor(wakeText(items, { whileBusy, cards }) + noted, items);
      found.agent.followup(createUserMessage({ content, source: answer ? { ...PHONE_NOTIFICATION_SOURCE, thing: answer.answers, ...(answer.forHim ? { for: 'him' } : {}) } : PHONE_NOTIFICATION_SOURCE }));
      bump('woke', 1);
      audit('notification-woke', { session: id, count: items.length, pkgs: [...new Set(items.map((n) => n.pkg))], whileBusy, sinceSeenMs: Date.now() - Date.parse(items[0].at), sincePostedMs: items[0].postedAt ? Date.now() - items[0].postedAt : undefined });
    }).catch((err) => { logger.warn(`wake for notification failed: ${err.message}`); audit('notification-dropped', { pkgs, why: err.message }); });
  };
  // ── her side of the conversation with him ──
  // Writing (a turn of his words is open, `turns`), sending (her bubbles are going out, outlet.busy()), or neither.
  // One rule for both: what has not reached him yet gives way to what he just said; what has reached him stands.
  let ackHold = null;   // the answer to his turn that opened a thing, held for a moment (see the voice at a turn's end)
  const dropAck = (why) => { if (!ackHold) return; clearTimeout(ackHold.timer); ackHold = null; audit('ack-dropped', { why }); };
  /** Is something he asked for still in her hands (queued or running)? */
  const hisUnderWay = () => ledger.unfinished().some((e) => e.asker === 'him');
  let preempts = 0;     // her words in a row that gave way before anything of hers reached him (see defaults.ownerPreemptMax)
  /** Her transcript gets what reached him, not what she wrote (dsh-dot/memory). */
  const herSaid = (id, text) => { try { if (String(text ?? '').trim()) ctx.get('dotMemory')?.herSaid?.({ session: id, text }); } catch (err) { logger.warn(`transcript: ${err.message}`); } };
  const replyChecks = () => { try { return cfg.replyCheck ? ctx.get('dshInterlude')?.checks?.() ?? [] : []; } catch { return []; } };
  /** Has he said something she has not read — still in the buffer, or held while her conversation is being handed over? */
  const hisUnread = () => ownerBatch.length > 0 || frozenQueue.some((n) => n.fromOwner);
  /** What is in her hands, as the call that writes her words is told it: from the code, not from what she says she is doing. */
  // What the voice is told about her doings comes from the book, never from what she wrote: one line a thing, no task
  // text beyond its first clause (11-21: given the whole task, the voice read it out as progress).
  const titleOf = (task) => { const t = String(task ?? '').split(/[。\n]/)[0].trim(); return t.length > 40 ? `${head(t, 40)}…` : t; };
  // What the voice is given comes in two shapes, by what the book has for this turn.
  // A report (planFor): a thing of this turn ended, was stopped, or was begun — the book's own sentences, plain and in
  // the first person, which the voice says her way and to which it adds nothing (say.js reportInput). `must` is what
  // is said; `may` is the thing's detail, given when it is what he asked for.
  // Talk (factsFor): nothing of this turn is in the book — she is talking with him; the voice has the conversation,
  // and is told what is in her hands so that it does not make up doings.
  const nameOf = (task) => titleOf(String(task ?? '').replace(/^（[^）]*）/, ''));
  const planFor = (t) => {
    const must = [], may = [];
    const about = t?.thing ? ledger.get(t.thing) : null;
    if (about?.state === 'ended') {
      const what = nameOf(about.task);
      if (about.ask?.tier && about.ask.what) must.push(prompt(about.ask.tier === 'him' ? 'dot.plain.gate.him' : 'dot.plain.gate.ask', { what, step: about.ask.what }));
      else if (about.question) must.push(prompt('dot.plain.stuck', { what, question: about.question }));
      else if (about.outcome === 'done') must.push(about.summary ? prompt('dot.plain.done', { what, summary: about.summary }) : prompt('dot.plain.done.bare', { what }));
      else must.push(prompt('dot.plain.notdone', { what, how: voiceHow(about), summary: about.summary ? prompt('dot.plain.summary', { summary: about.summary }).trim() : '' }));
      if (about.detail && !about.question) may.push(headTail(about.detail, cfg.sayDetailChars));
      if (about.awaiting?.from) must.push(prompt(about.awaiting.answeredAt ? 'dot.plain.answered' : 'dot.plain.awaiting', { from: about.awaiting.from, text: about.awaiting.text ?? '' }));
    }
    for (const id of t?.stopped ?? []) { const e = ledger.get(id); if (e) must.push(prompt('dot.plain.stopped', { what: nameOf(e.task), how: voiceHow(e) || prompt('dot.plain.how.stopped.her').trim() })); }
    // Of things just given to her hands nothing is said but that they are being done — not even what they are: he has
    // just said it himself, and with the task in front of it the voice told it as done (11-24: 12 of 20 with the task
    // named, 1 of 20 without).
    const said = must.length;
    const going = (t?.opened ?? []).map((id) => ledger.get(id)).filter((e) => e && e.state !== 'ended');
    if (going.length > 1) must.push(prompt('dot.plain.opened.many', { n: going.length }));
    else if (going.length) must.push(prompt(going[0].state === 'queued' ? 'dot.plain.queued' : 'dot.plain.opened'));
    return must.length ? { his: t?.hisWords ?? '', must: must.map((x) => x.trim()), may, underway: !said } : null;
  };
  const factsFor = (t) => {
    const out = [];
    const mine = new Set([...(t?.opened ?? []), ...(t?.stopped ?? []), t?.thing].filter(Boolean));
    const rest = ledger.unfinished().filter((e) => !mine.has(e.id));
    for (const e of rest.filter((x) => x.state === 'running')) out.push(prompt('dot.say.fact.running', { what: titleOf(e.task), since: ago(e.startedAt ?? e.openedAt, Date.now()) ? `（${ago(e.startedAt ?? e.openedAt, Date.now())}前开始的）` : '' }));
    const waiting = rest.filter((x) => x.state === 'queued').length;
    if (waiting) out.push(prompt('dot.say.fact.waiting', { n: waiting }));
    if (!out.length) out.push(prompt('dot.say.fact.none'));
    return out.map((x) => x.trim());
  };
  const outlet = createOutlet({
    qq: () => ctx.get('dshQq'), im,
    here: () => { const t = turns.get(lastSession); return Boolean(t?.elsewhere && !t.fromQq); },
    herSaid: (text) => herSaid(lastSession, text),
  });
  // What she says (say.js): written by a call that is only her card, checked once, and carried out from here —
  // to his QQ or anyone's (her bubbles one after another; qq.send stops between them when he speaks), to her own
  // window when that is where he is talking to her (the tool's output is what he reads there), or over the IM
  // channel when her QQ is not connected.
  const say = createSay({
    card: () => { try { return ctx.get('dshInterlude')?.cardText?.() ?? ''; } catch { return ''; } },
    call: async ({ system, text }) => {
      // What this side sends (compare with the model gate's say-request: the same system, nothing added on the way).
      audit('say-call', { systemChars: system.length, systemSha: createHash('sha256').update(system).digest('hex').slice(0, 12), userChars: text.length });
      const sel = ctx.get('agentDefaultModel')?.currentSelection?.();
      const llm = ctx.get('llm');
      if (!sel || !llm?.stream) throw new Error('no model to say it with');
      const effort = cfg.sayEffort ? (await effortFor(ctx, sel, cfg.sayEffort)).effort : sel.reasoningEffort;
      const reply = await collectReply(llm.stream({ provider: sel.provider, model: sel.model, ...(effort ? { reasoningEffort: effort } : {}), system, maxTokens: cfg.sayMaxTokens, messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-dot', form: 'say' } })] }));
      return reply.text;
    },
    recent: (n) => { try { return ctx.get('dotMemory')?.recent?.(n) ?? []; } catch { return []; } },
    stickers: () => { try { return ctx.get('dshQq')?.stickerList?.() ?? []; } catch { return []; } },
    check: (text) => (cfg.replyCheck ? checkReply(text, replyChecks()) : { lines: String(text).split('\n').map((l) => l.trim()).filter(Boolean), hits: [] }),
    unread: (to) => to === 'owner' && preempts < cfg.ownerPreemptMax && hisUnread(),
    lines: cfg.sayLines,
    audit: (event, data) => audit(event, { session: lastSession, ...data }),
    send: (m) => outlet.send(m),
  });
  /** What went out, told back to her: the lines and pictures as they were sent. */
  let saidNote = '';
  const saidText = (r) => prompt(r.interrupted ? 'dot.say.interrupted' : 'dot.say.said', { said: [...(r.said ?? []), ...(r.images ?? []).map((i) => `[${i}]`)].join('\n') || '（只发了图）', unsent: (r.unsent ?? []).join('\n') });
  /**
   * Something of hers for him, in turn `t` (the open one, or the one that just ended): what she knows that bears on it
   * (`about`, from the say tool) or what she wrote she means to tell him (`meant`, a turn's closing words). The same
   * call writes it either way; here is what the turn and the day keep of it.
   */
  async function tellHim(t, { about = '', images = [] } = {}) {
    // Nothing of his is waiting for an answer when the turn was not opened by his words (her hands came back, a notification, her own time).
    const plan = planFor(t), facts = plan ? [] : factsFor(t);
    audit('say-facts', { facts: (plan ? plan.must : facts).map((f) => f.slice(0, 160)), about: String(about ?? '').slice(0, 160), ...(plan ? { report: true, may: plan.may.length } : {}) });
    // A question for him that needs the screen (a QR code to scan): it goes with what she says.
    const ended = t?.thing ? ledger.get(t.thing) : null;
    const shots = ended?.outcome === 'stuck' && ended.ask?.screen && (ended.device === 'phone' || ended.device === 'computer') ? [`${ended.device}:screen`] : [];
    const r = await say.speak({ to: 'owner', about, facts, plan, images: [...[].concat(images ?? []), ...shots], unprompted: !(t?.fromQq || t?.elsewhere) });
    if (r.status === 'held') preempts++;
    if (r.status !== 'said') return r;
    preempts = 0; // something of hers reached him
    if (t) t.spoke = true;
    saidNote = saidText(r); // hers to know: shown with whatever reaches her next
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
    owe(id);
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
    sending: outlet.busy(),                                        // her bubbles are going out
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
      parameters: { type: 'object', properties: { device: { type: 'string', enum: ['phone', 'computer', 'web', 'host'], description: 'phone / computer：在你的那台设备上做；web：查资料，不碰设备；host：在他这台电脑本机上用命令行做（他开口要的才交）' }, do: { type: 'string', description: '要做成的事，说完整；要打的字原样写上。手上的事停在要你拿主意的地方时，这里写你的回答' }, say: { type: 'string', description: '这件事里要打给别人看的话（评论、回帖、在 App 里回人）：写你想说的意思，原话会替你写好、照着打上去' }, add: { type: 'string', description: '给正在做的那件事补一句（他又加了要求、你想起一点）：它下一步之前就看到，接着做' }, stop: { type: 'boolean', description: '手上的事不做了' }, after: { type: 'boolean', description: '接着这台设备上一件停下的事做（它停在要他来、要你定的地方，现在可以接着了）：屏幕还停在那里' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'started' ? prompt('dot.hands.started') : v?.status === 'added' ? prompt('dot.hands.added') : v?.status === 'queued' ? prompt('dot.hands.queued', { task: v.doing?.task ?? '' }) : v?.status === 'stopped' ? prompt('dot.hands.stopped') : v?.status === 'idle' ? prompt(_a?.add ? 'dot.hands.add.idle' : 'dot.hands.idle') : `没开始：${v?.why ?? ''}` }] },
      async execute(args) {
        if (args?.stop) { const open = ledger.unfinished().map((e) => e.id); const t = turns.get(lastSession); const stopped = hands.stop({ by: t?.fromQq || t?.elsewhere ? 'him' : 'her' }); if (stopped && t) t.stopped = [...(t.stopped ?? []), ...open]; return { status: stopped ? 'stopped' : 'idle' }; }
        // Words her hands are to type for someone to read are hers to mean and the card's to write (say.js): they go
        // into what her hands are given, as the words to type.
        let words = '';
        if (String(args?.say ?? '').trim()) {
          try { words = await say.compose({ about: args.say, where: String(args?.do ?? '').trim() }); } catch (err) { return { status: 'failed', why: `要打的话没写出来：${err.message}` }; }
          if (!words) return { status: 'failed', why: '这句话她不想说，没有交出去' };
        }
        const given = [String(args?.do ?? '').trim(), words ? prompt('dot.hands.words', { words }).trim() : ''].filter(Boolean).join('\n');
        // One more thing for the hands at work: read between two of their steps.
        if (String(args?.add ?? '').trim()) { const added = hands.add([String(args.add).trim(), words ? prompt('dot.hands.words', { words }).trim() : ''].filter(Boolean).join('\n')); const t = turns.get(lastSession); if (t && added.status === 'added') t.answered = true; return added; }
        const device = args?.device === 'computer' ? 'computer' : args?.device === 'web' ? 'web' : args?.device === 'host' ? 'host' : 'phone';
        // Whose business this is: his (a turn his words opened, or one her hands came back to on his business) or her own.
        const t = turns.get(lastSession);
        const forHim = Boolean(t && !t.scheduled && (t.fromQq || t.elsewhere || t.forHim));
        // This machine is his: her hands go there on his business only, never in her own time.
        if (device === 'host' && !forHim) { audit('hands-host-refused', { session: lastSession }); return { status: 'failed', why: prompt('dot.hands.host.his').trim() }; }
        if (device === 'phone') { clearTimeout(phoneHomeTimer); phoneHomeTimer = null; }
        // Given in the turn a thing came back to: it carries on from where that one stopped — the device is as it was left.
        // Or, asked for, the last thing on that device that stopped short (his yes came in a later turn of his).
        const before = t?.thing ? ledger.get(t.thing) : args?.after ? ledger.recent(10).find((e) => e.device === device) : null;
        const after = before?.state === 'ended' && before.outcome !== 'done' ? `\n${prompt('dot.hands.after', { task: before.task, where: before.question ? `问过：${before.question}` : before.summary || before.detail ? `停下时说的是：${head(before.summary || before.detail, 300)}` : '没有留下话' }).trim()}` : '';
        const started = await hands.start({ device, task: `${prompt(device === 'computer' ? 'dot.hands.where.computer' : device === 'web' ? 'dot.hands.where.web' : device === 'host' ? 'dot.hands.where.host' : 'dot.hands.where.phone').trim()}${given}${after}`, forHim, ...(before && after ? { after: before.id } : {}) });
        if (started?.id && t) t.opened = [...(t.opened ?? []), started.id];
        return started;
      },
    }), 'dsh-dot: hands tool');
    // Her one way of saying something to anyone (say.js). She gives what she knows that bears on it — or nothing —
    // and the words are written by a call that is only her card; what went out comes back to her as the result.
    scope.effect(() => scope.tools.register({
      name: SAY_TOOL,
      description: prompt('dot.say-tool'),
      parameters: { type: 'object', properties: { to: { type: 'string', description: '说给谁：不填就是他；别人填 user:<QQ号>，群里填 group:<群号>' }, about: { type: 'string', description: '这次要让对方知道的事，一句话；手上那件事的结果不用复述（会照记录给到），写你的看法、打算或要他做的；只是接他的话、没有要告诉他的事，就不填' }, context: { type: 'string', description: '说给别人时：对方刚说了什么、在哪说的' }, images: { type: 'array', items: { type: 'string' }, description: '要一起发的图："phone:screen"、"computer:screen"、"phone:latest"、图片网址。表情包不用填，会自己挑' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'needs-ok' ? prompt('dot.gates.asked.her', { what: v.what ?? '' }) : v?.status === 'said' ? saidText(v) : v?.status === 'silent' ? prompt('dot.say.silent') : v?.status === 'held' ? prompt('dot.owner-interrupt') : `没说成：${v?.why ?? ''}` }] },
      async execute(args) {
        const to = String(args?.to ?? '').trim() || 'owner';
        if (isOwnerTarget(to, ctx.get('dshQq')?.owner)) return tellHim(turns.get(lastSession), { about: args?.about, images: args?.images });
        // Someone she does not talk with, a group gone quiet, a file off her devices: his yes first (gates.js).
        const why = ctx.get('dshQq')?.gateFor?.({ to, images: args?.images ?? [] });
        if (why) {
          const k = approvalKind('qq_send', why);
          if (!consent.allows({ kind: k.kind, subject: k.subject })) { consent.ask(k); audit('consent-asked', { session: lastSession, kind: k.kind, to }); return { status: 'needs-ok', what: k.what }; }
          audit('consent-used', { session: lastSession, kind: k.kind, to });
        }
        return say.speak({ to, about: args?.about, context: args?.context, images: args?.images });
      },
    }), 'dsh-dot: say tool');
    // His yes, in his own words (consent.js): only in a turn his words opened, kept with the kind of thing it is for.
    scope.effect(() => scope.tools.register({
      name: HIS_OK_TOOL,
      description: prompt('dot.gates.ok-tool'),
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: Object.keys(KINDS), description: Object.entries(KINDS).map(([k, v]) => `${k}：${v}`).join('；') }, always: { type: 'boolean', description: '他明说以后这种都行才填 true' } }, required: ['kind'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: prompt(v?.status === 'ok' ? 'dot.gates.ok' : 'dot.gates.ok.refused', { what: KINDS[v?.kind] ?? '' }) }] },
      async execute(args) {
        const t = turns.get(lastSession);
        const kind = String(args?.kind ?? '');
        if (!KINDS[kind] || !(t?.fromQq || t?.elsewhere)) { audit('consent-refused', { session: lastSession, kind }); return { status: 'refused', kind }; }
        // A yes answers a question: the newest thing of this kind that stopped to ask him, or that she was told to ask
        // him about. With none waiting there is nothing for it to be a yes to.
        const since = Date.now() - 6 * 3600_000;
        const waiting = [
          ...ledger.recent(10).filter((e) => e.outcome === 'stuck' && e.ask?.for === 'him' && e.ask.tier !== 'him' && e.ask.kind === kind && !e.askSettled && (e.endedAt ?? 0) >= since).map((e) => ({ at: e.endedAt, subject: e.ask.subject ?? '' })),
          ...consent.asking().filter((a) => a.kind === kind).map((a) => ({ at: a.at, subject: a.subject ?? '' })),
        ].sort((a, b) => b.at - a.at)[0];
        // Nothing has stopped to ask him: he asked for this himself, in the words of this turn. That counts as his yes
        // (11-23, his decision) — for the next thing of this kind, once. Whether his words do ask for it is her reading:
        // the code has his words on record with it, not a check of them.
        if (!waiting) {
          const g = consent.grant({ kind, words: t.hisWords ?? '', ahead: true });
          audit('consent-granted', { session: lastSession, kind, subject: '', always: false, ahead: true, words: g.words.slice(0, 80) });
          return { status: 'ok', kind };
        }
        const g = consent.grant({ kind, subject: waiting.subject, words: t.hisWords ?? '', always: Boolean(args?.always) });
        audit('consent-granted', { session: lastSession, kind, subject: g.subject, always: g.always });
        return { status: 'ok', kind };
      },
    }), 'dsh-dot: his yes');
    // Her hands' one way of coming back with a question (hands.js): a choice that is hers, words that have to be hers.
    // Said with a tool, so "they need her" is a fact the code has and not something read out of a report.
    scope.effect(() => scope.tools.register({
      name: HANDS_ASK_TOOL,
      description: prompt('dot.hands.ask-tool'),
      parameters: { type: 'object', properties: { question: { type: 'string', description: '要定的事，一两句说清；要选的东西一条一条列出来' }, for: { type: 'string', enum: ['her', 'him'], description: 'her：她来定（默认）；him：只有他能做的一步（发到他手机上的验证码、扫码、人脸、付款最后一步）' }, screen: { type: 'boolean', description: '要把现在的屏幕一起给他看（比如二维码）' } }, required: ['question'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: prompt(v?.status === 'asked' ? 'dot.hands.asked' : 'dot.hands.idle') }] },
      async execute(args) { return { status: hands.ask(args?.question, { for: args?.for, kind: args?.for === 'him' ? (/验证码|校验码|动态码/.test(String(args?.question ?? '')) ? 'code' : 'him') : undefined, screen: args?.screen }) ? 'asked' : 'idle' }; },
    }), 'dsh-dot: hands ask tool');
    // Her hands' one way of waiting (11-23): what they wait for is said as a condition the code can see — words that
    // come onto the screen, words that leave it, a notification — with a limit. The code looks; they pay one step,
    // and get the screen as it is when the wait ends. Someone's answer (a reply, a receipt) is not waited for here:
    // it reaches her as a notification, whenever it comes.
    scope.effect(() => scope.tools.register({
      name: HANDS_WAIT_TOOL,
      description: prompt('dot.hands.wait-tool', { max: Math.round(cfg.waitMaxMs / 1000) }),
      parameters: { type: 'object', properties: { text: { type: 'string', description: '等屏幕上出现这几个字' }, gone: { type: 'string', description: '等屏幕上这几个字消失（"加载中""下载中"）' }, notification: { type: 'string', description: '等一条通知：填 App 名、标题或内容里的几个字' }, seconds: { type: 'number', description: '最多等多少秒；只填它就是单纯等这么久' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'idle' ? prompt('dot.hands.idle') : prompt(v?.status === 'met' ? 'dot.hands.wait.met' : v?.status === 'waited' ? 'dot.hands.wait.waited' : 'dot.hands.wait.timeout', { what: v?.what ?? '', seconds: v?.seconds ?? 0, screen: v?.screen || '（屏幕上的字读不出来）' }) }] },
      async execute(args) {
        const mine = hands.doing();
        if (!mine) return { status: 'idle' };
        const want = { text: String(args?.text ?? '').trim(), gone: String(args?.gone ?? '').trim(), note: String(args?.notification ?? '').trim() };
        const any = Boolean(want.text || want.gone || want.note);
        const limit = Math.max(1000, Math.min(cfg.waitMaxMs, (Number(args?.seconds) > 0 ? Number(args.seconds) * 1000 : any ? cfg.waitMaxMs : 5000)));
        // What came since they last did something counts: the notification may be here before the wait is asked for.
        const since = handsActedAt || Date.now(), began = Date.now();
        const onPhone = mine.device === 'phone' && Boolean(phone()?.isReady);
        const look = async () => { try { return onPhone ? await phone().screenItems() : []; } catch { return []; } };
        const words = (items) => items.map((it) => it.words ?? '').join('\n');
        let items = [], met = '';
        for (;;) {
          if (hands.doing()?.id !== mine.id) return { status: 'idle' }; // the thing was stopped meanwhile
          if (want.note) { const n = seenNotes.find((x) => x.at >= since && `${x.pkg}\n${x.title}\n${x.text}`.toLowerCase().includes(want.note.toLowerCase())); if (n) met = `来了一条通知：${[n.title, n.text].filter(Boolean).join('：').slice(0, 200)}`; }
          if (!met && (want.text || want.gone) && onPhone) { items = await look(); const w = words(items); if (want.text && w.includes(want.text)) met = `屏幕上出现了「${want.text}」`; else if (want.gone && items.length && !w.includes(want.gone)) met = `屏幕上没有「${want.gone}」了`; }
          if (met || Date.now() - began >= limit) break;
          await new Promise((r) => setTimeout(r, Math.min(cfg.waitPollMs, Math.max(50, limit - (Date.now() - began)))));
        }
        if (!items.length) items = await look();
        const seconds = Math.round((Date.now() - began) / 1000);
        audit('hands-wait', { thing: mine.id, met: Boolean(met), seconds, ...(want.text ? { text: true } : {}), ...(want.gone ? { gone: true } : {}), ...(want.note ? { notification: true } : {}) });
        return { status: met ? 'met' : any ? 'timeout' : 'waited', what: met || [want.text && `「${want.text}」出现`, want.gone && `「${want.gone}」消失`, want.note && `「${want.note}」的通知`].filter(Boolean).join('、'), seconds, screen: onPhone ? screenLines(items) : '' };
      },
    }), 'dsh-dot: hands wait tool');
    // Her hands' one way of saying a thing is done (hands.js): what came of it, as a line and as details. The book keeps
    // both; each reader words them for itself (the voice gets the line, she gets both with the screen).
    scope.effect(() => scope.tools.register({
      name: HANDS_DONE_TOOL,
      description: prompt('dot.hands.done-tool'),
      parameters: { type: 'object', properties: { summary: { type: 'string', description: '一句话的结果，不超过 40 个字，写事实，不用「我」' }, detail: { type: 'string', description: '给她看的细节：做成了什么、屏幕上现在是什么、卡在哪，最多五六行' }, task: { type: 'string', description: '这件事的短名，八个字以内（如「看消息」「装App」「搜商品」）；同一件事每次用同一个名字' }, awaiting: { type: 'string', description: '这件事里给谁发了东西（短信、消息、申请）就要填：还在等对方回，填对方在屏幕上显示的名字或号码（会话标题那样）——回了会带着这件事叫她，不用守着；不用等谁回（对方已经回了、或者本来就不会回），填空字符串' }, reached: { type: 'boolean', description: '要的那个样子到了没有：到了 true，没到 false' } }, required: ['summary', 'reached'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: prompt(v?.status === 'done' ? 'dot.hands.done' : v?.status === 'unsaid' ? 'dot.hands.done.unsaid' : v?.status === 'unsaid-awaiting' ? 'dot.hands.done.unsaid-awaiting' : 'dot.hands.idle') }] },
      // Whether what was wanted was reached is theirs to say and nobody's to guess: left out, the thing is not ended either way.
      async execute(args) {
        if (typeof args?.reached !== 'boolean') return { status: 'unsaid' };
        // Sent, and an answer is owed: written on the thing before it ends (its end is told from the book). Whoever
        // has answered meanwhile — a notification since the thing began — is on the record as the answer.
        const doing = hands.doing(), from = String(args?.awaiting ?? '').trim().slice(0, 60);
        if (doing?.id && args.reached && reached.has(doing.id) && typeof args?.awaiting !== 'string') return { status: 'unsaid-awaiting' };
        if (doing?.id && from && args.reached) {
          const began = ledger.get(doing.id)?.startedAt ?? Date.now();
          const got = [...seenNotes].reverse().find((n) => n.at >= began && sameName(from, conversationTitle(n.title)));
          ledger.note(doing.id, { awaiting: { from, since: Date.now(), until: Date.now() + cfg.awaitMs, ...(got ? { answeredAt: got.at, text: head(got.text, 300) } : {}) } });
          audit('awaiting', { thing: doing.id, from, answered: Boolean(got) });
        }
        const ended = hands.finish({ summary: args?.summary, detail: args?.detail, task: args?.task, reached: args.reached });
        if (!ended && doing?.id && from) ledger.note(doing.id, { awaiting: null });
        return { status: ended ? 'done' : 'idle' };
      },
    }), 'dsh-dot: hands done tool');
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
    if (!agent && outlet.busy() && ownerBatch.length) { void outlet.settled().finally(() => flushOwner()); return 0; }
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
  // Apps whose notification title is who wrote (or called): a conversation with someone.
  const conversationPlatform = { qq: 'qq', 'com.tencent.mobileqq': 'qq', 'com.tencent.mm': 'wechat', 'com.google.android.apps.messaging': 'sms', 'com.android.mms': 'sms', 'com.android.messaging': 'sms', 'com.google.android.dialer': 'call', 'com.android.dialer': 'call' };
  const seenNotes = []; // the last notifications of her phone, with when they came: what wait_for looks through
  const wake = (n) => {
    seenNotes.push({ at: Date.now(), pkg: String(n?.pkg ?? ''), title: String(n?.title ?? ''), text: String(n?.text ?? '') }); if (seenNotes.length > 60) seenNotes.shift();
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
    // The answer a thing was waiting for (see `awaited`): it wakes her whatever kind of notification carries it, as
    // that thing's — and as his business when the thing was his.
    if (!n.fromOwner) { const e = answerTo(n); if (e) n = { ...n, answers: e.id, answersTask: e.task, forHim: e.asker === 'him', handles: n.handles ?? [`${n.pkg}:name:${conversationTitle(n.title)}`] }; }
    if (n.fromOwner) {
      dropAck('he spoke');
      if (!ownerBatch.length) ownerFirstAt = Date.now();
      ownerBatch.push(n); ownerTyping = false; // he pressed send
      wakeUp('him');
      answerReaches();
      armOwner();
      return;
    }
    // Someone writing to her wakes her: a chat whose sender is known (her QQ, a chat app's conversation), or what
    // the app itself calls a message or a call. An app's own push wakes no one: it is held (the latest few) and
    // shown with whatever reaches her next (dot:pushes). What it says is shown as it is; opening it is hers to decide.
    if (!n.handles && n.category !== 'msg' && n.category !== 'call') {
      pushes = [...pushes.filter((p) => p.key !== n.key || !n.key), n].slice(-cfg.pushesKept);
      audit('notification-held', { pkg: n.pkg, why: 'not a person', category: n.category ?? '' });
      return;
    }
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
  /** A call of her hands one of the gates stopped (gates.js): ended as a question for him, refused; null when it goes on. */
  // Things in which a step that reaches someone was let through (a text, a call, a message, a request to be added):
  // whether an answer is owed is then a fact of the thing, and only her hands know it — like whether what was wanted
  // was reached, it is theirs to say and nobody's to guess (11-24: told how, they still left it out, and the reply
  // would again have been tied to nothing).
  const REACHES = new Set(['call', 'message', 'friend', 'send-file']);
  const reached = new Set();
  const gateHands = (g, id, device) => {
    if (!g) return null;
    const thing = hands.doing()?.id ?? '';
    if (g.tier === 'forbid') { audit('gate-forbid', { session: id, device, kind: g.kind, what: g.what, thing }); return deny(prompt('dot.gates.forbid', { what: g.what })); }
    // Not done the way it was asked (a batch that has to be cut shorter): said back to her hands, nobody is asked.
    if (g.tier === 'refuse') { audit('gate-refuse', { session: id, device, kind: g.kind, thing }); return deny(prompt('dot.gates.refuse', { what: g.what })); }
    if (g.tier === 'him') {
      const what = HIM_KINDS[g.kind] ?? g.what;
      hands.ask(prompt('dot.gates.him.q', { what }), { for: 'him', kind: g.kind, tier: 'him', what, ...(g.screen ? { screen: true } : {}) });
      audit('gate-him', { session: id, device, kind: g.kind, what: g.what, thing });
      return deny(prompt('dot.gates.him', { what }));
    }
    if (!consent.allows({ kind: g.kind, subject: g.subject, thing })) {
      hands.ask(prompt('dot.gates.ask.q', { what: g.what }), { for: 'him', kind: g.kind, tier: 'ask', what: g.what, ...(g.subject ? { subject: g.subject } : {}) });
      audit('consent-asked', { session: id, device, kind: g.kind, what: g.what, thing });
      return deny(prompt('dot.gates.ask', { what: g.what }));
    }
    audit('consent-used', { session: id, device, kind: g.kind, thing });
    if (thing && REACHES.has(g.kind)) { reached.add(thing); if (reached.size > 50) reached.delete(reached.values().next().value); }
    return null;
  };
  // The computer's own gate (computer/gate.js) leaves her hands' calls to the gates here, whichever hook runs first.
  ctx.inject(['dshComputer'], (c) => c.effect(() => { const pc = c.dshComputer; pc.handsOf = (exec) => Boolean(hands?.isHands(exec?.agent?.session?.id, exec?.agent?.session?.header?.cwd)); return () => { delete pc.handsOf; }; }, 'dsh-dot: computer gate defers to hands gates'));
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
    if ((exec.name === HANDS_ASK_TOOL || exec.name === HANDS_DONE_TOOL || exec.name === HANDS_WAIT_TOOL) && !theirs) return deny(prompt('dot.lean.not-hers', { tool: exec.name }));
    if (theirs && exec.name !== HANDS_ASK_TOOL && hands.asked()) return deny(prompt('dot.hands.asked'));
    // Her phone is reached with its own tools, where the gates look: not through the shell.
    if (theirs && exec.name === 'bash' && /\b(?:adb|emulator|am\s+start|input\s+(?:tap|text|keyevent))\b/.test(String(args?.command ?? ''))) { audit('gate-shell', { session: id }); return deny(prompt('dot.gates.shell')); }
    // What her hands do on her phone, by the gates' four tiers (gates.js): code decides, from the screen as it was last read.
    if (theirs && (exec.name.startsWith(PHONE_TOOL_PREFIX) || exec.name === PHONE_TYPE_TOOL)) {
      // Which app is in front, and what is on the screen: what could not be found out is passed on as not known
      // (null), and the gates ask about a press they cannot judge — nothing is let through for want of a reading.
      let fg = null;
      try { fg = String((await phone()?.foreground?.()) ?? '') || null; } catch (error) { void error; }
      // A tap is judged by the words under it now: a screen read more than a few seconds ago (or never: her hands
      // looked with the phone's own listing tool) is read again first.
      let seen = phone()?.lastScreen ?? null;
      if (/click|tap|press|batch/.test(exec.name) && (!seen || Date.now() - (seen.at ?? 0) > cfg.gateScreenMs)) { try { await phone()?.screenItems?.(); seen = phone()?.lastScreen ?? null; } catch (error) { void error; seen = null; } }
      const stop = gateHands(classify({ tool: exec.name, input: args, screen: seen, fg }), id, 'phone');
      if (stop) return stop;
    }
    // On her computer the same tiers (gates.js classifyComputer), from what the computer's own rules find in the call
    // (computer/gate.js, which then asks nothing of its own for it) and the page her browser is on now.
    // On this machine itself (a thing given with device 'host'): only looking is theirs; anything else is asked of him
    // (gates.js classifyHost). Every call of theirs there is judged, whatever the tool.
    const onHost = theirs && handsPlace(id, exec.agent?.session?.header?.cwd) === 'host';
    if (onHost) {
      exec.dotGated = true;
      const stop = gateHands(classifyHost({ tool: exec.name, input: args }), id, 'host');
      if (stop) return stop;
    }
    if (theirs && !onHost && (exec.name === 'bash' || exec.name.startsWith(VM_TOOL_PREFIX))) {
      const pc = computer();
      const doing = Boolean(pc?.gate?.acts?.(exec.name));
      const page = doing ? (await pc?.page?.()) ?? null : null;
      exec.dotGated = true;
      const stop = gateHands(classifyComputer({ tool: exec.name, input: args, risk: pc?.gate?.riskOf?.(exec) ?? null, acts: doing, page }), id, 'computer');
      if (stop) return stop;
    }
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
  // Her conversation is never cancelled: he is told once per turn.
  const doingOf = (t) => t.doing || (t.said ? t.said.replace(/\s+/g, ' ').slice(0, 60) : '') || '（不清楚）';
  const turnInfo = (id, now = Date.now()) => {
    const t = turns.get(id);
    if (!t) return null;
    return { session: id, retired: retired(id), conversation: id === lastSession, startedAt: t.startedAt, lastEventAt: t.lastEventAt, doing: doingOf(t), ...turnState(t, { now, turnStallMs: cfg.turnStallMs }) };
  };
  const watchTurns = (now = Date.now()) => {
    if (!(cfg.turnStallMs > 0)) return;
    for (const [id, t] of [...turns]) {
      const idle = now - (t.lastEventAt ?? t.startedAt);
      if (idle < cfg.turnStallMs) continue;
      if (!t.stallAudited) { t.stallAudited = true; audit('turn-stalled', { session: id, retired: retired(id), idleMs: idle, doing: doingOf(t) }); }
      if (id !== lastSession || t.ownerTold) continue;
      t.ownerTold = true;
      void im.send(`⏳ dot: 她这一轮 ${Math.round(idle / 60000)} 分钟没动静了（最后在做：${doingOf(t)}）。没替她取消；要停就在 DeepSeek Harness 里点停止。`, 'plain');
    }
  };
  ctx.effect(() => { const timer = setInterval(() => { watchTurns(); noteUnanswered(); watchDrift(); void nextTask(); }, 60000); return () => clearInterval(timer); }, 'dsh-dot: turn watchdog');
  // Doctor (checkup.js): on /dot doctor, once a start when something still has to be installed, and when a device fails.
  const checkup = createCheckup({ items: () => ({ phone: phone(), computer: computer(), compat: ctx.get('dshDotCompat'), home: dshHome() }), im, audit, logger });
  const doctorTell = (why) => checkup.tell(why);
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
    const out = [...consent.asking().map((a) => `waiting for his yes: ${a.what} · ${mins(now - a.at)}`), ...consent.standing().map((g) => `his standing yes: ${KINDS[g.kind] ?? g.kind}${g.subject ? ` (${g.subject})` : ''} · 「${g.words}」`)];
    for (const id of turns.keys()) {
      const t = turnInfo(id, now);
      if (t && t.state === 'stalled') out.push(`stalled turn: ${who(id)} · no event for ${mins(t.idleMs)} · last: ${t.doing} · not cancelled`);
    }
    const d = drift();
    if (d) out.push(`plugin files changed on disk since dsh started: running ${d.loaded || '?'}, on disk ${d.disk || '?'}, ${d.missing.length} prompt file(s) gone · quit dsh and open it again`);
    if (lastFailure && now - lastFailure.at < 3600000) out.push(`last failed turn: ${who(lastFailure.session)} · ${mins(now - lastFailure.at)} ago · ${lastFailure.lost ? 'his words were not taken · ' : ''}${lastFailure.error}`);
    return out.length ? out : [`liveness: nothing waits for his yes, no stalled or failed turn (stalled after ${mins(cfg.turnStallMs)})`];
  };

  // /dot (command.js): the command's surface; what it reports of her state is said here.
  const statusText = async (arg) => {
    const t = await im.target();
    let test = '';
    if (arg === 'test') test = `\ntest message: ${(await im.send('👋 dot 测试消息：IM 通道正常。', 'plain')) ? 'sent' : 'FAILED'}`;
    const vm = computer()?.status?.();
    const ph = phone()?.status?.();
    const lines = [
      `computer: ${vm ? `${vm.state}${vm.publicLiveViewUrl ? ` · ${vm.publicLiveViewUrl}` : ''}` : 'not installed (optional)'} · phone: ${ph ? `${ph.state}${ph.error ? ` (${ph.error})` : ''}` : 'not installed (optional)'}`,
      `IM: ${t.error ? `not ready (${t.error})` : `${t.name ?? t.target} via ${t.bot}`}`,
      ...(checkup.last() && (checkup.last().bad || checkup.last().warn) ? [`doctor: ${checkup.last().bad} problem(s), ${checkup.last().warn} warning(s) — /dot doctor`] : []),
      `scope: ${cfg.scope} · home: ${home} · im sessions seen: ${imSessions.size}`,
      // Where his next message goes: when she "does not answer", look here first.
      `her conversation: ${lastSession ? `${lastSession}${turns.has(lastSession) ? ' (in a turn)' : ''}` : '(none yet: say something to her in a session under home)'}`,
      `his messages: wait ${cfg.ownerQuietMs} ms of quiet, at most ${cfg.ownerMaxWaitMs} ms (${cfg.ownerTypingMaxMs} ms while typing) · mid-turn: steered · her words give way to his unread ones ≤${cfg.ownerPreemptMax}× in a row${ownerBatch.length ? ` · ${ownerBatch.length} waiting` : ''}`,
      ...statusLiveness(),
      `budget: ${ctx.get('budget') ? (budget.blocked().length ? `BLOCKED (${budget.blocked().join(', ')})` : 'ok') : 'not installed (optional)'}`,
      (() => { try { return llmGateLine(llmGate?.status()); } catch (err) { return `model requests: ${err.message}`; } })(),
      `schedule: ${ctx.get('schedule') ? 'ok' : 'not installed'}`,
    ];
    return lines.join('\n') + test;
  };
  // The command registry can come up after dot, so register through a child that waits for it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register(dotCommand({
      // His stop is a command, not a message she gets round to: what is in her hands ends now, and she is told it was him.
      stop: () => { const d = hands?.doing?.(); return hands?.stop({ by: 'him', cause: 'command' }) ? `停下了：${d?.task ?? ''}` : '她手上现在没有事'; },
      memory: () => ctx.get('dotMemory'), howto, checkup, prompts, status: statusText, nightcheck, voicetest,
    })), 'dsh-dot: /dot command');
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
    get asleepSince() { return sleep.asleepSince(); },
    onSleep: sleep.onSleep,
    stats,
    retired,
    /** Is this session hers (her conversation, an IM-opened one, one that was hers): what compat asks before letting it see her tools. */
    hers: (id, cwd) => isDotSession(id, cwd) || retired(id),
    /** Her hands' session (hands.js): the device tools, nothing else of hers. */
    isHands: (id, cwd) => Boolean(hands?.isHands(id, cwd)),
    /** The device a session of her hands is for: 'phone' | 'computer' | 'web' | 'host' ('' when not known); a host thing is known by its folder alone. */
    handsDevice: (id, cwd) => handsPlace(id, cwd),
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
    /** The book of things (ledger.js), newest first: what she set out to do and what came of each. */
    things: (n = 20) => ledger.recent(n),
    /** What waits for his yes, and his standing yeses (consent.js). */
    consent: () => ({ asking: consent.asking(), standing: consent.standing() }),
    /** The know-how book, place by place: notes or not, how each task went (howto.js summary). */
    knowhow: () => howto.summary(),
    /** A code sent to his phone that he gave her is not kept: digits in his words while a thing waits for one are masked. */
    redact: (text) => { const e = ledger.recent(5).find((x) => x.ask?.kind === 'code' && Date.now() - (x.endedAt ?? 0) < 15 * 60_000); return e ? String(text ?? '').replace(/(?<!\d)\d{4,8}(?!\d)/g, '〔验证码〕') : text; },
    /** His messages waiting in the buffer; flushOwner() delivers them now. */
    ownerPending: () => ownerBatch.length,
    /** Her bubbles to him are going out right now. */
    sending: () => outlet.busy(),
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
