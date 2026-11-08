// dsh-dot/howto: what she learns in each app — logged, reflected on when worth it, given back on the next visit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHowto, callLine, fileOf, batchLaunch, batchFailures, errorType, isRefusal } from '../src/dot/howto.js';

const P = 'mcp__dot-phone__';

test('howto: steps per app (a batch counts its steps), real errors kept (refusals and batch failures sorted), nothing outside an open turn', () => {
  const dir = mkdtempSync(join(tmpdir(), 'howto-'));
  let t = Date.now();
  const h = createHowto({ dir, minSteps: 4, now: () => t });
  assert.equal(h.step('s1', '小黑盒', `${P}mobile_list_elements_on_screen`, {}), '', 'no open turn: a late result of an ended one');
  h.turnStarted('s1');
  h.step('s1', 'phone', `${P}mobile_list_elements_on_screen`, {});
  h.step('s1', '小黑盒', `${P}mobile_launch_app`, { packageName: 'com.max.xiaoheihe' });
  h.step('s1', '小黑盒', `${P}mobile_click_on_screen_at_coordinates`, { x: 421, y: 428 }, { isError: true, error: 'Error: approval rejected by the user' });
  h.step('s1', '小黑盒', `${P}mobile_batch_commands`, { steps: [{ name: 'mobile_click_on_screen_at_coordinates' }, { name: 'mobile_type_keys' }] }, { error: 'Step 1 (click) ok\nStep 2 (mobile_type_keys) failed: element not found' });
  const learn = h.end('s1', '图发你了 https://example.com/x');
  assert.deepEqual(learn.map((r) => [r.app, r.steps, r.errors]), [['小黑盒', 4, ['element not found']]], 'the approval refusal is not her mistake');
  assert.equal(learn[0].said, '图发你了 （链接）');
  assert.match(learn[0].calls[2], /^batch_commands\(click_on_screen_at_coordinates\+type_keys\) ✗ element not found/);
  assert.deepEqual(h.recent('小黑盒').map((r) => r.steps), [4]);
  assert.deepEqual(h.apps(), ['小黑盒'], 'the home screen is not an app');
  // the same app again within the cooldown: logged, not reflected on
  h.turnStarted('s1');
  for (let i = 0; i < 6; i++) h.step('s1', '小黑盒', `${P}mobile_swipe_on_screen`, {}, { isError: true, error: 'boom' });
  assert.deepEqual(h.end('s1'), []);
  t += 2 * 3600000;
  h.turnStarted('s1');
  for (let i = 0; i < 6; i++) h.step('s1', '小黑盒', `${P}mobile_swipe_on_screen`, {});
  assert.equal(h.end('s1').length, 1, 'no notes yet: a long run is worth it');
  assert.equal(callLine(`${P}mobile_type_keys`, { text: '浮游世界' }), 'type_keys(浮游世界)');
  assert.equal(fileOf('a/b c'), 'a_b_c.md');
  assert.equal(batchLaunch({ steps: [{ name: 'mobile_launch_app', arguments: { packageName: 'com.x' } }] }), 'com.x');
  assert.deepEqual(batchFailures('Step 3 (mobile_click) failed: nope\nStep 4 (x) ok'), ['nope']);
  assert.equal(errorType('Error: no element "这是一大段从屏幕上抄下来的帖子正文内容呢" at https://a.b/c\nmore'), 'Error: no element "…" at （链接）');
  assert.ok(isRefusal('dsh-interlude: 她自己的时间里，在 小黑盒 打字') && !isRefusal('element not found'));
});

test('howto: long runs are worth it only when clearly above her usual; notes once per session (not before there are any); keep marks its own run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'howto-'));
  let t = Date.now();
  const h = createHowto({ dir, minSteps: 3, maxChars: 40, cooldownMs: 0, now: () => t });
  const run = (sid, n) => { h.turnStarted(sid); for (let i = 0; i < n; i++) h.step(sid, '小黑盒', `${P}mobile_swipe_on_screen`, {}); return h.end(sid); };
  assert.equal(h.take('s1', '小黑盒'), null, 'nothing learned yet');
  const [first] = run('s1', 10);
  assert.ok(first);
  assert.equal(h.keep('小黑盒', { notes: '## 教训\n详情页点图片会跳走 https://x.y/z ，要点标题。'.repeat(3), worked: true }, first.id), true);
  assert.equal(h.notes('小黑盒').length, 40);
  assert.doesNotMatch(h.notes('小黑盒'), /https/);
  assert.equal(h.recent('小黑盒').find((r) => r.id === first.id).worked, true);
  assert.deepEqual(run('s1', 12), [], 'with notes, 12 is not above 1.5× her median (10)');
  assert.equal(run('s1', 20).length, 1, '20 is');
  const got = h.take('s2', '小黑盒');
  assert.match(got.notes, /^## 教训/);
  assert.match(got.recent, /10 步；.*12 步；.*20 步/);
  assert.equal(h.take('s2', '小黑盒'), null, 'once per session');
  h.keep('小黑盒', { notes: '新的', worked: false }, 'nope');
  assert.equal(h.take('s2', '小黑盒').notes, '新的', 'new notes are given again');
  assert.ok(readFileSync(join(dir, '_log.jsonl'), 'utf8').includes('"worked":true'));
  const input = h.input({ app: '小黑盒', steps: 3, errors: [], calls: ['a'], said: 'x' });
  assert.equal(input.notesNow, '新的');
});
