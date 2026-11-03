import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sectionOf, setValues, settingsPath } from '../src/settings.js';
import { apply as applyPhone } from '../src/phone/phone.js';

const withHome = (content) => {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  if (content !== undefined) writeFileSync(join(dsh, 'dsh-dot.json'), typeof content === 'string' ? content : JSON.stringify(content));
  return dsh;
};

test('sectionOf: missing file, one section, comments dropped', () => {
  withHome();
  assert.deepEqual(sectionOf('phone'), {});
  const dsh = withHome({ phone: { dataGb: 32, _note: 'mine' }, qq: [] });
  assert.equal(settingsPath(), join(dsh, 'dsh-dot.json'));
  assert.deepEqual(sectionOf('phone'), { dataGb: 32 });
  assert.deepEqual(sectionOf('qq'), {});
  assert.deepEqual(sectionOf('memory'), {});
});

test('sectionOf: a broken file is ignored with a warning', () => {
  withHome('{ not json');
  const warnings = [];
  assert.deepEqual(sectionOf('phone', (m) => warnings.push(m)), {});
  assert.equal(warnings.length, 1);
});

test('setValues drops unset values', () => {
  assert.deepEqual(setValues({ a: '', b: undefined, c: 0, d: [], e: 'x' }), { c: 0, d: [], e: 'x' });
  assert.deepEqual(setValues({ d: [], n: '' }, { dropEmptyArrays: true, keepEmpty: ['n'] }), { n: '' });
});

test('phone.enabled = false in dsh-dot.json turns the phone off', () => {
  withHome({ phone: { enabled: false } });
  const provided = [];
  const ctx = { logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }), provide: (n) => provided.push(n) };
  applyPhone(ctx, { window: true });
  assert.deepEqual(provided, []);
});
