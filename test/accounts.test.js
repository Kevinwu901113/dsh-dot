import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccounts, generatePassword, accountsFile } from '../src/phone/accounts.js';

const fresh = () => { const dir = mkdtempSync(join(tmpdir(), 'dot-accounts-')); return { dir, file: join(dir, 'dsh-dot-accounts.json') }; };

test('accounts: default password generated once, stable across reloads, 0600, written atomically', () => {
  const { dir, file } = fresh();
  const a = createAccounts({ file, number: () => '13800138000' });
  const p = a.defaultPassword();
  assert.match(p, /^[A-HJ-NP-Za-km-np-z2-9]{12}$/);
  assert.ok(/[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p));
  assert.equal(a.defaultPassword(), p);
  assert.equal(createAccounts({ file }).defaultPassword(), p, 'a new store over the same file keeps it');
  assert.equal(JSON.parse(readFileSync(file, 'utf8'))._default.password, p);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['dsh-dot-accounts.json'], 'no temp file left');
  assert.ok(accountsFile().endsWith('dsh-dot-accounts.json'));
});

test('accounts: set/get/list; get of an unknown app gives the default password and the number; list has no passwords', () => {
  const { file } = fresh();
  let number = '';
  const a = createAccounts({ file, number: () => number });
  const g = a.get('B站');
  assert.deepEqual(g, { app: 'B站', found: false, password: a.defaultPassword(), number: '' });
  number = '13800138000';
  assert.equal(a.get('B站').number, '13800138000');
  assert.deepEqual(a.set('B站', { login: '13800138000', password: g.password }), { app: 'B站', changed: ['login', 'password'] });
  assert.deepEqual(a.set('b站', { password: 'Other22pass', note: '强制改过' }), { app: 'B站', changed: ['password', 'note'] }, 'same app, any case');
  const r = a.get('B站');
  assert.equal(r.found, true); assert.equal(r.login, '13800138000'); assert.equal(r.password, 'Other22pass'); assert.equal(r.note, '强制改过'); assert.match(r.at, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(a.list(), [{ app: 'B站', login: '13800138000', note: '强制改过', at: r.at }]);
  assert.ok(!JSON.stringify(a.list()).includes('Other22pass'));
  assert.equal(a.count(), 1);
  assert.throws(() => a.set('_default', { password: 'x' }), /app/);
  assert.throws(() => a.get(''), /app/);
  assert.throws(() => a.set('B站', {}), /nothing to record/);
});

test('accounts: generatePassword never uses 0 O o 1 l I', () => {
  for (let i = 0; i < 200; i++) assert.doesNotMatch(generatePassword(), /[0Oo1lI]/);
});
