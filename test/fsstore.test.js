// dsh-dot/fsstore: a write is whole or not at all; a file that cannot be read is copied aside before anything is written over it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStore, readJson, readJsonl, writeJson } from '../src/fsstore.js';

const dir = () => mkdtempSync(join(tmpdir(), 'fsstore-'));

test('a write that does not finish leaves the old file whole', () => {
  const d = dir(), f = join(d, 's.json');
  writeJson(f, { a: 1 });
  // a write that died before its rename: only the side file is left
  writeFileSync(`${f}.tmp-123`, '{"a": 2, "b"');
  assert.deepEqual(readJson(f, {}).value, { a: 1 });
  assert.equal(readJson(f, {}).state, 'ok');
});

test('a state file that cannot be read is copied aside, not overwritten unseen; the store starts fresh and the evidence stays', () => {
  const d = dir(), f = join(d, 'dsh-dot-state.json');
  writeFileSync(f, '{"lastSession": "s1", "things": [');
  const seen = [];
  const s = createJsonStore(f, { onBroken: (g) => seen.push(g) });
  assert.equal(s.opened, 'broken'); assert.equal(seen.length, 1);
  const kept = readdirSync(d).find((x) => x.startsWith('dsh-dot-state.json.broken-'));
  assert.ok(kept); assert.equal(readFileSync(join(d, kept), 'utf8'), '{"lastSession": "s1", "things": [');
  s.set('x', 1);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { x: 1 });
  assert.equal(readFileSync(join(d, kept), 'utf8'), '{"lastSession": "s1", "things": [', 'the broken one is still there');
});

test('a state file that cannot be read nor copied aside is not written at all', { skip: process.getuid?.() === 0 }, () => {
  const d = dir(), f = join(d, 's.json');
  writeFileSync(f, 'not json'); chmodSync(d, 0o500);
  try {
    const s = createJsonStore(f);
    assert.equal(s.opened, 'stuck');
    s.set('x', 1); assert.equal(s.get('x'), 1);
  } finally { chmodSync(d, 0o700); }
  assert.equal(readFileSync(f, 'utf8'), 'not json');
});

test('JSON lines: a bad line is skipped and counted, the rest is read', () => {
  const d = dir(), f = join(d, 't.jsonl');
  writeFileSync(f, '{"a":1}\n{"a":\n\n{"a":3}\n');
  assert.deepEqual(readJsonl(f), { rows: [{ a: 1 }, { a: 3 }], bad: 1 });
  assert.deepEqual(readJsonl(join(d, 'none.jsonl')), { rows: [], bad: 0 });
  assert.equal(existsSync(join(d, 'none.jsonl')), false);
});
