// dsh-dot/ledger: the book of things. Only code writes it; a thing is ended once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, headTail } from '../src/dot/ledger.js';

const mem = (kv = new Map()) => ({ get: (k) => kv.get(k), set: (k, v) => kv.set(k, structuredClone(v)), kv });

test('ledger: a thing is opened, begun, counted and ended once; how it ended does not change', () => {
  let t = 1000;
  const store = mem();
  const book = createLedger({ store, now: () => t });
  const a = book.open({ asker: 'him', device: 'phone', task: '去小黑盒找五个表情包' });
  const b = book.open({ device: 'web', task: '查天气' });
  assert.deepEqual([a, b], ['t1', 't2']);
  assert.deepEqual(book.unfinished().map((e) => [e.id, e.state, e.asker]), [['t1', 'queued', 'him'], ['t2', 'queued', 'her']]);
  t = 2000; book.begin(a, { session: 'h1' });
  book.count(a, { steps: 3, tokens: { in: 10, cached: 100, out: 5 } }); book.count(a, { steps: 1 });
  t = 9000;
  assert.equal(book.end(a, { outcome: 'done', result: '存了五张' }).outcome, 'done');
  book.end(a, { outcome: 'failed', why: 'late' });
  const e = book.get(a);
  assert.deepEqual([e.state, e.outcome, e.result, e.steps, e.tokens, e.startedAt, e.endedAt, e.session, e.why], ['ended', 'done', '存了五张', 4, { in: 10, cached: 100, out: 5 }, 2000, 9000, 'h1', undefined]);
  book.note(a, { shot: '/x/t1.png', told: 9500 });
  assert.deepEqual(book.recent(1)[0].id, 't2');
  assert.deepEqual(book.unfinished().map((x) => x.id), ['t2']);
  e.outcome = 'x'; assert.equal(book.get(a).outcome, 'done', 'what is handed out is a copy');
  // kept across a restart: what was not over is ended by it, and told once
  const again = createLedger({ store, now: () => 20000 });
  assert.deepEqual(again.interrupted().map((x) => [x.id, x.outcome, x.why]), [['t2', 'failed', 'restart']]);
  assert.deepEqual(again.interrupted(), []);
  assert.equal(again.open({ task: '下一件' }), 't3', 'ids go on');
  assert.equal(again.get('t1').shot, '/x/t1.png');
  again.clear(); assert.deepEqual(again.recent(), []);
});

test('ledger: only the newest are kept; a long result keeps its head and its tail', () => {
  const book = createLedger({ store: mem(), keep: 3 });
  for (let i = 0; i < 5; i++) book.end(book.open({ task: `第${i}件` }), { outcome: 'done' });
  assert.deepEqual(book.recent(10).map((e) => e.task), ['第4件', '第3件', '第2件']);
  assert.equal(headTail('短的', 10), '短的');
  const long = `${'头'.repeat(50)}${'中'.repeat(100)}${'尾'.repeat(50)}`;
  const cut = headTail(long, 30);
  assert.ok(cut.startsWith('头'.repeat(20)) && cut.endsWith('尾'.repeat(10)) && /中间略去 170 字/.test(cut));
});

test('cut: a text is never cut in the middle of a character', async () => {
  const { head, tail } = await import('../src/cut.js');
  const s = '真废啊🤣好';
  assert.equal(head(s, 4), '真废啊', 'half an emoji is dropped, not sent');
  assert.equal(head(s, 5), '真废啊🤣');
  assert.equal(tail(s, 2), '好');
  assert.equal(tail(s, 3), '🤣好');
  assert.ok(headTail(`${'头'.repeat(19)}🤣${'中'.repeat(50)}🤣${'尾'.repeat(9)}`, 30).isWellFormed());
  const { screenLines } = await import('../src/phone/typing.js');
  assert.ok(screenLines([{ words: `${'字'.repeat(59)}🤣后面`, x: 1, y: 200 }]).isWellFormed());
});
