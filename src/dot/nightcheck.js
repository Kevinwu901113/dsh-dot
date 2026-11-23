// dsh-dot/nightcheck: what she has written down for herself, held against what is on record.
//
// Her know-how book (howto.js) is written by a model from one thing's steps. 11-23: her hands said a text had no
// answer "possibly because the emulator cannot reach the carrier"; the notes kept it as a lesson in bold; the next
// hands were given it as experience and reported it as a fact; he was told it as the result. Each hand dropped a
// little of the "possibly". A note is worth what the records behind it are worth, so each line is held against them:
//   seen        the records show it (it names the runs that do)            → kept
//   guess       it says why, or what something is, and no record shows that → reworded to what was seen, or dropped
//   stale       a later record contradicts it (it names the run)           → dropped
//   unsupported it claims to be seen but names no run that is on record    → kept, and listed for him
// Which lines are which is a model's reading; that the runs it names exist, what happens to a line, and the notes
// that result are the code's. Shortcuts are not read by a model at all: a shortcut for a task that has no way on
// record (howto.tasks) is dropped. Nothing is applied by the check itself: it writes what it would do; applying is
// a second step.
import { createHash } from 'node:crypto';

export const OPS = ['seen', 'guess', 'stale'];
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
      runs: { type: 'array', items: { type: 'string' }, description: '作证的记录的 id：seen 填看得到它的那几次，stale 填和它对不上的那一次' },
      text: { type: 'string', description: 'guess 才填：只留记录里看得到的那部分，改写成一条；什么都留不下就不填（这条会去掉）' },
      why: { type: 'string', description: '一句话：凭哪一步、哪个报错这样判' },
    }, required: ['n', 'is'], additionalProperties: false } } },
    required: ['lines'], additionalProperties: false,
  },
});

/**
 * What would be done to the notes. → { ops: [{ n, was, op: 'keep' | 'reword' | 'drop', is, text?, runs, why }], notes, changed }
 * @param {object} a
 * @param {string} a.notes     the notes as they are
 * @param {object[]} a.judged  the model's lines ([{ n, is, runs, text, why }]); a lesson it did not judge is kept, as unjudged
 * @param {object[]} a.records the records it was given ([{ id, … }])
 * @param {{ task: string, route?: string[] }[]} a.tasks  the place's tasks with their ways on record (howto.tasks)
 */
export function settle({ notes, judged = [], records = [], tasks = [] }) {
  const ids = new Set(records.map((r) => String(r.id)));
  const by = new Map((Array.isArray(judged) ? judged : []).map((j) => [Number(j?.n), j]));
  const routed = tasks.filter((t) => Array.isArray(t.route) && t.route.length).map((t) => String(t.task));
  const ops = [], out = [];
  for (const l of linesOf(notes)) {
    if (l.kind === 'head' || l.kind === 'other') { out.push(l.text); continue; }
    const was = l.text.replace(ITEM, '');
    if (l.kind === 'shortcut') {
      // A shortcut is a way that was walked: one for a task with no way on record is not a shortcut.
      const known = routed.some((t) => t && was.includes(t));
      if (known || /没有记账|没有.*捷径/.test(was)) out.push(l.text); else ops.push({ n: l.n, was, op: 'drop', is: 'no-route', runs: [], why: '这件事没有记账下来的走法' });
      continue;
    }
    const j = by.get(l.n);
    const runs = [].concat(j?.runs ?? []).map(String).filter((id) => ids.has(id));
    const why = String(j?.why ?? '').slice(0, 200);
    if (!j || !OPS.includes(j.is)) { out.push(l.text); ops.push({ n: l.n, was, op: 'keep', is: 'unjudged', runs: [], why: '' }); continue; }
    if (j.is === 'seen') { out.push(l.text); if (!runs.length) ops.push({ n: l.n, was, op: 'keep', is: 'unsupported', runs, why }); continue; }
    if (j.is === 'stale') {
      // Dropped only against a record that is there: "contradicted" with no run named is not a contradiction.
      if (runs.length) ops.push({ n: l.n, was, op: 'drop', is: 'stale', runs, why }); else { out.push(l.text); ops.push({ n: l.n, was, op: 'keep', is: 'unsupported', runs, why }); }
      continue;
    }
    const text = String(j.text ?? '').replace(/\s*\n+\s*/g, ' ').trim();
    if (text && text !== was) { out.push(`- ${text}`); ops.push({ n: l.n, was, op: 'reword', is: 'guess', text, runs, why }); }
    else if (!text) ops.push({ n: l.n, was, op: 'drop', is: 'guess', runs, why });
    else out.push(l.text);
  }
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { ops, notes: next, changed: ops.some((o) => o.op !== 'keep') };
}

/** The check of one place, as he reads it. */
export function report(place, r) {
  if (!r.ops.length) return `${place}：没有要动的`;
  const word = { reword: '改写', drop: '去掉', keep: '留着' }, is = { guess: '是推测', stale: '和后来的记录对不上', 'no-route': '没有走成过的记录', unsupported: '没有记录作证', unjudged: '没判' };
  return `${place}：\n${r.ops.map((o) => `  ${word[o.op]}（${is[o.is] ?? o.is}${o.runs.length ? `，记录 ${o.runs.join('、')}` : ''}）：${o.was}${o.op === 'reword' ? `\n    → ${o.text}` : ''}${o.why ? `\n    凭：${o.why}` : ''}`).join('\n')}`;
}
