// dsh-dot/ledger: the book of things. Only code writes it; a thing is ended once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, headTail, factsOf } from '../src/dot/ledger.js';

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
  assert.equal(book.end(a, { outcome: 'done', summary: '存了五张', detail: '在相册 dot-stickers 里' }).outcome, 'done');
  book.end(a, { outcome: 'failed', cause: 'broke-off' });
  const e = book.get(a);
  assert.deepEqual([e.state, e.outcome, e.by, e.summary, e.detail, e.steps, e.tokens, e.startedAt, e.endedAt, e.session, e.cause], ['ended', 'done', 'code', '存了五张', '在相册 dot-stickers 里', 4, { in: 10, cached: 100, out: 5 }, 2000, 9000, 'h1', undefined]);
  book.note(a, { shot: '/x/t1.png', told: 9500 });
  assert.deepEqual(book.recent(1)[0].id, 't2');
  assert.deepEqual(book.unfinished().map((x) => x.id), ['t2']);
  e.outcome = 'x'; assert.equal(book.get(a).outcome, 'done', 'what is handed out is a copy');
  // kept across a restart: what was not over is ended by it, and told once
  const again = createLedger({ store, now: () => 20000 });
  assert.deepEqual(again.interrupted().map((x) => [x.id, x.outcome, x.by, x.cause]), [['t2', 'failed', 'code', 'restart']]);
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

test('ledger: an entry from before it kept facts only is read once as fields — who stopped it, why, what came of it', () => {
  assert.deepEqual(factsOf({ id: 't1', outcome: 'stopped', why: '他叫停了', result: '翻到第三页' }), { id: 't1', outcome: 'stopped', cause: 'stopped', by: 'him', detail: '翻到第三页' });
  assert.deepEqual(factsOf({ id: 't2', outcome: 'failed', why: 'broke off: 400 bad request' }), { id: 't2', outcome: 'failed', cause: 'broke-off', error: '400 bad request' });
  assert.deepEqual(factsOf({ id: 't3', outcome: 'timeout', why: 'took too long' }), { id: 't3', outcome: 'timeout', cause: 'timeout' });
  assert.deepEqual(factsOf({ id: 't4', outcome: 'done', result: '存好了' }), { id: 't4', outcome: 'done', detail: '存好了' });
  const kv = new Map([['things', [{ id: 't5', state: 'ended', outcome: 'stopped', why: '她叫停了', result: 'x' }]]]);
  const book = createLedger({ store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) } });
  assert.deepEqual([book.get('t5').by, book.get('t5').detail, 'why' in kv.get('things')[0]], ['her', 'x', false], 'written back as fields');
});

test('what is still owed is never cut for room nor aged out: a thing under way, an end of his not told, an answer owed — the history keeps the newest only', async () => {
  const { createLedger } = await import('../src/dot/ledger.js');
  let t = 1_000_000;
  const kv = new Map([['thingsOwedSince', 1]]);
  const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) };
  const L = createLedger({ store, keep: 100, now: () => t });
  const long = L.open({ asker: 'him', task: '长任务' }); L.begin(long);
  const his = L.open({ asker: 'him', task: '他要的' }); L.begin(his); L.end(his, { outcome: 'done', summary: '做完了' });
  const asked = L.open({ asker: 'her', task: '发消息' }); L.begin(asked); L.end(asked, { outcome: 'done' }); L.note(asked, { awaiting: { from: '小明', since: t, until: t + 3 * 86400000 } });
  for (let i = 0; i < 100; i++) { const id = L.open({ task: `t${i}` }); L.begin(id); L.end(id, { outcome: 'done' }); t += 60_000; }
  t += 86400000; // a day later
  assert.ok(L.get(long), 'under way'); assert.ok(L.get(his), 'his end, not told'); assert.ok(L.get(asked), 'an answer owed');
  assert.deepEqual(L.owed().map((e) => e.id), [long, his, asked]);
  assert.equal(L.recent(1000).length, 103);
  L.note(his, { told: t }); L.end(long, { outcome: 'done' }); L.note(long, { told: t }); L.note(asked, { awaiting: { from: '小明', since: 0, until: 0, answeredAt: t } });
  assert.deepEqual(L.owed(), []);
  assert.equal(L.recent(1000).length, 100, 'settled: they go with the history');
});

test('a book from before owed things were kept apart: what ended more than an hour ago is closed as it stood, not brought back as owed', async () => {
  const { createLedger } = await import('../src/dot/ledger.js');
  const now = 10 * 86400000;
  const kv = new Map([['things', [
    { id: 't1', asker: 'him', task: '旧的', state: 'ended', outcome: 'stopped', by: 'her', endedAt: now - 5 * 86400000, steps: 0, tokens: { in: 0, cached: 0, out: 0 } },
    { id: 't2', asker: 'him', task: '刚才的', state: 'ended', outcome: 'done', endedAt: now - 60_000, steps: 0, tokens: { in: 0, cached: 0, out: 0 } },
  ]]]);
  const L = createLedger({ store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) }, now: () => now });
  assert.deepEqual(L.owed().map((e) => e.id), ['t2']);
  assert.equal(L.get('t1').closed.why, 'before');
  assert.ok(kv.get('thingsOwedSince'));
});

test('an answer is tied to the thing waiting on that name in that app; two things waiting on the same name are not guessed between', async () => {
  const { createThings } = await import('../src/dot/things.js');
  const t = Date.now();
  const L = createLedger({ store: mem(new Map([['thingsOwedSince', 1]])) });
  const mk = (task, from, app) => { const id = L.open({ asker: 'him', task }); L.begin(id); L.end(id, { outcome: 'done' }); L.note(id, { told: t, awaiting: { from, since: t, until: t + 86400000, ...(app ? { app } : {}) } }); return id; };
  const audit = [];
  const things = createThings({ audit: (e, d) => audit.push([e, d]), ledger: L, consent: { asking: () => [] } });
  const sms = mk('给 10086 发短信', '10086', 'com.google.android.apps.messaging');
  assert.equal(things.answerTo({ name: '10086', pkg: 'com.tencent.mobileqq', text: 'x' }), null, 'the same name in another app');
  assert.equal(things.answerTo({ name: '10086', pkg: 'com.google.android.apps.messaging', text: '余额 3 元' }).id, sms);
  const a = mk('问小明周六来不来', '小明', 'com.tencent.mobileqq'), b = mk('问小明借书', '小明', 'com.tencent.mobileqq');
  const r = things.answerTo({ name: '小明', pkg: 'qq', text: '来' });
  assert.deepEqual(r.maybe.map((e) => e.id), [a, b], 'her QQ and the phone\'s QQ are the same people; two waiting: neither is taken');
  assert.equal(L.get(a).awaiting.answeredAt, undefined); assert.equal(L.get(b).awaiting.answeredAt, undefined);
});
