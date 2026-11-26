// dsh-dot/hands: her phone and her computer, operated for her — a whole thing at a time, one thing a place at a time.
//
// There is one of her: the conversation. Hands are not her: a session with the device tools and nothing else of
// hers — no card, no memory, no QQ. Until 11-20 she gave them one press at a time and was woken after each: in one
// evening 972 calls of hers for 230 rounds, 130 of them stopped by herself six seconds in (the only thing she could
// do while a round ran was to ask again), and 95 messages to him about a phone that was fine. So:
//   - A thing she gives her hands is the whole of it ("去那个站挑几张猫的贴图存下来"), and they do it to the end.
//     Nothing comes back in between: she has nothing to look at, so nothing to ask about and nothing to stop.
//   - It is an object here, not a state of some session: under way / waiting for her / over. Her conversation moving
//     to a new session, him saying stop, a reset — each is one call on it.
//   - It ends in one of two ways she is woken for: it is over (done, stopped, took too long, could not run), or her
//     hands need her — a choice that is hers, words that have to be hers — and say so with their one tool for that
//     (ask), never in the prose of a report. The thing then ends as stuck on that question: nothing waits in a
//     half-open state. What she decides she gives as a new thing; the device is where the last one left it.
//   - Each thing gets hands that have seen nothing else: what was stopped before cannot be picked up again by
//     mistake (11-20: a tap she had cancelled was made four rounds later).
//   start({ device, task })  → { status: 'started' } at once; or 'busy' (what that place is on) / 'failed'.
//   add(text)                → one more thing said to the hands at work, read between two of their steps.
//   ask(question)            ← from the hands' own tool: this round ends as a question to her.
//   finish({ summary, detail, task, reached }) ← from the hands' own tool: it is over, what came of it, its short name, and
//                            whether what was wanted was reached (not reached: the thing failed)
//   fail({ cause, error })   → the code ends it as failed (the same error over and over)
//   stop({ by, cause })      → everything under way ends now, stopped (with `thing`: that one).
// How a thing ends is told as facts (ledger.js): its outcome, who stopped it, why, the hands' summary and details.
// Nothing here writes a sentence for anyone: each reader words them for itself.
// Every thing is an entry in the ledger (ledger.js): opened and begun when she gives it, ended when it is over.
// Each place (phone, computer, host, web) has one lock, and this file is the only record of who holds it: a thing
// under way there (from start to its end, whatever its hands' session does in between), or — phone and computer —
// a session that is not her hands using the device directly (a qq-bridge chat: hold(), until its turn ends or it
// has left the device alone DIRECT_IDLE_MS). Things in different places run together; a thing given to a place that
// is held does not wait in any line: start says at once what holds it ('busy'), and what to do about that is hers.
// The web has nothing to lock — no one else can be on it — but the same one-at-a-time: so a place names the thing
// under way there, and two lookups cost one session's fixed share of every step, not two (a second question is added
// to the first). What is under way is kept by the hands' session it is done in, not as "the" thing: whoever asks says
// which — a hook of a hands session asks for that session's (thingOf), the ledger's id finds one (thingById), a place
// the one there (on), and what is under way can be listed (things). doing()/busy() are "any of them" for whoever means
// any. What the wiring counts per thing (the same error, the same screen, when they last did something) is kept on
// the thing itself (keptOf) and goes with it.
// The calls that act on a thing (ask, note, has, finish, fail, add, asked; stop with `thing`) take `which` last:
// { session } or { thing }; left out, the first one begun.
// The hands' sessions live outside her home (so nothing that goes by "a session in her home" takes them for her).
import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { headTail } from './ledger.js';
import { head } from '../cut.js';

const squash = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
export const HANDS_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'hands' });
const SHOWN_MAX = 200000; // characters of screen text a thing keeps for has() (the newest)
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${head(t, n)}…` : t; };
const inside = (dir, p) => { const a = resolve(String(dir)), b = resolve(String(p || sep)); return b === a || b.startsWith(a + sep); };
/** A session using a device directly (not her hands) has left it alone this long: it is not holding it any more. */
export const DIRECT_IDLE_MS = 120000;

/**
 * @param deps.dir        the hands' working folder (outside her home)
 * @param deps.create     async (cwd, device) => session id ('' when the host cannot make one)
 * @param deps.agentFor   async (id) => the agent handle ({ followup, cancel? }) or null — asked for each time it is used: the
 *                        handle of a session that is not running is a thinner one, and goes stale
 * @param deps.ledger     the book of things (ledger.js)
 * @param deps.overCap    (entry) => '' or the question to ask him when a thing has cost more than it may (it ends stuck there)
 * @param deps.done       () => what they are told when a run ends without their tool saying it is done (once)
 * @param deps.onEvent    (fn: (session, event) => void) => dispose — the host's session events
 * @param deps.message    (text) => the user message that carries a task or something added to it
 * @param deps.textOf     (content) => text of an assistant message's content
 * @param deps.store      { get(key), set(key, value) } — remembered across restarts
 * @param deps.onDone     (result, thing) — it is over. result = { outcome, by, cause?, error?, summary?, detail?, question?, ask?, steps, rounds, ms, notes }
 * @param deps.retire     (id) — a session the hands are done with (the host may put it away)
 * @param deps.maxMs      a thing is cut after this long
 * @param deps.lane       (event, { device, session, holder, why? }) — a session that is not her hands took a device ('acquired'),
 *                        was not let on ('refused'), or let it go ('expired')
 */
export function createHands({ dir, create, agentFor, onEvent, message, textOf, store, ledger, overCap = () => '', done = () => '', onDone = () => {}, retire = () => {}, audit = () => {}, lane = () => {}, maxMs = 600000, maxChars = 900, now = () => Date.now() }) {
  const past = new Set(store.get('handsPast') ?? []);
  { const old = store.get('handsSession'); if (old) { past.add(String(old)); store.set('handsSession', ''); } } // one session for all rounds, before 0.25
  { const old = store.get('handsThing'); if (old) { ledger.end(ledger.open({ asker: old.forHim ? 'him' : 'her', device: old.device, task: old.task }), { outcome: 'failed', cause: 'restart' }); store.set('handsThing', null); } } // the one thing on record, before the ledger
  // What is under way: by its entry, in the order begun; and by the hands' session it is done in, once that session
  // is made (a thing is under way from start, its session comes a moment later). At most one a place (start).
  const under = new Map();     // entry id → thing under way: { entry, id (its session), device, task, extra, kept, … }
  const bySession = new Map(); // hands session id → that thing
  const direct = new Map();    // device → { session, tool, at }: a session that is not her hands, on the device itself
  let offDirect = null;        // their turns' ends are listened for while any of them holds a device
  /** The first one begun: what a call that does not say which acts on. */
  const first = () => under.values().next().value ?? null;
  const onDevice = (device) => [...under.values()].find((t) => t.device === device) ?? null;
  const letGo = (device, why) => { const d = direct.get(device); if (!d) return; direct.delete(device); lane('expired', { device, session: d.session, holder: d.session, why }); if (!direct.size && offDirect) { try { offDirect(); } catch (e) { void e; } offDirect = null; } };
  /** The thing `which` names, under way: { session } its hands' session, { thing } its entry; left out, first(). */
  const pick = (which) => (which == null ? first() : 'thing' in which ? under.get(which.thing) ?? null : 'session' in which ? bySession.get(which.session) ?? null : first());
  const free = (t) => { if (under.get(t.entry) !== t) return false; under.delete(t.entry); if (t.id && bySession.get(t.id) === t) bySession.delete(t.id); return true; };
  const remember = (id) => { past.add(id); store.set('handsPast', [...past].slice(-30)); };
  const call = (fn, ...a) => { try { Promise.resolve(fn(...a)).catch(() => {}); } catch (error) { void error; } };
  const view = (t) => ({ id: t.entry, session: t.id, device: t.device, task: t.task, ...t.extra });
  /** A thing under way as it is right now, for whoever asks (doing, thingOf, thingById, things); null for none. */
  const now_ = (t) => (t ? { id: t.entry, session: t.id, device: t.device, task: t.task, state: 'running', question: t.question, startedAt: t.startedAt, said: clip(t.said || t.last, 120), steps: t.steps, forHim: Boolean(t.extra?.forHim) } : null);
  /** Who holds this place now: { thing } (a thing under way there, as doing() shows it), { session, tool, at } (a session on the device directly), or null. */
  const holderOf = (device) => {
    const t = onDevice(device);
    if (t) return { thing: now_(t) };
    const d = direct.get(device);
    if (d && now() - d.at > DIRECT_IDLE_MS) letGo(device, 'idle');
    return direct.has(device) ? { ...direct.get(device) } : null;
  };
  const snapshot = (t, more) => ({ steps: t.steps, rounds: t.rounds, ms: now() - t.startedAt, notes: t.notes, ...more });
  const withAgent = async (t, fn) => { const agent = t.id ? await agentFor(t.id) : null; if (!agent) throw new Error('no hands session'); return fn(agent); };
  /**
   * The thing is over, whichever way. `outcome`: done · stuck · failed · timeout · stopped; `by`: whose word ended it
   * (him, her, or the code); `cause` (ledger.js CAUSES) and `error` when it did not simply end.
   */
  const settle = (t, outcome, { by = 'code', cause = '', error = '' } = {}) => {
    if (t.over) return; t.over = true;
    clearTimeout(t.timer); try { t.off?.(); } catch (e) { void e; }
    const running = under.get(t.entry) === t && t.state === 'running';
    free(t);
    // A run still going is ended here: stopped or too long, or done by their own word (their tool, nothing more to say).
    if (running && (outcome === 'stopped' || outcome === 'timeout' || t.result || cause === 'same-error')) call(withAgent, t, (agent) => agent.cancel?.({ kind: 'hook', reason: `dot-hands: ${outcome}` }));
    // What came of it: their own summary and details when they gave them (finish), else what they last said, as details.
    const summary = String(t.result?.summary ?? '').trim(), detail = headTail(t.result ? t.result.detail : t.said, maxChars);
    const facts = { outcome, by, ...(cause ? { cause } : {}), ...(error ? { error: String(error).slice(0, 160) } : {}), ...(summary ? { summary } : {}), ...(detail ? { detail } : {}), ...(t.result?.name ? { name: t.result.name } : {}), ...(outcome === 'stuck' ? { question: t.question, ...(t.ask ? { ask: t.ask } : {}) } : {}) };
    const out = snapshot(t, facts);
    ledger.end(t.entry, facts);
    audit('hands-thing', { thing: t.entry, session: t.id, device: t.device, outcome, by, steps: t.steps, rounds: t.rounds, ms: out.ms, ...(cause ? { cause } : {}) });
    if (t.id) call(retire, t.id);
    call(onDone, out, view(t));
  };
  /** Their run begins: what they are given, and how long they have. */
  const round = async (t, text) => {
    t.state = 'running'; t.question = ''; t.said = ''; t.rounds++;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => settle(t, 'timeout', { cause: 'timeout' }), maxMs); t.timer.unref?.();
    await withAgent(t, (agent) => agent.followup(message(text)));
  };
  /** Hands that have seen nothing else are made for it, and given the whole of it. */
  const begin = (mine) => {
    under.set(mine.entry, mine); mine.startedAt = now();
    ledger.begin(mine.entry);
    void (async () => {
      try {
        try { mkdirSync(dir, { recursive: true }); } catch (error) { void error; }
        const id = mine.id = await create(dir, mine.device);
        if (id && !mine.over) bySession.set(id, mine);
        if (id) { remember(id); audit('hands-opened', { session: id, thing: mine.entry }); }
        if (id) ledger.note(mine.entry, { session: id });
        if (mine.over) return;
        if (!id) { settle(mine, 'failed', { cause: 'no-session' }); return; }
        mine.off = onEvent((session, event) => {
          if (session?.id !== id || mine.over || mine.state !== 'running') return;
          if (event?.type === 'tool/call') { mine.steps++; ledger.count(mine.entry, { steps: 1 }); }
          // What the screen showed them, as text: what they type is checked against this (has).
          else if (event?.type === 'tool/result') { const c = event.data?.message?.content; let s = textOf(c); if ((!s || typeof s !== 'string') && c && typeof c === 'object') { try { s = JSON.stringify(c); } catch (error) { void error; s = ''; } } if (s) mine.shown = `${mine.shown}\n${s}`.slice(-SHOWN_MAX); }
          else if (event?.type === 'assistant/message') {
            const u = event.data?.usage;
            if (u) {
              ledger.count(mine.entry, { tokens: { in: (Number(u.inputTokens ?? 0) || 0) + (Number(u.cacheWriteTokens ?? 0) || 0), cached: u.cacheReadTokens, out: u.outputTokens } });
              // Over what a thing may cost without his yes: it stops here, as a question for him.
              const q = overCap(ledger.get(mine.entry) ?? {});
              if (q && !mine.question) { mine.question = q; mine.ask = { for: 'him', kind: 'spend' }; call(withAgent, mine, (agent) => agent.cancel?.({ kind: 'hook', reason: 'dot-hands: over its cost' })); settle(mine, 'stuck', { cause: 'over-cap' }); return; }
            }
            // What a run closes with is its result: its last message, when that one calls no tool. What was said beside a call is on the way, not the outcome.
            if (!event.data?.interrupted) { const c = event.data?.message?.content; const t = textOf(c); if (String(t ?? '').trim()) mine.last = t; mine.said = Array.isArray(c) && c.some((b) => b?.type === 'tool-call') ? '' : String(t ?? ''); }
          }
          else if (event?.type === 'turn/end') {
            // Ended by someone else (the host, a crash of the step): not done, and not a question either.
            if (event.data?.reason?.kind === 'aborted') { settle(mine, 'failed', { cause: 'interrupted' }); return; }
            // The run broke (the model call failed): how far it got is on the screen, what it meant to say is not a result.
            if (event.data?.reason?.kind === 'error') { settle(mine, 'failed', { cause: 'broke-off', error: String(event.data.reason.error?.message ?? '') }); return; }
            // A thing is done when they say so with their tool (finish), which ends it. Over without it: told once to
            // finish properly (what they would say is the thing's result); still nothing, and nobody can tell what came of it.
            if (!mine.question) {
              if (!mine.nudged) { mine.nudged = true; void round(mine, done()).catch((err) => settle(mine, 'failed', { cause: 'broke-off', error: err.message })); return; }
              settle(mine, 'failed', { cause: 'no-result' }); return;
            }
            // They need her: the thing ends here, as stuck on that question. Nothing waits — what she decides is given as a new thing, and the device is where it was left.
            settle(mine, 'stuck');
          }
        }) ?? (() => {});
        await round(mine, mine.task);
      } catch (err) { settle(mine, 'failed', { cause: 'broke-off', error: err.message }); }
    })();
  };
  const api = {
    dir,
    /** Is this session her hands (by id, or by where it lives — known before the id is)? */
    isHands: (id, cwd) => Boolean((id && (bySession.has(id) || past.has(id))) || (cwd && inside(dir, cwd))),
    /** Is any thing of hers in her hands? */
    busy: () => under.size > 0,
    /** Who holds this place (phone · computer · host · web) now: { thing } | { session, tool, at } | null — the one record of it. */
    holder: holderOf,
    /** The thing under way in this place (the same view as doing()), or null. */
    on: (device) => now_(onDevice(device)),
    /**
     * A session that is not her hands uses a device itself (a qq-bridge chat): it holds the device until its turn ends
     * or it leaves it alone DIRECT_IDLE_MS. → null (it holds it now), or what holds it instead (holder()): it is not
     * let on. A session of her hands is not let on this way — its thing holds its place.
     */
    hold(device, session, tool = '') {
      const h = holderOf(device);
      if (h && !(h.session && h.session === session)) { lane('refused', { device, session, holder: h.thing ? h.thing.id : h.session }); return h; }
      if (!h) lane('acquired', { device, session, holder: session });
      direct.set(device, { session, tool, at: now() });
      offDirect ??= onEvent((s, event) => { if (event?.type === 'turn/end' && s?.id) for (const [dev, d] of [...direct]) if (d.session === s.id) letGo(dev, 'turn-end'); }) ?? (() => {});
      return null;
    },
    /** Have her hands asked her something in the round under way of this thing (`which`; it ends as that question)? */
    asked: (which) => { const t = pick(which); return Boolean(t?.state === 'running' && t.question); },
    /** What is in her hands right now (any one: the first begun): { id, device, task, state, question, startedAt, said, steps, … } or null. */
    doing: () => now_(first()),
    /** The thing done in this hands session, while it is under way (the same view as doing()), or null. */
    thingOf: (session) => now_(bySession.get(session)),
    /** The thing with this ledger id, while it is under way (the same view as doing()), or null. */
    thingById: (id) => now_(under.get(id)),
    /** Everything under way, in the order begun (the same views as doing()). */
    things: () => [...under.values()].map(now_),
    /**
     * What the code keeps on a thing while it is under way (by its ledger id): an object of the caller's, made with
     * the thing and gone with it — nothing in it reaches the next thing. null when that thing is not under way.
     */
    keptOf: (id) => under.get(id)?.kept ?? null,
    /**
     * Is this text something her hands were given for this thing — in what she said (the task, what she added), or shown
     * to them by a tool (the screen, an account)? Her hands do not write: what they type is hers or is already
     * there. Whitespace does not count.
     */
    has(text, which) { const n = squash(text); const t = pick(which); return !n || (Boolean(t) && (squash(t.words).includes(n) || squash(t.shown).includes(n))); },
    /** Something the code saw happen (a refusal): it comes back with the result, as `notes`. */
    note(what, which) { const t = pick(which); if (t) t.notes.push(String(what)); },
    /**
     * From the hands' own tool, or from a gate: they need her — or him (`ask.for: 'him'`: his yes, or something only he
     * can do; `ask.screen`: the screen goes with the question). The run under way ends as this question; the first
     * question stands. False when nothing is under way.
     */
    ask(question, ask = {}, which) { const thing = pick(which); const q = String(question ?? '').trim(); if (!q || thing?.state !== 'running' || thing.question) return Boolean(q && thing?.question); thing.question = q; thing.ask = { for: ask.for === 'him' ? 'him' : 'her', ...(ask.kind ? { kind: ask.kind } : {}), ...(ask.subject ? { subject: ask.subject } : {}), ...(ask.tier ? { tier: ask.tier } : {}), ...(ask.what ? { what: String(ask.what) } : {}), ...(ask.screen ? { screen: true } : {}) }; return true; },
    /**
     * From the hands' own tool: the thing is done, and this is what came of it — `summary` in a line, `detail` for her.
     * It ends here (nothing more is said). False when nothing is under way, or it has already asked.
     */
    finish({ summary = '', detail = '', task = '', reached = true } = {}, which) {
      const t = pick(which);
      if (!t || t.state !== 'running' || t.question || t.over) return false;
      t.result = { summary: String(summary ?? '').trim(), detail: String(detail ?? '').trim(), ...(String(task ?? '').trim() ? { name: String(task).trim().slice(0, 12) } : {}) };
      // Ending is not succeeding: what was wanted not reached is a thing that failed, in their own words.
      if (reached === false) settle(t, 'failed', { cause: 'not-reached' }); else settle(t, 'done');
      return true;
    },
    /**
     * The code ends the thing under way as failed (the same error over and over: `cause` 'same-error', `error` its
     * type). What the hands said last is kept as details. False when nothing is under way.
     */
    fail({ cause = 'same-error', error = '' } = {}, which) {
      const t = pick(which);
      if (!t || t.state !== 'running' || t.over) return false;
      settle(t, 'failed', { cause, error });
      return true;
    },
    /**
     * Everything under way stops now (she or he said stop). `by`: whose word it was; `cause`: 'stopped', or 'command'
     * when it came from outside her conversation (his /dot stop). False when there is none.
     * With `thing` (a ledger id): that one only — the others go on.
     */
    stop({ by = 'her', cause = 'stopped', thing } = {}) {
      if (thing !== undefined) {
        const t = under.get(thing);
        if (!t) return false;
        settle(t, 'stopped', { by, cause });
        return true;
      }
      if (!under.size) return false;
      for (const t of [...under.values()]) settle(t, 'stopped', { by, cause });
      return true;
    },
    /** What a restart cut off ([{ id, device, task, asker, … }]); told once. */
    interrupted: () => ledger.interrupted(),
    /**
     * Give her hands a thing to do. → { status: 'started', id } at once; { status: 'busy', device, holder } when that
     * place is held (holder(): a thing of hers there, or a session on the device itself) — nothing is opened and
     * nothing waits; or { status: 'failed', why }. Its end goes to onDone.
     */
    start({ device = '', task = '', ...extra } = {}) {
      const what = String(task).trim();
      if (!what) return { status: 'failed', why: 'no task' };
      // One a place: whatever holds this one, and this thing is not begun. (The one place that decides what may run together.)
      const held = holderOf(device);
      if (held) { audit('hands-busy', { device, forHim: Boolean(extra.forHim), ...(held.thing ? { thing: held.thing.id } : { holder: held.session }) }); return { status: 'busy', device, holder: held }; }
      const entry = ledger.open({ asker: extra.forHim ? 'him' : 'her', device, task: what, ...(extra.after ? { after: extra.after } : {}) });
      const mine = { entry, device, task: what, extra, state: 'running', question: '', words: what, startedAt: now(), said: '', last: '', shown: '', steps: 0, rounds: 0, notes: [], kept: {}, over: false };
      begin(mine);
      return { status: 'started', id: entry };
    },
    /**
     * One more thing said to the hands at work (he added something, she thought of something): read between two of
     * their steps, the thing goes on. → 'added' | 'idle' (nothing under way) | 'failed'.
     */
    add(text, which) {
      const said = String(text ?? '').trim();
      if (!said) return { status: 'failed', why: 'nothing to add' };
      const t = pick(which);
      if (!t || t.over) return { status: 'idle' };
      t.words = `${t.words}\n${said}`;
      ledger.note(t.entry, { added: [...(ledger.get(t.entry)?.added ?? []), said] });
      withAgent(t, (agent) => (typeof agent.steer === 'function' ? agent.steer(message(said)) : typeof agent.send === 'function' ? agent.send(message(said), 'next-step', true) : agent.followup(message(said)))).catch((err) => audit('hands-add-failed', { thing: t.entry, why: String(err?.message ?? err).slice(0, 120) }));
      return { status: 'added', id: t.entry };
    },
  };
  return api;
}
