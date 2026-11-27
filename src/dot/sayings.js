// dsh-dot/sayings: what she looks at, of how she answered him before, when her words to him are written — and her say
// in it. Every time old exchanges go with a reply of hers, which ones is written down where she can read it
// (~/dot/her/sayings/used.jsonl: when, what she said, the exchanges, each by its stamp). What she makes of that is hers:
// in ~/dot/her/sayings.md a line "- 不看 MM-DD HH:MM:SS" (or 「a line of hers then」) keeps an exchange from being looked at
// again, "- 常看 …" puts one in front of every reply; a line taken out undoes it. Everything else in the file is her
// own notes, not read by the code. The next reply goes by the file as it is then (11-27: the first loop she can close
// herself — see something come out wrong, find which examples it came from, change that, look again later).
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const p2 = (n) => String(n).padStart(2, '0');
/** "MM-DD HH:MM:SS", local: how an exchange is named in her record and in her file (several can share a minute). */
export const stampOf = (ms) => { const d = new Date(ms); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
const normStamp = (s) => { const m = /^(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s).trim()); return m ? `${p2(m[1])}-${p2(m[2])} ${p2(m[3])}:${m[4]}${m[5] ? `:${m[5]}` : ''}` : ''; };
/** Does a stamp she wrote (to the second, or only to the minute: the first of that minute) name the moment `ms`? */
export const stampNames = (stamp, ms) => stampOf(ms).startsWith(stamp);

/** Her file → { drop: [{ stamp?, quote? }], keep: [{ stamp?, quote? }] } (lines "- 不看 …" / "- 常看 …"). */
export function parseChoices(text) {
  const out = { drop: [], keep: [] };
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?(不看|常看)\s*[:：]?\s*(?:(\d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})?)|「([^」]+)」)/.exec(line);
    if (!m) continue;
    const c = m[2] ? { stamp: normStamp(m[2]) } : { quote: m[3].trim() };
    if (!c.stamp && !c.quote) continue;
    (m[1] === '不看' ? out.drop : out.keep).push(c);
  }
  return out;
}

/** Does choice `c` name exchange `ex` ({ at, his, her })? */
export const names = (c, ex) => (c.stamp ? stampNames(c.stamp, ex.at) : Boolean(c.quote) && String(ex.her ?? '').includes(c.quote));

/**
 * The exchanges to look at: `found` (best first) without the ones she dropped, after the ones she keeps in front
 * (`kept`: already looked up, in her order) — at most `n`, each once.
 */
export function choose(found, kept, choices, n) {
  const out = [], seen = new Set();
  const add = (ex) => { if (out.length < n && ex && !seen.has(ex.at) && !choices.drop.some((c) => names(c, ex))) { seen.add(ex.at); out.push(ex); } };
  for (const ex of kept) add(ex);
  for (const ex of found) add(ex);
  return out;
}

/** Her place for this: reading her file, writing down what was looked at. */
export function sayingsPlace(home, { keep = 300 } = {}) {
  const dir = join(home, 'her', 'sayings'), file = join(home, 'her', 'sayings.md'), used = join(dir, 'used.jsonl');
  return {
    file, used,
    choices: () => { try { return parseChoices(readFileSync(file, 'utf8')); } catch { return { drop: [], keep: [] }; } },
    /** One reply of hers and the exchanges it was written with. */
    record({ at = Date.now(), said = [], past = [] } = {}) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(used, `${JSON.stringify({ when: stampOf(at), said: said.slice(0, 4), past: past.map((x) => ({ when: stampOf(x.at), his: x.his, her: x.her })) })}\n`);
        // Kept to the newest `keep`, now and then (a file she reads should not grow without end).
        if (statSync(used).size > keep * 1200) { const rows = readFileSync(used, 'utf8').split('\n').filter(Boolean); writeFileSync(used, `${rows.slice(-keep).join('\n')}\n`); }
      } catch { /* her record is best-effort: a reply is not held up by it */ }
    },
  };
}
