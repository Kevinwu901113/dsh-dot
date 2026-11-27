// dsh-dot/turns: the turn watchdog — the machine asleep is not a turn stalled (11-27: five of seven "stalls" were the
// Mac asleep to the second; awake again, the turn was done in seconds); and what she waits on is named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurns, HOST_ASLEEP_MS } from '../src/dot/turns.js';

function make() {
  const log = [], sent = [];
  const dot = {
    ctx: {}, cfg: { turnStallMs: 300000 }, logger: { info() {}, warn() {}, debug() {} },
    audit: (e, d = {}) => log.push({ event: e, ...d }), im: { send: async (t) => { sent.push(t); } },
    sessions: { wantIm: false, isDotSession: () => true, retired: () => false, last: () => 's1', setLast() {}, imSessions: new Set() },
    turnState: () => ({}), sleep: { wakeUp() {} }, arrive: { turnStarted() {} },
  };
  const turns = createTurns(dot);
  const emit = (type, data = {}) => turns.onSessionEvent({ id: 's1', header: { cwd: '/x' } }, { type, data });
  return { turns, emit, log, sent };
}

test('asleep: the gap between two ticks is taken off the turn\'s quiet — no stall, no ⏳, one line of record', () => {
  const { turns, emit, log, sent } = make();
  const t0 = Date.now();
  emit('turn/start', { turn: 1 });
  turns.watchTurns(t0 + 30000);
  turns.watchTurns(t0 + 30000 + 473000); // 473 s asleep, then the clock ticks once on waking
  assert.ok(!log.some((e) => e.event === 'turn-stalled'), 'not stalled');
  assert.equal(sent.length, 0, 'nothing sent to him');
  const slept = log.find((e) => e.event === 'host-slept');
  assert.ok(slept && slept.ms === 473000 && slept.turns === 1);
  assert.ok(473000 > HOST_ASLEEP_MS);
});

test('awake and quiet past the limit: stalled, once, and he is told — with what she waits on', () => {
  const { turns, emit, log, sent } = make();
  const t0 = Date.now();
  emit('turn/start', { turn: 1 });
  emit('tool/call', { name: 'mcp__x__read' });
  emit('tool/result', { name: 'mcp__x__read' });
  for (let s = 30; s <= 330; s += 30) turns.watchTurns(t0 + s * 1000);
  const st = log.filter((e) => e.event === 'turn-stalled');
  assert.equal(st.length, 1);
  assert.equal(st[0].doing, '等模型的下一步（上一步：read）');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /等模型的下一步/);
});
