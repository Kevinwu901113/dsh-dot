// dsh-dot/sayings: her say in which of her old answers she looks at — her file read as it is, her record of what was
// looked at; and a small-hours 明天 written with both days.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChoices, choose, sayingsPlace, stampOf } from '../src/dot/sayings.js';
import { annotate } from '../src/memory/when.js';
import { daysOf } from '../src/memory/facts.js';

test('her file: 不看 / 常看 by stamp or by a line of hers; everything else is her notes', () => {
  const c = parseChoices('# 我自己的说明\n这几段太像客服了\n- 不看 11-20 18:22\n- 不看「那就去睡」\n* 常看：3-1 9:05\n常看 随便写写');
  assert.deepEqual(c, { drop: [{ stamp: '11-20 18:22' }, { quote: '那就去睡' }], keep: [{ stamp: '03-01 09:05' }] });
  assert.deepEqual(parseChoices('- 常看 11-27 01:36:12').keep, [{ stamp: '11-27 01:36:12' }]);
});

test('choose: kept first, dropped never, each once, at most n', () => {
  const at = (s) => new Date(`2026-${s.replace(' ', 'T')}:00`).getTime();
  const a = { at: at('11-20 18:22'), his: '在吗', her: '在' }, b = { at: at('11-21 01:00'), his: '困', her: '那就去睡' }, k = { at: at('11-22 10:00'), his: '早', her: '醒啦' };
  const ch = { drop: [{ stamp: stampOf(a.at) }, { quote: '那就去睡' }], keep: [{ stamp: stampOf(k.at) }] };
  assert.deepEqual(choose([a, b, k], [k], ch, 4), [k]);
  assert.deepEqual(choose([k], [k], { drop: [], keep: [] }, 4), [k], 'not twice');
});

test('her place: the record is hers to read, kept short; her file read each time', () => {
  const home = mkdtempSync(join(tmpdir(), 'dot-'));
  const place = sayingsPlace(home, { keep: 3 });
  assert.deepEqual(place.choices(), { drop: [], keep: [] }, 'no file yet: nothing chosen');
  for (let i = 0; i < 8; i++) place.record({ at: Date.now(), said: [`第${i}句`], past: [{ at: Date.now() - 86400000, his: '在吗', her: '在' }] });
  const rows = readFileSync(place.used, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.length <= 8 && rows.at(-1).said[0] === '第7句');
  assert.match(rows[0].past[0].when, /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  mkdirSync(join(home, 'her'), { recursive: true });
  writeFileSync(place.file, '- 不看「在」\n');
  assert.deepEqual(place.choices().drop, [{ quote: '在' }]);
});

test('when: 明天 said before 5 in the morning carries both days; later in the day, one', () => {
  const night = new Date(2026, 10, 27, 1, 40).getTime(), day = new Date(2026, 10, 27, 13, 40).getTime();
  assert.equal(annotate('明天中午提醒我', night), '明天（=11-28；凌晨说的，按睡醒算是 11-27）中午提醒我');
  assert.equal(annotate('明天中午提醒我', day), '明天（=11-28）中午提醒我');
  assert.deepEqual(daysOf('明天中午提醒我', night).map((d) => new Date(d).getDate()), [28, 27]);
});
