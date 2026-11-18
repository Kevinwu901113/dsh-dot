// dsh-dot/hands: one round at a time, ended by the hands' turn, by time, or by him speaking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHands } from '../src/dot/hands.js';

function harness(opts = {}) {
  const listeners = new Set(), sent = [], cancelled = [], kv = new Map(), audits = [];
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
    tokensOf: () => tokens, audit: (event, data) => audits.push({ event, ...data }), ...opts,
  });
  const emit = (id, type, data) => { for (const fn of [...listeners]) fn({ id }, { type, data }); };
  return { hands, sent, cancelled, emit, audits, kv, dir, setTokens: (t) => { tokens = t; }, listeners };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('hands: a round ends with the hands\' turn and brings back what they said last; the session is kept for the next round', async () => {
  const h = harness({ maxChars: 12 });
  const p = h.hands.run({ device: 'phone', task: '打开贴吧，说说首页有什么' });
  await tick();
  assert.deepEqual(h.sent, [['h1', '打开贴吧，说说首页有什么']]);
  assert.ok(h.hands.busy() && h.hands.isHands('h1') && h.hands.isHands('', join(h.dir, 'x')) && !h.hands.isHands('s1', '/home/her'));
  h.emit('other', 'turn/end');
  h.emit('h1', 'tool/call'); h.emit('h1', 'tool/call');
  h.emit('h1', 'assistant/message', { message: { content: '我看看' } });
  h.emit('h1', 'assistant/message', { message: { content: '首页有三个帖子：第一个讲显卡，第二个讲猫' } });
  h.emit('h1', 'turn/end');
  const r = await p;
  assert.deepEqual([r.status, r.steps, r.text], ['done', 2, '首页有三个帖子：第一个讲…']);
  assert.equal(h.listeners.size, 0);
  const q = h.hands.run({ device: 'phone', task: '点开第一个' });
  await tick(); h.emit('h1', 'turn/end');
  assert.equal((await q).status, 'done');
  assert.equal(h.sent[1][0], 'h1', 'the same hands');
  assert.equal(h.kv.get('handsSession'), 'h1');
});

test('hands: cut when he speaks or it takes too long (the turn is cancelled, what was said so far comes back); one round at a time; a large session is replaced', async () => {
  const h = harness({ maxMs: 30 });
  const a = h.hands.run({ task: '登录' }), b = h.hands.run({ task: '第二件' });
  await tick();
  assert.equal(h.sent.length, 1, 'the second waits for the first');
  h.emit('h1', 'assistant/message', { message: { content: '停在验证码' } });
  h.hands.interrupt('he spoke');
  assert.deepEqual(await a, { status: 'cut', text: '停在验证码', steps: 0, ms: (await a).ms, why: 'he spoke' });
  assert.deepEqual(h.cancelled[0], ['h1', 'dot-hands: he spoke']);
  await tick();
  assert.equal(h.sent.length, 2);
  await tick(60);
  const rb = await b;
  assert.deepEqual([rb.status, rb.why], ['cut', 'took too long']);
  h.setTokens(999999);
  const c = h.hands.run({ task: '第三件' });
  await tick(); h.emit('h2', 'turn/end');
  assert.equal((await c).status, 'done');
  assert.ok(h.hands.isHands('h1') && h.hands.isHands('h2'), 'the old one is still her hands');
  assert.ok(h.audits.some((e) => e.event === 'hands-rotated'));
  assert.equal((await h.hands.run({ task: '' })).status, 'failed');
});
