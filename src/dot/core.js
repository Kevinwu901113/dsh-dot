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
import { createLedger } from './ledger.js';
import { createConsent } from './consent.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSessions } from './sessions.js';
import { createThings } from './things.js';
import { createTurns } from './turns.js';
import { createVoice } from './voice.js';
import { createArrive } from './arrive.js';
import { createHandsWiring } from './hands-wiring.js';
import { createTools } from './tools.js';
import { createStatus, promptsPage } from './status.js';
import { mountPanel } from './panel.js';
import { watchBudget } from './budget.js';
import { createSleep } from './sleep.js';
import { createCheckup } from './checkup.js';
import { dotCommand } from './command.js';
import { sectionOf, setValues } from '../settings.js';
import { installLlmGate } from '../llm-gate.js';
import { configure as configurePrompts, prompt } from '../prompts.js';
import { runPendingReset } from '../reset.js';
import { today } from '../clock.js';
import { workingRules, stripSilent, SILENT } from './text.js';
// What used to be defined here and now lives with the part that uses it: the same names, the same values.
export { ERRAND_NOTE_SOURCE, IM_RPC, isImMessage } from './sessions.js';
export { shortTool } from './turns.js';
export { SETUP_SOURCE } from './arrive.js';
export { LOOP_EXEMPT } from './hands-wiring.js';
export { promptsPage } from './status.js';
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
  // The plugin's parts, one object made here and handed to each part (sessions.js … status.js). A part keeps its own
  // state and is reached through its methods; what a part needs of a part made after it, it reads from here when it
  // is used (dot.voice, dot.arrive, dot.hands, dot.sleep, dot.ledger, …), never at the time it is made.
  const dot = { ctx, cfg, logger, audit, phone, computer, home, store, im, turnState, bump };
  dot.ledger = null; dot.consent = null; dot.hands = null; dot.sleep = null; dot.llmGate = null; dot.budget = null; dot.checkup = null; // made below, in the order they always were
  const sessions = dot.sessions = createSessions(dot);
  dot.things = createThings(dot);
  const turns = dot.turns = createTurns(dot);
  const voice = dot.voice = createVoice(dot);
  const arrive = dot.arrive = createArrive(dot);
  const hw = dot.hw = createHandsWiring(dot);
  const tools = dot.tools = createTools(dot);
  const status = dot.status = createStatus(dot);
  const { isDotSession, retired, selfCheck, createConversation } = sessions;
  const { turnNote, inHome, turnInfo, watchTurns, watchDrift } = turns;
  const { flushOwner, nextTask, enqueueTask, herState, quiet } = arrive;
  const { howto, nightcheck, handsPlace } = hw;
  // Her model requests share his provider key: her hands' steps on her own business are background and wait behind
  // his (src/llm-gate.js). A round they do for him is his business — he is waiting on it — and goes like her replies.
  const llmGate = dot.llmGate = installLlmGate(ctx, { name: 'dsh-dot', backgroundSessions: (id) => Boolean(dot.hands?.isHands(id)) && !dot.hands.thingOf(id)?.forHim });
  selfCheck();
  // The registry can come up after dot: look again once it is there.
  ctx.inject?.(['workspaceRegistry'], (c) => c.effect(() => { selfCheck(); return () => {}; }, 'dsh-dot: startup self-check'));

  // 1. Her turns (turns.js).
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
  turnNote({ name: 'dot:now', order: 899, text: turns.nowNote });
  // What she writes here is read by no one: said once per arrival, because nothing else in front of her says it.
  turnNote({ name: 'dot:say', order: 901, text: () => prompt('dot.say.note') });
  // What went out to him since she was last up, as it was sent: the voice's words, not hers.
  turnNote({ name: 'dot:said', order: 897, text: voice.saidNoteText });
  // Her phone's pushes held since she was last up (see wake): once, with whatever woke her.
  turnNote({ name: 'dot:pushes', order: 898, text: arrive.pushesNote });
  turnNote({ name: 'dot:scheduled-turn', order: 900, text: turns.scheduledNote });

  // 3. Budget (budget.js).
  dot.budget = watchBudget({ ctx, cfg, store, audit, im, logger });

  // 4. Device health (whichever devices are installed; they may come up after dot).
  ctx.inject(['dshComputer'], (c) => c.effect(() => c.dshComputer.onStatus?.((s) => {
    if (s.state === 'error') void im.send(`⚠️ dot: 虚拟机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-computer.log`, 'plain');
  }) ?? (() => {}), 'dsh-dot: computer status'));
  // Her sleep (sleep.js): asleep, only he wakes her; what her phone and her QQ show waits, and is shown when she wakes.
  const sleep = createSleep({ cfg, store, audit, logger, quiet: () => arrive.quiet(), onWake: () => arrive.onWake() });
  // Her deciding, run again on kept requests (replay.js): kept only with replayKeep > 0 — else nothing listens.
  if (cfg.replayKeep > 0) ctx.on('llm/stream', status.replayObserver(), { global: true });
  // Each night, once she is asleep: checked, then amended where the check would change something (hands-wiring.js nightly).
  // Once a night: the night it was done for is kept, so a restart while she sleeps does not do it again.
  ctx.effect(() => sleep.onSleep((night) => { if (store.get('nightcheckNight') === night) return; store.set('nightcheckNight', night); hw.nightly(); }), 'dsh-dot: nightcheck when she falls asleep');
  dot.sleep = sleep;
  const awake = sleep.awake;
  const sleeps = sleepsAtAll(cfg.awakeHours);
  turnNote({ name: 'dot:woke', order: 898, text: ({ agent }) => (agent.session.id === sessions.last() ? sleep.wokeNote() : '') });
  ctx.effect(() => hw.disposePhoneHome, 'dsh-dot: phone back to its home screen');
  // The book of things (ledger.js): every thing she gives her hands, and what came of it.
  dot.ledger = createLedger({ store });
  // What he said yes to (consent.js).
  dot.consent = createConsent({ store });
  // Her hands (hands.js, made in hands-wiring.js).
  hw.makeHands();
  // A thing a restart cut off is told to her once, when her conversation can be reached.
  ctx.effect(hw.restartCut, 'dsh-dot: what a restart cut off');
  ctx.inject(['tools'], (scope) => tools.register(scope));
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({ name: 'dot:hands', order: 59, text: (c) => (dot.hands?.isHands(c.agent?.session?.id, c.agent?.session?.header?.cwd) ? prompt('dot.hands.system') : '') }), 'dsh-dot: hands section');
  });

  // 5. Her phone rings, QQ messages come in (arrive.js).
  ctx.inject(['dshPhone'], (c) => c.effect(() => { c.dshPhone.setPriority?.(sessions.last()); return c.dshPhone.onNotification?.(arrive.wake) ?? (() => {}); }, 'dsh-dot: phone notifications'));
  // QQ messages (NapCat in the computer) take the same road as phone notifications: batch, hold while busy, group.
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onMessage?.(arrive.qqMessage) ?? (() => {}), 'dsh-dot: qq messages'));
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onTyping?.(arrive.ownerTypingNow) ?? (() => {}), 'dsh-dot: qq typing'));
  // What she said on QQ some other way than qq_send (the backend's own tools, her phone's QQ): on record all the same.
  ctx.inject(['dshQq'], (c) => c.effect(() => c.dshQq.onSelf?.(voice.saidElsewhere) ?? (() => {}), 'dsh-dot: her own qq messages'));
  // The computer's own gate (computer/gate.js) leaves her hands' calls to the gates here, whichever hook runs first.
  ctx.inject(['dshComputer'], (c) => c.effect(() => { const pc = c.dshComputer; pc.handsOf = hw.handsOf; return () => { delete pc.handsOf; }; }, 'dsh-dot: computer gate defers to hands gates'));
  // Read before you speak, the gates of her hands, loops (hands-wiring.js preExecute).
  ctx.on('tools/pre-execute', hw.preExecute);
  // Her clock: the one timer for what comes of time passing, in this order — her sleep (sleep.js), a stalled turn
  // (turns.js), an unanswered reach (voice.js), the plugin's drift, what other parts watch on it (dshDot.onTick: her
  // own time, interlude), then a thing of hers waiting to go in (arrive.js). Whatever it brings goes in by arrive().
  // The budget's watch (budget.js) is not on it: it asks another plugin's state for him, at its own setting.
  const tickers = new Set();
  const tick = () => {
    sleep.tick(); watchTurns(); voice.noteUnanswered(); watchDrift();
    for (const fn of [...tickers]) { try { fn(); } catch (err) { logger.warn(`tick: ${err.message}`); } }
    void nextTask();
  };
  ctx.effect(() => { const timer = setInterval(tick, 30000); timer.unref?.(); return () => clearInterval(timer); }, 'dsh-dot: her clock');
  // Doctor (checkup.js): on /dot doctor, once a start when something still has to be installed, and when a device fails.
  const checkup = dot.checkup = createCheckup({ items: () => ({ phone: phone(), computer: computer(), compat: ctx.get('dshDotCompat'), home: dshHome() }), im, audit, logger });
  const doctorTell = (why) => checkup.tell(why);
  ctx.effect(() => {
    const t = setTimeout(() => {
      const p = phone()?.doctorInfo?.(), c = computer()?.doctorInfo?.();
      if ((p && !p.installed) || (c && !c.installed)) void doctorTell('手机/电脑还没装好，先替你查了一遍这台机器');
    }, 15_000);
    return () => clearTimeout(t);
  }, 'dsh-dot: first-run doctor');
  // When a device she was waiting for (installing or booting in this run) comes up, she tells him herself (arrive.js).
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

  // The command registry can come up after dot, so register through a child that waits for it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register(dotCommand({
      // His stop is a command, not a message she gets round to: what is in her hands ends now, and she is told it was him.
      // Everything in her hands stops: what is under way is named (one now, so one name).
      stop: () => { const d = dot.hands?.things?.() ?? []; return dot.hands?.stop({ by: 'him', cause: 'command' }) ? `停下了：${d.map((t) => t.task ?? '').join('、')}` : '她手上现在没有事'; },
      memory: () => ctx.get('dotMemory'), howto, checkup, prompts, status: status.statusText, nightcheck, voicetest: status.voicetest, replay: status.replay,
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
    /** Her clock (every 30 s): `fn()` is called on each tick, after her sleep and before what waits goes in; returns its disposer. */
    onTick: (fn) => { tickers.add(fn); return () => tickers.delete(fn); },
    stats,
    retired,
    /** Is this session hers (her conversation, the one the plugin made for her, or one that was hers): what compat, the interlude and memory ask. */
    hers: (id, cwd) => isDotSession(id, cwd) || retired(id),
    /** Her hands' session (hands.js): the device tools, nothing else of hers. */
    isHands: (id, cwd) => Boolean(dot.hands?.isHands(id, cwd)),
    /** Whose thing a session of her hands is on: 'him' | 'her' ('' when it is not on one). */
    handsFor: (id) => { const t = dot.hands?.thingOf(id); return !t ? '' : t.forHim ? 'him' : 'her'; },
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
    things: (n = 20) => dot.ledger.recent(n),
    /** What waits for his yes, and his standing yeses (consent.js). */
    consent: () => ({ asking: dot.consent.asking(), standing: dot.consent.standing() }),
    /** The know-how book, place by place: notes or not, how each task went (howto.js summary). */
    knowhow: () => howto.summary(),
    /** A code sent to his phone that he gave her is not kept: digits in his words while a thing waits for one are masked. */
    redact: (text) => { const e = dot.ledger.recent(5).find((x) => x.ask?.kind === 'code' && Date.now() - (x.endedAt ?? 0) < 15 * 60_000); return e ? String(text ?? '').replace(/(?<!\d)\d{4,8}(?!\d)/g, '〔验证码〕') : text; },
    /** His messages waiting in the buffer; flushOwner() delivers them now. */
    ownerPending: () => arrive.ownerPending(),
    /** Her bubbles to him are going out right now. */
    sending: () => voice.outlet.busy(),
    flushOwner: () => flushOwner(),
    isIm: (id) => sessions.imSessions.has(id),
    /** The model-request gate's status (src/llm-gate.js): per provider, requests in the last minute, background cap, cooldown, waiting. */
    llmGate: () => llmGate?.status() ?? null,
    /** Hold deliveries to her conversation (a handoff is moving it); the returned function releases them to the new one. */
    freeze: () => arrive.freeze(),
  });

  // The panel: `/dsh-dot/` on dsh's own web server (the "dot" sidebar tab is an iframe of it).
  ctx.inject(['webServer', 'connection'], (c) => c.effect(() => mountPanel(ctx, c.webServer, logger, c.connection), 'dsh-dot: panel'));

  logger.info(`dot ready — home ${home}`);
}
