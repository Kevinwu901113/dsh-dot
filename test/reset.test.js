import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_BACKFILL, RESET_LEVELS, cancelReset, lastReset, pendingReset, resetsDir, runPendingReset as runInProcess, scheduleReset } from '../src/reset.js';

// As the next start of dsh would: a process that began after the request, and (the tests run several) not the same one.
const runPendingReset = (o = {}) => runInProcess({ startedAt: Date.now() + 60_000, again: true, ...o });

function world() {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const put = (file, text = 'x') => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
  put(join(home, 'memory', 'transcript.jsonl')); put(join(home, 'memory', 'recall', 'idx', 'meta.jsonl'));
  put(join(home, 'interlude', 'canon.json'), '{"storyDefaults":{"characterName":"她"}}'); put(join(home, 'interlude', 'canon.json.bak-20261117'));
  put(join(home, 'interlude', 'script.md')); put(join(home, 'interlude', 'growth', 'current.md'));
  put(join(home, 'her', 'howto', 'QQ.md')); put(join(home, 'her', '礼物', 'card.md'));
  put(join(dsh, 'dsh-dot-state.json'), JSON.stringify({ lastSession: 's-old', errandSession: 'e-old', pastErrands: ['e-0'], stats: { day: 'd' } }));
  put(join(dsh, 'stickers', 'ab12.img')); put(join(dsh, 'dsh-qq-stickers.json'), '[]');
  for (const f of ['dsh-computer-audit.jsonl', 'dsh-computer-audit.jsonl.1', 'dsh-phone-audit.jsonl', 'dsh-qq-audit.jsonl']) put(join(dsh, f));
  put(join(dsh, 'dsh-dot.json'), '{}');
  return { dsh, home, has: (...p) => existsSync(join(...p)), state: () => JSON.parse(readFileSync(join(dsh, 'dsh-dot-state.json'), 'utf8')) };
}
const now = new Date('2026-11-17T08:30:05Z');

test('nothing scheduled: nothing happens; an unknown level is refused and a broken marker is dropped', () => {
  const w = world();
  assert.equal(runPendingReset({ now }), null);
  assert.ok(w.has(w.home, 'memory', 'transcript.jsonl'));
  assert.throws(() => scheduleReset('everything', w.home), /unknown reset level/);
  writeFileSync(join(w.dsh, 'dsh-dot-reset.json'), '{"level":"nope"}');
  assert.equal(pendingReset(), null);
  assert.equal(runPendingReset({ now }), null);
  assert.ok(!w.has(w.dsh, 'dsh-dot-reset.json'), 'not left to be tried at every start');
});

test('levels: each one includes the ones before it; everything is moved into $DSH_HOME/dsh-dot-resets/<time> (outside her home), never deleted; her persona stays', () => {
  assert.deepEqual(RESET_LEVELS.map((l) => l.id), ['memory', 'life', 'fresh', 'all']);
  const T = '20261117-083005';
  // memory
  let w = world(); scheduleReset('memory', w.home);
  assert.equal(pendingReset().level, 'memory');
  let r = runPendingReset({ now });
  const B = join(w.dsh, 'dsh-dot-resets', T);
  assert.equal(r.backup, B); assert.equal(resetsDir(), join(w.dsh, 'dsh-dot-resets'));
  assert.ok(w.has(B, 'memory', 'transcript.jsonl') && w.has(B, 'memory', 'recall', 'idx', 'meta.jsonl'));
  assert.deepEqual(readdirSync(join(w.home, 'memory')), [NO_BACKFILL], 'her memory is empty, with the note that keeps the old conversation from being read back in');
  assert.deepEqual(readdirSync(join(w.home, '..')), ['dot'], 'nothing of the backup is where she can read it');
  assert.ok(w.has(w.home, 'interlude', 'script.md'), 'the interlude is not part of this level');
  assert.equal(w.state().lastSession, 's-old');
  assert.equal(pendingReset(), null); assert.equal(lastReset().level, 'memory');
  assert.equal(runPendingReset({ now }), null, 'the next component to start finds nothing to do');
  // life
  w = world(); scheduleReset('life', w.home); r = runPendingReset({ now });
  assert.deepEqual(readdirSync(join(w.home, 'interlude')).sort(), ['canon.json', 'canon.json.bak-20261117'], 'her persona and its backups stay');
  assert.ok(w.has(r.backup, 'interlude', 'script.md') && w.has(r.backup, 'interlude', 'growth', 'current.md'));
  assert.equal(w.state().lastSession, 's-old');
  // fresh
  w = world(); scheduleReset('fresh', w.home); r = runPendingReset({ now });
  assert.deepEqual(w.state(), { lastSession: '', stats: { day: 'd' }, pastConversations: ['e-0', 'e-old', 's-old'] }, 'no conversation is hers; the old ones are known as retired');
  assert.equal(JSON.parse(readFileSync(join(r.backup, 'dsh-dot-state.json'), 'utf8')).lastSession, 's-old', 'the pointers are kept in the backup');
  assert.ok(w.has(w.home, 'her', 'howto', 'QQ.md') && w.has(w.dsh, 'stickers', 'ab12.img') && w.has(w.dsh, 'dsh-qq-audit.jsonl'));
  // all
  w = world(); scheduleReset('all', w.home); r = runPendingReset({ now });
  assert.ok(!w.has(w.home, 'her', 'howto') && w.has(r.backup, 'her', 'howto', 'QQ.md'));
  assert.ok(w.has(w.home, 'her', '礼物', 'card.md'), 'only her how-to notes, nothing else of hers');
  assert.ok(!w.has(w.dsh, 'stickers') && !w.has(w.dsh, 'dsh-qq-stickers.json') && w.has(r.backup, 'stickers', 'ab12.img'));
  for (const f of ['dsh-computer-audit.jsonl', 'dsh-computer-audit.jsonl.1', 'dsh-phone-audit.jsonl', 'dsh-qq-audit.jsonl']) assert.ok(!w.has(w.dsh, f) && w.has(r.backup, 'logs', f), f);
  assert.deepEqual(w.state(), { lastSession: '', pastConversations: ['e-0', 'e-old', 's-old'] }, 'today\'s counters start from zero too');
  assert.ok(w.has(w.dsh, 'dsh-dot.json') && w.has(w.home, 'interlude', 'canon.json'), 'settings and persona are never touched');
  assert.equal(r.error, undefined); assert.ok(r.moved.length >= 9);
});

test('only at the next start: the process that scheduled it never carries it out, and a process carries out at most one', () => {
  let w = world(); scheduleReset('all', w.home);
  assert.equal(runInProcess({ now }), null, 'a component re-applied while dsh runs: the others are alive, their state in RAM');
  assert.equal(pendingReset().level, 'all', 'still waiting');
  assert.ok(w.has(w.home, 'memory', 'transcript.jsonl'));
  assert.equal(runInProcess({ now, startedAt: Date.now() + 60_000, again: true }).level, 'all');
  w = world(); scheduleReset('memory', w.home);
  assert.equal(runInProcess({ now, startedAt: Date.now() + 60_000 }), null, 'this process has carried one out already');
  assert.ok(w.has(w.home, 'memory', 'transcript.jsonl'));
});

test('a reset that fails half-way puts everything back, says so, and is not retried at every start', () => {
  const w = world();
  // the interlude folder cannot be read as one (a file where the folder should be): the step after memory fails
  renameSync(join(w.home, 'interlude'), join(w.home, 'interlude.dir')); writeFileSync(join(w.home, 'interlude'), 'x');
  scheduleReset('all', w.home);
  const r = runPendingReset({ now });
  assert.ok(r.error); assert.equal(r.rolledBack, true);
  assert.ok(w.has(w.home, 'memory', 'transcript.jsonl') && !w.has(w.home, 'memory', NO_BACKFILL), 'her memory is back as it was');
  assert.equal(w.state().lastSession, 's-old'); assert.ok(w.has(w.dsh, 'stickers', 'ab12.img'));
  assert.equal(pendingReset(), null); assert.equal(lastReset().rolledBack, true);
});

test('a scheduled reset can be cancelled before the restart', () => {
  const w = world(); scheduleReset('all', w.home);
  assert.equal(cancelReset(), true); assert.equal(cancelReset(), false);
  assert.equal(runPendingReset({ now }), null);
  assert.ok(w.has(w.home, 'memory', 'transcript.jsonl'));
});
