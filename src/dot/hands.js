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
//   stop(why)                → the thing ends now, as cut; what waited behind it is let go with it.
// Every thing is an entry in the ledger (ledger.js): opened when she gives it, ended when it is over. One is done at
// a time; one given meanwhile waits its turn.
// The hands' sessions live outside her home (so nothing that goes by "a session in her home" takes them for her).
import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { headTail } from './ledger.js';

const squash = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
export const HANDS_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'hands' });
const SHOWN_MAX = 200000; // characters of screen text a thing keeps for keep_line's check (the newest)
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
/** How a thing ended, in the ledger's words, from how the hands' run ended. */
export const outcomeOf = (status, why = '') => (status === 'done' ? 'done' : status === 'failed' ? 'failed' : /too long|no answer/.test(why) ? 'timeout' : 'stopped');
const inside = (dir, p) => { const a = resolve(String(dir)), b = resolve(String(p || sep)); return b === a || b.startsWith(a + sep); };

/**
 * @param deps.dir        the hands' working folder (outside her home)
 * @param deps.create     async (cwd) => session id ('' when the host cannot make one)
 * @param deps.agentFor   async (id) => the agent handle ({ followup, cancel? }) or null — asked for each time it is used: the
 *                        handle of a session that is not running is a thinner one, and goes stale
 * @param deps.ledger     the book of things (ledger.js)
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
export function createHands({ dir, create, agentFor, onEvent, message, textOf, store, ledger, onDone = () => {}, onAsk = () => {}, retire = () => {}, audit = () => {}, maxMs = 600000, askMs = 1800000, maxChars = 900, now = () => Date.now() }) {
  const past = new Set(store.get('handsPast') ?? []);
  { const old = store.get('handsSession'); if (old) { past.add(String(old)); store.set('handsSession', ''); } } // one session for all rounds, before 0.25
  { const old = store.get('handsThing'); if (old) { ledger.end(ledger.open({ asker: old.forHim ? 'him' : 'her', device: old.device, task: old.task }), { outcome: 'failed', why: 'restart' }); store.set('handsThing', null); } } // the one thing on record, before the ledger
  let thing = null; // the one thing under way: { entry, device, task, extra, state: 'running' | 'asking', … }
  const queue = []; // things given while one is under way, in order
  const remember = (id) => { past.add(id); store.set('handsPast', [...past].slice(-30)); };
  const call = (fn, ...a) => { try { Promise.resolve(fn(...a)).catch(() => {}); } catch (error) { void error; } };
  const view = (t) => ({ id: t.entry, device: t.device, task: t.task, ...t.extra });
  const snapshot = (t, more) => ({ text: headTail(t.said, maxChars), shown: t.shown, steps: t.steps, rounds: t.rounds, ms: now() - t.startedAt, notes: t.notes, ...more });
  const withAgent = async (t, fn) => { const agent = t.id ? await agentFor(t.id) : null; if (!agent) throw new Error('no hands session'); return fn(agent); };
  /** The thing is over, whichever way. */
  const settle = (t, status, why) => {
    if (t.over) return; t.over = true;
    clearTimeout(t.timer); try { t.off?.(); } catch (error) { void error; }
    const running = thing === t && t.state === 'running';
    if (thing === t) thing = null; else { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); }
    if (status === 'cut' && running) call(withAgent, t, (agent) => agent.cancel?.({ kind: 'hook', reason: `dot-hands: ${why}` }));
    const out = snapshot(t, { status, ...(why ? { why } : {}) });
    ledger.end(t.entry, { outcome: outcomeOf(status, why), why, by: status === 'cut' && /^他/.test(String(why)) ? 'him' : status === 'cut' && /^她/.test(String(why)) ? 'her' : '', result: out.text });
    audit('hands-thing', { thing: t.entry, session: t.id, device: t.device, status, steps: t.steps, rounds: t.rounds, ms: out.ms, ...(why ? { why } : {}) });
    if (t.id) call(retire, t.id);
    call(onDone, out, view(t));
    if (!thing && queue.length) begin(queue.shift());
  };
  /** A round of theirs begins (the first, or the one after her answer): what they are given, and how long they have. */
  const round = async (t, text) => {
    t.state = 'running'; t.question = ''; t.said = ''; t.rounds++;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => settle(t, 'cut', 'took too long'), maxMs); t.timer.unref?.();
    await withAgent(t, (agent) => agent.followup(message(text)));
  };
  /** Its turn has come: hands that have seen nothing else are made for it, and given the whole of it. */
  const begin = (mine) => {
    thing = mine; mine.startedAt = now();
    void (async () => {
      try {
        try { mkdirSync(dir, { recursive: true }); } catch (error) { void error; }
        const id = mine.id = await create(dir);
        if (id) { remember(id); audit('hands-opened', { session: id, thing: mine.entry }); }
        ledger.begin(mine.entry, { session: id });
        if (mine.over) return;
        if (!id) { settle(mine, 'failed', 'no hands session'); return; }
        mine.off = onEvent((session, event) => {
          if (session?.id !== id || mine.over || mine.state !== 'running') return;
          if (event?.type === 'tool/call') { mine.steps++; ledger.count(mine.entry, { steps: 1 }); }
          // What the screen showed them, as text: she sees the picture, and a line she keeps from it (keep_line) is checked against this.
          else if (event?.type === 'tool/result') { const c = event.data?.message?.content; let s = textOf(c); if ((!s || typeof s !== 'string') && c && typeof c === 'object') { try { s = JSON.stringify(c); } catch (error) { void error; s = ''; } } if (s) mine.shown = `${mine.shown}\n${s}`.slice(-SHOWN_MAX); }
          else if (event?.type === 'assistant/message') {
            const u = event.data?.usage;
            if (u) ledger.count(mine.entry, { tokens: { in: (Number(u.inputTokens ?? 0) || 0) + (Number(u.cacheWriteTokens ?? 0) || 0), cached: u.cacheReadTokens, out: u.outputTokens } });
            if (!event.data?.interrupted) { const t = textOf(event.data?.message?.content); if (String(t ?? '').trim()) mine.said = t; }
          }
          else if (event?.type === 'turn/end') {
            // Ended by someone else (the host, a crash of the step): not done, and not a question either.
            if (event.data?.reason?.kind === 'aborted') { settle(mine, 'failed', 'interrupted'); return; }
            // Over with nothing said is not a thing done: nobody can tell what came of it.
            if (!mine.question) { if (String(mine.said ?? '').trim()) settle(mine, 'done'); else settle(mine, 'failed', 'no result'); return; }
            // A question nobody answers does not hold her hands for good: after askMs the thing is let go.
            clearTimeout(mine.timer); mine.state = 'asking';
            mine.timer = setTimeout(() => settle(mine, 'cut', 'no answer'), askMs); mine.timer.unref?.();
            audit('hands-asked', { session: id, steps: mine.steps, rounds: mine.rounds });
            call(onAsk, snapshot(mine, { question: mine.question }), view(mine));
          }
        }) ?? (() => {});
        await round(mine, mine.task);
      } catch (err) { settle(mine, 'failed', err.message); }
    })();
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
    /** What is in her hands right now: { id, device, task, state, question, startedAt, said, steps, … } or null. */
    doing: () => (thing ? { id: thing.entry, device: thing.device, task: thing.task, state: thing.state, question: thing.question, startedAt: thing.startedAt, said: clip(thing.said, 120), steps: thing.steps, forHim: Boolean(thing.extra?.forHim), waiting: queue.length } : null),
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
    /** Everything stops now, as cut (she or he said stop): the thing under way, and what waited behind it. False when there is none. */
    stop(why = 'stopped') {
      if (!thing && !queue.length) return false;
      for (const t of queue.splice(0)) settle(t, 'cut', why);
      if (thing) settle(thing, 'cut', why);
      return true;
    },
    /** What a restart cut off ([{ id, device, task, asker, … }]); told once. */
    interrupted: () => ledger.interrupted(),
    /**
     * Give her hands a thing to do. → { status: 'started', id } at once; { status: 'queued', id, doing } when something
     * is in her hands already (it is done after that); or { status: 'failed', why }. Its end goes to onDone, a
     * question of theirs to onAsk.
     */
    start({ device = '', task = '', ...extra } = {}) {
      const what = String(task).trim();
      if (!what) return { status: 'failed', why: 'no task' };
      const entry = ledger.open({ asker: extra.forHim ? 'him' : 'her', device, task: what });
      const mine = { entry, device, task: what, extra, state: 'running', question: '', words: what, startedAt: now(), said: '', shown: '', steps: 0, rounds: 0, notes: [], over: false };
      if (thing) { queue.push(mine); return { status: 'queued', id: entry, doing: api.doing() }; }
      begin(mine);
      return { status: 'started', id: entry };
    },
    /** Her answer to what her hands asked: they carry on with it, the same hands. → 'answered' | 'idle' (nothing was asked) | 'failed'. */
    answer(text) {
      const said = String(text ?? '').trim();
      if (!said) return { status: 'failed', why: 'no answer' };
      if (thing?.state !== 'asking') return { status: 'idle' };
      const t = thing;
      t.words = `${t.words}\n${said}`;
      round(t, said).catch((err) => settle(t, 'failed', err.message));
      return { status: 'answered' };
    },
  };
  return api;
}
