// dsh-dot/hands: her phone and her computer, operated for her.
//
// There is one of her: the conversation. Until now a second session of hers (the errand) operated the devices —
// with her card, her memory tools and a voice of its own, so most of dot/core.js went into keeping two of her
// in step (hand_off, reports, "an errand never talks to him", who holds the phone). Hands are not her: a
// session with the device tools and nothing else of hers — no card, no memory, no QQ — that does one thing she
// asks and says back, briefly, what it did and what is on the screen. What to do next is hers to decide, so a
// longer thing (reading a forum, signing in somewhere) is several rounds between her and her hands.
//   start({ device, task })  one round, not waited for: the task goes to the hands session and she goes on with her
//                            turn (she can answer him meanwhile); when the hands' turn ends, or it took too long,
//                            or she stopped it, onDone gets what they said — and her conversation is told.
//   One pair of hands: a second round while one is under way is not started (she is told what they are on).
// The hands session lives outside her home (so nothing that goes by "a session in her home" takes it for her),
// is kept across rounds (the hands remember the screen they left), and is replaced when it has grown large.
import { mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const HANDS_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'hands' });
const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const inside = (dir, p) => { const a = resolve(String(dir)), b = resolve(String(p || sep)); return b === a || b.startsWith(a + sep); };

/**
 * @param deps.dir        the hands' working folder (outside her home)
 * @param deps.create     async (cwd) => session id ('' when the host cannot make one)
 * @param deps.agentFor   async (id) => the agent handle ({ followup, cancel? }) or null
 * @param deps.onEvent    (fn: (session, event) => void) => dispose — the host's session events
 * @param deps.message    (text) => the user message that carries a task
 * @param deps.textOf     (content) => text of an assistant message's content
 * @param deps.store      { get(key), set(key, value) } — remembered across restarts
 * @param deps.tokensOf   (id) => tokens in that session so far (0 when unknown)
 */
export function createHands({ dir, create, agentFor, onEvent, message, textOf, store, onDone = () => {}, tokensOf = () => 0, audit = () => {}, maxMs = 360000, maxTokens = 60000, maxChars = 450, now = () => Date.now() }) {
  let current = String(store.get('handsSession') ?? '');
  const past = new Set(store.get('handsPast') ?? []);
  let job = null; // the round under way: { device, task, startedAt, said, steps, finish, … }
  const api = {
    dir,
    /** Is this session her hands (by id, or by where it lives — known before the id is)? */
    isHands: (id, cwd) => Boolean((id && (id === current || past.has(id))) || (cwd && inside(dir, cwd))),
    busy: () => Boolean(job),
    /** What her hands are on right now: { device, task, startedAt, said, steps } or null. */
    doing: () => (job ? { device: job.device, task: job.task, startedAt: job.startedAt, said: clip(job.said, 120), steps: job.steps } : null),
    /** The round under way ends now, as cut (she said stop, or it is not wanted any more). False when there is none. */
    stop(why = 'stopped') { if (!job) return false; job.finish('cut', why); return true; },
    /**
     * Start a round. → { status: 'started' } at once, or { status: 'busy', doing } when her hands are on something,
     * or { status: 'failed', why }. The round's end goes to onDone(result, { device, task, ...extra }) with
     * result = { status: 'done' | 'cut' | 'failed', text, steps, ms, why? }.
     */
    start({ device = '', task = '', ...extra } = {}) {
      const what = String(task).trim();
      if (!what) return { status: 'failed', why: 'no task' };
      if (job) return { status: 'busy', doing: api.doing() };
      const mine = job = { device, task: what, extra, startedAt: now(), said: '', steps: 0, over: false, finish: () => {} };
      const settle = (status, why) => {
        if (mine.over) return; mine.over = true;
        clearTimeout(mine.timer); try { mine.off?.(); } catch (error) { void error; }
        if (job === mine) job = null;
        if (status === 'cut') { try { mine.agent?.cancel?.({ kind: 'hook', reason: `dot-hands: ${why}` }); } catch (error) { void error; } }
        const out = { status, text: clip(mine.said, maxChars), steps: mine.steps, ms: now() - mine.startedAt, ...(why ? { why } : {}) };
        audit('hands-round', { session: mine.id, device, status, steps: mine.steps, ms: out.ms, ...(why ? { why } : {}) });
        try { Promise.resolve(onDone(out, { device, task: what, ...extra })).catch(() => {}); } catch (error) { void error; }
      };
      mine.finish = settle;
      void (async () => {
        try {
          const id = mine.id = await ensure();
          const agent = mine.agent = id ? await agentFor(id) : null;
          if (mine.over) return;
          if (!agent || typeof agent.followup !== 'function') { settle('failed', 'no hands session'); return; }
          mine.off = onEvent((session, event) => {
            if (session?.id !== id || mine.over) return;
            if (event?.type === 'tool/call') mine.steps++;
            else if (event?.type === 'assistant/message' && !event.data?.interrupted) { const t = textOf(event.data?.message?.content); if (String(t ?? '').trim()) mine.said = t; }
            else if (event?.type === 'turn/end') settle('done');
          }) ?? (() => {});
          mine.timer = setTimeout(() => settle('cut', 'took too long'), maxMs); mine.timer.unref?.();
          agent.followup(message(what));
        } catch (err) { settle('failed', err.message); }
      })();
      return { status: 'started' };
    },
  };
  async function ensure() {
    if (current && tokensOf(current) >= maxTokens) { past.add(current); store.set('handsPast', [...past].slice(-20)); audit('hands-rotated', { session: current }); current = ''; }
    if (current && await agentFor(current)) return current;
    try { mkdirSync(dir, { recursive: true }); } catch (error) { void error; }
    const id = await create(dir);
    if (id) { if (current) { past.add(current); store.set('handsPast', [...past].slice(-20)); } current = id; store.set('handsSession', id); audit('hands-opened', { session: id }); }
    return id;
  }
  return api;
}
