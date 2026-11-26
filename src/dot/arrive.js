// dsh-dot/arrive: the one way into her conversation. Everything that goes in is an arrival, given to arrive():
// { kind, for: 'him'|'her', text, images, thing, external, at, … } — kind: 'his' (his words), 'person' (someone writing:
// a notification, a QQ message, an answer a thing waited for), 'push' (an app's own news: rides along with the next),
// 'hands' (her hands back), 'setup' (a device is up), 'own' (her own time), 'note' (a line of ours, waking no one);
// external: written by someone else than him or her (kept; nothing reads it yet). What has not gone in waits in one
// list; when it may go in is decided in one place (holdFor). Holds besides: his buffer's and the batch's clocks, whether
// QQ says he is typing, the last notifications seen (for wait_for), her own thing running, the devices announced ready.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { prompt } from '../prompts.js';
import { head } from '../cut.js';
import { ERRAND_NOTE_SOURCE } from './sessions.js';
import { titleOf } from './things.js';
import { forHim, overQq } from './turns.js';
import { PHONE_NOTIFICATION_SOURCE, ownerSource, ownerUnread, ownerWords, withImages, handsStatus, pushesText, conversationTitle, wakeText } from './text.js';

export const SETUP_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'setup' });

/**
 * @param dot  the plugin's parts (core.js apply): ctx, cfg, audit, logger, im, bump, sessions, things, turns, voice;
 *             read when used: sleep (awake, wakeUp), hands (busy), ledger
 * → { arrive, wake, qqMessage, ownerTypingNow, flushOwner, ownerPending, hisUnread, freeze, onWake, turnEnded, note,
 *     pushesNote, seenNotes, herState, quiet, enqueueTask, nextTask, taskTurnEnded, watchSetup }
 */
export function createArrive(dot) {
  const { ctx, cfg, audit, logger, im, bump, sessions, things, turns, voice } = dot;
  const { resolveLive, openConversation, retired } = sessions;
  const waiting = []; // what has not gone in yet, in the order it came
  let frozen = 0;     // her conversation is being handed over (dsh-dot/memory)
  // His buffer closes (`due`) once he has been quiet ownerQuietMs after his last word or his typing, at the latest
  // ownerMaxWaitMs after the first (ownerTypingMaxMs once QQ said he was typing).
  const his = { firstAt: 0, due: 0, typing: false, seen: false };
  const armHis = (now = Date.now()) => { const cap = his.firstAt + (his.seen ? cfg.ownerTypingMaxMs : cfg.ownerMaxWaitMs); his.due = his.typing ? cap : Math.min(now + cfg.ownerQuietMs, cap); };
  let batchDue = 0;       // someone writing: one wake for what comes within notifyBatchMs of her being awake to see it
  let taskRunning = null; // her own thing in her conversation right now (see enqueueTask)

  // Why `e` does not go in now ('' = it goes), the one place this is decided. His words: while he is still writing,
  // while her bubbles to him go out, while she is handed over — not for her sleep (he wakes her) nor a running turn
  // (steered in). Someone writing: asleep, its batch, handed over, a turn of hers running (all of it goes in when that
  // ends). Her own time: asleep, anything else going on. Her hands back, a device up, a line of ours: handed over
  // only (the host queues them behind a turn). A push: never by itself.
  const holdFor = (e, now = Date.now()) => {
    switch (e.kind) {
      case 'push': return 'rides along';
      case 'his': return now < his.due ? 'his buffer' : voice.outlet.busy() ? 'sending' : frozen ? 'handoff' : '';
      case 'person': return !dot.sleep.awake() ? 'asleep' : !e.batched ? 'batch' : frozen ? 'handoff' : turns.has(sessions.last()) ? 'turn running' : '';
      case 'own': return !dot.sleep.awake() ? 'asleep' : !quiet() ? 'busy' : '';
      default: return frozen ? 'handoff' : '';
    }
  };
  const all = (kind) => waiting.filter((e) => e.kind === kind);
  const take = (es) => { for (const e of es) waiting.splice(waiting.indexOf(e), 1); return es; };
  // His words and someone writing that are on their way and not held by a handoff (that is `moving`, not theirs).
  const onTheWay = (kind) => all(kind).filter((e) => e.held !== 'handoff');

  /** The way in: the arrival waits in the list, and whatever may go in now goes. */
  const arrive = (e) => {
    const now = Date.now();
    if (e.kind === 'his') { if (!onTheWay('his').length) his.firstAt = now; his.typing = false; armHis(now); } // he pressed send
    waiting.push({ at: now, for: 'her', external: false, ...e });
    pump();
  };

  let timer = null, settling = false;
  /** Everything that may go in now goes in, in one delivery, his words first. Her own time apart (nextTask). */
  const pump = () => {
    clearTimeout(timer); timer = null;
    const now = Date.now();
    if (his.due && now >= his.due) { his.due = 0; his.typing = his.seen = false; } // his buffer closes
    if (batchDue && now >= batchDue) { batchDue = 0; if (dot.sleep.awake()) for (const e of all('person')) e.batched = true; }
    if (!batchDue && dot.sleep.awake() && all('person').some((e) => !e.batched)) batchDue = now + cfg.notifyBatchMs;
    const ready = [], held = new Map();
    for (const e of waiting) {
      if (e.kind === 'own') continue;
      const why = holdFor(e, now);
      if (!why) { ready.push(e); continue; }
      // His words or someone writing held for her turn or a handoff: audited once together; she reads that it came meanwhile.
      if ((why === 'handoff' || why === 'turn running') && e.held !== why && (e.kind === 'his' || e.kind === 'person')) { const k = `${why}|${e.kind}`; held.set(k, [...(held.get(k) ?? []), e]); e.whileBusy = true; }
      e.held = why;
    }
    for (const [k, es] of held) audit('notification-held', { count: es.length, why: k.split('|')[0], ...(k.startsWith('turn') ? { retired: retired(sessions.last()) } : {}) });
    if (ready.length) deliver(take(ready));
    // Her bubbles are going out: once they are, his words go in, with what was left unsent.
    if (!settling && all('his').some((e) => e.held === 'sending')) { settling = true; void voice.outlet.settled().finally(() => { settling = false; pump(); }); }
    const next = Math.min(...[his.due, batchDue].filter(Boolean));
    if (Number.isFinite(next)) { timer = setTimeout(pump, Math.max(0, next - now)); timer.unref?.(); }
  };

  // What goes in goes through one chain, so nothing overtakes what came before it.
  let going = Promise.resolve();
  const deliver = (ready) => {
    const words = ready.filter((e) => e.kind === 'his'), persons = ready.filter((e) => e.kind === 'person');
    if (words.length || persons.length) {
      const pkgs = [...new Set([...words, ...persons].map((e) => e.n.pkg))];
      const controller = ctx.get('sessionController');
      if (!controller) audit('notification-dropped', { pkgs, why: 'no sessionController' });
      else {
        going = going.then(async () => {
          // No conversation yet (first run, or after a reset): his words open one. Anything else has nowhere to go.
          const id = sessions.last() || (words.length ? await openConversation(controller) : '');
          if (!id) { audit('notification-dropped', { pkgs, why: 'no session yet' }); return; }
          const found = await resolveLive(id);
          if (!found || 'error' in found) { audit('notification-dropped', { pkgs, why: found?.error?.message ?? 'session not found' }); return; }
          // The owner's words, exactly as typed (several messages → several lines), as human input.
          if (words.length) toOwnerAgent(found.agent, id, words.map((e) => e.n));
          if (!persons.length) return;
          // Someone writing: one message for what came together, with the people in it as she remembers them.
          const items = persons.map((e) => e.n), whileBusy = persons.some((e) => e.whileBusy);
          const cards = ctx.get('dotMemory')?.cardsFor?.(items) ?? '';
          // An answer a thing of his was waiting for makes this turn his business: what comes of it is told to him.
          const answer = items.find((n) => n.answers);
          const noted = answer ? `\n${prompt('dot.notification.awaited', { task: head(String(answer.answersTask ?? '').split(/[。\n]/)[0], 60) }).trim()}${answer.forHim ? `\n${prompt('dot.hands.result.his').trim()}` : ''}` : '';
          found.agent.followup(createUserMessage({ content: contentFor(wakeText(items, { whileBusy, cards }) + noted, items), source: answer ? { ...PHONE_NOTIFICATION_SOURCE, thing: answer.answers, ...(answer.forHim ? { for: 'him' } : {}) } : PHONE_NOTIFICATION_SOURCE }));
          bump('woke', 1);
          audit('notification-woke', { session: id, count: items.length, pkgs: [...new Set(items.map((n) => n.pkg))], whileBusy, sinceSeenMs: Date.now() - Date.parse(items[0].at), sincePostedMs: items[0].postedAt ? Date.now() - items[0].postedAt : undefined });
        }).catch((err) => { logger.warn(`wake for notification failed: ${err.message}`); audit('notification-dropped', { pkgs, why: err.message }); });
      }
    }
    // The rest goes in its own way (`into`), into her conversation as it is then; what it does (a screenshot) holds up nothing.
    for (const e of ready.filter((x) => x.kind !== 'his' && x.kind !== 'person')) {
      going = going.then(async () => {
        const id = sessions.last();
        const found = id ? await resolveLive(id) : null;
        void Promise.resolve(e.into(found && !('error' in found) ? found.agent : null, id)).catch((err) => logger.warn(`${e.kind} did not go in: ${err.message}`));
      }).catch((err) => logger.warn(`${e.kind} did not go in: ${err.message}`));
    }
  };

  /** Has he said something she has not read — not gone in yet, or given to her agent (`agent`, else her conversation's) for its next step and not read by the model? Read-before-you-speak goes by this (voice.readFirst). */
  const hisUnread = (agent) => {
    const id = sessions.last(), mine = !agent || agent.session?.id === id;
    return (mine && all('his').length > 0) || ownerUnread(agent ?? ctx.get('agents')?.get?.(id));
  };

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
    const restart = busy && overQq(open) && forHim(open) && !open.tools && !open.spoke && typeof agent.cancel === 'function' && voice.readFirst(true) === 'gave-way';
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
        turns.startedOver(open); // only once the cancel is in: a turn that was not cancelled keeps its answer
        if (typeof agent.send === 'function') agent.send(message, 'next-turn', true); else agent.followup(message);
      } else if (via === 'steer') agent.steer(message); else if (via === 'send') agent.send(message, 'next-step', true); else agent.followup(message);
    } catch (err) { logger.warn(`${via} failed (${err.message}); followup instead`); agent.followup(message); }
    audit('owner-message', { session: id, count: items.length, whileBusy: busy, via }); bump('owner', items.length);
    turns.owe(id);
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

  /** His buffered words go in now. With `agent` (the say gate's caller, her conversation): steered into it, at once. */
  const flushOwner = (agent) => {
    const items = onTheWay('his');
    his.due = 0; his.typing = his.seen = false;
    const id = sessions.last();
    if (agent && items.length && !frozen && id && agent.session?.id === id) toOwnerAgent(agent, id, take(items).map((e) => e.n));
    else pump();
    return items.length;
  };
  /** QQ says he is typing / stopped typing: while a batch of his waits, typing holds it up to ownerTypingMaxMs. */
  const ownerTypingNow = (s) => {
    if (!s?.fromOwner || !onTheWay('his').length) return;
    his.typing = Boolean(s.typing);
    if (his.typing) his.seen = true;
    armHis(); pump();
  };

  // Apps whose notification title is who wrote (or called): a conversation with someone.
  const conversationPlatform = { qq: 'qq', 'com.tencent.mobileqq': 'qq', 'com.tencent.mm': 'wechat', 'com.google.android.apps.messaging': 'sms', 'com.android.mms': 'sms', 'com.android.messaging': 'sms', 'com.google.android.dialer': 'call', 'com.android.dialer': 'call' };
  const seenNotes = []; // the last notifications of her phone, with when they came: what wait_for looks through
  /** What her phone and her QQ show: told apart here (his words, someone writing, an app's push), then in by arrive(). */
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
    if (!n.fromOwner) { const e = things.answerTo(n); if (e) n = { ...n, answers: e.id, answersTask: e.task, forHim: e.asker === 'him', handles: n.handles ?? [`${n.pkg}:name:${conversationTitle(n.title)}`] }; }
    const said = { text: n.text, images: n.images ?? [], n };
    if (n.fromOwner) {
      voice.dropAck('he spoke');
      arrive({ kind: 'his', for: 'him', ...said });
      dot.sleep.wakeUp('him');
      voice.answerReaches();
      return;
    }
    // Someone writing to her wakes her: a chat whose sender is known (her QQ, a chat app's conversation), or what
    // the app itself calls a message or a call. An app's own push wakes no one: it is held (the latest few) and
    // shown with whatever reaches her next (dot:pushes). What it says is shown as it is; opening it is hers to decide.
    if (!n.handles && n.category !== 'msg' && n.category !== 'call') {
      take(all('push').filter((p) => n.key && p.n.key === n.key));
      arrive({ kind: 'push', external: true, ...said });
      take(all('push').slice(0, Math.max(0, all('push').length - cfg.pushesKept)));
      audit('notification-held', { pkg: n.pkg, why: 'not a person', category: n.category ?? '' });
      return;
    }
    if (!dot.sleep.awake()) audit('notification-held', { pkg: n.pkg, why: 'asleep' });
    arrive({ kind: 'person', for: n.forHim ? 'him' : 'her', thing: n.answers, external: true, ...said });
  };
  // QQ messages (NapCat in the computer) take the same road as phone notifications: batch, hold while busy, group.
  const qqMessage = (m) => wake({
    key: `qq:${m.kind}:${m.groupId || m.userId}`, pkg: 'qq', title: m.kind === 'group' ? `群 ${m.groupId} · ${m.who}` : `${m.who}（${m.userId}）`, text: m.text, at: m.at, postedAt: Date.parse(m.at), fromOwner: Boolean(m.fromOwner),
    ...(m.images?.length ? { images: m.images } : {}),
    handles: [`qq:${m.userId}`], platform: 'qq', name: m.who, kind: m.kind,
  });
  // Her phone's pushes held since she was last up (see wake): once, with whatever woke her (turn note dot:pushes).
  const pushesNote = ({ agent }) => {
    if (!all('push').length || agent.session.id !== sessions.last()) return '';
    const t = pushesText(take(all('push')).map((p) => p.n)); audit('pushes-shown', { count: t ? t.split('\n').length - 2 : 0 }); return t;
  };
  /** A line of the plugin's in her conversation, without waking it (`origin` is for the audit). */
  const note = (origin, text) => arrive({ kind: 'note', text, into: (agent, id) => {
    if (!agent || typeof agent.inject !== 'function' || !ctx.get('sessionController')) return;
    agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: ERRAND_NOTE_SOURCE }));
    audit('errand-noted', { session: id, origin });
  } });
  /** Hold deliveries to her conversation (a handoff is moving it); the returned function releases them to the new one. */
  const freeze = () => { frozen++; let done = false; return () => { if (!done) { done = true; frozen--; pump(); } }; };
  /** A turn of her conversation ended (turns.js): once that has settled, what waited for it goes in, then a thing of her own. */
  const turnEnded = (id) => { if (id === sessions.last()) setTimeout(() => { pump(); void nextTask(); }, 50); };

  // Her own things (dshDot.task: her own time): the lowest priority, one at a time, when nothing else is going on.
  // What her attention is on right now, in one place. Everything that would wake her on its own account (a thing of
  // her own, picking up her phone, the one asking) asks `quiet()`; nothing keeps a list of its own.
  const herState = () => ({
    writing: Boolean(sessions.last()) && turns.has(sessions.last()),            // a turn of her conversation is running
    sending: voice.outlet.busy(),                                               // her bubbles are going out
    hands: Boolean(dot.hands?.busy()),                                          // her hands are on a round (any thing under way)
    his: onTheWay('his').length > 0 || his.typing,                              // he said something she has not got yet, or is typing
    moving: frozen > 0,                                                         // her conversation is being handed over
    waiting: Boolean(taskRunning) || onTheWay('person').length > 0,             // something is already on its way to her
  });
  const quiet = () => !Object.values(herState()).some(Boolean);
  const finishTask = (t, status, report = '', cost = null) => {
    if (t === taskRunning) taskRunning = null; else take([t]);
    audit(`task-${status}`, { kind: t.task, key: t.key, session: t.session, waitedMs: (t.startedAt ?? Date.now()) - t.queuedAt });
    try { t.onDone?.({ status, queuedAt: t.queuedAt, startedAt: t.startedAt ?? null, doneAt: Date.now(), busyWith: t.busyWith, report, cost }); } catch (err) { logger.warn(`task onDone failed: ${err.message}`); }
  };
  // Looked at when one is posted, when a turn of hers ends and once a minute — not on every arrival (what has just gone in has not started its turn).
  const nextTask = async () => {
    const now = Date.now();
    for (const t of all('own').filter((x) => x.expiresAt <= now)) finishTask(t, 'expired');
    // What he asked for goes before her own things, after earlier asks.
    const t = all('own').find((x) => x.task === 'ask') ?? all('own')[0];
    if (!t || holdFor(t, now)) return; // her own things do not wake her
    taskRunning = take([t])[0];
    t.startedAt = now;
    try {
      // Her own time and what her phone shows her come to her conversation: there is one of her.
      let id = sessions.last();
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
      audit('task-started', { kind: t.task, key: t.key, session: id, readOnly: Boolean(t.readOnly) });
    } catch (err) { logger.warn(`task not started: ${err.message}`); finishTask(t, 'dropped'); }
  };
  /** dshDot.task: a thing of her own (`kind` is the thing's: free, ask, …; it is kept as `task`). */
  const enqueueTask = ({ ttlMs = cfg.interludeTaskTtlMs, kind, ...spec }) => {
    const now = Date.now();
    const same = spec.key && all('own').find((x) => x.key === spec.key);
    if (same) { same.expiresAt = now + ttlMs; audit('task-refreshed', { kind: same.task, key: same.key }); return 'refreshed'; }
    waiting.push({ ...spec, at: now, kind: 'own', for: kind === 'ask' ? 'him' : 'her', external: false, task: kind, queuedAt: now, expiresAt: now + ttlMs, busyWith: turns.busyWith() });
    // What he asked for is never the one dropped for room.
    while (all('own').filter((x) => x.task !== 'ask').length > Math.max(1, cfg.interludeQueueMax)) finishTask(all('own').find((x) => x.task !== 'ask'), 'dropped');
    void nextTask();
    return 'queued';
  };
  /** A turn of a session ended (turns.js): a thing of her own that ran in it gets its cost, and its end when her hands are free. */
  const taskTurnEnded = (id, t) => {
    // A thing of her own (her own time) lasts as long as her hands are still on it: the turn that started it, then
    // every turn her hands come back to, until one ends with her hands free. Its cost is all of those turns'.
    if (taskRunning?.session === id && (t.by.form === taskRunning.source?.form || (t.by.form === 'hands-result' && !t.by.thing))) {
      const c = taskRunning.cost ??= { in: 0, cached: 0, out: 0 };
      if (t.cost) { c.in += t.cost.in; c.cached += t.cost.cached; c.out += t.cost.out; }
      // What came of her own time is what the book has of the things she did in it — not what she wrote about it.
      // Her hands free: nothing of anyone's under way (one at a time, so a thing of this stretch of hers is the one there would be).
      if (!dot.hands?.busy()) finishTask(taskRunning, 'done', dot.ledger.recent(20).filter((e) => e.asker === 'her' && e.state === 'ended' && (e.endedAt ?? 0) >= (taskRunning.startedAt ?? 0)).reverse().map((e) => `${titleOf(e.task)}：${[e.outcome === 'done' ? '' : handsStatus(e, e.device), e.summary].filter(Boolean).join('。') || '没有留下结果'}`).join('\n'), c);
    }
  };

  // When a device she was waiting for (installing or booting in this run) comes up, she tells him herself.
  const announced = new Set();
  const announceReady = (device, label) => {
    if (announced.has(device)) return;
    announced.add(device);
    audit('setup-ready', { device });
    arrive({ kind: 'setup', into: (agent) => {
      if (!agent) { void im.send(`✅ dot: ${label}装好了`, 'plain'); return; }
      agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt('dot.setup-done', { device: label }) }], source: SETUP_SOURCE }));
    } });
  };
  const watchSetup = (device, label, waits) => { let wasWaiting = false; return (s) => { if (waits(s)) wasWaiting = true; else if (wasWaiting && s.state === 'ready') announceReady(device, label); }; };
  return {
    arrive, wake, qqMessage, ownerTypingNow, flushOwner,
    /** His messages waiting in his buffer (or for her bubbles to be out). */
    ownerPending: () => onTheWay('his').length,
    hisUnread, freeze, turnEnded, note, pushesNote,
    /** She just woke (sleep.js onWake): what waited is shown to her. */
    onWake: () => pump(),
    /** The last notifications of her phone (the array itself: wait_for and done look through it). */
    seenNotes: () => seenNotes,
    herState, quiet, enqueueTask, nextTask, taskTurnEnded, watchSetup,
  };
}
