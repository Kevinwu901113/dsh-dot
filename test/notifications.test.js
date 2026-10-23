import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShade, createShadeWatch, createPolicy, SYSTEM_PKG } from '../src/phone/notifications.js';
import { shade, record, SYSTEM, QQ_KUAN, QQ_GROUP } from './fixtures/shade.js';

test('parseShade: records with title/text in the API 35 layout; bigText fallback; archive ignored', () => {
  const n = parseShade(shade([SYSTEM, QQ_KUAN('hi'), QQ_GROUP], [QQ_KUAN('old')]));
  assert.deepEqual(n.map((x) => [x.key, x.pkg, x.title, x.text]), [
    ['0|android|19|null|1000', 'android', 'qwerty2 configured', 'Keyboard layout set to English (US). Tap to change.'],
    ['0|com.tencent.mobileqq|1|null|10171', 'com.tencent.mobileqq', '宽', 'hi'],
    ['0|com.tencent.mobileqq|3|null|10171', 'com.tencent.mobileqq', '群聊', '有人@你'],
  ]);
  assert.deepEqual(parseShade(''), []);
  assert.ok(SYSTEM_PKG.test('com.google.android.apps.wellbeing') && !SYSTEM_PKG.test('com.tencent.mobileqq'));
});

function watch({ dumps, pollMs = 0, policy = createPolicy() }) {
  const changes = [];
  let events = null;
  const w = createShadeWatch({
    readShade: async () => dumps.current,
    tailEvents: (onEvent) => { events = onEvent; return () => { events = null; }; },
    pollMs, wanted: (n) => policy.wanted(n), onChange: (k, n) => changes.push([k, n.pkg, n.text]), settleMs: 5,
  });
  return { w, changes, fire: () => events?.(), tailing: () => Boolean(events) };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('shade watch: the first snapshot is not news; an event triggers a read; posted / updated / removed; system apps skipped', async () => {
  const dumps = { current: shade([SYSTEM, QQ_KUAN('嘿嘿')]) };
  const { w, changes, fire, tailing } = watch({ dumps });
  w.start();
  await tick();
  assert.deepEqual(changes, [], 'what was on the shade at start is not announced');
  assert.ok(tailing(), 'the events tail starts after the first snapshot');
  assert.equal(w.known().length, 2);
  // QQ rewrites the same notification as a second message arrives
  dumps.current = shade([SYSTEM, QQ_KUAN('在吗[2条]嘿嘿')]);
  fire(); await tick();
  assert.deepEqual(changes, [['updated', 'com.tencent.mobileqq', '在吗[2条]嘿嘿']]);
  // a new conversation and a system notification post together; only the app one counts
  dumps.current = shade([SYSTEM, QQ_KUAN('在吗[2条]嘿嘿'), QQ_GROUP, record({ pkg: 'android', id: 55, uid: 1000, title: 'Serial console enabled', text: 'Performance is impacted.' })]);
  fire(); fire(); fire(); await tick();
  assert.deepEqual(changes.slice(1), [['posted', 'com.tencent.mobileqq', '有人@你']], 'a burst of events collapses into one read');
  // she read the chat: QQ cancels it
  dumps.current = shade([SYSTEM, QQ_GROUP]);
  fire(); await tick();
  assert.deepEqual(changes.at(-1), ['removed', 'com.tencent.mobileqq', '在吗[2条]嘿嘿']);
  w.stop();
  assert.ok(!tailing());
  dumps.current = shade([SYSTEM, QQ_KUAN('after stop')]);
  fire(); await tick();
  assert.equal(changes.length, 3, 'nothing after stop');
});

test('shade watch: polling alone also catches changes; one read at a time', async () => {
  const dumps = { current: shade([QQ_KUAN('a')]) };
  let reads = 0;
  const changes = [];
  const w = createShadeWatch({ readShade: async () => { reads++; await tick(20); return dumps.current; }, pollMs: 15, wanted: () => true, onChange: (k, n) => changes.push([k, n.text]) });
  w.start();
  await tick(60);
  dumps.current = shade([QQ_KUAN('b')]);
  await tick(120);
  w.stop();
  assert.deepEqual(changes, [['updated', 'b']]);
  assert.ok(reads >= 2 && reads < 12, `reads serialize (${reads})`);
});

test('policy: every non-system app unless muted; `only` narrows; apps seen are counted', () => {
  const p = createPolicy();
  assert.ok(p.wanted({ pkg: 'com.tencent.mobileqq' }));
  assert.ok(p.wanted({ pkg: 'com.brand.new.app' }), 'an app installed later counts without registration');
  assert.ok(!p.wanted({ pkg: 'com.google.android.gms' }));
  p.set('com.tencent.mobileqq', 'mute');
  assert.ok(!p.wanted({ pkg: 'com.tencent.mobileqq' }));
  p.set('com.tencent.mobileqq', 'wake');
  assert.ok(p.wanted({ pkg: 'com.tencent.mobileqq' }));
  assert.deepEqual(p.apps().map((a) => a.pkg).sort(), ['com.brand.new.app', 'com.tencent.mobileqq']);
  const only = createPolicy({ only: ['com.tencent.mm'], muted: ['com.x'] });
  assert.ok(!only.wanted({ pkg: 'com.tencent.mobileqq' }) && only.wanted({ pkg: 'com.tencent.mm' }) && !only.wanted({ pkg: 'com.x' }));
  assert.deepEqual(only.muted(), ['com.x']);
});
