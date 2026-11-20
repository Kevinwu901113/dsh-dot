// dsh-dot/hands: her phone and her computer, operated for her — one thing at a time, a whole thing at a time.
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
//     (ask), never in the prose of a report. Her answer goes back to the same hands, which carry on.
//   - Each thing gets hands that have seen nothing else: what was stopped before cannot be picked up again by
//     mistake (11-20: a tap she had cancelled was made four rounds later).
//   start({ device, task })  → { status: 'started' } at once; or 'busy' (what they are on) / 'failed'.
//   answer(text)             → her answer to what they asked: 'answered', or 'idle' when nothing was asked.
//   ask(question)            ← from the hands' own tool: this round ends as a question to her.
//   stop(why)                → the thing ends now, as cut.
// The hands' sessions live outside her home (so nothing that goes by "a session in her home" takes them for her).
import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const squash = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
export const HANDS_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'hands' });
const SHOWN_MAX = 200000; // characters of screen text a thing keeps for keep_line's check (the newest)
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const inside = (dir, p) => { const a = resolve(String(dir)), b = resolve(String(p || sep)); return b === a || b.startsWith(a + sep); };

/**
 * @param deps.dir        the hands' working folder (outside her home)
 * @param deps.create     async (cwd) => session id ('' when the host cannot make one)
 * @param deps.agentFor   async (id) => the agent handle ({ followup, cancel? }) or null
 * @param deps.onEvent    (fn: (session, event) => void) => dispose — the host's session events
 * @param deps.message    (text) => the user message that carries a task or an answer
 * @param deps.textOf     (content) => text of an assistant message's content
 * @param deps.store      { get(key), set(key, value) } — remembered across restarts
 * @param deps.onDone     (result, thing) — it is over. result = { status: 'done' | 'cut' | 'failed', text, shown, steps, rounds, ms, notes, why? }
 * @param deps.onAsk      (result, thing) — her hands need her. result = { question, text, shown, steps, rounds, ms, notes }
 * @param deps.retire     (id) — a session the hands are done with (the host may put it away)
 * @param deps.maxMs      a stretch of theirs (the thing, or the part after an answer) is cut after this long
 * @param deps.askMs      a question of theirs she has not answered for this long: the thing is let go
 */
export function createHands({ dir, create, agentFor, onEvent, message, textOf, store, onDone = () => {}, onAsk = () => {}, retire = () => {}, audit = () => {}, maxMs = 600000, askMs = 1800000, maxChars = 900, now = () => Date.now() }) {
  const past = new Set(store.get('handsPast') ?? []);
  { const old = store.get('handsSession'); if (old) { past.add(String(old)); store.set('handsSession', ''); } } // one session for all rounds, before 0.25
  // What a restart cut off: on record until it is told once (interrupted()).
  let cutOff = store.get('handsThing') ?? null;
  if (cutOff) store.set('handsThing', null);
  let thing = null; // the one thing under way: { device, task, extra, state: 'running' | 'asking', … }
  const remember = (id) => { past.add(id); store.set('handsPast', [...past].slice(-30)); };
  const call = (fn, ...a) => { try { Promise.resolve(fn(...a)).catch(() => {}); } catch (error) { void error; } };
  const view = (t) => ({ device: t.device, task: t.task, ...t.extra });
  const snapshot = (t, more) => ({ text: clip(t.said, maxChars), shown: t.shown, steps: t.steps, rounds: t.rounds, ms: now() - t.startedAt, notes: t.notes, ...more });
  /** The thing is over, whichever way. */
  const settle = (t, status, why) => {
    if (t.over) return; t.over = true;
    clearTimeout(t.timer); try { t.off?.(); } catch (error) { void error; }
    if (thing === t) { thing = null; store.set('handsThing', null); }
    if (status === 'cut' && t.state === 'running') { try { t.agent?.cancel?.({ kind: 'hook', reason: `dot-hands: ${why}` }); } catch (error) { void error; } }
    const out = snapshot(t, { status, ...(why ? { why } : {}) });
    audit('hands-thing', { session: t.id, device: t.device, status, steps: t.steps, rounds: t.rounds, ms: out.ms, ...(why ? { why } : {}) });
    if (t.id) call(retire, t.id);
    call(onDone, out, view(t));
  };
  /** A round of theirs begins (the first, or the one after her answer): what they are given, and how long they have. */
  const round = (t, text) => {
    t.state = 'running'; t.question = ''; t.said = ''; t.rounds++;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => settle(t, 'cut', 'took too long'), maxMs); t.timer.unref?.();
    t.agent.followup(message(text));
  };
  const api = {
    dir,
    /** Is this session her hands (by id, or by where it lives — known before the id is)? */
    isHands: (id, cwd) => Boolean((id && (id === thing?.id || past.has(id))) || (cwd && inside(dir, cwd))),
    /** Is a thing of hers in her hands — under way, or waiting for her answer? */
    busy: () => Boolean(thing),
    /** Are her hands waiting for her answer? */
    asking: () => thing?.state === 'asking',
    /** Have her hands asked her something in the round under way (it ends as that question)? */
    asked: () => Boolean(thing?.state === 'running' && thing.question),
    /** What is in her hands right now: { device, task, state, question, startedAt, said, steps, … } or null. */
    doing: () => (thing ? { device: thing.device, task: thing.task, state: thing.state, question: thing.question, startedAt: thing.startedAt, said: clip(thing.said, 120), steps: thing.steps, forHim: Boolean(thing.extra?.forHim) } : null),
    /**
     * Is this text something her hands were given for this thing — in what she said (the task, her answers), or shown
     * to them by a tool (the screen, an account)? Her hands do not write: what they type is hers or is already
     * there. Whitespace does not count.
     */
    has(text) { const n = squash(text); return !n || (Boolean(thing) && (squash(thing.words).includes(n) || squash(thing.shown).includes(n))); },
    /** Something the code saw happen (a refusal): it comes back with the result, as `notes`. */
    note(what) { if (thing) thing.notes.push(String(what)); },
    /** From the hands' own tool: they need her. The round under way ends as this question. False when nothing is under way. */
    ask(question) { const q = String(question ?? '').trim(); if (!q || thing?.state !== 'running') return false; thing.question = q; return true; },
    /** The thing ends now, as cut (she or he said stop, or it is not wanted any more). False when there is none. */
    stop(why = 'stopped') { if (!thing) return false; settle(thing, 'cut', why); return true; },
    /** What a restart cut off ({ device, task, … } or null); told once. */
    interrupted() { const t = cutOff; cutOff = null; return t; },
    /**
     * Give her hands a thing to do. → { status: 'started' } at once, or { status: 'busy', doing } when something is
     * in her hands already, or { status: 'failed', why }. Its end goes to onDone, a question of theirs to onAsk.
     */
    start({ device = '', task = '', ...extra } = {}) {
      const what = String(task).trim();
      if (!what) return { status: 'failed', why: 'no task' };
      if (thing) return { status: 'busy', doing: api.doing() };
      const mine = thing = { device, task: what, extra, state: 'running', question: '', words: what, startedAt: now(), said: '', shown: '', steps: 0, rounds: 0, notes: [], over: false };
      store.set('handsThing', { ...view(mine), startedAt: mine.startedAt });
      void (async () => {
        try {
          try { mkdirSync(dir, { recursive: true }); } catch (error) { void error; }
          const id = mine.id = await create(dir);
          if (id) { remember(id); audit('hands-opened', { session: id }); }
          const agent = mine.agent = id ? await agentFor(id) : null;
          if (mine.over) return;
          if (!agent || typeof agent.followup !== 'function') { settle(mine, 'failed', 'no hands session'); return; }
          mine.off = onEvent((session, event) => {
            if (session?.id !== id || mine.over || mine.state !== 'running') return;
            if (event?.type === 'tool/call') mine.steps++;
            // What the screen showed them, as text: she sees the picture, and a line she keeps from it (keep_line) is checked against this.
            else if (event?.type === 'tool/result') { const c = event.data?.message?.content; let s = textOf(c); if ((!s || typeof s !== 'string') && c && typeof c === 'object') { try { s = JSON.stringify(c); } catch (error) { void error; s = ''; } } if (s) mine.shown = `${mine.shown}\n${s}`.slice(-SHOWN_MAX); }
            else if (event?.type === 'assistant/message' && !event.data?.interrupted) { const t = textOf(event.data?.message?.content); if (String(t ?? '').trim()) mine.said = t; }
            else if (event?.type === 'turn/end') {
              // Ended by someone else (the host, a crash of the step): not done, and not a question either.
              if (event.data?.reason?.kind === 'aborted') { settle(mine, 'failed', 'interrupted'); return; }
              if (!mine.question) { settle(mine, 'done'); return; }
              // A question nobody answers does not hold her hands for good: after askMs the thing is let go.
              clearTimeout(mine.timer); mine.state = 'asking';
              mine.timer = setTimeout(() => settle(mine, 'cut', 'no answer'), askMs); mine.timer.unref?.();
              audit('hands-asked', { session: id, steps: mine.steps, rounds: mine.rounds });
              call(onAsk, snapshot(mine, { question: mine.question }), view(mine));
            }
          }) ?? (() => {});
          round(mine, what);
        } catch (err) { settle(mine, 'failed', err.message); }
      })();
      return { status: 'started' };
    },
    /** Her answer to what her hands asked: they carry on with it, the same hands. → 'answered' | 'idle' (nothing was asked) | 'failed'. */
    answer(text) {
      const said = String(text ?? '').trim();
      if (!said) return { status: 'failed', why: 'no answer' };
      if (thing?.state !== 'asking') return { status: 'idle' };
      thing.words = `${thing.words}\n${said}`;
      try { round(thing, said); } catch (err) { settle(thing, 'failed', err.message); return { status: 'failed', why: err.message }; }
      return { status: 'answered' };
    },
  };
  return api;
}
