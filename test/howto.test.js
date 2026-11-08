// dsh-dot/howto: what she learns in each app — logged, reflected on when worth it, given back on the next visit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHowto, callLine, fileOf } from '../src/dot/howto.js';

const P = 'mcp__dot-phone__';
const labels = { 'com.max.xiaoheihe': '小黑盒' };

test('howto: steps are counted per app (the last app opened), errors kept; a long or failing run comes back to learn from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'howto-'));
  const h = createHowto({ dir, labelOf: (p) => labels[p] ?? p, minSteps: 4 });
  assert.equal(h.step('s1', `${P}mobile_list_elements_on_screen`, {}), 'phone', 'before any app is opened');
  assert.equal(h.step('s1', `${P}mobile_launch_app`, { packageName: 'com.max.xiaoheihe' }), '小黑盒');
  h.step('s1', `${P}mobile_click_on_screen_at_coordinates`, { x: 421, y: 428 });
  h.step('s1', `${P}mobile_type_keys`, { text: '浮游世界', submit: true });
  h.step('s1', `${P}mobile_click_on_screen_at_coordinates`, { x: 10, y: 10 }, { isError: true, error: 'Device "emulator-5554" not found' });
  const learn = h.end('s1', '图发你了');
  assert.deepEqual(learn.map((r) => [r.app, r.steps, r.errors.length]), [['小黑盒', 4, 1]], 'the phone-only step is logged, not reflected on');
  assert.deepEqual(learn[0].calls, ['launch_app(com.max.xiaoheihe)', 'click_on_screen_at_coordinates(421,428)', 'type_keys(浮游世界)', 'click_on_screen_at_coordinates(10,10) ✗ Device "emulator-5554" not found']);
  assert.equal(learn[0].said, '图发你了');
  assert.deepEqual(h.recent('小黑盒').map((r) => r.steps), [4]);
  // a short clean run is only logged; the app is remembered across turns of the session
  h.step('s1', `${P}mobile_press_button`, { button: 'BACK' });
  assert.deepEqual(h.end('s1'), []);
  assert.deepEqual(h.recent('小黑盒').map((r) => r.steps), [4, 1]);
  assert.deepEqual(h.end('nothing'), []);
  assert.equal(callLine(`${P}mobile_batch_commands`, { commands: [1, 2, 3] }), 'batch_commands(3 步)');
  assert.equal(fileOf('a/b c'), 'a_b_c.md');
});

test('howto: notes come once per session per app, with her last runs; kept notes are capped and mark whether it worked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'howto-'));
  const h = createHowto({ dir, labelOf: (p) => labels[p] ?? p, maxChars: 40 });
  assert.equal(h.take('s1', '小黑盒'), null, 'nothing learned yet');
  h.step('s1', `${P}mobile_launch_app`, { packageName: 'com.max.xiaoheihe' });
  h.end('s1');
  assert.equal(h.keep('小黑盒', { notes: '## 教训\n详情页点图片会跳走，要点标题。'.repeat(3), worked: true }), true);
  assert.equal(h.notes('小黑盒').length, 40);
  assert.equal(h.recent('小黑盒').at(-1).worked, true);
  const got = h.take('s2', '小黑盒');
  assert.match(got.notes, /^## 教训/);
  assert.match(got.recent, /1 步/);
  assert.equal(h.take('s2', '小黑盒'), null, 'once per session');
  assert.equal(h.take('s2', 'phone'), null);
  assert.deepEqual(h.apps(), ['小黑盒']);
  const input = h.input({ app: '小黑盒', steps: 3, errors: [], calls: ['a'], said: 'x' });
  assert.equal(input.notesNow, h.notes('小黑盒'));
  assert.equal(input.limits.notesMaxChars, 40);
  assert.ok(readFileSync(join(dir, '_log.jsonl'), 'utf8').includes('"worked":true'));
});
