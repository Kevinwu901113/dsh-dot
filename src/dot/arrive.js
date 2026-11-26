// dsh-dot/arrive: what reaches her and how it gets there (taken out of core.js as it was).
// Holds: his words' own buffer (and whether QQ says he is typing), what her phone and her QQ showed (the batch, held
// while a turn runs, the pushes nobody sent, the last notifications seen), what waits while her conversation is handed
// over (frozen), the one chain every wake goes through (waking), her own things (the task queue and the one running),
// and the devices announced ready.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { prompt } from '../prompts.js';
import { head } from '../cut.js';
import { titleOf } from './things.js';
import { forHim, overQq } from './turns.js';
import { PHONE_NOTIFICATION_SOURCE, ownerSource, ownerUnread, ownerWords, withImages, handsStatus, pushesText, conversationTitle, wakeText } from './text.js';

export const SETUP_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'setup' });

/**
 * @param dot  the plugin's parts (core.js apply): ctx, cfg, audit, logger, im, bump, sessions, things, turns, voice;
 *             read when used: sleep (awake, wakeUp), hands (busy), ledger
 * → { wake, qqMessage, ownerTypingNow, flushOwner, ownerPending, hisUnread, deliver, send, releaseHeld, moved, freeze,
 *     onWake, pushesNote, seenNotes, herState, quiet, enqueueTask, nextTask, taskTurnEnded, announceReady, watchSetup }
 */
export function createArrive(dot) {
  const { ctx, cfg, audit, logger, im, bump, sessions, things, turns, voice } = dot;
  const { resolveLive, openConversation, retired } = sessions;
  // 5. Her phone rings: a new notification wakes her in her latest session. She reads and answers in
  // the app herself; the dsh reply is not relayed anywhere.
  let waking = Promise.resolve();
  let pushes = []; // her phone's pushes that no one sent (see wake): shown with the next thing that reaches her
  let batch = [], batchTimer = null; // what her phone and her QQ showed (not his words): one wake for what arrives within notifyBatchMs
  const held = new Map(); // session id → items that arrived while it was running a turn (each with heldAt); delivered as one message when it ends
  let deliverTracked; // assigned below, used by flush/releaseHeld
  const deliver = (all, whileBusy, target) => {
    const controller = ctx.get('sessionController');
    const pkgs = [...new Set(all.map((n) => n.pkg))];
    if (!controller) { audit('notification-dropped', { pkgs, why: 'no sessionController' }); return; }
    const fromOwner = all.filter((n) => n.fromOwner);
    const items = all.filter((n) => !n.fromOwner);
    waking = waking.then(async () => {
      // No conversation yet (first run, or after a reset): his words open one. Anything else has nowhere to go.
      const id = target || sessions.last() || (fromOwner.length ? await openConversation(controller) : '');
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
  /**
   * Has he said something she has not read? Still in his buffer, held while her conversation is handed over, or handed
   * to her agent for its next step and not read by the model yet (`agent`: the one asking, else her conversation's).
   * The one reading of "unread" that read-before-you-speak goes by (voice.readFirst).
   */
  const hisUnread = (agent) => {
    const id = sessions.last(), mine = !agent || agent.session?.id === id;
    return (mine && (ownerBatch.length > 0 || frozenQueue.some((n) => n.fromOwner))) || ownerUnread(agent ?? ctx.get('agents')?.get?.(id));
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
  let frozen = 0; let frozenQueue = []; let frozenWaiters = []; // while her conversation is being handed over (dsh-dot/memory)
  /** Resolves once her conversation is not being handed over (at once, when it is not). */
  const moved = () => (frozen ? new Promise((go) => frozenWaiters.push(go)) : Promise.resolve());
  const send = (id, items) => {
    if (!items.length) return;
    if (frozen && id === sessions.last()) { frozenQueue.push(...items); audit('notification-held', { count: items.length, why: 'handoff' }); return; }
    // That session is in the middle of a turn: hold these; the turn's end delivers everything at once, in order.
    // (His own words never come this way: they have their own buffer and are steered in, see flushOwner.)
    if (id && turns.has(id)) { held.set(id, [...(held.get(id) ?? []), ...items.map((n) => ({ heldAt: Date.now(), ...n }))]); audit('notification-held', { count: items.length, why: 'turn running', retired: retired(id) }); return; }
    deliverTracked(items, false, id);
  };
  // Asleep, what came stays here until she wakes; then it is all shown to her at once, in order.
  const flush = () => {
    batchTimer = null;
    if (!dot.sleep.awake()) return; // waking shows it to her (wakeUp)
    const items = batch; batch = []; send(sessions.last(), items);
  };
  /** She just woke (sleep.js onWake): what waited is shown to her. */
  const onWake = () => { if (batch.length && !batchTimer) { batchTimer = setTimeout(flush, cfg.notifyBatchMs); batchTimer.unref?.(); } };
  // What arrived while her conversation was in a turn goes in when the turn ends.
  const releaseHeld = async (id) => { const items = held.get(id); if (!items?.length) return; held.delete(id); deliverTracked(items, true, id); };
  // Her own things (dshDot.task: her own time): the lowest priority, one at a time, when nothing else is going on.
  const taskQueue = []; let taskRunning = null;
  // What her attention is on right now, in one place. Everything that would wake her on its own account (a thing of
  // her own, picking up her phone, the one asking) asks `quiet()`; nothing keeps a list of its own.
  const herState = () => ({
    writing: Boolean(sessions.last()) && turns.has(sessions.last()),       // a turn of her conversation is running
    sending: voice.outlet.busy(),                                  // her bubbles are going out
    hands: Boolean(dot.hands?.busy()),                             // her hands are on a round (any thing under way)
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
    if (!taskQueue.length || !quiet() || !dot.sleep.awake()) return; // her own things do not wake her
    const t = taskRunning = taskQueue.shift();
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
      audit('task-started', { kind: t.kind, key: t.key, session: id, readOnly: Boolean(t.readOnly) });
    } catch (err) { logger.warn(`task not started: ${err.message}`); finishTask(t, 'dropped'); }
  };
  const enqueueTask = ({ ttlMs = cfg.interludeTaskTtlMs, ...spec }) => {
    const now = Date.now();
    const same = spec.key && taskQueue.find((x) => x.key === spec.key);
    if (same) { same.expiresAt = now + ttlMs; audit('task-refreshed', { kind: same.kind, key: same.key }); return 'refreshed'; }
    const task = { ...spec, queuedAt: now, expiresAt: now + ttlMs, busyWith: turns.busyWith() };
    // What he asked for goes before her own things, after earlier asks; it is never the one dropped for room.
    if (spec.kind === 'ask') taskQueue.splice(taskQueue.filter((x) => x.kind === 'ask').length, 0, task); else taskQueue.push(task);
    while (taskQueue.filter((x) => x.kind !== 'ask').length > Math.max(1, cfg.interludeQueueMax)) finishTask(taskQueue.find((x) => x.kind !== 'ask'), 'dropped');
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
    if (!agent && voice.outlet.busy() && ownerBatch.length) { void voice.outlet.settled().finally(() => flushOwner()); return 0; }
    const items = ownerBatch; ownerBatch = []; ownerTyping = ownerTypingSeen = false;
    if (!items.length) return 0;
    const id = sessions.last();
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
    if (!n.fromOwner) { const e = things.answerTo(n); if (e) n = { ...n, answers: e.id, answersTask: e.task, forHim: e.asker === 'him', handles: n.handles ?? [`${n.pkg}:name:${conversationTitle(n.title)}`] }; }
    if (n.fromOwner) {
      voice.dropAck('he spoke');
      if (!ownerBatch.length) ownerFirstAt = Date.now();
      ownerBatch.push(n); ownerTyping = false; // he pressed send
      dot.sleep.wakeUp('him');
      voice.answerReaches();
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
    if (!dot.sleep.awake()) { audit('notification-held', { pkg: n.pkg, why: 'asleep' }); return; }
    if (!batchTimer) { batchTimer = setTimeout(flush, cfg.notifyBatchMs); batchTimer.unref?.(); }
  };
  // QQ messages (NapCat in the computer) take the same road as phone notifications: batch, hold while busy, group.
  const qqMessage = (m) => wake({
    key: `qq:${m.kind}:${m.groupId || m.userId}`, pkg: 'qq', title: m.kind === 'group' ? `群 ${m.groupId} · ${m.who}` : `${m.who}（${m.userId}）`, text: m.text, at: m.at, postedAt: Date.parse(m.at), fromOwner: Boolean(m.fromOwner),
    ...(m.images?.length ? { images: m.images } : {}),
    handles: [`qq:${m.userId}`], platform: 'qq', name: m.who, kind: m.kind,
  });
  // Her phone's pushes held since she was last up (see wake): once, with whatever woke her (turn note dot:pushes).
  const pushesNote = ({ agent }) => { if (!pushes.length || agent.session.id !== sessions.last()) return ''; const t = pushesText(pushes); pushes = []; audit('pushes-shown', { count: t ? t.split('\n').length - 2 : 0 }); return t; };
  /** Hold deliveries to her conversation (a handoff is moving it); the returned function releases them to the new one. */
  const freeze = () => {
    frozen++;
    let done = false;
    return () => {
      if (done) return; done = true;
      frozen = Math.max(0, frozen - 1);
      if (!frozen) { const waiting = frozenWaiters; frozenWaiters = []; for (const go of waiting) go(); }
      if (frozen || !frozenQueue.length) return;
      const items = frozenQueue; frozenQueue = [];
      deliverTracked(items, true, sessions.last());
    };
  };
  // When a device she was waiting for (installing or booting in this run) comes up, she tells him herself.
  const announced = new Set();
  const announceReady = (device, label) => {
    if (announced.has(device)) return;
    announced.add(device);
    audit('setup-ready', { device });
    const id = sessions.last();
    if (!id) { void im.send(`✅ dot: ${label}装好了`, 'plain'); return; }
    waking = waking.then(async () => {
      const found = await resolveLive(id);
      if (!found || 'error' in found) { void im.send(`✅ dot: ${label}装好了`, 'plain'); return; }
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt('dot.setup-done', { device: label }) }], source: SETUP_SOURCE }));
    }).catch((err) => logger.warn(`setup announce failed: ${err.message}`));
  };
  const watchSetup = (device, label, waiting) => { let wasWaiting = false; return (s) => { if (waiting(s)) wasWaiting = true; else if (wasWaiting && s.state === 'ready') announceReady(device, label); }; };
  deliverTracked = deliver;
  return {
    wake, qqMessage, ownerTypingNow, flushOwner,
    /** His messages waiting in the buffer. */
    ownerPending: () => ownerBatch.length,
    hisUnread, deliver, send, releaseHeld, moved, freeze, onWake, pushesNote,
    /** The last notifications of her phone (the array itself: wait_for and done look through it). */
    seenNotes: () => seenNotes,
    herState, quiet, enqueueTask, nextTask, taskTurnEnded, announceReady, watchSetup,
  };
}
