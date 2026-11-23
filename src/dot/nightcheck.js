// dsh-dot/nightcheck: what she has written down for herself, held against what is on record.
//
// Her know-how book (howto.js) is written by a model from one thing's steps. 11-23: her hands said a text had no
// answer "possibly because the emulator cannot reach the carrier"; the notes kept it as a lesson in bold; the next
// hands were given it as experience and reported it as a fact; he was told it as the result. Each hand dropped a
// little of the "possibly". So each lesson is read for two things that are not the same:
//   what kind of sentence it is — what happened and what to do (a step, an error, what worked), or also why it
//     happened / what the device, the app or the other side "is". The why is a guess unless a record shows it:
//     the line is reworded to what it reports as seen (or dropped when nothing else is in it)       → cause
//   whether a later record contradicts it (the run is named, and is one whose steps or way are on record) → stale
//   everything else is kept; a kept line with no run on record behind it is counted, not touched    → ok
// The first run of this (11-23 night) showed why "not on record" must never mean "wrong": runs logged before steps
// were kept show only counts, the model said of nearly every lesson "the records do not show it", and the check
// would have emptied the book. A record that is missing proves nothing. Shortcuts are left alone for the same
// reason: they are rewritten from the ways on record the next time the place is reflected on (howto.js).
// Which lines are which is a model's reading; that the runs it names exist, what happens to a line, and the notes
// that result are the code's. Nothing is applied by the check itself: it writes what it would do; applying is a
// second step.
import { createHash } from 'node:crypto';

export const OPS = ['ok', 'cause', 'stale'];
const ITEM = /^\s*[-*]\s+/;
export const hashOf = (text) => createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 12);

/** The notes as lines: [{ n, text, kind: 'head' | 'lesson' | 'shortcut' | 'other' }] — items under 「捷径」 are shortcuts, other items lessons. */
export function linesOf(notes) {
  let section = '';
  return String(notes ?? '').split('\n').map((text, n) => {
    if (/^#+\s/.test(text)) { section = /捷径/.test(text) ? 'shortcut' : 'lesson'; return { n, text, kind: 'head' }; }
    return { n, text, kind: ITEM.test(text) ? section || 'lesson' : 'other' };
  });
}

/** What the model is given: the lessons, numbered, and the records of the place. */
export const checkInput = ({ place, notes, records }) => ({
  place,
  lessons: linesOf(notes).filter((l) => l.kind === 'lesson').map(({ n, text }) => ({ n, text: text.replace(ITEM, '') })),
  records,
});

export const checkTool = () => ({
  name: 'check',
  description: '逐条交回对每条教训的判断',
  parameters: {
    type: 'object',
    properties: { lines: { type: 'array', items: { type: 'object', properties: {
      n: { type: 'number', description: '这条教训的编号（输入里的 n）' },
      is: { type: 'string', enum: OPS },
      runs: { type: 'array', items: { type: 'string' }, description: '记录的 id：ok 填看得到它的那几次（没有就空着）；stale 填和它对不上的那一次' },
      text: { type: 'string', description: 'cause 才填：去掉原因和「是什么样」的说法，只留它自己写明看到的现象和该怎么做，改写成一条；什么都留不下就不填（这条会去掉）' },
      why: { type: 'string', description: '一句话：为什么这样判' },
    }, required: ['n', 'is'], additionalProperties: false } } },
    required: ['lines'], additionalProperties: false,
  },
});

/**
 * What would be done to the notes. → { ops: [{ n, was, op: 'keep' | 'reword' | 'drop', is, text?, runs, why }], notes, changed, unsupported }
 * @param {object} a
 * @param {string} a.notes     the notes as they are
 * @param {object[]} a.judged  the model's lines ([{ n, is, runs, text, why }]); a lesson it did not judge is kept
 * @param {object[]} a.records the records it was given ([{ id, calls?, route? }])
 */
export function settle({ notes, judged = [], records = [] }) {
  const shows = new Set(records.filter((r) => r.calls?.length || r.route?.length).map((r) => String(r.id))); // runs whose steps or way are on record
  const ids = new Set(records.map((r) => String(r.id)));
  const by = new Map((Array.isArray(judged) ? judged : []).map((j) => [Number(j?.n), j]));
  const ops = [], out = [];
  let unsupported = 0;
  for (const l of linesOf(notes)) {
    if (l.kind !== 'lesson') { out.push(l.text); continue; }
    const was = l.text.replace(ITEM, '');
    const j = by.get(l.n);
    const named = [].concat(j?.runs ?? []).map(String);
    const why = String(j?.why ?? '').slice(0, 200);
    if (j?.is === 'stale') {
      // Dropped only against a run whose steps or way are on record: a count of steps contradicts nothing.
      const runs = named.filter((id) => shows.has(id));
      if (runs.length) { ops.push({ n: l.n, was, op: 'drop', is: 'stale', runs, why }); continue; }
      out.push(l.text); unsupported++; continue;
    }
    if (j?.is === 'cause') {
      const text = String(j.text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
      if (!text) { ops.push({ n: l.n, was, op: 'drop', is: 'cause', runs: [], why }); continue; }
      if (text !== was) { out.push(`- ${text}`); ops.push({ n: l.n, was, op: 'reword', is: 'cause', text, runs: [], why }); continue; }
    }
    out.push(l.text);
    if (!named.some((id) => ids.has(id))) unsupported++;
  }
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { ops, notes: next, changed: ops.length > 0, unsupported };
}

/** The check of one place, as he reads it. */
export function report(place, r) {
  const rest = r.unsupported ? `（另有 ${r.unsupported} 条背后没有在册的记录，没动）` : '';
  if (!r.ops.length) return `${place}：没有要动的${rest}`;
  const word = { reword: '改写', drop: '去掉' }, is = { cause: '里面有原因的推测', stale: '和后来的记录对不上' };
  return `${place}：${rest}\n${r.ops.map((o) => `  ${word[o.op]}（${is[o.is] ?? o.is}${o.runs.length ? `，记录 ${o.runs.join('、')}` : ''}）：${o.was}${o.op === 'reword' ? `\n    → ${o.text}` : ''}${o.why ? `\n    凭：${o.why}` : ''}`).join('\n')}`;
}
