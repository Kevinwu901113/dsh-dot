import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { apply, resolveDownloads, avdConfig, hostTarget, phoneGate, OBSERVATION_TOOLS } from '../src/phone/phone.js';

const REPO_XML = `
<remotePackage path="emulator"><revision><major>37</major><minor>3</minor><micro>5</micro></revision><channelRef ref="channel-2"/>
<archives><archive><url>emulator-darwin_x64-2.zip</url></archive><archive><url>emulator-darwin_aarch64-2.zip</url></archive></archives></remotePackage>
<remotePackage path="emulator"><revision><major>37</major><minor>2</minor><micro>12</micro></revision><channelRef ref="channel-0"/>
<archives><archive><url>emulator-darwin_x64-1.zip</url></archive><archive><url>emulator-darwin_aarch64-1.zip</url></archive><archive><url>emulator-linux_x64-1.zip</url></archive><archive><url>emulator-windows_x64-1.zip</url></archive></archives></remotePackage>
<remotePackage path="platform-tools"><channelRef ref="channel-0"/><archives><archive><url>platform-tools_r37.0.1-linux.zip</url></archive><archive><url>platform-tools_r37.0.1-darwin.zip</url></archive><archive><url>platform-tools_r37.0.1-win.zip</url></archive></archives></remotePackage>`;
const SYS_XML = `
<remotePackage path="system-images;android-35;google_apis;arm64-v8a"><channelRef ref="channel-0"/><archives><archive><size>1778384896</size><url>arm64-v8a-35_r09.zip</url></archive></archives></remotePackage>
<remotePackage path="system-images;android-35;google_apis;x86_64"><channelRef ref="channel-0"/><archives><archive><size>1000000000</size><url>x86_64-35_r09.zip</url></archive></archives></remotePackage>`;

test('resolveDownloads picks the stable emulator for the host, platform-tools and the system image', () => {
  const d = resolveDownloads({ repoXml: REPO_XML, sysImgXml: SYS_XML, osTag: 'darwin', abi: 'arm64-v8a', api: 35 });
  assert.equal(d.emulator.url, 'https://dl.google.com/android/repository/emulator-darwin_aarch64-1.zip');
  assert.equal(d.emulator.version, '37.2.12');
  assert.equal(d.platformTools.url, 'https://dl.google.com/android/repository/platform-tools_r37.0.1-darwin.zip');
  assert.equal(d.systemImage.url, 'https://dl.google.com/android/repository/sys-img/google_apis/arm64-v8a-35_r09.zip');
  assert.equal(d.systemImage.sizeMb, 1696);
  const w = resolveDownloads({ repoXml: REPO_XML, sysImgXml: SYS_XML, osTag: 'windows', abi: 'x86_64', api: 35 });
  assert.match(w.emulator.url, /emulator-windows_x64-1\.zip$/);
  assert.match(w.platformTools.url, /-win\.zip$/);
  assert.throws(() => resolveDownloads({ repoXml: REPO_XML, sysImgXml: SYS_XML, osTag: 'linux', abi: 'arm64-v8a', api: 35 }), /no emulator build for linux\/arm64-v8a/);
  assert.throws(() => resolveDownloads({ repoXml: REPO_XML, sysImgXml: SYS_XML, osTag: 'darwin', abi: 'arm64-v8a', api: 99 }), /no system image/);
});

test('avdConfig and hostTarget', () => {
  const ini = avdConfig({ avd: 'dot', api: 35, tag: 'google_apis', abi: 'arm64-v8a', device: 'pixel_6', ramMb: 3072, dataGb: 8 });
  assert.match(ini, /^AvdId=dot$/m);
  assert.match(ini, /^image\.sysdir\.1=system-images\/android-35\/google_apis\/arm64-v8a\/$/m);
  assert.match(ini, /^hw\.cpu\.arch=arm64$/m);
  assert.match(ini, /^PlayStore\.enabled=false$/m);
  assert.match(ini, /^disk\.dataPartition\.size=8G$/m);
  assert.deepEqual(hostTarget('darwin', 'arm64'), { osTag: 'darwin', abi: 'arm64-v8a' });
  assert.deepEqual(hostTarget('win32', 'x64'), { osTag: 'windows', abi: 'x86_64' });
});

test('phoneGate: installs and sensitive typing ask; looking does not', () => {
  const cfg = { askTools: ['mobile_install_app', 'mobile_uninstall_app'], sensitivePatterns: ['密码', 'pay'] };
  assert.equal(phoneGate({ name: 'mcp__dot-phone__mobile_take_screenshot' }, cfg), null);
  assert.match(phoneGate({ name: 'mcp__dot-phone__mobile_install_app', input: {} }, cfg), /mobile_install_app/);
  assert.match(phoneGate({ name: 'mcp__dot-phone__mobile_type_keys', input: { text: '我的密码是' } }, cfg), /sensitive/);
  assert.equal(phoneGate({ name: 'mcp__dot-phone__mobile_type_keys', input: { text: '你好' } }, cfg), null);
  assert.equal(phoneGate({ name: 'mcp__dot-vm__browser_click' }, cfg), null);
  assert.ok(OBSERVATION_TOOLS.includes('mobile_take_screenshot') && !OBSERVATION_TOOLS.includes('mobile_type_keys'));
});

function harness({ installed = true, license = true, bootAfter = 1, running = false, foreign = false } = {}) {
  const state = { running, foreign };
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  const home = join(dsh, 'phone');
  if (installed) {
    for (const f of ['emulator/emulator', 'platform-tools/adb', 'system-images/android-35/google_apis/arm64-v8a/system.img']) { mkdirSync(join(home, f, '..'), { recursive: true }); writeFileSync(join(home, f), ''); }
    mkdirSync(join(home, 'emulator', 'resources'), { recursive: true });
    writeFileSync(join(home, 'emulator', 'resources', 'Toren1BD.posters'), 'poster wall\nsize 2 2\nposition -0.807 0.320 5.316\nrotation 0 -150 0\ndefault poster.png\n\nposter table\nsize 1 1\nposition -2.205 -0.077 3.949\nrotation -90 0 120\n');
  }
  const spawned = [], execs = [], effects = [], gates = [], sections = [], plugins = [], logcats = [];
  let cmd, child;
  let polls = 0;
  const run = async (file, args) => {
    execs.push([file.split('/').slice(-1)[0], ...args]);
    if (args[0] === 'devices') return { stdout: `List of devices attached\n${state.running || state.foreign ? 'emulator-5554\tdevice\n' : ''}` };
    if (args.includes('emu') && args.includes('avd') && args.includes('name')) { if (state.running && args.includes('emulator-5554')) return { stdout: 'dot\r\nOK\r\n' }; throw new Error('connection refused'); }
    if (args.includes('emu') && args.includes('kill')) { state.running = false; return { stdout: '' }; }
    if (args.includes('sys.boot_completed')) return { stdout: ++polls >= bootAfter ? '1\n' : '\n' };
    return { stdout: '' };
  };
  const fake = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.emit('exit', 0); } });
  const spawn = (file, args, opts) => { const c = fake(); if (args.includes('logcat')) { logcats.push(c); return c; } child = c; spawned.push({ file, args, opts }); return c; };
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'tools/pre-execute') gates.push(fn); return () => {}; },
    effect(fn) { effects.push(fn()); },
    provide(n, v) { ctx[n] = v; },
    plugin(p, c) { plugins.push({ p, c }); return { dispose() {} }; },
    inject(deps, fn) { if (deps.every((d) => ctx.get(d))) fn({ ...ctx, ...Object.fromEntries(deps.map((d) => [d, ctx.get(d)])) }); },
    get: (n) => ({
      systemPrompt: { section: (c) => { sections.push(c); return () => {}; } }, commands: { register: (c) => { cmd = c; return () => {}; } },
      webServer: { register: (r) => { routes.push(r); return () => {}; }, getOrigin: () => 'http://127.0.0.1:3080' },
      connection: { requestRejection: () => undefined },
    }[n]),
  };
  const routes = [];
  apply(ctx, { home, abi: 'arm64-v8a', acceptLicense: license, bootTimeoutMs: 2000, restartDelayMs: 10, mcp: true }, { spawn, run, fetch: async () => { throw new Error('no network in tests'); }, mcpClient: { name: 'fake-mcp' } });
  const gate = async (name, input) => { let out = { kind: 'allow', via: 'next' }; for (const fn of gates) out = await fn({ name, input }, async () => out); return out; };
  return { ctx, home, state, spawned, execs, effects, gate, sections, plugins, logcats, cmd: () => cmd, child: () => child, stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}
const until = async (pred, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); } return pred(); };

test('phone: installed SDK → AVD written, emulator spawned, booted, settled, MCP mounted; section and /phone reflect it', async () => {
  const h = harness();
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'ready');
  assert.ok(existsSync(join(h.home, 'avd', 'dot.avd', 'config.ini')));
  assert.match(readFileSync(join(h.home, 'avd', 'dot.ini'), 'utf8'), /target=android-35/);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0].args.slice(0, 4), ['-avd', 'dot', '-port', '5554']);
  assert.ok(!h.spawned[0].args.includes('-virtualscene-poster'), 'no launch flag: the scene file decides where posters hang');
  { const res = join(h.home, 'emulator', 'resources');
    assert.equal(readFileSync(join(res, 'Toren1BD.posters'), 'utf8'), 'poster wall\nsize 1 1\nposition 0 0 -1.5\nrotation 0 0 0\ndefault poster.png\n\nposter table\nsize 1 1\nposition -2.205 -0.077 3.949\nrotation -90 0 120\n', 'before launch the wall poster moved in front of the camera; table kept');
    assert.match(readFileSync(join(res, 'Toren1BD.posters.orig'), 'utf8'), /position -0\.807 0\.320 5\.316/, 'stock list kept');
    const a = await h.ctx.dshPhone.showToCamera(Buffer.from('qr'));
    await new Promise((r) => setTimeout(r, 5));
    const b = await h.ctx.dshPhone.showToCamera(Buffer.from('qr2'));
    assert.notEqual(a, b, 'a new path each time: the emulator keeps the old picture for a path it already shows');
    assert.equal(readFileSync(b, 'utf8'), 'qr2'); assert.ok(!existsSync(a), 'the previous picture is removed');
    const swap = h.execs.findIndex((e) => e.join(' ') === `adb -s emulator-5554 emu virtualscene-image wall ${b}`);
    assert.ok(swap > 0, 'swapped live through the emulator console');
    assert.equal(h.execs[swap - 1].join(' '), 'adb -s emulator-5554 emu virtualscene-image wall', 'the poster is cleared right before each new picture'); }
  assert.ok(h.execs.some((e) => e.some((a) => String(a).includes('stayon'))), 'screen kept on');
  assert.equal(h.plugins.length, 1);
  assert.equal(h.plugins[0].c.serverName, 'dot-phone');
  assert.equal(h.plugins[0].c.transport, 'stdio');
  assert.match(h.plugins[0].c.args[0], /mobile-mcp/);
  assert.match(h.sections[0].text(), /emulator-5554/);
  const out = await h.cmd().handler({ rawInput: '' });
  assert.match(out.text, /phone: ready/);
  assert.match(out.text, /live view: http:\/\/127\.0\.0\.1:3080\/dsh-dot\/phone\//, 'the live view lives on dsh\'s own web server');
  // the emulator dies → error state, relaunch
  h.child().emit('exit', 1);
  assert.equal(h.ctx.dshPhone.state, 'error');
  assert.ok(await until(() => h.spawned.length === 2), 'relaunched');
  h.stop();
});

test('phone: an emulator left running from the last dsh run is attached, not launched again', async () => {
  const h = harness({ running: true });
  assert.ok(await until(() => h.ctx.dshPhone.isReady));
  assert.equal(h.spawned.length, 0);
  h.stop();
});

test('phone: another emulator on the port (MuMu and the like) is never attached; hers takes the next port', async () => {
  const h = harness({ foreign: true });
  assert.ok(await until(() => h.ctx.dshPhone.isReady));
  assert.equal(h.spawned.length, 1, 'launched her own');
  assert.deepEqual(h.spawned[0].args.slice(0, 4), ['-avd', 'dot', '-port', '5556']);
  assert.equal(h.ctx.dshPhone.serial, 'emulator-5556');
  assert.equal(h.ctx.dshPhone.status().serial, 'emulator-5556');
  assert.ok(!h.execs.some((e) => e.includes('emulator-5554') && e.includes('shell')), 'nothing run on the other emulator');
  assert.equal(h.plugins[0].c.env.ANDROID_SERIAL, 'emulator-5556');
  h.stop();
});

test('phone: /phone restart on an attached emulator kills it and launches a new one', async () => {
  const h = harness({ running: true });
  assert.ok(await until(() => h.ctx.dshPhone.isReady));
  assert.equal(h.spawned.length, 0, 'attached, not launched');
  await h.cmd().handler({ rawInput: 'restart' });
  assert.ok(await until(() => h.spawned.length === 1), 'launched after the kill');
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'ready again');
  h.stop();
});

test('phone: nothing installed and no license → needs-license; /phone accept records it and starts', async () => {
  const h = harness({ installed: false, license: false });
  assert.ok(await until(() => h.ctx.dshPhone.state === 'needs-license'));
  assert.match(h.ctx.dshPhone.error, /license/);
  assert.equal(h.sections[0].text(), '');
  const out = await h.cmd().handler({ rawInput: 'accept' });
  assert.match(out.text, /license accepted/);
  assert.ok(await until(() => h.ctx.dshPhone.state === 'error'), 'download attempted (fails offline in tests)');
  assert.match(h.ctx.dshPhone.error, /no network/);
  assert.equal(JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-phone.json'), 'utf8')).acceptLicense, true);
  h.stop();
});

test('phone gate asks through tools/pre-execute', async () => {
  const h = harness();
  assert.equal((await h.gate('mcp__dot-phone__mobile_install_app', {})).kind, 'ask');
  assert.equal((await h.gate('mcp__dot-phone__mobile_swipe_on_screen', {})).via, 'next');
  h.stop();
});

test('live view on dsh\'s web server: every request passes dsh\'s connection gate; forwarded headers buy nothing', async () => {
  const { mountLiveView, LIVE_VIEW_PATH, shellQuote } = await import('../src/phone/live-view.js');
  const http = await import('node:http');
  const shells = [];
  // A stand-in for dsh: its web server dispatches the prefix route; its connection service admits
  // only the signed-in owner (here: the dsh login cookie) and ignores X-Forwarded-* entirely.
  let route = null;
  const webServer = { register: (r) => { route = r; return () => { route = null; }; } };
  const connection = { requestRejection: (req) => (/\bdsh=owner\b/.test(String(req.headers.cookie ?? '')) ? undefined : 401) };
  const view = mountLiveView({ webServer, connection, screenshot: async () => Buffer.from('PNG!'), shell: async (c) => { shells.push(c); return c === 'wm size' ? 'Physical size: 1080x2400\n' : ''; }, ready: () => true, logger: {} });
  assert.equal(route.kind, 'prefix'); assert.equal(route.path, LIVE_VIEW_PATH);
  const server = http.createServer((req, res) => (req.url.startsWith(LIVE_VIEW_PATH) && route ? route.handler(req, res) : (res.writeHead(404), res.end())));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${LIVE_VIEW_PATH}`;
  const owner = { cookie: 'dsh=owner' };
  // Nobody without dsh's login: not the page, not the stream, not a tap — whatever headers they bring.
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/status`, { headers: { 'x-forwarded-host': 'dsh.local', 'x-forwarded-for': '127.0.0.1' } })).status, 401);
  assert.equal((await fetch(`${base}/tap`, { method: 'POST', body: '{"x":0.5,"y":0.5}', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'dsh.local', origin: 'http://127.0.0.1' } })).status, 401);
  assert.equal(shells.length, 0, 'the phone was never touched');
  // The owner, on dsh's origin.
  assert.match(await (await fetch(`${base}/`, { headers: owner })).text(), /<img id="screen" src="stream/);
  assert.deepEqual(await (await fetch(`${base}/status`, { headers: owner })).json(), { ready: true, size: null });
  const ac = new AbortController();
  const res = await fetch(`${base}/stream?fps=5`, { signal: ac.signal, headers: owner });
  const { value } = await res.body.getReader().read();
  assert.match(Buffer.from(value).toString(), /--frame\r\ncontent-type: image\/png\r\ncontent-length: 4\r\n\r\nPNG!/);
  ac.abort();
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...owner, ...headers } });
  assert.equal((await post('/tap', { x: 0.5, y: 0.25 })).status, 204);
  assert.equal(shells.at(-1), 'input tap 540 600');
  assert.equal((await post('/swipe', { from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, ms: 300 })).status, 204);
  assert.equal(shells.at(-1), 'input swipe 540 1920 540 480 300');
  assert.equal((await post('/key', { key: 'KEYCODE_BACK' })).status, 204);
  assert.equal((await post('/key', { key: 'rm -rf' })).status, 400);
  assert.equal((await post('/text', { text: 'hi there' })).status, 204);
  assert.equal(shells.at(-1), "input text 'hi%sthere'");
  assert.equal((await fetch(`${base}/tap`, { method: 'POST', body: 'x=1', headers: { ...owner, 'content-type': 'application/x-www-form-urlencoded' } })).status, 415, 'a form post (what a cross-site page can send) is not accepted');
  assert.equal(shellQuote("a b'c"), "'a%sb'\\''c'");
  view.close();
  assert.equal(route, null, 'close unregisters the route');
  server.close(); server.closeAllConnections?.();
});

import { shade, SYSTEM, QQ_KUAN } from './fixtures/shade.js';

test('phone: notifications flow through the policy to listeners and /phone; mute persists', async () => {
  let dump = shade([SYSTEM, QQ_KUAN('嘿嘿')]);
  const h = harness();
  const got = [];
  h.ctx.dshPhone.adbExec = async (args) => (args.includes('dumpsys') ? { stdout: dump } : { stdout: '' });
  assert.ok(await until(() => h.ctx.dshPhone.isReady));
  h.ctx.dshPhone.onNotification((n) => got.push(n));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.logcats.length, 1, 'events tail started once ready');
  assert.equal(got.length, 0);
  dump = shade([SYSTEM, QQ_KUAN('在吗[2条]嘿嘿')]);
  h.logcats[0].stdout.emit('data', '[10171,1234,com.tencent.mobileqq,1,NULL,0,Notification(...)]\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(got.map((n) => n.text), ['在吗[2条]嘿嘿']);
  assert.match((await h.cmd().handler({ rawInput: 'notifications' })).text, /com\.tencent\.mobileqq: 宽 — 在吗\[2条\]嘿嘿/);
  assert.match((await h.cmd().handler({ rawInput: 'notify mute com.tencent.mobileqq' })).text, /except: com\.tencent\.mobileqq/);
  dump = shade([SYSTEM, QQ_KUAN('第三条')]);
  h.logcats[0].stdout.emit('data', '[10171,1234,com.tencent.mobileqq,1,NULL,0,Notification(...)]\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(got.length, 1, 'muted app does not wake her');
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-phone.json'), 'utf8')).notifyMuted, ['com.tencent.mobileqq']);
  h.stop();
});

test('phone camera: the AVD has a virtual-scene back camera; showToCamera writes the poster an app\'s camera sees', async () => {
  const { avdConfig } = await import('../src/phone/phone.js');
  assert.match(avdConfig({ avd: 'a', api: 35, tag: 'google_apis', abi: 'arm64-v8a', device: 'pixel', ramMb: 2048, dataGb: 8 }), /^hw\.camera\.back=virtualscene$/m);
});

test('phone storage: 16 GB by default, chosen before the phone exists, fixed after', async () => {
  const { avdConfig } = await import('../src/phone/phone.js');
  const h = harness();
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'ready');
  assert.match(readFileSync(join(h.home, 'avd', 'dot.avd', 'config.ini'), 'utf8'), /^disk\.dataPartition\.size=16G$/m, 'a new phone gets 16 GB');
  assert.deepEqual(h.ctx.dshPhone.storage(), { gb: 16, fixed: true });
  assert.throws(() => h.ctx.dshPhone.setStorage(32), /already exists with 16 GB/);
  assert.throws(() => h.ctx.dshPhone.setStorage(4), /8 to 256/);
  assert.match((await h.cmd().handler({ rawInput: 'size' })).text, /storage: 16 GB \(fixed: the phone exists\)/);
  assert.match((await h.cmd().handler({ rawInput: '' })).text, /storage: 16 GB · license/);
  assert.match(avdConfig({ avd: 'a', api: 35, tag: 'google_apis', abi: 'arm64-v8a', device: 'pixel', ramMb: 2048, dataGb: 48 }), /^disk\.dataPartition\.size=48G$/m);
  h.stop();
});
