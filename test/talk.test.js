// What he said that has no word back yet (src/dot/talk.js): the account is kept by what happened — his words, her
// hands starting and coming back, a turn ending with or without anything of hers going out — never by what she said.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTalk } from '../src/dot/talk.js';

/** A talk with a clock and timers of the test's own; `fire()` runs the settle timer as if it had elapsed. */
function make(opts = {}) {
  let t = 1_000_000, pending = null, free = true, accept = true;
  const woke = [], events = [];
  const talk = createTalk({
    now: () => t, setTimer: (fn) => { pending = fn; return { unref() {} }; }, clearTimer: () => { pending = null; },
    canWake: () => free, wake: async (m) => { if (accept) woke.push(m); return accept; }, audit: (e) => events.push(e), ...opts,
  });
  return {
    talk, woke, events, closed: () => events.filter((e) => e.event === 'open-closed').map((e) => e.how),
    advance: (ms) => { t += ms; }, armed: () => Boolean(pending), fire: async () => { const fn = pending; pending = null; if (fn) fn(); await new Promise((r) => setImmediate(r)); },
    free: (v) => { free = v; }, accept: (v) => { accept = v; },
  };
}

test('talk: a chat turn opens nothing that lasts — her hands were never in it', async () => {
  const h = make();
  h.talk.heSaid('在吗');
  h.talk.sheSaid('在');
  h.talk.turnEnded({ spoke: true });
  assert.equal(h.talk.state(), null);
  assert.deepEqual(h.closed(), ['answered']);
  assert.equal(h.armed(), false);
  assert.equal(h.woke.length, 0);
});

test('talk: her hands came back, she told him what she would do next and called nothing — she is asked, once', async () => {
  const h = make();
  h.talk.heSaid('[11-19 15:28] 查一下下一场猎鹰的cs比赛什么时候开始');
  h.talk.handsStarted();                        // she gave her hands the first step …
  h.talk.sheSaid('正在翻 HLTV，稍等，页面别关。');
  h.talk.turnEnded({ spoke: true, busy: true }); // … and her turn ended while they were on it: nothing to ask
  assert.equal(h.armed(), false);
  h.talk.handsDone();                           // the round is over, its result on its way
  h.talk.resultArrived();                       // the turn it wakes has started
  h.talk.sheSaid('等着，马上给你');
  h.talk.turnEnded({ spoke: true, busy: false }); // 11-19: words, no hands, turn over
  assert.equal(h.armed(), true);
  await h.fire();
  assert.equal(h.woke.length, 1);
  assert.match(h.woke[0].his, /猎鹰/);
  assert.equal(h.woke[0].last, '等着，马上给你');
  assert.equal(h.talk.state().asked, 1);
  // The asked turn: she gives her hands the next step. His business goes on; nothing is closed, nothing asked again.
  h.talk.handsStarted();
  h.talk.turnEnded({ spoke: false, asked: true, busy: true });
  assert.ok(h.talk.state());
  assert.equal(h.events.find((e) => e.event === 'open-nudge-outcome').outcome, 'hands');
  h.talk.handsDone(); h.talk.resultArrived();
  h.talk.sheSaid('下一场是周六 20:00 打 Vitality');
  h.talk.turnEnded({ spoke: true, busy: false });
  // She has been asked about this thing of his once: whatever this turn was, it is not asked again.
  assert.equal(h.talk.state(), null);
  assert.deepEqual(h.closed(), ['asked']);
  assert.equal(h.woke.length, 1);
});

test('talk: the asked turn ends it either way — said again without her hands, or said nothing', async () => {
  for (const [spoke, how, outcome] of [[true, 'after-nudge', 'spoke'], [false, 'silent', 'silent']]) {
    const h = make();
    h.talk.heSaid('帮我看下小黑盒热榜'); h.talk.handsStarted(); h.talk.handsDone(); h.talk.resultArrived();
    h.talk.sheSaid('我再看看'); h.talk.turnEnded({ spoke: true });
    await h.fire();
    assert.equal(h.woke.length, 1);
    h.talk.turnEnded({ spoke, asked: true, busy: false });
    assert.equal(h.talk.state(), null, how);
    assert.deepEqual(h.closed(), [how]);
    assert.equal(h.events.find((e) => e.event === 'open-nudge-outcome').outcome, outcome);
    assert.equal(h.armed(), false);
  }
});

test('talk: a round that ended in her silence, or with the answer and nothing after, is not asked about twice', async () => {
  const h = make();
  h.talk.heSaid('查个东西'); h.talk.handsStarted(); h.talk.handsDone(); h.talk.resultArrived();
  h.talk.turnEnded({ spoke: false });            // only DOT_SILENT: her saying it is done
  assert.deepEqual(h.closed(), ['silent']);
  assert.equal(h.armed(), false);
});

test('talk: nothing is asked while the result is still on its way, or while her hands are on a round', async () => {
  const h = make();
  h.talk.heSaid('查个东西'); h.talk.handsStarted();
  h.talk.handsDone();                            // the hands were quick: the result is queued before her turn ends
  h.talk.sheSaid('在查了');
  h.talk.turnEnded({ spoke: true, busy: false });
  assert.equal(h.armed(), false, 'the result will wake her');
  assert.ok(h.talk.state().pending);
  h.talk.resultArrived();
  h.talk.handsStarted();
  h.talk.turnEnded({ spoke: true, busy: true });
  assert.equal(h.armed(), false);
  assert.equal(h.woke.length, 0);
});

test('talk: he speaks, is typing, or her bubbles are going out — the asking waits or is dropped', async () => {
  const h = make();
  h.talk.heSaid('查个东西'); h.talk.handsStarted(); h.talk.handsDone(); h.talk.resultArrived();
  h.talk.sheSaid('等下'); h.talk.turnEnded({ spoke: true });
  // Not now (he is typing / bubbles going out / her conversation busy): it stays due and the tick tries again.
  h.free(false);
  await h.fire();
  assert.equal(h.woke.length, 0);
  assert.equal(h.talk.state().due, true);
  h.talk.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(h.woke.length, 0);
  h.free(true);
  h.talk.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(h.woke.length, 1);
  // He speaks before the asking: his words open it anew, the old asking is gone.
  const g = make();
  g.talk.heSaid('查个东西'); g.talk.handsStarted(); g.talk.handsDone(); g.talk.resultArrived();
  g.talk.sheSaid('等下'); g.talk.turnEnded({ spoke: true });
  assert.equal(g.armed(), true);
  g.talk.heSaid('算了不用查了');
  assert.equal(g.armed(), false);
  assert.equal(g.talk.state().rounds, 0);
  g.talk.sheSaid('好'); g.talk.turnEnded({ spoke: true });
  assert.deepEqual(g.closed(), ['answered']);
  assert.equal(g.woke.length, 0);
});

test('talk: the wake that does not go in (a goal of hers is running) leaves it due; left too long it is let go', async () => {
  const h = make({ ttlMs: 60_000 });
  h.talk.heSaid('查个东西'); h.talk.handsStarted(); h.talk.handsDone(); h.talk.resultArrived();
  h.talk.sheSaid('等下'); h.talk.turnEnded({ spoke: true });
  h.accept(false);
  await h.fire();
  assert.equal(h.talk.state().asked, 0);
  assert.equal(h.talk.state().due, true);
  h.advance(61_000);
  h.talk.tick();
  assert.equal(h.talk.state(), null);
  assert.deepEqual(h.closed(), ['expired']);
  // Hands' rounds, results and her lines with nothing open are nothing (her own time, a restart in between).
  h.talk.handsStarted(); h.talk.handsDone(); h.talk.resultArrived(); h.talk.sheSaid('x'); h.talk.turnEnded({ spoke: true }); h.talk.tick();
  assert.equal(h.talk.state(), null);
});
