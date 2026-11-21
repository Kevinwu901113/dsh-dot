// dsh-dot/ledger: the book of things — what she set out to do with her phone, her computer and the web, and what
// came of each. One entry per thing; only code writes it. What she is told about a thing, what she can say about it,
// and what the panel shows all come from here, never from what a model remembers having done.
//   entry = { id, asker: 'him' | 'her', device, task, state: 'queued' | 'running' | 'ended',
//             outcome?: 'done' | 'stopped' | 'failed' | 'timeout' | 'stuck', why?, by?: 'him' | 'her',
//             question?, ask?: { for: 'her' | 'him', kind?, subject?, screen? }, result?, steps, tokens: { in, cached, out }, openedAt, startedAt?, endedAt?, session?,
//             shot?: path of the screen as it was at the end, told?: at }
// State and outcome are two things: a thing is ended once, and how it ended does not change. A restart ends whatever
// was not ended ('failed', why 'restart') — the device may have been left halfway, and that is told once.

import { head as headOf, tail as tailOf } from '../cut.js';

/** The head and the tail of a long text: not a summary, so nothing in it was made up on the way. */
export function headTail(text, max = 900) {
  const t = String(text ?? '').trim();
  if (t.length <= max) return t;
  const head = Math.ceil(max * 2 / 3), tail = max - head;
  return `${headOf(t, head)}\n…（中间略去 ${t.length - max} 字）…\n${tailOf(t, tail)}`;
}

/**
 * @param deps.store  { get(key), set(key, value) } — kept across restarts
 * @param deps.keep   how many entries are kept (the newest)
 */
export function createLedger({ store, key = 'things', keep = 100, now = () => Date.now() }) {
  let list = (Array.isArray(store.get(key)) ? store.get(key) : []).filter((e) => e && e.id);
  const cut = [];
  for (const e of list) if (e.state !== 'ended') { Object.assign(e, { state: 'ended', outcome: 'failed', why: 'restart', endedAt: now() }); cut.push(e); }
  let n = list.reduce((m, e) => Math.max(m, Number(String(e.id).slice(1)) || 0), 0);
  const save = () => { list = list.slice(-keep); store.set(key, list); };
  if (cut.length) save();
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
    count(id, { steps = 0, tokens } = {}) { const e = find(id); if (!e) return; e.steps += steps; if (tokens) for (const k of ['in', 'cached', 'out']) e.tokens[k] += Number(tokens[k] ?? 0) || 0; },
    /** It is over, this way. Once: an ended thing stays as it ended. */
    end(id, { outcome, why = '', by = '', question = '', result = '', ask = null } = {}) {
      const e = find(id);
      if (!e || e.state === 'ended') return e;
      Object.assign(e, { state: 'ended', outcome, endedAt: now(), ...(why ? { why } : {}), ...(by ? { by } : {}), ...(question ? { question } : {}), ...(ask ? { ask } : {}), ...(result ? { result } : {}) });
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
    /** What a restart ended, told once. */
    interrupted() { return cut.splice(0).map((e) => ({ ...e })); },
    /** Everything forgotten (a reset). */
    clear() { list = []; cut.length = 0; n = 0; save(); },
  };
}
