// dsh-dot/hands: a round is started and not waited for; its end is told through onDone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHands } from '../src/dot/hands.js';

function harness(opts = {}) {
  const listeners = new Set(), sent = [], cancelled = [], kv = new Map(), audits = [], done = [];
  let n = 0, tokens = 0;
  const agents = new Map();
  const dir = join(mkdtempSync(join(tmpdir(), 'hands-')), 'hands');
  const hands = createHands({
    dir,
    create: async () => { const id = `h${++n}`; agents.set(id, { followup: (m) => sent.push([id, m]), cancel: (c) => cancelled.push([id, c.reason]) }); return id; },
    agentFor: async (id) => agents.get(id) ?? null,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    message: (text) => text, textOf: (c) => c,
    store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) },
    onDone: (r, j) => done.push([r, j]),
    tokensOf: () => tokens, audit: (event, data) => audits.push({ event, ...data }), ...opts,
  });
  const emit = (id, type, data) => { for (const fn of [...listeners]) fn({ id }, { type, data }); };
  return { hands, sent, cancelled, emit, audits, kv, dir, done, setTokens: (t) => { tokens = t; }, listeners };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('hands: a round starts at once and is not waited for; its end brings what the hands said last, with what the round was', async () => {
  const h = harness({ maxChars: 12 });
  assert.deepEqual(h.hands.start({ device: 'phone', task: '打开贴吧，说说首页有什么', forHim: true }), { status: 'started' });
  await tick();
  assert.deepEqual(h.sent, [['h1', '打开贴吧，说说首页有什么']]);
  assert.ok(h.hands.busy() && h.hands.isHands('h1') && h.hands.isHands('', join(h.dir, 'x')) && !h.hands.isHands('s1', '/home/her'));
  h.emit('h1', 'tool/call'); h.emit('h1', 'tool/call');
  h.emit('h1', 'tool/result', { message: { content: '显卡又涨价了，纯纯坐牢' } }); h.emit('h1', 'tool/result', { message: { content: [{ text: '猫把杯子推下去了' }] } });
  h.emit('h1', 'assistant/message', { message: { content: '我先看看' } });
  assert.deepEqual([h.hands.doing().task, h.hands.doing().said, h.hands.doing().steps], ['打开贴吧，说说首页有什么', '我先看看', 2]);
  // one pair of hands: a second round is not started
  const busy = h.hands.start({ device: 'phone', task: '再做一件' });
  assert.equal(busy.status, 'busy'); assert.equal(busy.doing.task, '打开贴吧，说说首页有什么');
  h.emit('h1', 'assistant/message', { message: { content: '首页有三个帖子：第一个讲显卡，第二个讲猫' } });
  assert.equal(h.done.length, 0);
  h.emit('h1', 'turn/end');
  const [r, j] = h.done[0];
  assert.deepEqual([r.status, r.steps, r.text], ['done', 2, '首页有三个帖子：第一个讲…']);
  assert.match(r.shown, /纯纯坐牢[\s\S]*猫把杯子推下去了/, 'what the screen showed them, in full: what a line she keeps is checked against');
  assert.deepEqual(j, { device: 'phone', task: '打开贴吧，说说首页有什么', forHim: true });
  assert.ok(!h.hands.busy() && h.hands.doing() === null && h.listeners.size === 0);
  assert.equal(h.hands.start({ device: 'phone', task: '点开第一个' }).status, 'started');
  await tick(); h.emit('h1', 'turn/end');
  assert.equal(h.sent[1][0], 'h1', 'the same hands');
  assert.equal(h.done.length, 2);
});

test('hands: stopped by her, or cut for taking too long (the turn is cancelled, what was said so far comes back); a large session is replaced', async () => {
  const h = harness({ maxMs: 30 });
  h.hands.start({ task: '登录' });
  await tick();
  h.emit('h1', 'assistant/message', { message: { content: '停在验证码' } });
  assert.equal(h.hands.stop('她叫停了'), true);
  assert.deepEqual([h.done[0][0].status, h.done[0][0].text, h.done[0][0].why], ['cut', '停在验证码', '她叫停了']);
  assert.deepEqual(h.cancelled[0], ['h1', 'dot-hands: 她叫停了']);
  assert.equal(h.hands.stop(), false, 'nothing under way');
  h.hands.start({ task: '第二件' });
  await tick(60);
  assert.deepEqual([h.done[1][0].status, h.done[1][0].why], ['cut', 'took too long']);
  h.setTokens(999999);
  h.hands.start({ task: '第三件' });
  await tick(); h.emit('h2', 'turn/end');
  assert.equal(h.done[2][0].status, 'done');
  assert.ok(h.hands.isHands('h1') && h.hands.isHands('h2'), 'the old one is still her hands');
  assert.ok(h.audits.some((e) => e.event === 'hands-rotated'));
  assert.equal(h.hands.start({ task: '' }).status, 'failed');
});

test('hands: what they type is hers or was shown to them — never their own words', async () => {
  const { ownWords } = await import('../src/dot/core.js');
  const h = harness();
  assert.equal(h.hands.has('随便'), false, 'no round: nothing was given');
  h.hands.start({ device: 'phone', task: '在这条帖子下面评论「笑死 这也行」，然后搜 瓦罗兰特' });
  await tick();
  assert.ok(h.hands.has('笑死 这也行') && h.hands.has('笑死这也行') && h.hands.has('瓦罗兰特'), 'her words, whitespace aside');
  assert.equal(h.hands.has('哈哈确实，我也这么觉得'), false);
  h.emit('h1', 'tool/result', { message: { content: '登录名 15625040795 密码 Abc-123456' } });
  assert.ok(h.hands.has('15625040795') && h.hands.has('Abc-123456'), 'what a tool showed them (an account, the screen)');
  const has = h.hands.has;
  assert.deepEqual(ownWords('笑死 这也行', has), []);
  assert.deepEqual(ownWords('tieba.baidu.com', has), [], 'an address is not words');
  assert.deepEqual(ownWords('https://www.bilibili.com/v/popular', has), []);
  assert.deepEqual(ownWords('笑死 这也行\n哈哈确实', has), ['哈哈确实']);
  h.emit('h1', 'turn/end');
});
