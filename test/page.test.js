import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SCHEMA, COMPONENT_DEFAULTS, validatePatch, describe } from '../src/settings-schema.js';
import { redact, redactSettings, bundle, summary } from '../src/page/diag.js';
import { zip, crc32 } from '../src/page/zip.js';
import { createApi } from '../src/page/api.js';
import { writeSections, fileError } from '../src/settings.js';
import { connectivityCommands, gpuMode, proxyArg } from '../src/phone/phone.js';

const home = mkdtempSync(join(tmpdir(), 'dsh-dot-page-'));
process.env.DSH_HOME = home;

test('schema: every entry names a real key of its component defaults', () => {
  for (const s of SCHEMA) assert.ok(s.key in COMPONENT_DEFAULTS[s.section], `${s.section}.${s.key} is not in ${s.section} defaults`);
});

test('schema: validation coerces ints, refuses out of range, wrong enums and unknown keys', () => {
  assert.deepEqual(validatePatch({ phone: { dataGb: '32', window: false, gpu: 'swiftshader_indirect', dnsServer: ' 223.5.5.5 ' } }), { phone: { dataGb: 32, window: false, gpu: 'swiftshader_indirect', dnsServer: '223.5.5.5' } });
  assert.throws(() => validatePatch({ phone: { dataGb: 4 } }), /不能小于 8/);
  assert.throws(() => validatePatch({ gate: { mode: 'yolo' } }), /只能是/);
  assert.throws(() => validatePatch({ phone: { home: '/x' } }), /页面不能改/);
  assert.throws(() => validatePatch({ qq: { token: 'x' } }), /页面不能改/);
  assert.deepEqual(validatePatch({ phone: { gpu: null } }), { phone: { gpu: null } });
});

test('settings file: merge, null removes, comments kept, a broken file is not overwritten unless asked', () => {
  writeFileSync(join(home, 'dsh-dot.json'), JSON.stringify({ _note: 'mine', phone: { dataGb: 16, _x: 1 }, memory: { dailyAt: '01:00' } }));
  writeSections({ phone: { gpu: 'host', dataGb: null } });
  const all = JSON.parse(readFileSync(join(home, 'dsh-dot.json'), 'utf8'));
  assert.deepEqual(all, { _note: 'mine', phone: { _x: 1, gpu: 'host' }, memory: { dailyAt: '01:00' } });
  writeFileSync(join(home, 'dsh-dot.json'), '{ "phone": ');
  assert.match(fileError(), /JSON/);
  assert.throws(() => writeSections({ phone: { gpu: 'host' } }), /not valid JSON/);
  writeSections({ phone: { gpu: 'host' } }, { overwriteBroken: true });
  assert.equal(fileError(), '');
  assert.equal(describe(JSON.parse(readFileSync(join(home, 'dsh-dot.json'), 'utf8'))).find((e) => e.key === 'gpu').value, 'host');
});

test('redaction: keys, tokens, bearer, url keys, phone numbers, e-mails', () => {
  const t = redact('{"apiKey":"abc123","x":"ok"} Authorization: Bearer abcdefgh12345 https://a.b/c?key=SECRET&q=1 call 13812345678 mail kevin@example.com sk-abcdefghijklmnop');
  assert.ok(!/abc123|abcdefgh12345|SECRET|kevin@example|abcdefghijklmnop/.test(t), t);
  assert.match(t, /138\*\*\*\*5678/);
  assert.deepEqual(redactSettings({ qq: { token: 't', owner: '1' }, computer: { apiKey: '' } }), { qq: { token: '***', owner: '1' }, computer: { apiKey: '' } });
});

/** Read a zip's entries back (deflate only, as written). */
function unzip(buf) {
  const out = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18), raw = buf.readUInt32LE(p + 22), n = buf.readUInt16LE(p + 26), x = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + n).toString('utf8');
    const data = inflateRawSync(buf.slice(p + 30 + n + x, p + 30 + n + x + size));
    assert.equal(data.length, raw); assert.equal(crc32(data), buf.readUInt32LE(p + 14));
    out[name] = data.toString('utf8');
    p += 30 + n + x + size;
  }
  return out;
}

test('diagnostics zip: logs redacted, private files only when asked', () => {
  writeFileSync(join(home, 'dsh-dot.json'), JSON.stringify({ qq: { token: 'tok', owner: '12345' } }));
  writeFileSync(join(home, 'dsh-phone.log'), 'boot ok\nkey=abc https://x/?token=zzz\n');
  mkdirSync(join(home, 'phone'), { recursive: true });
  writeFileSync(join(home, 'phone', 'emulator.log'), Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n'));
  writeFileSync(join(home, 'dsh-qq-audit.jsonl'), '{"text":"hi"}\n');
  const files = unzip(bundle({ home, status: { phone: { state: 'ready' } }, doctor: [{ name: '磁盘空间', level: 'ok', detail: '够' }], info: { plugin: '0.21.0' } }));
  assert.ok(files['logs/dsh-phone.log'].includes('boot ok'));
  assert.ok(!files['logs/dsh-phone.log'].includes('zzz'));
  assert.equal(files['logs/emulator.log'].split('\n').length, 3000);
  assert.match(files['settings.json'], /"token": "\*\*\*"/);
  assert.ok(!Object.keys(files).some((n) => n.startsWith('private/')));
  const priv = unzip(bundle({ home, withPrivate: true }));
  assert.ok(priv['private/dsh-qq-audit.jsonl']);
  assert.ok(zip([{ name: 'a.txt', data: 'x' }]).length > 0);
});

test('summary: versions, states, doctor problems', () => {
  const s = summary({ status: { phone: { state: 'error', error: 'boom\nmore' }, computer: null }, doctor: [{ name: '下载源：电脑', level: 'bad', detail: '连不上 ghcr.io' }], info: { plugin: '0.21.0', dsh: 'x', os: 'win32', ramGb: 16 } });
  assert.match(s, /phone: error — boom/);
  assert.match(s, /computer: 关/);
  assert.match(s, /❌ 下载源：电脑/);
});

test('api: settings round trip, fixes, actions, unknown routes', async () => {
  writeFileSync(join(home, 'dsh-dot.json'), '{}');
  let accepted = null;
  const phone = { status: () => ({ state: 'needs-license' }), accept: () => { accepted = true; }, setStorage: (gb) => { accepted = gb; }, doctorInfo: () => null };
  const ctx = { get: (n) => (n === 'dshPhone' ? phone : undefined) };
  const api = createApi(ctx);
  const call = async (method, sub, body) => {
    let status, out = '';
    const req = { method, url: sub, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    const res = { writeHead(s) { status = s; return this; }, end(b) { out = b; } };
    await api(req, res, sub);
    return { status, body: out && !Buffer.isBuffer(out) && out[0] === '{' ? JSON.parse(out) : out };
  };
  assert.equal((await call('GET', '/status')).body.status.phone.state, 'needs-license');
  assert.equal((await call('GET', '/status')).body.status.computer, null);
  const put = await call('PUT', '/settings', { patch: { phone: { gpu: 'swiftshader_indirect' } } });
  assert.equal(put.status, 200);
  assert.equal((await call('PUT', '/settings', { patch: { phone: { dataGb: 1 } } })).status, 400);
  assert.equal((await call('POST', '/fix/computer-image-cn')).status, 200);
  assert.match(readFileSync(join(home, 'dsh-dot.json'), 'utf8'), /volces/);
  assert.equal((await call('POST', '/action/phone-accept', { gb: 32 })).status, 200);
  assert.equal(accepted, true);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/diag')).status, 200);
});

test('phone network/gpu helpers', () => {
  assert.equal(gpuMode('', 'win32'), 'swiftshader_indirect');
  assert.equal(gpuMode('', 'darwin'), 'auto');
  assert.equal(gpuMode('host', 'win32'), 'host');
  assert.match(connectivityCommands('cn')[0], /captive_portal_https_url https:\/\/connect\.rom\.miui\.com\/generate_204/);
  assert.match(connectivityCommands('google')[0], /settings delete global/);
  assert.match(connectivityCommands('https://example.com/204')[1], /http:\/\/example\.com\/204/);
  assert.equal(proxyArg(''), '');
  assert.equal(proxyArg('system', () => ({ HTTPS_PROXY: 'http://127.0.0.1:7890' })), 'http://127.0.0.1:7890');
  assert.equal(proxyArg('http://h:1'), 'http://h:1');
});
