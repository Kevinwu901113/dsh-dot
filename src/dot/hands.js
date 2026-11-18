// dsh-dot/hands: her phone and her computer, operated for her.
//
// There is one of her: the conversation. Until now a second session of hers (the errand) operated the devices —
// with her card, her memory tools and a voice of its own, so most of dot/core.js went into keeping two of her
// in step (hand_off, reports, "an errand never talks to him", who holds the phone). Hands are not her: a
// session with the device tools and nothing else of hers — no card, no memory, no QQ — that does one thing she
// asks and says back, briefly, what it did and what is on the screen. What to do next is hers to decide, so a
// longer thing (reading a forum, signing in somewhere) is several rounds between her and her hands.
//   run({ device, task })  one round: the task goes to the hands session, the round ends when its turn ends,
//                          when it took too long (cut, with what it had said so far), or when he speaks
//                          (interrupt() — she reads him first).
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
export function createHands({ dir, create, agentFor, onEvent, message, textOf, store, tokensOf = () => 0, audit = () => {}, maxMs = 150000, maxTokens = 120000, maxChars = 700, now = () => Date.now() }) {
  let current = String(store.get('handsSession') ?? '');
  const past = new Set(store.get('handsPast') ?? []);
  const rounds = new Map(); // session id → the round in flight
  let chain = Promise.resolve(); // one round at a time: she has one pair of hands
  const api = {
    dir,
    /** Is this session her hands (by id, or by where it lives — known before the id is)? */
    isHands: (id, cwd) => Boolean((id && (id === current || past.has(id))) || (cwd && inside(dir, cwd))),
    busy: () => rounds.size > 0,
    /** He spoke (or the round is otherwise not wanted any more): the round in flight ends now, as cut. */
    interrupt(why = 'interrupted') { for (const r of rounds.values()) r.finish('cut', why); },
    /**
     * One round. → { status: 'done' | 'cut' | 'failed', text, steps, ms, why? } — text is what the hands said last,
     * at most maxChars.
     */
    run({ device = '', task = '' } = {}) {
      const job = chain.then(() => round(device, String(task).trim()));
      chain = job.catch(() => {});
      return job;
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
  async function round(device, task) {
    const started = now();
    if (!task) return { status: 'failed', text: '', steps: 0, ms: 0, why: 'no task' };
    const id = await ensure();
    const agent = id ? await agentFor(id) : null;
    if (!agent || typeof agent.followup !== 'function') return { status: 'failed', text: '', steps: 0, ms: now() - started, why: 'no hands session' };
    return new Promise((done) => {
      let said = '', steps = 0, over = false, off = () => {}, timer = null;
      const finish = (status, why) => {
        if (over) return; over = true;
        clearTimeout(timer); try { off(); } catch (error) { void error; }
        rounds.delete(id);
        if (status === 'cut') { try { agent.cancel?.({ kind: 'hook', reason: `dot-hands: ${why}` }); } catch (error) { void error; } }
        const out = { status, text: clip(said, maxChars), steps, ms: now() - started, ...(why ? { why } : {}) };
        audit('hands-round', { session: id, device, status, steps, ms: out.ms, ...(why ? { why } : {}) });
        done(out);
      };
      rounds.set(id, { finish });
      off = onEvent((session, event) => {
        if (session?.id !== id || over) return;
        if (event?.type === 'tool/call') steps++;
        else if (event?.type === 'assistant/message' && !event.data?.interrupted) { const t = textOf(event.data?.message?.content); if (String(t ?? '').trim()) said = t; }
        else if (event?.type === 'turn/end') finish('done');
      }) ?? (() => {});
      timer = setTimeout(() => finish('cut', 'took too long'), maxMs); timer.unref?.();
      try { agent.followup(message(task)); } catch (err) { finish('failed', err.message); }
    });
  }
  return api;
}
