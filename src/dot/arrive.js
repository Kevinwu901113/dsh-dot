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
import { addSpend } from '../price.js';

export const SETUP_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'setup' });

/**
 * @param dot  the plugin's parts (core.js apply): ctx, cfg, audit, logger, im, bump, sessions, things, turns, voice;
 *             read when used: sleep (awake, wakeUp), hands (busy, thingById), ledger
 * → { arrive, wake, qqMessage, ownerTypingNow, flushOwner, ownerPending, hisUnread, freeze, onWake, turnStarted, turnEnded,
 *     overflowed, comingAgain, movedOn, notMoved, note,
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
  const onTheWay = (kind) => all(kind).filter((e) => e.held !== 'handoff'); // a handoff is `moving`, not theirs

  // What has gone in and has not been through a turn that ended: { e, session, turn } — `turn` the open turn it was
  // steered into, or null while it waits in the session's inbox for the next one (bound when that starts). It is let
  // go when its turn ends; a turn that broke because her conversation no longer fits the model keeps it for the new
  // conversation (overflowed). A line of ours (`note`) wakes no turn and is not kept.
  const sent = [];
  const track = (e, session, turn = null) => { if (e.kind === 'note') return; sent.push({ e, session, turn }); if (sent.length > 100) sent.shift(); };
  const untrack = (es) => { for (const s of es) sent.splice(sent.indexOf(s), 1); return es; };
  /** A turn of a session started (turns.js): what waits in its inbox is that turn's. */
  const turnStarted = (id, t) => { for (const s of sent) if (s.session === id && s.turn === null) s.turn = t; };
  // Her conversation no longer fits the model (turns.js: a turn of it broke on that). dsh-dot/memory hands her over to a
  // new one; what that turn was given — what woke it, his words steered into it — and whatever still waited in the
  // conversation she leaves arrives again there, by arrive(), once (`again`): to him it is as if nothing had happened.
  // Kept by the conversation it broke in, until she has moved (movedOn) or memory says she will not (notMoved); only
  // then is he told, and what was kept is let go. What already came again once is never sent a third time.
  const overflow = new Map(); // session → { es, since (when the first turn that broke began), error, lost, his, outcome }
  /** A turn of her conversation broke because it no longer fits: true when what it was given is kept for the new conversation. */
  const overflowed = (id, t, info) => {
    if (id !== sessions.last() || typeof ctx.get('dotMemory')?.handoff !== 'function') return false; // nobody to hand her over
    const o = overflow.get(id) ?? { es: [], since: t.startedAt, his: false };
    const es = untrack(sent.filter((s) => s.session === id && s.turn === t)).map((s) => s.e);
    o.es.push(...es);
    Object.assign(o, info, { since: Math.min(o.since, t.startedAt), his: o.his || info.his });
    overflow.set(id, o);
    audit('turn-overflowed', { session: id, held: es.length, his: info.his });
    return true;
  };
  /** What of his will arrive again in the conversation after `from` ({ since, words }, or null): memory leaves it out of the lines it carries over. */
  const comingAgain = (from) => {
    const o = overflow.get(from);
    if (!o) return null;
    return { since: o.since, words: [...o.es, ...sent.filter((s) => s.session === from).map((s) => s.e)].filter((e) => e.kind === 'his' && !e.again).map((e) => String(e.n?.text ?? e.text ?? '')) };
  };
  /** He is told what became of a turn that broke because her conversation no longer fits, and what was kept for it is let go. */
  const overflowTold = (from, o, why, es, error = o.error) => {
    audit('overflow-dropped', { session: from, count: es.length, why });
    turns.turnFailed(from, error, { lost: o.lost, his: o.his, outcome: o.outcome, overflow: why });
  };
  /** Her conversation moved on (dshDot.setSession): after an overflow, what was kept arrives in the new one; otherwise what went into the one she left is let go. */
  const movedOn = (from, to) => {
    // Her own time going on when she moved goes on in the new conversation: its end is the end of a turn there.
    if (taskRunning?.session === from) { taskRunning.session = to; audit('task-moved', { kind: taskRunning.task, from, to }); }
    const o = overflow.get(from);
    overflow.delete(from);
    const rest = untrack(sent.filter((s) => s.session === from)).map((s) => s.e);
    if (!o) return;
    const es = [...o.es, ...rest], once = es.filter((e) => !e.again), twice = es.filter((e) => e.again);
    audit('overflow-resent', { from, to, count: once.length, kinds: once.map((e) => e.kind) });
    // Held for the handoff from the start (it is going on): not held anew, and his words not put in his buffer again.
    for (const e of once) arrive({ ...e, again: true, held: 'handoff' });
    if (twice.length) overflowTold(from, o, 'again', twice);
  };
  /** dsh-dot/memory did not move her after an overflow (`r`: the handoff's { error } or { skipped }, or { again: true } — the conversation an overflow made overflowed too). */
  const notMoved = (from, r = {}) => {
    const o = overflow.get(from);
    if (!o) return;
    overflow.delete(from);
    const why = r.again ? 'again' : 'failed';
    overflowTold(from, o, why, o.es, why === 'failed' ? `${o.error ?? ''}（换新对话没成：${r.error ?? r.skipped ?? '没有说原因'}）` : o.error);
  };

  /** The way in: the arrival waits in the list, and whatever may go in now goes. */
  const arrive = (e) => {
    if (e.kind === 'his' && !e.again) { if (!onTheWay('his').length) his.firstAt = Date.now(); his.typing = false; armHis(); } // he pressed send
    waiting.push({ at: Date.now(), for: 'her', external: false, ...e }); pump();
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
          if (words.length) toOwnerAgent(found.agent, id, words);
          if (!persons.length) return;
          // Someone writing: one message for what came together, with the people in it as she remembers them.
          const items = persons.map((e) => e.n), whileBusy = persons.some((e) => e.whileBusy);
          const cards = ctx.get('dotMemory')?.cardsFor?.(items) ?? '';
          // An answer a thing of his was waiting for makes this turn his business: what comes of it is told to him.
          const answer = items.find((n) => n.answers);
          const noted = answer ? `\n${prompt('dot.notification.awaited', { task: head(String(answer.answersTask ?? '').split(/[。\n]/)[0], 60) }).trim()}${answer.forHim ? `\n${prompt('dot.hands.result.his').trim()}` : ''}` : '';
          for (const e of persons) track(e, id);
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
        if (found && !('error' in found)) track(e, id);
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
  const toOwnerAgent = (agent, id, es) => {
    const items = es.map((e) => e.n);
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
    // Steered in, they are the open turn's; otherwise the next turn's — and so is what the turn started over had.
    if (via === 'restart') for (const s of sent) if (s.session === id && s.turn === open) s.turn = null;
    for (const e of es) track(e, id, via === 'steer' || via === 'send' ? open : null);
    try {
      if (via === 'restart') {
        // The cancelled turn's own input stays in her history. His new words are queued in the same tick: waking
        // input submitted after an active cancellation is held by the host for the next turn and runs when the
        // aborted one has settled, so nothing waits on a promise of ours and the order is the host's inbox order.
        agent.cancel({ kind: 'hook', reason: 'dot-owner-spoke' }, { keepInbox: true });
        turns.startedOver(open); // only once the cancel is in: a turn that was not cancelled keeps its answer
        if (typeof agent.send === 'function') agent.send(message, 'next-turn', true); else agent.followup(message);
      } else if (via === 'steer') agent.steer(message); else if (via === 'send') agent.send(message, 'next-step', true); else agent.followup(message);
    } catch (err) { logger.warn(`${via} failed (${err.message}); followup instead`); for (const s of sent) if (es.includes(s.e)) s.turn = null; agent.followup(message); }
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
    if (agent && items.length && !frozen && id && agent.session?.id === id) toOwnerAgent(agent, id, take(items));
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
  /** A turn of a session ended (turns.js): what went in for it is let go; for her conversation, once that has settled, what waited for it goes in, then a thing of her own. */
  const turnEnded = (id, t) => {
    untrack(sent.filter((s) => s.session === id && s.turn === t));
    if (id === sessions.last()) setTimeout(() => { pump(); void nextTask(); }, 50);
  };

  // Her own things (dshDot.task: her own time): the lowest priority, one at a time, when nothing else is going on.
  // What her attention is on right now, in one place. Everything that would wake her on its own account (a thing of
  // her own, picking up her phone, the one asking) asks `quiet()`; nothing keeps a list of its own.
  const herState = () => ({
    writing: Boolean(sessions.last()) && turns.has(sessions.last()),            // a turn of her conversation is running
    sending: voice.outlet.busy(),                                               // her bubbles are going out
    hands: Boolean(dot.hands?.busy()),                                          // a thing of hers is under way, in any place (its end will wake her)
    his: onTheWay('his').length > 0 || his.typing,                              // he said something she has not got yet, or is typing
    moving: frozen > 0,                                                         // her conversation is being handed over
    waiting: Boolean(taskRunning) || onTheWay('person').length > 0,             // something is already on its way to her
  });
  const quiet = () => !Object.values(herState()).some(Boolean);
  /**
   * Is this session's work right now her own time's (the stretch running, taskRunning)? Her conversation: when the turn
   * running in it was opened by her own time or by her hands coming back to a thing of hers — not by his words or
   * anyone else's, which may come in the same conversation while her own time waits on her hands (11-26: a session
   * id alone counted his turns into her own time's budget, and could have stopped them). Her hands: when their thing
   * was given in this stretch. What her own time costs and may do is judged by this, not by the session id.
   */
  const ownTime = (id, cwd) => {
    if (!taskRunning || !id) return false;
    const t0 = taskRunning.session ? turns.get(taskRunning.session) : null;
    const ownTurn = (t) => Boolean(t) && t.by.whose === 'her' && (t.by.form === taskRunning.source?.form || t.by.form === 'hands-result');
    if (id === taskRunning.session) return ownTurn(turns.get(id));
    const thing = dot.hands?.isHands(id, cwd) ? dot.hands.thingOf(id) : null;
    return Boolean(thing) && !thing.forHim && (taskRunning.things.includes(thing.id) || (ownTurn(t0) && (t0.opened ?? []).includes(thing.id)));
  };
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
    t.startedAt = now; t.things = []; // what she gives her hands in this stretch of her own
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
  /** A turn of a session ended (turns.js): a thing of her own that ran in it gets its cost, and its end once what she gave her hands in it is over. */
  const taskTurnEnded = (id, t) => {
    // A thing of her own (her own time) lasts as long as what she gave her hands in it is under way: the turn that
    // started it, then every turn her hands come back to, until one ends with none of the things of this stretch
    // under way — things of his in other places do not hold it. Its cost is all of those turns'.
    if (taskRunning?.session === id && (t.by.form === taskRunning.source?.form || (t.by.form === 'hands-result' && !t.by.thing))) {
      const c = taskRunning.cost ??= { in: 0, cached: 0, out: 0 };
      if (t.cost) addSpend(c, t.cost, t.cost);
      taskRunning.things.push(...(t.opened ?? []));
      // What came of her own time is what the book has of the things she did in it — not what she wrote about it.
      if (!taskRunning.things.some((x) => dot.hands?.thingById(x))) finishTask(taskRunning, 'done', taskRunning.things.map((x) => dot.ledger.get(x)).filter((e) => e?.state === 'ended').map((e) => `${titleOf(e.task)}：${[e.outcome === 'done' ? '' : handsStatus(e, e.device), e.summary].filter(Boolean).join('。') || '没有留下结果'}`).join('\n'), c);
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
    hisUnread, freeze, turnStarted, turnEnded, overflowed, comingAgain, movedOn, notMoved, note, pushesNote,
    /** She just woke (sleep.js onWake): what waited is shown to her. */
    onWake: () => pump(),
    /** The last notifications of her phone (the array itself: wait_for and done look through it). */
    seenNotes: () => seenNotes,
    herState, quiet, ownTime,
    /** The conversation her own time is going on in ('' when none is). */
    ownTimeSession: () => taskRunning?.session ?? '',
    enqueueTask, nextTask, taskTurnEnded, watchSetup,
  };
}
