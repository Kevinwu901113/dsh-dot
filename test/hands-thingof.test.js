// dsh-dot/hands: what is under way is found by the hands' session it is done in, or by its id — not as "the" thing.
// What the code keeps on a thing (keptOf) goes with it; a thing that waited its turn begins with its own state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHands } from '../src/dot/hands.js';
import { createLedger } from '../src/dot/ledger.js';

function harness(opts = {}) {
  const listeners = new Set(), sent = [], cancelled = [], kv = new Map(), done = [];
  let n = 0;
  const agents = new Map();
  const dir = join(mkdtempSync(join(tmpdir(), 'hands-')), 'hands');
  const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) };
  const ledger = createLedger({ store });
  const hands = createHands({
    dir, ledger,
    create: async () => { const id = `h${++n}`; agents.set(id, { followup: (m) => sent.push([id, m]), cancel: (c) => cancelled.push([id, c.reason]) }); return id; },
    agentFor: async (id) => agents.get(id) ?? null,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    message: (text) => text, textOf: (c) => c,
    store, done: () => 'MISSING',
    onDone: (r, j) => done.push([r, j]), ...opts,
  });
  const emit = (id, type, data) => { for (const fn of [...listeners]) fn({ id }, { type, data }); };
  return { hands, ledger, sent, emit, done };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('hands, by session: thingOf finds the thing done in that session, thingById by its id, things lists what is under way', async () => {
  const h = harness();
  assert.deepEqual([h.hands.thingOf('h1'), h.hands.thingById('t1'), h.hands.things()], [null, null, []], 'nothing under way');
  h.hands.start({ device: 'phone', task: '打开相册', forHim: true });
  // under way at once, its session a moment later: by id it is there, by a session not yet
  assert.equal(h.hands.thingById('t1').task, '打开相册');
  assert.equal(h.hands.thingOf('h1'), null);
  await tick();
  assert.deepEqual(h.hands.thingOf('h1'), h.hands.doing(), 'the same view as doing()');
  assert.deepEqual([h.hands.thingOf('h1').id, h.hands.thingOf('h1').session, h.hands.thingOf('h1').forHim], ['t1', 'h1', true]);
  assert.deepEqual(h.hands.thingById('t1'), h.hands.thingOf('h1'));
  assert.deepEqual(h.hands.things().map((t) => [t.id, t.session]), [['t1', 'h1']]);
  assert.equal(h.hands.thingOf('h2'), null, 'another session has nothing under way');
  assert.equal(h.hands.thingOf(undefined), null);
  // a second waits its turn: not under way, so not found by its id
  assert.equal(h.hands.start({ device: 'computer', task: '再做一件' }).status, 'queued');
  assert.equal(h.hands.thingById('t2'), null);
  assert.equal(h.hands.things().length, 1);
  h.hands.finish({ summary: '开了' }, { session: 'h1' });
  await tick();
  // the session of a thing that is over is still hers (isHands), but nothing is under way in it
  assert.ok(h.hands.isHands('h1'));
  assert.equal(h.hands.thingOf('h1'), null);
  assert.equal(h.hands.thingById('t1'), null);
  assert.deepEqual([h.hands.thingOf('h2')?.id, h.hands.thingById('t2')?.session], ['t2', 'h2']);
});

test('hands, by session: a call that names a session acts on that session\'s thing only — a late one from a session that is over acts on nothing', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '第一件' }); await tick();
  h.hands.start({ device: 'phone', task: '第二件 喝咖啡的猫' });
  h.hands.finish({ summary: '好了' }, { session: 'h1' }); await tick();
  assert.equal(h.hands.thingOf('h2').id, 't2');
  const late = { session: 'h1' }, mine = { session: 'h2' };
  assert.equal(h.hands.ask('还要吗？', {}, late), false);
  assert.equal(h.hands.asked(mine), false);
  assert.equal(h.hands.thingOf('h2').question, '', 'its question is its own');
  assert.equal(h.hands.has('喝咖啡的猫', late), false);
  assert.equal(h.hands.has('喝咖啡的猫', mine), true);
  h.hands.note('own-words', late);
  assert.deepEqual(h.hands.add('再存一张', late), { status: 'idle' });
  assert.equal(h.hands.fail({ cause: 'same-error', error: 'x' }, late), false);
  assert.equal(h.hands.finish({ summary: '假的' }, late), false);
  assert.ok(h.hands.busy() && h.hands.thingOf('h2'), 'still under way');
  // by its id, the same
  assert.deepEqual(h.hands.add('再存一张', { thing: 't2' }), { status: 'added', id: 't2' });
  assert.ok(h.hands.has('再存一张', { thing: 't2' }));
  assert.equal(h.hands.ask('存哪张？', {}, { thing: 't2' }), true);
  assert.equal(h.hands.asked({ session: 'h2' }), true);
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } });
  const [r] = h.done.at(-1);
  assert.deepEqual([r.outcome, r.question, r.notes], ['stuck', '存哪张？', []], 'the late note did not land on it');
});

test('hands, kept on the thing: what the code keeps on one thing does not reach the next; a thing that waited begins with its own state', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '第一件' }); await tick();
  const k1 = h.hands.keptOf('t1');
  assert.deepEqual(k1, {}, 'made with the thing');
  k1.actedAt = 123; k1.errorRun = { type: 'timeout', n: 2 }; k1.reached = true;
  assert.equal(h.hands.keptOf('t1'), k1, 'the same object while it is under way');
  h.emit('h1', 'tool/call'); h.emit('h1', 'tool/result', { message: { content: '屏幕上的字 甲乙丙' } });
  h.hands.note('reply-check', { session: 'h1' });
  h.hands.ask('选哪个？', {}, { session: 'h1' });
  // the second waits behind it
  assert.equal(h.hands.start({ device: 'phone', task: '第二件' }).status, 'queued');
  assert.equal(h.hands.keptOf('t2'), null, 'not under way yet');
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } }); // ends stuck on its question
  assert.equal(h.done[0][0].outcome, 'stuck');
  assert.equal(h.hands.keptOf('t1'), null, 'gone with it');
  await tick();
  // its turn: its own state, nothing of the first's
  const t2 = h.hands.thingOf('h2');
  assert.deepEqual([t2.id, t2.task, t2.question, t2.steps, t2.said], ['t2', '第二件', '', 0, '']);
  assert.deepEqual(h.hands.keptOf('t2'), {}, 'nothing kept on the first is on it');
  assert.equal(h.hands.asked({ session: 'h2' }), false);
  assert.equal(h.hands.has('甲乙丙', { session: 'h2' }), false, 'what the first was shown is not its');
  assert.equal(h.hands.has('第二件', { session: 'h2' }), true);
  h.hands.finish({ summary: '好' }, { session: 'h2' });
  assert.deepEqual(h.done[1][0].notes, [], 'the first one\'s notes stayed with it');
  assert.deepEqual(h.done[0][0].notes, ['reply-check']);
});

test('hands, stop: everything by default; with a thing\'s id that one only, waiting or under way', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '一' }); await tick();
  h.hands.start({ device: 'phone', task: '二' });
  h.hands.start({ device: 'phone', task: '三' });
  assert.equal(h.hands.stop({ by: 'her', thing: 't2' }), true, 'one that waits');
  assert.deepEqual(h.ledger.unfinished().map((e) => e.id), ['t1', 't3']);
  assert.equal(h.hands.stop({ by: 'her', thing: 't1' }), true, 'the one under way: the next begins');
  await tick();
  assert.equal(h.hands.doing().id, 't3');
  assert.equal(h.hands.stop({ thing: 't9' }), false);
  assert.equal(h.hands.stop({ by: 'him', cause: 'command' }), true);
  assert.deepEqual([h.hands.busy(), h.hands.stop()], [false, false]);
  assert.deepEqual(h.done.map(([r, j]) => [j.id, r.outcome, r.by]), [['t2', 'stopped', 'her'], ['t1', 'stopped', 'her'], ['t3', 'stopped', 'him']]);
});
