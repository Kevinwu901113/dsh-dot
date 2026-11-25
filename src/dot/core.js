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
import { HANDS_ASK_TOOL, HANDS_DONE_TOOL, HIS_OK_TOOL, SAY_TOOL, PHONE_TOOL_PREFIX, PHONE_TYPE_TOOL, VM_TOOL_PREFIX, isHerTool, HER_PRESET, HANDS_PRESETS, handsPlaceOf, HANDS_WAIT_TOOL, PHONE_LOOK_TOOLS } from '../tool-prefixes.js';
import { checkReply } from '../persona/card.js';
import { VM_SCREENSHOT } from '../qq/qq.js';
import { BRIDGE_ID_RE } from '../compat/qq-bridge.js';
import { batchLaunch, createHowto, errorType, howtoTool, isRefusal, placeName } from './howto.js';
import { HANDS_SOURCE, createHands } from './hands.js';
import { createLedger, headTail } from './ledger.js';
import { checkInput, checkTool, settle as settleCheck, report as checkReport, hashOf } from './nightcheck.js';
import { approvalKind, classify, classifyComputer, classifyHost, KINDS, HIM_KINDS } from './gates.js';
import { createConsent, REACHES } from './consent.js';
import { createSay } from './say.js';
import { createOutlet } from './outlet.js';
import { createRecorder, replay as replayKept } from './replay.js';
import { KNOWN_APPS, collectReply } from '../interlude/core.js';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { join, relative, isAbsolute, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createSessions, isImMessage } from './sessions.js';
import { costOf, createThings, nameOf, sameName, titleOf } from './things.js';
import { createTurns, shortTool } from './turns.js';
import { createVoice } from './voice.js';
import { createArrive } from './arrive.js';
import { createHandsWiring } from './hands-wiring.js';
export { LOOP_EXEMPT } from './hands-wiring.js';
export { SETUP_SOURCE } from './arrive.js';
export { shortTool } from './turns.js';
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
  // Her conversation's model requests kept as sent, the newest this many, for /dot replay (replay.js). 0: none kept.
  replayKeep: 0,
};

/** An open turn as the panel and /dot show it: 'stalled' (no session event for turnStallMs) or 'running'. */
export function turnState(t, { now = Date.now(), turnStallMs = defaults.turnStallMs } = {}) {
  const idleMs = Math.max(0, now - (t.lastEventAt ?? t.startedAt ?? now));
  return { state: turnStallMs > 0 && idleMs >= turnStallMs ? 'stalled' : 'running', idleMs };
}

export { ERRAND_NOTE_SOURCE, IM_RPC, isImMessage } from './sessions.js';

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

  // Today's counters for the panel (persisted; reset when the day changes).
  const stats = () => { const st = store.get('stats'); return st && st.day === today() ? st : { day: today(), woke: 0, owner: 0 }; };
  const bump = (k, n = 1) => { const st = stats(); st[k] = (st[k] ?? 0) + n; store.set('stats', st); };
  const dot = { ctx, cfg, logger, audit, phone, computer, home, store, im, turnState, bump };
  const sessions = dot.sessions = createSessions(dot);
  const { setLast, wantIm, imSessions, isDotSession, retired, selfCheck, noteToConversation, thinkAt, resolveLive, createConversation, openConversation } = sessions;
  dot.ledger = null; dot.consent = null; // made below (ledger.js, consent.js)
  const things = dot.things = createThings(dot);
  const { awaited, answerTo, owedToHim, thingsLines, hisUnderWay } = things;
  dot.hands = null; dot.sleep = null; // made below (hands.js, sleep.js)
  const turns = dot.turns = createTurns(dot);
  const { turnFailed, taken, owe, watchDrift, driftLine, turnNote, busyWith, inHome, doingOf, turnInfo, watchTurns } = turns;
  const voice = dot.voice = createVoice(dot);
  const arrive = dot.arrive = createArrive(dot);
  const { moved, flushOwner, nextTask, enqueueTask, herState, quiet } = arrive;
  const hw = dot.hw = createHandsWiring(dot);
  const { howto, nightcheck, handsPlace } = hw;
  const { handBack, answerReaches, noteUnanswered, dropAck, outlet, say, saidText, tellHim } = voice;
  // Her model requests share his provider key: her hands' steps on her own business are background and wait behind
  // his (src/llm-gate.js). A round they do for him is his business — he is waiting on it — and goes like her replies.
  const llmGate = installLlmGate(ctx, { name: 'dsh-dot', backgroundSessions: (id) => Boolean(dot.hands?.isHands(id)) && !dot.hands.doing()?.forHim });
  selfCheck();
  // The registry can come up after dot: look again once it is there.
  ctx.inject?.(['workspaceRegistry'], (c) => c.effect(() => { selfCheck(); return () => {}; }, 'dsh-dot: startup self-check'));


  // 1. Her turns.
  ctx.effect(() => turns.disposeOwed, 'dsh-dot: his words not yet taken');

  ctx.on('session/event', turns.onSessionEvent);

  // 2. What of hers needs him (gates.js): nothing waits on a button (hands-wiring.js onApproval); a refusal that waits for his yes says so.
  ctx.on('approval/request', hw.onApproval, { prepend: true });
  ctx.on('tools/post-execute', hw.onPostExecute);

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.on('system-prompt/assemble', hw.assemble), 'dsh-dot: device instructions go to the hands');
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
  ctx.on('agent/pre-step', turns.preStep);
  // Her clock: "since the last message" counts from the last line said before this turn began.
  turnNote({ name: 'dot:now', order: 899, text: ({ agent }) => {
    const id = agent.session.id, started = turns.get(id)?.startedAt ?? Date.now();
    return [nowText(Date.now(), ctx.get('dotMemory')?.lastSaidAt?.(started) ?? 0), id === sessions.last() ? voice.reachLine() : '', id === sessions.last() ? thingsLines() : ''].filter(Boolean).join('\n');
  } });
  // What she writes here is read by no one: said once per arrival, because nothing else in front of her says it.
  turnNote({ name: 'dot:say', order: 901, text: () => prompt('dot.say.note') });
  // What went out to him since she was last up, as it was sent: the voice's words, not hers.
  turnNote({ name: 'dot:said', order: 897, text: voice.saidNoteText });
  // Her phone's pushes held since she was last up (see wake): once, with whatever woke her.
  turnNote({ name: 'dot:pushes', order: 898, text: arrive.pushesNote });
  turnNote({ name: 'dot:scheduled-turn', order: 900, text: turns.scheduledNote });


  // 3. Budget (budget.js).
  const budget = watchBudget({ ctx, cfg, store, audit, im, logger });

  // 4. Device health (whichever devices are installed; they may come up after dot).
  ctx.inject(['dshComputer'], (c) => c.effect(() => c.dshComputer.onStatus?.((s) => {
    if (s.state === 'error') void im.send(`⚠️ dot: 虚拟机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-computer.log`, 'plain');
  }) ?? (() => {}), 'dsh-dot: computer status'));
  // Her sleep (sleep.js): asleep, only he wakes her; what her phone and her QQ show waits, and is shown when she wakes.
  const sleep = createSleep({ cfg, store, audit, logger, effect: (fn, label) => ctx.effect(fn, label), quiet: () => arrive.quiet(),
    onWake: () => arrive.onWake() });
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
  // Her deciding, run again on kept requests (replay.js): kept only with replayKeep > 0 — else nothing listens.
  const replayDir = join(dshHome(), 'dot-replay', 'decide');
  if (cfg.replayKeep > 0) {
    const herStep = (id) => { const s = ctx.get('agents')?.get?.(id)?.session; return !retired(id) && !dot.hands?.isHands(id, s?.header?.cwd) && (id === sessions.last() || isDotSession(id, s?.header?.cwd)); };
    const recorder = createRecorder({ dir: replayDir, keep: cfg.replayKeep, hers: herStep, audit, logger });
    ctx.on('llm/stream', (options, next) => { recorder.observe(options); return next(); }, { global: true });
  }
  const replay = (file, times) => replayKept({ dir: replayDir, base: join(dshHome(), 'dot-replay'), file, times, llm: ctx.get('llm'), sel: ctx.get('agentDefaultModel')?.currentSelection?.(), audit });
  // Each night, once she is asleep: checked, then amended where the check would change something (hands-wiring.js nightly).
  ctx.effect(() => sleep.onSleep(hw.nightly), 'dsh-dot: nightcheck when she falls asleep');
  dot.sleep = sleep;
  const awake = sleep.awake, wakeUp = sleep.wakeUp, stir = sleep.stir;
  const sleeps = sleepsAtAll(cfg.awakeHours);
  turnNote({ name: 'dot:woke', order: 898, text: ({ agent }) => (agent.session.id === sessions.last() ? sleep.wokeNote() : '') });
  ctx.effect(() => hw.disposePhoneHome, 'dsh-dot: phone back to its home screen');
  // The book of things (ledger.js): every thing she gives her hands, and what came of it.
  const ledger = dot.ledger = createLedger({ store });
  // What he said yes to (consent.js).
  const consent = dot.consent = createConsent({ store });
  // Her hands (hands.js, made in hands-wiring.js).
  hw.makeHands();
  // A thing a restart cut off is told to her once, when her conversation can be reached.
  ctx.effect(hw.restartCut, 'dsh-dot: what a restart cut off');
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'hands',
      description: prompt('dot.hands-tool'),
      parameters: { type: 'object', properties: { device: { type: 'string', enum: ['phone', 'computer', 'web', 'host'], description: 'phone / computer：在你的那台设备上做；web：查资料，不碰设备；host：在他这台电脑本机上用命令行做（他开口要的才交）' }, do: { type: 'string', description: '要做成的事，说完整；要打的字原样写上。手上的事停在要你拿主意的地方时，这里写你的回答' }, say: { type: 'string', description: '这件事里要打给别人看的话（评论、回帖、在 App 里回人）：写你想说的意思，原话会替你写好、照着打上去' }, add: { type: 'string', description: '给正在做的那件事补一句（他又加了要求、你想起一点）：它下一步之前就看到，接着做' }, stop: { type: 'boolean', description: '手上的事不做了' }, after: { type: 'boolean', description: '接着这台设备上一件停下的事做（它停在要他来、要你定的地方，现在可以接着了）：屏幕还停在那里' } }, additionalProperties: false },
      output: { schema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: v?.status === 'started' ? prompt('dot.hands.started') : v?.status === 'added' ? prompt('dot.hands.added') : v?.status === 'queued' ? prompt('dot.hands.queued', { task: v.doing?.task ?? '' }) : v?.status === 'stopped' ? prompt('dot.hands.stopped') : v?.status === 'idle' ? prompt(_a?.add ? 'dot.hands.add.idle' : 'dot.hands.idle') : `没开始：${v?.why ?? ''}` }] },
      async execute(args) {
        if (args?.stop) { const open = ledger.unfinished().map((e) => e.id); const t = turns.get(sessions.last()); const stopped = dot.hands.stop({ by: t?.fromQq || t?.elsewhere ? 'him' : 'her' }); if (stopped && t) t.stopped = [...(t.stopped ?? []), ...open]; return { status: stopped ? 'stopped' : 'idle' }; }
        // Words her hands are to type for someone to read are hers to mean and the card's to write (say.js): they go
        // into what her hands are given, as the words to type.
        let words = '';
        if (String(args?.say ?? '').trim()) {
          try { words = await say.compose({ about: args.say, where: String(args?.do ?? '').trim() }); } catch (err) { return { status: 'failed', why: `要打的话没写出来：${err.message}` }; }
          if (!words) return { status: 'failed', why: '这句话她不想说，没有交出去' };
        }
        const given = [String(args?.do ?? '').trim(), words ? prompt('dot.hands.words', { words }).trim() : ''].filter(Boolean).join('\n');
        // One more thing for the hands at work: read between two of their steps.
        if (String(args?.add ?? '').trim()) { return dot.hands.add([String(args.add).trim(), words ? prompt('dot.hands.words', { words }).trim() : ''].filter(Boolean).join('\n')); }
        const device = args?.device === 'computer' ? 'computer' : args?.device === 'web' ? 'web' : args?.device === 'host' ? 'host' : 'phone';
        // Whose business this is: his (a turn his words opened, or one her hands came back to on his business) or her own.
        const t = turns.get(sessions.last());
        const forHim = Boolean(t && !t.scheduled && (t.fromQq || t.elsewhere || t.forHim));
        // This machine is his: her hands go there on his business only, never in her own time.
        if (device === 'host' && !forHim) { audit('hands-host-refused', { session: sessions.last() }); return { status: 'failed', why: prompt('dot.hands.host.his').trim() }; }
        if (device === 'phone') hw.cancelPhoneHome();
        // Given in the turn a thing came back to: it carries on from where that one stopped — the device is as it was left.
        // Or, asked for, the last thing on that device that stopped short (his yes came in a later turn of his).
        const before = t?.thing ? ledger.get(t.thing) : args?.after ? ledger.recent(10).find((e) => e.device === device) : null;
        const after = before?.state === 'ended' && before.outcome !== 'done' ? `\n${prompt('dot.hands.after', { task: before.task, where: before.question ? `问过：${before.question}` : before.summary || before.detail ? `停下时说的是：${head(before.summary || before.detail, 300)}` : '没有留下话' }).trim()}` : '';
        const started = await dot.hands.start({ device, task: `${prompt(device === 'computer' ? 'dot.hands.where.computer' : device === 'web' ? 'dot.hands.where.web' : device === 'host' ? 'dot.hands.where.host' : 'dot.hands.where.phone').trim()}${given}${after}`, forHim, ...(before && after ? { after: before.id } : {}) });
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
        if (isOwnerTarget(to, ctx.get('dshQq')?.owner)) return tellHim(turns.get(sessions.last()), { about: args?.about, images: args?.images });
        // Someone she does not talk with, a group gone quiet, a file off her devices: his yes first (gates.js).
        const why = ctx.get('dshQq')?.gateFor?.({ to, images: args?.images ?? [] });
        if (why) {
          const k = approvalKind('qq_send', why);
          if (!consent.allows({ kind: k.kind, subject: k.subject })) { consent.ask(k); audit('consent-asked', { session: sessions.last(), kind: k.kind, to }); return { status: 'needs-ok', what: k.what }; }
          audit('consent-used', { session: sessions.last(), kind: k.kind, to });
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
        const t = turns.get(sessions.last());
        const kind = String(args?.kind ?? '');
        if (!KINDS[kind] || !(t?.fromQq || t?.elsewhere)) { audit('consent-refused', { session: sessions.last(), kind }); return { status: 'refused', kind }; }
        // A yes answers a question: the newest thing of this kind that stopped to ask him, or that she was told to ask
        // him about. With none waiting there is nothing for it to be a yes to.
        const since = Date.now() - 6 * 3600_000;
        const waiting = [
          ...ledger.recent(10).filter((e) => e.outcome === 'stuck' && e.ask?.for === 'him' && e.ask.tier !== 'him' && e.ask.kind === kind && !e.askSettled && (e.endedAt ?? 0) >= since).map((e) => ({ at: e.endedAt, subject: e.ask.subject ?? '' })),
          ...consent.asking().filter((a) => a.kind === kind).map((a) => ({ at: a.at, subject: a.subject ?? '' })),
        ].sort((a, b) => b.at - a.at)[0];
        // Nothing has stopped to ask him: he asked for this himself, in the words of this turn. That counts as his yes
        // (11-23, his decision) — for the next thing of this kind, once. Whether his words do ask for it is her reading:
        // the code has his words on record with it, not a check of them — except for a step that reaches someone else,
        // where the one it reaches has to be in those words (consent.js, 11-25).
        if (!waiting) {
          const g = consent.grant({ kind, words: t.hisWords ?? '', ahead: true });
          audit('consent-granted', { session: sessions.last(), kind, subject: '', always: false, ahead: true, words: g.words.slice(0, 80) });
          return { status: 'ok', kind };
        }
        const g = consent.grant({ kind, subject: waiting.subject, words: t.hisWords ?? '', always: Boolean(args?.always) });
        audit('consent-granted', { session: sessions.last(), kind, subject: g.subject, always: g.always });
        return { status: 'ok', kind };
      },
    }), 'dsh-dot: his yes');
    scope.effect(() => scope.tools.register(hw.askTool()), 'dsh-dot: hands ask tool');
    scope.effect(() => scope.tools.register(hw.waitTool()), 'dsh-dot: hands wait tool');
    scope.effect(() => scope.tools.register(hw.doneTool()), 'dsh-dot: hands done tool');
  });
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({ name: 'dot:hands', order: 59, text: (c) => (dot.hands?.isHands(c.agent?.session?.id, c.agent?.session?.header?.cwd) ? prompt('dot.hands.system') : '') }), 'dsh-dot: hands section');
  });

  ctx.inject(['dshPhone'], (c) => c.effect(() => { c.dshPhone.setPriority?.(sessions.last()); return c.dshPhone.onNotification?.(arrive.wake) ?? (() => {}); }, 'dsh-dot: phone notifications'));
  // QQ messages (NapCat in the computer) take the same road as phone notifications: batch, hold while busy, group.
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onMessage?.(arrive.qqMessage) ?? (() => {}), 'dsh-dot: qq messages'));
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onTyping?.(arrive.ownerTypingNow) ?? (() => {}), 'dsh-dot: qq typing'));
  // What she said on QQ some other way than qq_send (the backend's own tools, her phone's QQ): on record all the same.
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onSelf?.((m) => {
    audit('said-elsewhere', { to: m.to, chars: m.text.length });
    try { ctx.get('dotMemory')?.herSaid?.({ session: sessions.last(), text: m.text, to: m.to, at: Date.parse(m.at) || Date.now() }); } catch (err) { logger.warn(`transcript: ${err.message}`); }
  }) ?? (() => {}), 'dsh-dot: her own qq messages'));
  // The computer's own gate (computer/gate.js) leaves her hands' calls to the gates here, whichever hook runs first.
  ctx.inject(['dshComputer'], (c) => c.effect(() => { const pc = c.dshComputer; pc.handsOf = hw.handsOf; return () => { delete pc.handsOf; }; }, 'dsh-dot: computer gate defers to hands gates'));
  // Read before you speak, the gates of her hands, loops (hands-wiring.js preExecute).
  ctx.on('tools/pre-execute', hw.preExecute);
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
  const phoneSetup = arrive.watchSetup('phone', '手机', (s) => s.state === 'needs-license' || s.state === 'downloading');
  const computerSetup = arrive.watchSetup('computer', '电脑', (s) => s.state === 'starting' && (s.stage === 'downloading' || s.stage === 'installing'));
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
    const who = (id) => `${retired(id) ? 'retired' : id === sessions.last() ? 'her conversation' : 'session'} ${id.slice(0, 16)}`;
    const out = [...consent.asking().map((a) => `waiting for his yes: ${a.what} · ${mins(now - a.at)}`), ...consent.standing().map((g) => `his standing yes: ${KINDS[g.kind] ?? g.kind}${g.subject ? ` (${g.subject})` : ''} · 「${g.words}」`)];
    for (const id of turns.keys()) {
      const t = turnInfo(id, now);
      if (t && t.state === 'stalled') out.push(`stalled turn: ${who(id)} · no event for ${mins(t.idleMs)} · last: ${t.doing} · not cancelled`);
    }
    const d = drift();
    if (d) out.push(`plugin files changed on disk since dsh started: running ${d.loaded || '?'}, on disk ${d.disk || '?'}, ${d.missing.length} prompt file(s) gone · quit dsh and open it again`);
    if (turns.lastFailure() && now - turns.lastFailure().at < 3600000) out.push(`last failed turn: ${who(turns.lastFailure().session)} · ${mins(now - turns.lastFailure().at)} ago · ${turns.lastFailure().lost ? 'his words were not taken · ' : ''}${turns.lastFailure().error}`);
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
      `her conversation: ${sessions.last() ? `${sessions.last()}${turns.has(sessions.last()) ? ' (in a turn)' : ''}` : '(none yet: say something to her in a session under home)'}`,
      `his messages: wait ${cfg.ownerQuietMs} ms of quiet, at most ${cfg.ownerMaxWaitMs} ms (${cfg.ownerTypingMaxMs} ms while typing) · mid-turn: steered · her words give way to his unread ones ≤${cfg.ownerPreemptMax}× in a row${arrive.ownerPending() ? ` · ${arrive.ownerPending()} waiting` : ''}`,
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
      stop: () => { const d = dot.hands?.doing?.(); return dot.hands?.stop({ by: 'him', cause: 'command' }) ? `停下了：${d?.task ?? ''}` : '她手上现在没有事'; },
      memory: () => ctx.get('dotMemory'), howto, checkup, prompts, status: statusText, nightcheck, voicetest, replay,
    })), 'dsh-dot: /dot command');
  });

  // Other components (interlude, memory) need to know which session is her conversation.
  ctx.provide?.('dshDot', {
    home,
    session: () => sessions.last(),
    // Her conversation moves on (memory's handoff): the one she leaves is retired, so a turn still running in it
    // — his words restarted there a moment ago, a reminder set there — does not make it hers again when it ends.
    /** Does this conversation of hers start lean (see defaults.lean)? One begun at or after the moment lean was first on. */
    lean: (id, preset) => sessions.lean(id, preset),
    /** A new conversation of hers, made with her own preset when lean is on (and this host knows the preset). → { sessionId } */
    createConversation: (controller) => createConversation(controller),
    setSession: (id) => sessions.setSession(id),
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
    isHands: (id, cwd) => Boolean(dot.hands?.isHands(id, cwd)),
    /** The place a session of her hands is for, from its preset: 'phone' | 'computer' | 'web' | 'host' ('' when not known); a host thing is known by its folder alone. */
    handsDevice: (id, cwd, preset) => handsPlace(cwd, preset),
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
    ownerPending: () => arrive.ownerPending(),
    /** Her bubbles to him are going out right now. */
    sending: () => outlet.busy(),
    flushOwner: () => flushOwner(),
    isIm: (id) => imSessions.has(id),
    /** The model-request gate's status (src/llm-gate.js): per provider, requests in the last minute, background cap, cooldown, waiting. */
    llmGate: () => llmGate?.status() ?? null,
    /** Hold deliveries to her conversation (a handoff is moving it); the returned function releases them to the new one. */
    freeze: () => arrive.freeze(),
  });

  // The panel: `/dsh-dot/` on dsh's own web server (the "dot" sidebar tab is an iframe of it).
  ctx.inject(['webServer', 'connection'], (c) => c.effect(() => mountPanel(ctx, c.webServer, logger, c.connection), 'dsh-dot: panel'));

  logger.info(`dot ready — home ${home}`);
}
