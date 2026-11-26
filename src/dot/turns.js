// dsh-dot/turns: her turns as the session events tell them (taken out of core.js as it was).
// Holds: the open turns (session id → turn), what waits in a session's inbox for its next turn (upcoming), his words
// not yet taken by a turn (owed), the last failed turn, whether the plugin's drift was told, and the parts of the short
// message that goes with whatever has just reached her (turn notes).
// A turn is written here only; what happens in it elsewhere is said through spoke, opened, stopped and startedOver.
// Whose it is, is one field, written here from what enters it and read through the predicates below: by.whose 'him'
// (his words opened it, or a thing of his woke it) · 'her' · 'schedule' (a reminder of the host's: it stays the
// schedule's); by.where — where his words in it came from, 'qq' · 'desk' (her window, an IM bot) · '' (QQ wins);
// by.form — the kind of message of ours that woke it; by.thing — the thing of his it is about.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { drift } from '../integrity.js';
import { prompt } from '../prompts.js';
import { unstamp } from '../clock.js';
import { ownerSaid } from '../said.js';
import { isImMessage } from './sessions.js';
import { TURN_NOTE_SOURCE, addressed, contentText, nowText, scheduledRule } from './text.js';

/** Tool name without its MCP server prefix (mcp__dot-vm__browser_click → browser_click). */
export const shortTool = (name) => String(name ?? '').replace(/^mcp__.+?__/, '');

/** His words are in this turn (over QQ or at her window): a yes of his can be kept, a stop is his, the voice has words of his to answer. */
export const heSpoke = (t) => Boolean(t?.by.where);
/** The turn is on his business — his words are in it, or a thing of his woke it — and is not the schedule's: what comes of it is told to him, what she starts in it is his. */
export const forHim = (t) => Boolean(t) && t.by.whose !== 'schedule' && (t.by.whose === 'him' || heSpoke(t));
/** He wrote to her on QQ in this turn: he waits for her answer there. */
export const overQq = (t) => t?.by.where === 'qq';
/** He is talking to her in her own window: what she writes is on his screen there. */
export const atHisWindow = (t) => t?.by.where === 'desk';

/**
 * @param dot  the plugin's parts (core.js apply): ctx, cfg, audit, logger, im, sessions, turnState; read when used:
 *             sleep (wakeUp), ledger, consent, hands, things (thingsLines), voice (reachLine), arrive (taskTurnEnded, turnEnded), voice (turnEnded)
 * → { get, has, keys, size, onSessionEvent, disposeOwed, turnFailed, taken, owe, lastFailure, driftLine, watchDrift,
 *     turnNote, preStep, nowNote, scheduledNote, busyWith, inHome, doingOf, turnInfo, watchTurns, spoke, opened, stopped, startedOver }
 */
export function createTurns(dot) {
  const { ctx, cfg, audit, logger, im, sessions, turnState } = dot;
  const turns = new Map(); // session id → { turn, by, startedAt, lastEventAt, doing, said, hisWords, tools, cost, spoke, opened, stopped, startedOver }
  const upcoming = new Map(); // session id → what its inbox holds for its next turn: { schedule (a reminder), form (of a dsh-dot / dsh-interlude message) }
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
  const disposeOwed = () => clearTimeout(owed?.timer);
  // The plugin's files replaced under the running dsh (integrity.js): said once, before he finds out by her going quiet.
  const watchDrift = () => { if (driftTold) return; const line = driftLine(); if (!line) return; driftTold = true; audit('plugin-drift', drift() ?? {}); void im.send(`⚠️ dot：${line}`, 'plain'); };

  const onSessionEvent = (session, event) => {
    const id = session?.id;
    const cwd = session?.header?.cwd;
    if (!id || !event) return;
    if (sessions.wantIm && event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(isImMessage)) sessions.imSessions.add(id);
    if (sessions.wantIm && event.type === 'user/message' && isImMessage(event.data)) sessions.imSessions.add(id);
    if (!sessions.isDotSession(id, cwd)) return;
    const open = turns.get(id);
    if (open) {
      open.lastEventAt = Date.now();
      if (event.type === 'tool/call') { open.doing = shortTool(event.data?.name); open.tools = (open.tools ?? 0) + 1; }
      if (event.type === 'assistant/message' && !event.data?.interrupted) { const said = contentText(event.data?.message?.content).trim(); if (said) open.said = said; }
    }
    if (event.type === 'turn/end' && !sessions.retired(id)) sessions.setLast(id);
    if ((event.type === 'turn/start' || event.type === 'turn/end') && id === sessions.last()) dot.sleep.wakeUp('turn'); // a turn of her conversation: she is up (or stays up)
    // A reminder enters the inbox before its turn starts, and the prompt is assembled at turn
    // start, before the user/message event: note it here so the turn knows from its first step.
    if (event.type === 'agent/inbox/spliced') {
      if ((event.data?.inserted ?? []).some((m) => m?.source?.kind === 'user' && addressed(m.source) === 'qq')) taken(id); // his words are in her inbox's turn
      const next = upcoming.get(id) ?? {}, from = (event.data?.inserted ?? []).find((m) => ['dsh-dot', 'dsh-interlude'].includes(m?.source?.kind));
      upcoming.set(id, { schedule: next.schedule || (event.data?.inserted ?? []).some((m) => m?.source?.kind === 'schedule'), form: from ? from.source.form : next.form });
      return;
    }
    if (event.type === 'turn/start') {
      const next = upcoming.get(id) ?? {};
      upcoming.delete(id);
      turns.set(id, { turn: event.data?.turn, by: { whose: next.schedule ? 'schedule' : 'her', where: '', form: next.form, thing: undefined }, startedAt: Date.now(), lastEventAt: Date.now(), spoke: false, opened: [], stopped: [], startedOver: false });
      return;
    }
    const t = turns.get(id);
    if (!t) return;
    if (event.type === 'user/message' && event.data?.source?.kind === 'schedule') { t.by.whose = 'schedule'; return; }
    // His words: over his QQ, or anywhere else (her window, an IM bot) where her answer is on his screen — a window
    // that is not her conversation yet counts already (setLast at this turn's end), one she has left does not.
    const at = event.type === 'user/message' ? addressed(event.data?.source) : '';
    if (at === 'qq' || (at === 'desk' && !sessions.retired(id))) {
      if (at === 'qq' || !t.by.where) t.by.where = at;
      const user = event.data?.source?.kind === 'user';
      if (at === 'qq' && user) taken(id);
      const words = user ? ownerSaid(unstamp(contentText(event.data?.content))).trim() : '';
      if (user && t.by.whose === 'her' && !t.by.form && !t.tools) { // a turn his own words opened
        t.by.whose = 'him';
        if (at === 'qq' && words) t.said = [t.said, words].filter(Boolean).join(' ').slice(0, 120);
      }
      // His own words of this turn, as he typed them (t.said goes on to hold what she last wrote): what a yes of his is kept with.
      if (words) t.hisWords = [t.hisWords, words].filter(Boolean).join(' ').slice(-200);
      if (at === 'qq') return;
    }
    const ended = event.type === 'turn/end' && (event.data?.turn === undefined || event.data.turn === t.turn);
    // What woke this turn besides him (a notification, her own time) and what the turn cost: a task of hers that ran
    // in it (dshDot.task) gets its result and its cost back when the turn ends.
    if (event.type === 'user/message' && ['dsh-dot', 'dsh-interlude'].includes(event.data?.source?.kind) && event.data.source.form !== 'turn-note') t.by.form ??= event.data.source.form;
    // Her hands came back on something of his (or an answer it waited for): the turn is on his business (a thing she
    // starts from it is his too), unless it is the schedule's.
    if (event.type === 'user/message' && event.data?.source?.kind === 'dsh-dot' && event.data.source.for === 'him') { if (t.by.whose !== 'schedule') t.by.whose = 'him'; if (event.data.source.thing) t.by.thing = event.data.source.thing; }
    if (event.type === 'assistant/message') {
      const u = event.data?.usage;
      if (u) { t.cost ??= { in: 0, cached: 0, out: 0 }; t.cost.in += (Number(u.inputTokens ?? 0) || 0) + (Number(u.cacheWriteTokens ?? 0) || 0); t.cost.cached += Number(u.cacheReadTokens ?? 0) || 0; t.cost.out += Number(u.outputTokens ?? 0) || 0; }
    }
    // The turn broke (the model call failed, a prompt could not be put together): not her silence. Nothing is written
    // in her name about a turn that did not happen; he is told by the plugin when the turn was his.
    const broke = ended && event.data?.reason?.kind === 'error';
    if (broke) {
      const lost = owed?.session === id && !overQq(t);
      taken(id);
      turnFailed(id, event.data.reason.error?.message ?? event.data.reason.message, { lost, his: lost || forHim(t) });
    }
    // A question of hers to him is waiting until his next words have been read: the turn they open either keeps his
    // yes (his_ok) or does not — said no, said something else — and after it the question is not waiting any more
    // (11-23: a yes was matched to yesterday's text message he had called off).
    if (ended && heSpoke(t) && !broke) {
      for (const e of dot.ledger.recent(10)) if (e.outcome === 'stuck' && e.ask?.for === 'him' && !e.askSettled && (e.told ?? e.endedAt ?? 0) < t.startedAt) dot.ledger.note(e.id, { askSettled: Date.now() });
      dot.consent.settle(t.startedAt);
    }
    if (ended) {
      turns.delete(id); // every turn, scheduled or not: `turns` is also "is she busy right now"
      // A thing of her own (her own time) lasts as long as her hands are still on it (arrive.js taskTurnEnded).
      dot.arrive.taskTurnEnded(id, t);
      // What waited for this turn goes in once it has settled, so the followup starts a fresh turn (arrive.js).
      dot.arrive.turnEnded(id);
    }
    // A turn on his business that ends is answered by the voice (voice.js turnEnded).
    if (ended && forHim(t)) dot.voice.turnEnded(id, t, event, broke);
  };

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
  const preStep = async ({ agent, messages, signal }, next) => {
    const decision = await next();
    const s = agent?.session, id = s?.id;
    if (!decision || decision.kind === 'reject' || signal?.aborted || !id || !messages?.length) return decision;
    if (!sessions.isDotSession(id, s.header?.cwd) || sessions.retired(id) || dot.hands?.isHands(id, s.header?.cwd)) return decision;
    const parts = [];
    for (const n of [...turnNotes].sort((a, b) => a.order - b.order)) {
      try { const t = String(await n.text({ agent, messages }) ?? '').trim(); if (t) parts.push(t); } catch (err) { logger.debug?.(`turn note ${n.name}: ${err.message}`); }
    }
    if (!parts.length) return decision;
    return { ...decision, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text: `<system-reminder>\n${parts.join('\n\n')}\n</system-reminder>` }], source: TURN_NOTE_SOURCE })] };
  };
  // Her clock: "since the last message" counts from the last line said before this turn began (turn note dot:now).
  const nowNote = ({ agent }) => {
    const id = agent.session.id, started = turns.get(id)?.startedAt ?? Date.now();
    return [nowText(Date.now(), ctx.get('dotMemory')?.lastSaidAt?.(started) ?? 0), id === sessions.last() ? dot.voice.reachLine() : '', id === sessions.last() ? dot.things.thingsLines() : ''].filter(Boolean).join('\n');
  };
  const scheduledNote = ({ agent, messages }) => (turns.get(agent.session.id)?.by.whose === 'schedule' || messages.some((m) => m?.source?.kind === 'schedule') ? scheduledRule() : '');

  /** What she is busy with right now (an interlude task records it when it has to wait). */
  const busyWith = () => (turns.has(sessions.last()) ? prompt('dot.busy.chat') : '');
  // Working rules are a system-prompt section for sessions in <home> (static per session, so the
  // cached prefix holds). The silence rule is additionally put in front of the model on the turn a
  // schedule wakes, as a dynamic context; only those turns get it.
  const inHome = (c) => { const s = c.agent?.session; return sessions.isDotSession(s?.id, s?.header?.cwd) || turns.has(s?.id); };

  // Turn watchdog: a turn of hers with no session event for turnStallMs is stalled (audited once).
  // Her conversation is never cancelled: he is told once per turn.
  const doingOf = (t) => t.doing || (t.said ? t.said.replace(/\s+/g, ' ').slice(0, 60) : '') || '（不清楚）';
  const turnInfo = (id, now = Date.now()) => {
    const t = turns.get(id);
    if (!t) return null;
    return { session: id, retired: sessions.retired(id), conversation: id === sessions.last(), startedAt: t.startedAt, lastEventAt: t.lastEventAt, doing: doingOf(t), ...turnState(t, { now, turnStallMs: cfg.turnStallMs }) };
  };
  const watchTurns = (now = Date.now()) => {
    if (!(cfg.turnStallMs > 0)) return;
    for (const [id, t] of [...turns]) {
      const idle = now - (t.lastEventAt ?? t.startedAt);
      if (idle < cfg.turnStallMs) continue;
      if (!t.stallAudited) { t.stallAudited = true; audit('turn-stalled', { session: id, retired: sessions.retired(id), idleMs: idle, doing: doingOf(t) }); }
      if (id !== sessions.last() || t.ownerTold) continue;
      t.ownerTold = true;
      void im.send(`⏳ dot: 她这一轮 ${Math.round(idle / 60000)} 分钟没动静了（最后在做：${doingOf(t)}）。没替她取消；要停就在 DeepSeek Harness 里点停止。`, 'plain');
    }
  };

  return {
    /** The open turn of a session (the object itself, to read), or undefined. */
    get: (id) => turns.get(id),
    has: (id) => turns.has(id),
    keys: () => turns.keys(),
    get size() { return turns.size; },
    onSessionEvent, disposeOwed, turnFailed, taken, owe,
    lastFailure: () => lastFailure,
    driftLine, watchDrift, turnNote, preStep, nowNote, scheduledNote, busyWith, inHome, doingOf, turnInfo, watchTurns,
    // What happened in a turn, said by the part it happened in (a turn that is not there takes nothing):
    spoke: (t) => { if (t) t.spoke = true; },                   // something of hers reached him in it
    opened: (t, id) => { if (t && id) t.opened.push(id); },     // she gave her hands a thing in it
    stopped: (t, ids) => { if (t) t.stopped.push(...ids); },    // she stopped what was in her hands in it
    startedOver: (t) => { if (t) t.startedOver = true; },       // cancelled to start over with his new words: nothing of its own is said
  };
}
