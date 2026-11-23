// dsh-dot/howto: the know-how book — each thing's steps per place logged with the book's outcome, reflected on when
// worth it, given back the next time her hands are there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHowto, callLine, fileOf, batchLaunch, batchFailures, errorType, isRefusal, placeName } from '../src/dot/howto.js';
import { deny } from '../src/refusals.js';

const P = 'mcp__dot-phone__';
const dirOf = () => mkdtempSync(join(tmpdir(), 'howto-'));

test('howto: steps per place (a batch counts its steps), real errors kept (refusals and batch failures sorted); a thing\'s end logs each place with the book\'s outcome, time and cost', () => {
  const dir = dirOf();
  let t = Date.now();
  const h = createHowto({ dir, minSteps: 4, now: () => t });
  h.step('s1', 'phone', `${P}mobile_list_elements_on_screen`, {});
  h.step('s1', '小黑盒', `${P}mobile_launch_app`, { packageName: 'com.max.xiaoheihe' });
  h.step('s1', '小黑盒', `${P}mobile_click_on_screen_at_coordinates`, { x: 421, y: 428 }, { isError: true, error: 'Error: approval rejected by the user' });
  h.step('s1', '小黑盒', `${P}mobile_batch_commands`, { steps: [{ name: 'mobile_click_on_screen_at_coordinates' }, { name: 'mobile_type_keys' }] }, { error: 'Step 1 (click) ok\nStep 2 (mobile_type_keys) failed: element not found' });
  h.step('s1', '小黑盒', `${P}mobile_click_on_screen_at_coordinates`, { x: 1, y: 1 }, { isError: true, error: 'Error: 这一步要先问过他：装一个 App。' });
  t += 60000;
  const learn = h.end('s1', { thing: 't1', task: '去小黑盒搜 https://x.y 浮游世界', outcome: 'done', ms: 60000, tokens: 50000 });
  assert.deepEqual(learn.map((r) => [r.app, r.steps, r.errors, r.outcome]), [['小黑盒', 5, ['element not found'], 'done']], 'refusals and gates are not mistakes in the app');
  assert.equal(learn[0].task, '去小黑盒搜 （链接） 浮游世界');
  assert.equal(learn[0].tokens, Math.round(50000 * 0.83));
  assert.match(learn[0].calls[2], /^batch_commands\(click_on_screen_at_coordinates\+type_keys\) ✗ element not found/);
  assert.match(learn[0].calls[3], /⊘$/);
  const log = readFileSync(join(dir, '_log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map(({ thing, app, steps, outcome, ms, tokens, share }) => [thing, app, steps, outcome, ms, tokens, share]), [['t1', 'phone', 1, 'done', 60000, 50000, 0.17], ['t1', '小黑盒', 5, 'done', 60000, 50000, 0.83]]);
  assert.deepEqual(h.apps(), ['phone', '小黑盒'], 'the phone itself is a place');
  assert.deepEqual(h.end('s1'), [], 'a session with nothing open: nothing');
  // the same place again within the cooldown: logged, not reflected on; a run that broke off is worth it once the cooldown is over
  for (let i = 0; i < 6; i++) h.step('s2', '小黑盒', `${P}mobile_swipe_on_screen`, {}, { isError: true, error: 'boom' });
  assert.deepEqual(h.end('s2', { outcome: 'done' }), []);
  t += 2 * 3600000;
  for (let i = 0; i < 3; i++) h.step('s3', '小黑盒', `${P}mobile_swipe_on_screen`, {});
  assert.equal(h.end('s3', { outcome: 'timeout' }).length, 1, 'broke off');
  assert.equal(callLine(`${P}mobile_type_keys`, { text: '浮游世界' }), 'type_keys(浮游世界)');
  assert.equal(callLine('mcp__dot-vm__browser_navigate', { url: 'https://a.b/c' }), 'browser_navigate(（链接）)');
  assert.equal(fileOf('a/b c'), 'a_b_c.md');
  assert.equal(placeName('phone'), '这台手机（桌面、设置、通知栏、输入法、系统弹窗）');
  assert.equal(batchLaunch({ steps: [{ name: 'mobile_launch_app', arguments: { packageName: 'com.x' } }] }), 'com.x');
  assert.deepEqual(batchFailures('Step 3 (mobile_click) failed: nope\nStep 4 (x) ok'), ['nope']);
  assert.equal(errorType('Error: no element "这是一大段从屏幕上抄下来的帖子正文内容呢" at https://a.b/c\nmore'), 'Error: no element "…" at （链接）');
  assert.ok(isRefusal('dsh-interlude: 她自己的时间里，在 小黑盒 打字') && isRefusal('这一步要他本人来：验证码') && !isRefusal('element not found'));
});

test('howto: long runs are worth it only when clearly above the usual; notes once a thing, and only once there are some; tasks line up — done how often, in how many steps, at what cost', () => {
  const dir = dirOf();
  let t = Date.now();
  const h = createHowto({ dir, minSteps: 3, maxChars: 40, cooldownMs: 0, now: () => t });
  let n = 0;
  const run = (n_, outcome = 'done', tokens = 10000) => { const sid = `s${++n}`; for (let i = 0; i < n_; i++) h.step(sid, '小黑盒', `${P}mobile_swipe_on_screen`, {}); t += 1000; return h.end(sid, { thing: `t${n}`, outcome, ms: 1000, tokens }); };
  assert.equal(h.take('x', '小黑盒'), null, 'nothing learned yet');
  const [first] = run(10, 'done', 30000);
  assert.ok(first);
  assert.equal(h.keep('小黑盒', { notes: '## 教训\n详情页点图片会跳走 https://x.y/z ，要点标题。'.repeat(3), task: '搜游戏' }, first.id), true);
  assert.equal(h.notes('小黑盒').length, 40);
  assert.doesNotMatch(h.notes('小黑盒'), /https/);
  assert.equal(h.recent('小黑盒').find((r) => r.id === first.id).task, '搜游戏');
  assert.deepEqual(run(12), [], 'with notes, 12 is not above 1.5× the median (10)');
  const [third] = run(20, 'failed');
  h.keep('小黑盒', { notes: '## 教训\n- 搜索框要先点', task: '搜游戏' }, third.id);
  const [fourth] = run(19, 'done', 8000);
  h.keep('小黑盒', { notes: '## 教训\n- 搜索框要先点', task: '搜游戏' }, fourth.id);
  const swipes = Array(10).fill('swipe_on_screen()');
  assert.deepEqual(h.tasks('小黑盒'), [{ task: '搜游戏', runs: 3, done: 2, steps: [10, 19], tokens: [30000, 8000], route: swipes, walked: 1 }]);
  const got = h.take('s9', '小黑盒');
  assert.equal(got.notes, '## 教训\n- 搜索框要先点');
  assert.match(got.recent, /^「搜游戏」做成 2\/3 次，步数 10→19；/);
  assert.equal(h.take('s9', '小黑盒'), null, 'once a thing');
  h.keep('小黑盒', { notes: '新的' }, 'nope');
  assert.equal(h.take('s9', '小黑盒').notes, '新的', 'new notes are given again');
  const input = h.input({ app: '小黑盒', task: '搜浮游世界', outcome: 'done', steps: 3, errors: [], calls: ['a'], tokens: 5 });
  assert.equal(input.notesNow, '新的');
  assert.equal(input.thingWas, '搜浮游世界');
  assert.deepEqual(input.knownTasks, [{ task: '搜游戏', runs: 3, done: 2, steps: [10, 19], route: swipes, walked: 1 }]);
  assert.deepEqual(h.summary().map((p) => [p.app, p.notes, p.tasks.length]), [['小黑盒', true, 1]]);
});

test('howto: a call her own rules refused is marked, not an error; refusals alone are nothing to learn from', () => {
  const h = createHowto({ dir: dirOf(), minSteps: 3, cooldownMs: 0 });
  const { reason } = deny('这是写消息的输入框：在手机 QQ 里不发消息，给人发 QQ 用 qq_send。');
  const run = (n, refuse = false) => {
    if (refuse) h.step('s', 'QQ', `${P}mobile_type_keys`, { text: '在吗' }, { isError: true, error: `Error: ${reason}` });
    for (let i = 0; i < n; i++) h.step('s', 'QQ', `${P}mobile_click_on_screen_at_coordinates`, { x: 1, y: 2 });
    return h.end('s', { outcome: 'done' });
  };
  const [first] = run(9, true);
  assert.deepEqual(first.errors, [], 'the refusal is no error of the app');
  assert.equal(first.calls[0], 'type_keys(在吗) ⊘');
  assert.deepEqual(run(0, true), [], 'refusals alone are nothing to learn from');
});

test('howto: an old log\'s "worked" is read once as the outcome; notes from before refusals were told apart are read over once before they are given again', () => {
  const dir = dirOf();
  writeFileSync(join(dir, '_log.jsonl'), `${JSON.stringify({ id: 'a', at: 1, app: 'QQ', steps: 9, errors: 0, worked: true, task: '登录' })}\n${JSON.stringify({ id: 'b', at: 2, app: 'QQ', steps: 20, errors: 1, worked: false, task: '登录' })}\n${JSON.stringify({ id: 'c', at: 3, app: 'QQ', steps: 4, errors: 0 })}\n`);
  writeFileSync(join(dir, 'QQ.md'), '## 教训\n- 打字只能走 clipboard + 长按粘贴\n');
  const h = createHowto({ dir });
  assert.deepEqual(h.recent('QQ').map((r) => [r.id, r.outcome, 'worked' in r]), [['a', 'done', false], ['b', 'failed', false], ['c', undefined, false]]);
  assert.deepEqual(h.tasks('QQ'), [{ task: '登录', runs: 2, done: 1, steps: [9], tokens: [] }]);
  assert.ok(h.needsReview('QQ') && !h.needsReview('小黑盒'));
  assert.equal(h.take('s', 'QQ'), null, 'not given as they are');
  assert.deepEqual(Object.keys(h.input({ review: true, app: 'QQ' })), ['place', 'notesNow', 'limits']);
  h.keep('QQ', { notes: '## 教训\n\n## 捷径' });
  assert.ok(!h.needsReview('QQ'));
  assert.equal(h.take('s', 'QQ').notes, '## 教训\n\n## 捷径');
  assert.ok(!createHowto({ dir }).needsReview('QQ'), 'remembered (_meta.json)');
  const fresh = dirOf();
  const f = createHowto({ dir: fresh });
  f.keep('QQ', { notes: '新记的' });
  assert.ok(existsSync(join(fresh, '_meta.json')) && !createHowto({ dir: fresh }).needsReview('QQ'), 'a new folder has nothing to read over');
});

test('howto: a done run keeps its way (words typed left out); the shortest way of a task is its shortcut, with how often it was walked; the hands\' name for a thing is kept', () => {
  let t = Date.now();
  const h = createHowto({ dir: dirOf(), minSteps: 99, cooldownMs: 0, now: () => t });
  let n = 0;
  const run = (taps, { outcome = 'done', name = '看消息', fail = false } = {}) => {
    const sid = `r${++n}`;
    h.step(sid, 'QQ', `${P}mobile_launch_app`, { packageName: 'com.tencent.mobileqq' });
    for (const [x, y] of taps) h.step(sid, 'QQ', `${P}mobile_click_on_screen_at_coordinates`, { x, y });
    h.step(sid, 'QQ', `${P}mobile_type_keys`, { text: '验证码 123456' });
    if (fail) h.step(sid, 'QQ', `${P}mobile_click_on_screen_at_coordinates`, { x: 9, y: 9 }, { isError: true, error: 'Error: element not found' });
    t += 1000;
    return h.end(sid, { thing: `t${n}`, name, outcome });
  };
  run([[100, 200], [300, 400], [500, 600]]);
  run([[102, 198], [301, 405]], { fail: true });   // shorter, a failed step is not part of the way
  run([[99, 201], [305, 399]]);
  run([[100, 200]], { outcome: 'failed' });           // not done: no way kept
  const [task] = h.tasks('QQ');
  assert.equal(task.task, '看消息');
  assert.deepEqual(task.route, ['launch_app(com.tencent.mobileqq)', 'click_on_screen_at_coordinates(102,198)', 'click_on_screen_at_coordinates(301,405)', 'type_keys(…)']);
  assert.equal(task.walked, 2, 'taps a little off are the same way');
  assert.equal(task.runs, 4);
  assert.ok(!JSON.stringify(h.recent('QQ', 10)).includes('123456'), 'words typed are not kept');
  const last = h.recent('QQ', 1)[0];
  h.keep('QQ', { notes: '## 教训\n- x', task: '别的名' }, last.id);
  assert.equal(h.recent('QQ', 1)[0].task, '看消息', 'the hands named it: a reflection does not rename it');
  assert.match(h.take('s', 'QQ').recent, /捷径（这样走成过 2 次）：launch_app\(com\.tencent\.mobileqq\) → /);
});

test('nightcheck: a lesson is worth the records behind it — a guess is reworded to what was seen or dropped, a contradicted one is dropped against the run that contradicts it, a shortcut needs a way on record; the runs named must exist', async () => {
  const { settle, linesOf, checkInput, report } = await import('../src/dot/nightcheck.js');
  const notes = '## 教训\n- 这台是模拟器，短信发得出去但收不到运营商回信\n- 收起通知栏用小的滑动距离会报 Command failed，换成 up,540,2200 就成\n- 搜索框点不开\n- 没人判的一条\n\n## 捷径\n- 发短信查流量：list_available_devices()\n- 看电量：press_button(HOME) → swipe_on_screen(down,540,20)';
  const records = [{ id: 'a1', outcome: 'done', steps: 39 }, { id: 'a2', outcome: 'done', steps: 5, calls: ['swipe_on_screen(up,540,600) ✗ Command failed', 'swipe_on_screen(up,540,2200)'] }, { id: 'a3', outcome: 'done', steps: 4 }];
  assert.deepEqual(checkInput({ place: 'p', notes, records }).lessons.map((l) => l.n), [1, 2, 3, 4]);
  assert.equal(linesOf(notes)[7].kind, 'shortcut');
  const r = settle({ notes, records, tasks: [{ task: '看电量', route: ['press_button(HOME)'] }, { task: '发短信查流量' }], judged: [
    { n: 1, is: 'guess', text: '发出短信后等了三分钟没有回信', runs: ['a1'], why: '记录里只有没回' },
    { n: 2, is: 'seen', runs: ['a2', 'zz'] },
    { n: 3, is: 'stale', runs: ['nope'] },   // names no run that is on record: not dropped
  ] });
  assert.deepEqual(r.ops.map((o) => [o.n, o.op, o.is, o.runs]), [[1, 'reword', 'guess', ['a1']], [3, 'keep', 'unsupported', []], [4, 'keep', 'unjudged', []], [7, 'drop', 'no-route', []]]);
  assert.equal(r.notes, '## 教训\n- 发出短信后等了三分钟没有回信\n- 收起通知栏用小的滑动距离会报 Command failed，换成 up,540,2200 就成\n- 搜索框点不开\n- 没人判的一条\n\n## 捷径\n- 看电量：press_button(HOME) → swipe_on_screen(down,540,20)');
  assert.equal(r.changed, true);
  assert.match(report('手机', r), /改写（是推测，记录 a1）：这台是模拟器[\s\S]*→ 发出短信后等了三分钟没有回信[\s\S]*去掉（没有走成过的记录）：发短信查流量/);
  // a guess with nothing left of it goes; a stale one goes against the run named; nothing judged, nothing changed
  const g = settle({ notes: '- 多半是网不好\n- 点图片会跳走', records, judged: [{ n: 0, is: 'guess' }, { n: 1, is: 'stale', runs: ['a3'] }] });
  assert.equal(g.notes, ''); assert.deepEqual(g.ops.map((o) => o.op), ['drop', 'drop']);
  assert.equal(settle({ notes: '- 一条', records, judged: [{ n: 0, is: 'seen', runs: ['a1'] }] }).changed, false);
});

test('howto: a thing is known where most of it happened; a run the notes are written from keeps its steps, without the words typed', () => {
  const h = createHowto({ dir: dirOf(), minSteps: 3, cooldownMs: 0 });
  h.step('s', 'phone', `${P}mobile_list_available_devices`, {});
  for (let i = 0; i < 5; i++) h.step('s', '信息', `${P}mobile_click_on_screen_at_coordinates`, { x: i, y: 1 });
  h.step('s', '信息', `${P}mobile_type_keys`, { text: '密码 778899' }, { isError: true, error: 'Error: no focus' });
  h.end('s', { thing: 't1', name: '发短信', outcome: 'done' });
  assert.deepEqual(h.tasks('phone'), [], 'one step on the way through is not how it is done there');
  assert.equal(h.tasks('信息')[0].task, '发短信');
  const [rec] = h.records('信息');
  assert.equal(rec.calls.length, 6); assert.match(rec.calls.at(-1), /type_keys\(…\) ✗ Error: no focus/);
  assert.ok(!JSON.stringify(h.records('信息')).includes('778899'));
  h.amend('信息', '## 教训\n- 一条'); assert.equal(h.notes('信息'), '## 教训\n- 一条');
});
