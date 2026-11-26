// dsh-dot/ledger: the book of things — what she set out to do with her phone, her computer and the web, and what
// came of each. One entry per thing; only code writes it. What she is told about a thing, what she can say about it,
// and what the panel shows all come from here, never from what a model remembers having done.
//   entry = { id, asker: 'him' | 'her', device, task, state: 'queued' | 'running' | 'ended',
//             outcome?: 'done' | 'stopped' | 'failed' | 'timeout' | 'stuck', by?: 'him' | 'her' | 'code', cause?, error?,
//             summary?, detail?, name? (the hands' short name for it), question?, ask?: { for: 'her' | 'him', kind?, subject?, tier?: 'him' | 'ask', what?, screen? },
//             steps, tokens: { in, cached, out }, units?: 折算 token, yuan?: yuan at each call's price (null: a call had
//             no price) — both from src/price.js, call by call — openedAt, startedAt?, endedAt?, session?,
//             shot?: path of the screen as it was at the end, back?: when its end was put in front of her,
//             told?: when he was told how it ended (what the voice said of it reached him),
//             closed?: { at, why } — no longer owed, for a reason other than the ones below (an entry from before the
//             book kept owed things apart, 0.25.3) }
// The book is two things kept in one list: what is still owed (openOf: under way; an end of his he has not heard; a
// question to him not yet answered; an answer someone owes it) and the history of what is not. The history keeps the
// newest `keep`; what is owed is never cut for room and never ages out — it leaves when it is settled (11-26: an end
// of his could drop out of the last 100, or the last 20 / the last hour, before he was told).
// Only facts are kept, never a sentence written for one of its readers: who stopped it is a field, why it ended is one
// of a few causes (CAUSES), what came of it is the hands' own one-line summary and their details. Each reader (her
// conversation, the voice, the line in her notes, the panel) words these for itself.
// State and outcome are two things: a thing is ended once, and how it ended does not change. A restart ends whatever
// was not ended ('failed', cause 'restart') — the device may have been left halfway, and that is told once.

import { head as headOf, tail as tailOf } from '../cut.js';
import { addYuan } from '../price.js';

/** Why a thing ended, when that is not plain from its outcome. */
export const CAUSES = ['restart', 'no-session', 'interrupted', 'broke-off', 'no-result', 'timeout', 'stopped', 'command', 'over-cap', 'not-reached', 'same-error'];

/** An entry from before the book kept facts only (a `why` sentence, a `result` text): read once as fields. */
export function factsOf(e) {
  if (!e || !('why' in e || 'result' in e)) return e;
  const { why = '', result = '', ...rest } = e;
  const w = String(why);
  const cause = w === 'restart' || /重启/.test(w) ? 'restart' : /too long/.test(w) ? 'timeout' : /no hands session/.test(w) ? 'no-session' : /^broke off/.test(w) ? 'broke-off' : /no result/.test(w) ? 'no-result' : w === 'interrupted' ? 'interrupted' : e.outcome === 'stopped' ? 'stopped' : w ? 'broke-off' : '';
  return {
    ...rest,
    ...(cause && !rest.cause ? { cause } : {}),
    ...(!rest.by && e.outcome === 'stopped' ? { by: /^他/.test(w) ? 'him' : /^她/.test(w) ? 'her' : 'code' } : {}),
    ...(cause === 'broke-off' && w && !rest.error ? { error: w.replace(/^broke off:?\s*/, '').slice(0, 160) } : {}),
    ...(result && !rest.detail ? { detail: String(result) } : {}),
  };
}

/** The head and the tail of a long text: not a summary, so nothing in it was made up on the way. */
export function headTail(text, max = 900) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const head = Math.ceil(max * 2 / 3), tail = max - head;
  return `${headOf(t, head)}\n…（中间略去 ${t.length - max} 字）…\n${tailOf(t, tail)}`;
}

/**
 * Is this entry still owed? `takenUp`: the ids a later thing carries on from (its end is the one to tell). The reasons,
 * each of which ends only when it is settled: not ended yet; his, ended, not stopped by him, and he has not been told
 * how (again when an answer it waited for came after he was told); a question to him not yet answered; an answer
 * someone owes it, within the time its hands gave it.
 */
export function openOf(e, { takenUp = new Set(), at = Date.now() } = {}) {
  if (!e || e.closed) return false;
  if (e.state !== 'ended') return true;
  if (e.asker === 'him' && !(e.outcome === 'stopped' && e.by === 'him') && !takenUp.has(e.id) && (!e.told || (e.awaiting?.answeredAt ?? 0) > e.told)) return true;
  if (e.outcome === 'stuck' && e.ask?.for === 'him' && !e.askSettled) return true;
  if (e.awaiting?.from && !e.awaiting.answeredAt && at < (e.awaiting.until ?? 0)) return true;
  return false;
}

/**
 * @param deps.store  { get(key), set(key, value) } — kept across restarts
 * @param deps.keep   how many entries are kept (the newest)
 */
export function createLedger({ store, key = 'things', keep = 100, now = () => Date.now() }) {
  const raw = (Array.isArray(store.get(key)) ? store.get(key) : []).filter((e) => e && e.id);
  let list = raw.map(factsOf);
  const folded = list.some((e, i) => e !== raw[i]);
  const cut = [];
  for (const e of list) if (e.state !== 'ended') { Object.assign(e, { state: 'ended', outcome: 'failed', by: 'code', cause: 'restart', endedAt: now() }); cut.push(e); }
  let n = list.reduce((m, e) => Math.max(m, Number(String(e.id).slice(1)) || 0), 0);
  const takenUpOf = () => new Set(list.map((e) => e.after).filter(Boolean));
  // The newest `keep`, and every older one still owed.
  const save = () => {
    const newest = new Set(list.slice(-keep).map((e) => e.id)), takenUp = takenUpOf(), at = now();
    list = list.filter((e) => newest.has(e.id) || openOf(e, { takenUp, at }));
    store.set(key, list);
  };
  // A book from before owed things were kept apart: what ended more than an hour ago was out of sight by then (the
  // old window), and is not brought back as owed now — told or not, it is closed as it stood.
  const since = `${key}OwedSince`;
  let migrated = false;
  if (!store.get(since)) {
    for (const e of list) if (e.state === 'ended' && now() - (e.endedAt ?? 0) > 3600000 && !e.closed && openOf(e, { takenUp: takenUpOf(), at: now() })) { e.closed = { at: now(), why: 'before' }; migrated = true; }
    store.set(since, now());
  }
  if (cut.length || folded || migrated) save();
  const find = (id) => list.find((e) => e.id === id) ?? null;
  return {
    /** A new thing, queued. → its id */
    open({ asker = 'her', device = '', task = '', ...more } = {}) {
      const e = { id: `t${++n}`, asker, device, task: String(task), state: 'queued', steps: 0, tokens: { in: 0, cached: 0, out: 0 }, openedAt: now(), ...more };
      list.push(e); save();
      return e.id;
    },
    /** It is being done now. */
    begin(id, more = {}) { const e = find(id); if (!e || e.state === 'ended') return; Object.assign(e, { state: 'running', startedAt: now() }, more); save(); },
    /** Counted as it goes; written down with the next change of state. */
    // `units` and `yuan`: what the call cost (src/price.js charge), added up as it goes.
    count(id, { steps = 0, tokens, units, yuan } = {}) {
      const e = find(id); if (!e) return;
      e.steps += steps;
      if (tokens) for (const k of ['in', 'cached', 'out']) e.tokens[k] += Number(tokens[k] ?? 0) || 0;
      if (units !== undefined) e.units = (e.units ?? 0) + (Number(units) || 0);
      if (yuan !== undefined) e.yuan = addYuan(e.yuan, yuan);
    },
    /** It is over, this way. Once: an ended thing stays as it ended. */
    end(id, { outcome, by = 'code', cause = '', error = '', summary = '', detail = '', name = '', question = '', ask = null } = {}) {
      const e = find(id);
      if (!e || e.state === 'ended') return e;
      const some = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
      Object.assign(e, { state: 'ended', outcome, by, endedAt: now(), ...some({ cause, error, summary, detail, name, question }), ...(ask ? { ask } : {}) });
      save();
      return e;
    },
    /** Something learnt about it afterwards (where its last screen was kept, that he was told). */
    note(id, more = {}) { const e = find(id); if (!e) return; Object.assign(e, more); save(); },
    get: (id) => { const e = find(id); return e ? { ...e } : null; },
    /** What is not over: under way first, then what waits, in order. */
    unfinished: () => list.filter((e) => e.state !== 'ended').sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1)).map((e) => ({ ...e })),
    /** The newest entries, newest first. */
    recent: (count = 20) => list.slice(-count).reverse().map((e) => ({ ...e })),
    /** Everything still owed (openOf), oldest first, however old: what is under way, what he has not heard, what waits on an answer. */
    owed: () => { const takenUp = takenUpOf(), at = now(); return list.filter((e) => openOf(e, { takenUp, at })).map((e) => ({ ...e })); },
    /** No longer owed, for this reason (a thing she settled otherwise): it stays in the history. */
    close(id, why = '') { const e = find(id); if (!e || e.state !== 'ended') return; e.closed = { at: now(), why: String(why).slice(0, 120) }; save(); },
    /** What a restart ended, told once. */
    interrupted() { return cut.splice(0).map((e) => ({ ...e })); },
    /** Everything forgotten (a reset). */
    clear() { list = []; cut.length = 0; n = 0; save(); },
  };
}
