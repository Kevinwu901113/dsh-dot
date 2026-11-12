// Event times reach the round in her local clock, like interval.nowLocal (they are stored as UTC ISO strings).
process.env.TZ = 'Asia/Shanghai';
import test from 'node:test';
import assert from 'node:assert/strict';

test('localStamp: a UTC timestamp becomes local MM-DD HH:MM', async () => {
  const { localStamp } = await import('../src/interlude/core.js');
  assert.equal(localStamp('2026-11-12T08:05:44.923Z'), '11-12 16:05');
  assert.equal(localStamp('2026-11-12T18:30:00.000Z'), '11-13 02:30', 'crosses midnight');
  assert.equal(localStamp('not a time'), '');
});
