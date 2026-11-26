// dsh-dot/things: what the book of things (ledger.js) holds, read for whoever needs it (taken out of core.js as it
// was). Holds no state of its own: every answer is read from the ledger (and consent) when it is asked.
import { ago } from '../clock.js';
import { head } from '../cut.js';
import { prompt } from '../prompts.js';
import { conversationTitle, voiceHow } from './text.js';

/** One thing's cost in tokens: new input + output + a tenth of the cached input, as DeepSeek prices them. */
export const costOf = (e) => (Number(e?.tokens?.in) || 0) + (Number(e?.tokens?.out) || 0) + 0.1 * (Number(e?.tokens?.cached) || 0);
/** What is in her hands, as the call that writes her words is told it: from the code, not from what she says she is doing. */
// What the voice is told about her doings comes from the book, never from what she wrote: one line a thing, no task
// text beyond its first clause (11-21: given the whole task, the voice read it out as progress).
export const titleOf = (task) => { const t = String(task ?? '').split(/[。\n]/)[0].trim(); return t.length > 40 ? `${head(t, 40)}…` : t; };
export const nameOf = (task) => titleOf(String(task ?? '').replace(/^（[^）]*）/, ''));
// A thing that was sent to someone and is done as far as her hands go can still be owed an answer (a text to a
// service number, a message, a request). That is a record on the thing — who is to answer, since when, until when —
// not hands kept on the page: 11-23 a text to 10086 took 169 s, 135 of them her hands watching for the reply, and
// a reply that came later was tied to nothing. When someone by that name writes, the code marks it answered and
// wakes her with it as that thing's — his business when the thing was his.
export const sameName = (a, b) => { const x = String(a ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(), y = String(b ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(); return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)); };
// How long an ended thing stays in front of her, and owed to him while he has not heard how it ended.
const ENDED_SHOWN_MS = 3600000;

/**
 * @param dot  the plugin's parts (core.js apply): audit; ledger and consent are read from it when asked (they are made later)
 * → { awaited, answerTo, owedToHim, thingsLines, hisUnderWay }
 */
export function createThings(dot) {
  const { audit } = dot;
  const awaited = (now = Date.now()) => dot.ledger.recent(40).filter((e) => e.awaiting?.from && !e.awaiting.answeredAt && now < (e.awaiting.until ?? 0));
  /** Is this message the answer a thing is waiting for? → the thing, marked answered, or null. */
  const answerTo = (n) => {
    const e = awaited().find((x) => sameName(x.awaiting.from, n?.name) || sameName(x.awaiting.from, conversationTitle(n?.title)));
    if (!e) return null;
    dot.ledger.note(e.id, { awaiting: { ...e.awaiting, answeredAt: Date.now(), text: head(String(n?.text ?? ''), 300) } });
    audit('awaited-answer', { thing: e.id, from: e.awaiting.from, pkg: n?.pkg ?? '', forHim: e.asker === 'him' });
    return dot.ledger.get(e.id);
  };
  /**
   * The things of his that have ended and that he has not been told the end of, oldest first: the book's `told` is
   * written when what the voice said of it reached him (tellHim), and only then. Not one he stopped himself (he knows),
   * not one a later thing carries on from (its end is the one to tell), and again when an answer it waited for came
   * after he was told. Whichever turn of hers comes first — the one the result woke, or one of his words that the
   * result has not reached yet (11-24: a handoff held it 85 s) — has it in front of her, and its end tells him once.
   */
  const owedToHim = (now = Date.now()) => {
    const recent = dot.ledger.recent(20), takenUp = new Set(recent.map((e) => e.after).filter(Boolean));
    return recent.filter((e) => e.asker === 'him' && e.state === 'ended' && !(e.outcome === 'stopped' && e.by === 'him') && !takenUp.has(e.id)
      && now - (e.awaiting?.answeredAt ?? e.endedAt ?? 0) <= ENDED_SHOWN_MS && (!e.told || (e.awaiting?.answeredAt ?? 0) > e.told)).reverse();
  };
  /** What her hands are on right now, as a line for her conversation ('' when they are free). */
  // What the book holds that bears on what she decides now, one line a thing with what to do about it (cf. DeerFlow's
  // delegation ledger): what is under way, what ended in the last hour that is not just "done", and what of
  // his has ended and he has not heard yet.
  const thingsLines = (now = Date.now()) => {
    const title = (task) => { const t = String(task ?? '').split(/[。\n]/)[0].trim(); return t.length > 40 ? `${head(t, 40)}…` : t; };
    const lines = dot.ledger.unfinished().map((e) => prompt('dot.things.running', { what: title(e.task), since: ago(e.startedAt ?? e.openedAt, now) || '刚' }).trim());
    const recent = dot.ledger.recent(10), takenUp = new Set(recent.map((e) => e.after).filter(Boolean)); // a later thing carries on from it
    const untold = new Set(owedToHim(now).map((e) => e.id));
    for (const e of recent) {
      if (e.state !== 'ended' || now - (e.endedAt ?? 0) > ENDED_SHOWN_MS || takenUp.has(e.id)) continue;
      if (e.outcome === 'stopped' && e.by === 'him') lines.push(prompt('dot.things.stopped.his', { what: title(e.task) }).trim());
      // A question put to him that his next words have been read since is not waiting any more (askSettled, below):
      // he said yes and the thing was taken up, or he said no or something else — either way it is not "stuck" now.
      else if (e.outcome === 'stuck' && e.ask?.for === 'him' && e.askSettled) continue;
      else if (e.outcome === 'stuck') lines.push(prompt('dot.things.stuck', { what: title(e.task), question: e.question ?? '' }).trim());
      else if (untold.has(e.id)) lines.push(prompt('dot.things.untold', { what: title(e.task), how: voiceHow(e) || prompt('dot.things.untold.done').trim(), summary: e.summary ? prompt('dot.plain.summary', { summary: e.summary }).trim() : '' }).trim());
    }
    for (const e of awaited(now)) lines.push(prompt('dot.things.awaiting', { what: title(e.task), from: e.awaiting.from, since: ago(e.awaiting.since, now) || '刚' }).trim());
    for (const a of dot.consent.asking()) lines.push(prompt('dot.things.asking', { what: a.what }).trim());
    return lines.join('\n');
  };
  /** Is something he asked for still in her hands? */
  const hisUnderWay = () => dot.ledger.unfinished().some((e) => e.asker === 'him');
  return { awaited, answerTo, owedToHim, thingsLines, hisUnderWay };
}
