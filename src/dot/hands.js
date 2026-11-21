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
//     (ask), never in the prose of a report. The thing then ends as stuck on that question: nothing waits in a
//     half-open state. What she decides she gives as a new thing; the device is where the last one left it.
//   - Each thing gets hands that have seen nothing else: what was stopped before cannot be picked up again by
//     mistake (11-20: a tap she had cancelled was made four rounds later).
//   start({ device, task })  → { status: 'started' } at once; or 'busy' (what they are on) / 'failed'.
//   add(text)                → one more thing said to the hands at work, read between two of their steps.
//   ask(question)            ← from the hands' own tool: this round ends as a question to her.
//   finish({ summary, detail, task }) ← from the hands' own tool: the thing is done, what came of it, and its short name.
//   stop({ by, cause })      → the thing ends now, stopped; what waited behind it is let go with it.
// How a thing ends is told as facts (ledger.js): its outcome, who stopped it, why, the hands' summary and details.
// Nothing here writes a sentence for anyone: each reader words them for itself.
// Every thing is an entry in the ledger (ledger.js): opened when she gives it, ended when it is over. One is done at
// a time; one given meanwhile waits its turn.
// The hands' sessions live outside her home (so nothing that goes by "a session in her home" takes them for her).
import { mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { headTail } from './ledger.js';
import { head } from '../cut.js';

const squash = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');
export const HANDS_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'hands' });
const SHOWN_MAX = 200000; // characters of screen text a thing keeps for keep_line's check (the newest)
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${head(t, n)}…` : t; };
const inside = (dir, p) => { const a = resolve(String(dir)), b = resolve(String(p || sep)); return b === a || b.startsWith(a + sep); };

/**
 * @param deps.dir        the hands' working folder (outside her home)
 * @param deps.create     async (cwd) => session id ('' when the host cannot make one)
 * @param deps.agentFor   async (id) => the agent handle ({ followup, cancel? }) or null — asked for each time it is used: the
 *                        handle of a session that is not running is a thinner one, and goes stale
 * @param deps.ledger     the book of things (ledger.js)
 * @param deps.overCap    (entry) => '' or the question to ask him when a thing has cost more than it may (it ends stuck there)
 * @param deps.done       () => what they are told when a run ends without their tool saying it is done (once)
 * @param deps.onEvent    (fn: (session, event) => void) => dispose — the host's session events
 * @param deps.message    (text) => the user message that carries a task or something added to it
 * @param deps.textOf     (content) => text of an assistant message's content
 * @param deps.store      { get(key), set(key, value) } — remembered across restarts
 * @param deps.onDone     (result, thing) — it is over. result = { outcome, by, cause?, error?, summary?, detail?, question?, ask?, shown, steps, rounds, ms, notes }
 * @param deps.retire     (id) — a session the hands are done with (the host may put it away)
 * @param deps.maxMs      a thing is cut after this long
 */
export function createHands({ dir, create, agentFor, onEvent, message, textOf, store, ledger, overCap = () => '', done = () => '', onDone = () => {}, retire = () => {}, audit = () => {}, maxMs = 600000, maxChars = 900, now = () => Date.now() }) {
  const past = new Set(store.get('handsPast') ?? []);
  { const old = store.get('handsSession'); if (old) { past.add(String(old)); store.set('handsSession', ''); } } // one session for all rounds, before 0.25
  { const old = store.get('handsThing'); if (old) { ledger.end(ledger.open({ asker: old.forHim ? 'him' : 'her', device: old.device, task: old.task }), { outcome: 'failed', cause: 'restart' }); store.set('handsThing', null); } } // the one thing on record, before the ledger
  let thing = null; // the one thing under way: { entry, device, task, extra, … }
  const queue = []; // things given while one is under way, in order
  const remember = (id) => { past.add(id); store.set('handsPast', [...past].slice(-30)); };
  const call = (fn, ...a) => { try { Promise.resolve(fn(...a)).catch(() => {}); } catch (error) { void error; } };
  const view = (t) => ({ id: t.entry, session: t.id, device: t.device, task: t.task, ...t.extra });
  const snapshot = (t, more) => ({ shown: t.shown, steps: t.steps, rounds: t.rounds, ms: now() - t.startedAt, notes: t.notes, ...more });
  const withAgent = async (t, fn) => { const agent = t.id ? await agentFor(t.id) : null; if (!agent) throw new Error('no hands session'); return fn(agent); };
  /**
   * The thing is over, whichever way. `outcome`: done · stuck · failed · timeout · stopped; `by`: whose word ended it
   * (him, her, or the code); `cause` (ledger.js CAUSES) and `error` when it did not simply end.
   */
  const settle = (t, outcome, { by = 'code', cause = '', error = '' } = {}) => {
    if (t.over) return; t.over = true;
    clearTimeout(t.timer); try { t.off?.(); } catch (e) { void e; }
    const running = thing === t && t.state === 'running';
    if (thing === t) thing = null; else { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); }
    // A run still going is ended here: stopped or too long, or done by their own word (their tool, nothing more to say).
    if (running && (outcome === 'stopped' || outcome === 'timeout' || (outcome === 'done' && t.result))) call(withAgent, t, (agent) => agent.cancel?.({ kind: 'hook', reason: `dot-hands: ${outcome}` }));
    // What came of it: their own summary and details when they gave them (finish), else what they last said, as details.
    const summary = String(t.result?.summary ?? '').trim(), detail = headTail(t.result ? t.result.detail : t.said, maxChars);
    const facts = { outcome, by, ...(cause ? { cause } : {}), ...(error ? { error: String(error).slice(0, 160) } : {}), ...(summary ? { summary } : {}), ...(detail ? { detail } : {}), ...(t.result?.name ? { name: t.result.name } : {}), ...(outcome === 'stuck' ? { question: t.question, ...(t.ask ? { ask: t.ask } : {}) } : {}) };
    const out = snapshot(t, facts);
    ledger.end(t.entry, facts);
    audit('hands-thing', { thing: t.entry, session: t.id, device: t.device, outcome, by, steps: t.steps, rounds: t.rounds, ms: out.ms, ...(cause ? { cause } : {}) });
    if (t.id) call(retire, t.id);
    call(onDone, out, view(t));
    if (!thing && queue.length) begin(queue.shift());
  };
  /** Their run begins: what they are given, and how long they have. */
  const round = async (t, text) => {
    t.state = 'running'; t.question = ''; t.said = ''; t.rounds++;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => settle(t, 'timeout', { cause: 'timeout' }), maxMs); t.timer.unref?.();
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
        if (!id) { settle(mine, 'failed', { cause: 'no-session' }); return; }
        mine.off = onEvent((session, event) => {
          if (session?.id !== id || mine.over || mine.state !== 'running') return;
          if (event?.type === 'tool/call') { mine.steps++; ledger.count(mine.entry, { steps: 1 }); }
          // What the screen showed them, as text: she sees the picture, and a line she keeps from it (keep_line) is checked against this.
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
    isHands: (id, cwd) => Boolean((id && (id === thing?.id || past.has(id))) || (cwd && inside(dir, cwd))),
    /** Is a thing of hers in her hands? */
    busy: () => Boolean(thing),
    /** Have her hands asked her something in the round under way (it ends as that question)? */
    asked: () => Boolean(thing?.state === 'running' && thing.question),
    /** What is in her hands right now: { id, device, task, state, question, startedAt, said, steps, … } or null. */
    doing: () => (thing ? { id: thing.entry, session: thing.id, device: thing.device, task: thing.task, state: 'running', question: thing.question, startedAt: thing.startedAt, said: clip(thing.said || thing.last, 120), steps: thing.steps, forHim: Boolean(thing.extra?.forHim), waiting: queue.length } : null),
    /**
     * Is this text something her hands were given for this thing — in what she said (the task, what she added), or shown
     * to them by a tool (the screen, an account)? Her hands do not write: what they type is hers or is already
     * there. Whitespace does not count.
     */
    has(text) { const n = squash(text); return !n || (Boolean(thing) && (squash(thing.words).includes(n) || squash(thing.shown).includes(n))); },
    /** Something the code saw happen (a refusal): it comes back with the result, as `notes`. */
    note(what) { if (thing) thing.notes.push(String(what)); },
    /**
     * From the hands' own tool, or from a gate: they need her — or him (`ask.for: 'him'`: his yes, or something only he
     * can do; `ask.screen`: the screen goes with the question). The run under way ends as this question; the first
     * question stands. False when nothing is under way.
     */
    ask(question, ask = {}) { const q = String(question ?? '').trim(); if (!q || thing?.state !== 'running' || thing.question) return Boolean(q && thing?.question); thing.question = q; thing.ask = { for: ask.for === 'him' ? 'him' : 'her', ...(ask.kind ? { kind: ask.kind } : {}), ...(ask.subject ? { subject: ask.subject } : {}), ...(ask.tier ? { tier: ask.tier } : {}), ...(ask.what ? { what: String(ask.what) } : {}), ...(ask.screen ? { screen: true } : {}) }; return true; },
    /**
     * From the hands' own tool: the thing is done, and this is what came of it — `summary` in a line, `detail` for her.
     * It ends here (nothing more is said). False when nothing is under way, or it has already asked.
     */
    finish({ summary = '', detail = '', task = '' } = {}) {
      const t = thing;
      if (!t || t.state !== 'running' || t.question || t.over) return false;
      t.result = { summary: String(summary ?? '').trim(), detail: String(detail ?? '').trim(), ...(String(task ?? '').trim() ? { name: String(task).trim().slice(0, 12) } : {}) };
      settle(t, 'done');
      return true;
    },
    /**
     * Everything stops now (she or he said stop): the thing under way, and what waited behind it. `by`: whose word it
     * was; `cause`: 'stopped', or 'command' when it came from outside her conversation (his /dot stop). False when there is none.
     */
    stop({ by = 'her', cause = 'stopped' } = {}) {
      if (!thing && !queue.length) return false;
      for (const t of queue.splice(0)) settle(t, 'stopped', { by, cause });
      if (thing) settle(thing, 'stopped', { by, cause });
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
      const entry = ledger.open({ asker: extra.forHim ? 'him' : 'her', device, task: what, ...(extra.after ? { after: extra.after } : {}) });
      const mine = { entry, device, task: what, extra, state: 'running', question: '', words: what, startedAt: now(), said: '', last: '', shown: '', steps: 0, rounds: 0, notes: [], over: false };
      if (thing) { queue.push(mine); return { status: 'queued', id: entry, doing: api.doing() }; }
      begin(mine);
      return { status: 'started', id: entry };
    },
    /**
     * One more thing said to the hands at work (he added something, she thought of something): read between two of
     * their steps, the thing goes on. → 'added' | 'idle' (nothing under way) | 'failed'.
     */
    add(text) {
      const said = String(text ?? '').trim();
      if (!said) return { status: 'failed', why: 'nothing to add' };
      const t = thing;
      if (!t || t.over) return { status: 'idle' };
      t.words = `${t.words}\n${said}`;
      ledger.note(t.entry, { added: [...(ledger.get(t.entry)?.added ?? []), said] });
      withAgent(t, (agent) => (typeof agent.steer === 'function' ? agent.steer(message(said)) : typeof agent.send === 'function' ? agent.send(message(said), 'next-step', true) : agent.followup(message(said)))).catch((err) => audit('hands-add-failed', { thing: t.entry, why: String(err?.message ?? err).slice(0, 120) }));
      return { status: 'added', id: t.entry };
    },
  };
  return api;
}
