import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { apply, resolveDownloads, avdConfig, hostTarget, phoneGate, OBSERVATION_TOOLS, blankPng, screencapRetry, decodePng, encodePng, zoomPng } from '../src/phone/phone.js';
import { deflateSync } from 'node:zlib';

const REPO_XML = `
<remotePackage path="emulator"><revision><major>37</major><minor>3</minor><micro>5</micro></revision><channelRef ref="channel-2"/>
<archives><archive><url>emulator-darwin_x64-2.zip</url></archive><archive><url>emulator-darwin_aarch64-2.zip</url></archive></archives></remotePackage>
<remotePackage path="emulator"><revision><major>37</major><minor>2</minor><micro>12</micro></revision><channelRef ref="channel-0"/>
<archives><archive><url>emulator-darwin_x64-1.zip</url></archive><archive><url>emulator-darwin_aarch64-1.zip</url></archive><archive><url>emulator-linux_x64-1.zip</url></archive><archive><url>emulator-windows_x64-1.zip</url></archive></archives></remotePackage>
<remotePackage path="platform-tools"><channelRef ref="channel-0"/><archives><archive><url>platform-tools_r37.0.1-linux.zip</url></archive><archive><url>platform-tools_r37.0.1-darwin.zip</url></archive><archive><url>platform-tools_r37.0.1-win.zip</url></archive></archives></remotePackage>`;
const SYS_XML = `
<remotePackage path="system-images;android-35;google_apis;arm64-v8a"><channelRef ref="channel-0"/><archives><archive><size>1778384896</size><url>arm64-v8a-35_r09.zip</url></archive></archives></remotePackage>
<remotePackage path="system-images;android-35;google_apis;x86_64"><channelRef ref="channel-0"/><archives><archive><size>1000000000</size><url>x86_64-35_r09.zip</url></archive></archives></remotePackage>`;

/** A tiny RGBA PNG (CRCs left zero; blankPng does not check them); each row filtered with `filter`. */
function png(w, h, pixel, filter = 0) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const raw = Buffer.alloc(w * 4), prev = y ? Buffer.alloc(w * 4) : null;
    for (let x = 0; x < w; x++) Buffer.from(pixel(x, y)).copy(raw, x * 4);
    if (prev) for (let x = 0; x < w; x++) Buffer.from(pixel(x, y - 1)).copy(prev, x * 4);
    const out = Buffer.alloc(w * 4);
    for (let i = 0; i < raw.length; i++) out[i] = filter === 1 ? (raw[i] - (i >= 4 ? raw[i - 4] : 0)) & 0xff : filter === 2 ? (raw[i] - (prev ? prev[i] : 0)) & 0xff : raw[i];
    rows.push(Buffer.from([filter]), out);
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('blankPng: all white or all black (any filter) is blank; one other pixel, a grey screen or not-a-PNG is not', () => {
  for (const f of [0, 1, 2]) {
    assert.equal(blankPng(png(8, 6, () => [255, 255, 255, 255], f)), true, `white, filter ${f}`);
    assert.equal(blankPng(png(8, 6, () => [0, 0, 0, 255], f)), true, `black, filter ${f}`);
    assert.equal(blankPng(png(8, 6, (x, y) => (x === 5 && y === 4 ? [10, 200, 30, 255] : [255, 255, 255, 255]), f)), false, `one green pixel, filter ${f}`);
  }
  assert.equal(blankPng(png(8, 6, () => [128, 128, 128, 255])), false, 'grey is a real screen');
  assert.equal(blankPng(png(8, 6, (x) => (x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255]))), false, 'half black, half white');
  assert.equal(blankPng(Buffer.from('PNGDATA')), false);
});

test('screencapRetry: a blank screenshot is taken once more after 400 ms; a real one is not', async () => {
  const white = png(4, 4, () => [255, 255, 255, 255]), real = png(4, 4, (x) => [x * 40, 10, 10, 255]);
  const waits = [];
  const wait = async (ms) => { waits.push(ms); };
  let shots = [white, real];
  assert.equal(await screencapRetry(async () => shots.shift(), { wait }), real);
  assert.deepEqual(waits, [400]);
  shots = [real, white];
  assert.equal(await screencapRetry(async () => shots.shift(), { wait }), real);
  assert.deepEqual(waits, [400], 'no second shot for a real one');
  shots = [white, white];
  assert.equal(await screencapRetry(async () => shots.shift(), { wait }), white, 'still blank: returned as it is, only one retry');
});

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

function harness({ installed = true, license = true, bootAfter = 1, running = false, foreign = false, files = {}, config = {} } = {}) {
  const state = { running, foreign };
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  for (const [f, v] of Object.entries(files)) writeFileSync(join(dsh, f), JSON.stringify(v));
  const home = join(dsh, 'phone');
  if (installed) {
    for (const f of ['emulator/emulator', 'platform-tools/adb', 'system-images/android-35/google_apis/arm64-v8a/system.img']) { mkdirSync(join(home, f, '..'), { recursive: true }); writeFileSync(join(home, f), ''); }
    mkdirSync(join(home, 'emulator', 'resources'), { recursive: true });
    writeFileSync(join(home, 'emulator', 'resources', 'Toren1BD.posters'), 'poster wall\nsize 2 2\nposition -0.807 0.320 5.316\nrotation 0 -150 0\ndefault poster.png\n\nposter table\nsize 1 1\nposition -2.205 -0.077 3.949\nrotation -90 0 120\n');
  }
  const spawned = [], execs = [], effects = [], gates = [], events = [], sections = [], plugins = [], logcats = [], tools = [];
  let cmd, child;
  let polls = 0;
  const run = async (file, args) => {
    execs.push([file.split('/').slice(-1)[0], ...args]);
    if (args[0] === 'devices') return { stdout: `List of devices attached\n${state.running || state.foreign ? 'emulator-5554\tdevice\n' : ''}` };
    if (args.includes('emu') && args.includes('avd') && args.includes('name')) { if (state.running && args.includes('emulator-5554')) return { stdout: 'dot\r\nOK\r\n' }; throw new Error('connection refused'); }
    if (args.includes('emu') && args.includes('kill')) { state.running = false; return { stdout: '' }; }
    if (args.includes('get-state')) { if (state.gone) throw new Error("error: device 'emulator-5554' not found"); return { stdout: 'device\n' }; }
    if (args.includes('sys.boot_completed')) return { stdout: ++polls >= bootAfter ? '1\n' : '\n' };
    return { stdout: '' };
  };
  const fake = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.emit('exit', 0); } });
  const spawn = (file, args, opts) => { const c = fake(); if (args.includes('logcat')) { logcats.push(c); return c; } child = c; spawned.push({ file, args, opts }); return c; };
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    on: (name, fn, o) => { if (name === 'tools/pre-execute') gates[o?.prepend ? 'unshift' : 'push'](fn); if (name === 'session/event') events.push(fn); return () => {}; },
    effect(fn) { effects.push(fn()); },
    provide(n, v) { ctx[n] = v; },
    plugin(p, c) { plugins.push({ p, c }); return { dispose() {} }; },
    inject(deps, fn) { if (deps.every((d) => ctx.get(d))) fn({ ...ctx, ...Object.fromEntries(deps.map((d) => [d, ctx.get(d)])) }); },
    get: (n) => ({
      systemPrompt: { section: (c) => { sections.push(c); return () => {}; } }, commands: { register: (c) => { cmd = c; return () => {}; } },
      webServer: { register: (r) => { routes.push(r); return () => {}; }, getOrigin: () => 'http://127.0.0.1:3080' },
      connection: { requestRejection: () => undefined },
      tools: { register: (t) => { tools.push(t); return () => {}; } },
    }[n]),
  };
  const routes = [];
  apply(ctx, { home, abi: 'arm64-v8a', acceptLicense: license, bootTimeoutMs: 2000, restartDelayMs: 10, aliveEveryMs: 20, mcp: true, ...config }, { spawn, run, fetch: async () => { throw new Error('no network in tests'); }, mcpClient: { name: 'fake-mcp' } });
  const gate = async (name, input, session) => { const exec = { name, input, agent: session ? { session: { id: session } } : undefined }; const run = (i) => (i < gates.length ? gates[i](exec, () => run(i + 1)) : { kind: 'allow', via: 'next' }); return run(0); };
  const turnEnd = (id) => events.forEach((fn) => fn({ id }, { type: 'turn/end' }));
  return { ctx, turnEnd, home, state, spawned, execs, effects, gate, sections, plugins, logcats, tools, cmd: () => cmd, child: () => child, stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}
const until = async (pred, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); } return pred(); };

test('an attached emulator that stops answering adb (QEMU crash) is noticed and relaunched', async () => {
  const h = harness({ running: true }); // left from an earlier run: attached, not our child
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'attached and ready');
  assert.equal(h.spawned.length, 0, 'nothing spawned: it was attached');
  h.state.running = false; h.state.gone = true; // QEMU died: adb no longer lists or answers it
  assert.ok(await until(() => h.ctx.dshPhone.state === 'error', 2000), 'three missed heartbeats → error');
  assert.match(h.ctx.dshPhone.error, /gone/);
  h.state.gone = false; // the relaunch brings a fresh one
  assert.ok(await until(() => h.spawned.length === 1, 2000), 'relaunched after restartDelayMs');
  h.stop();
});

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
  assert.match(h.sections[0].text(), /设备 dot，/, 'the id mobile-mcp takes (the AVD), not the adb serial');
  const out = await h.cmd().handler({ rawInput: '' });
  assert.match(out.text, /phone: ready/);
  assert.match(out.text, /live view: http:\/\/127\.0\.0\.1:3080\/dsh-dot\/phone\//, 'the live view lives on dsh\'s own web server');
  // the emulator dies → error state, relaunch
  h.child().emit('exit', 1);
  assert.equal(h.ctx.dshPhone.state, 'error');
  assert.ok(await until(() => h.spawned.length === 2), 'relaunched');
  h.stop();
});

test('phone: launch is cold-boot, windowless console, own adb port; three quick exits stop the relaunch loop', async () => {
  const h = harness();
  assert.ok(await until(() => h.spawned.length === 1));
  const { args, opts } = h.spawned[0];
  assert.ok(args.includes('-no-snapshot'), 'no Quick Boot snapshot by default');
  assert.equal(opts.windowsHide, true, 'no console window to close on Windows');
  assert.equal(opts.env.ANDROID_ADB_SERVER_PORT, '5137', 'her own adb server, away from 5037');
  writeFileSync(join(h.home, 'emulator.log'), 'boot...\nFATAL: x86_64 emulation currently requires hardware acceleration\n');
  for (let i = 1; i <= 3; i++) {
    await until(() => h.spawned.length === i);
    h.child().emit('exit', 1);
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(h.spawned.length, 3, 'not relaunched a fourth time');
  assert.match(h.ctx.dshPhone.error, /keeps exiting right after launch[\s\S]*hardware acceleration/, 'the reason from emulator.log is in the error');
  h.stop();
});

test('phone: quickBoot and adbPort 0 restore the stock behaviour', async () => {
  const h = harness({ config: { quickBoot: true, adbPort: 0 } });
  assert.ok(await until(() => h.spawned.length === 1));
  assert.ok(!h.spawned[0].args.includes('-no-snapshot'));
  assert.equal(h.spawned[0].opts.env.ANDROID_ADB_SERVER_PORT, process.env.ANDROID_ADB_SERVER_PORT);
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

test('live view: viewers share one capture loop, paced by how long a capture takes', async () => {
  const { mountLiveView, LIVE_VIEW_PATH } = await import('../src/phone/live-view.js');
  const http = await import('node:http');
  let route = null, caps = 0;
  // A slow capture (software-rendered emulator): 150 ms each.
  const screenshot = async () => { caps++; await new Promise((r) => setTimeout(r, 150)); return Buffer.from('PNG!'); };
  const view = mountLiveView({ webServer: { register: (r) => { route = r; return () => {}; } }, connection: { requestRejection: () => undefined }, screenshot, shell: async () => '', ready: () => true, logger: {} });
  const server = http.createServer((req, res) => route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}${LIVE_VIEW_PATH}/stream?fps=5`;
  const a = new AbortController(), b = new AbortController();
  await Promise.all([fetch(url, { signal: a.signal }), fetch(url, { signal: b.signal })]);
  await new Promise((r) => setTimeout(r, 1500));
  // Two viewers at 5 fps would be 15 captures each, unshared and unpaced; one loop that rests 3× the
  // capture time does ≤ 1500 / (150 + 450) + 1.
  assert.ok(caps <= 4, `captures: ${caps}`);
  a.abort(); b.abort();
  await new Promise((r) => setTimeout(r, 700));
  const after = caps;
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(caps, after, 'no viewers, no captures');
  view.close(); server.close(); server.closeAllConnections?.();
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

test('phone number: /phone number persists and wins over dsh-dot.json; the device section says it, or not', async () => {
  const h = harness();
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'ready');
  assert.doesNotMatch(h.sections[0].text(), /你的手机号/, 'no number, no sentence');
  assert.match((await h.cmd().handler({ rawInput: '' })).text, /number: \(none: \/phone number <digits>\) · accounts: 0 app\(s\)/);
  assert.match((await h.cmd().handler({ rawInput: 'number 138 0013-8000' })).text, /number set to 13800138000/);
  assert.equal(JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-phone.json'), 'utf8')).number, '13800138000');
  assert.match(h.sections[0].text(), /\n你的手机号是 13800138000：注册默认用它；已有账号按 account get 的记录登录，验证码会发到用户那里——点了发送就停下来问他要。\n账号密码不要自己编/);
  assert.match((await h.cmd().handler({ rawInput: 'number abc' })).text, /digits only/);
  assert.equal(h.ctx.dshPhone.number(), '13800138000', 'a bad number changes nothing');
  assert.match((await h.cmd().handler({ rawInput: 'number -' })).text, /number cleared/);
  assert.doesNotMatch(h.sections[0].text(), /你的手机号/);
  h.stop();
  // dsh-dot.json sets it; one set by /phone number (dsh-phone.json) wins, like /phone size.
  const h2 = harness({ files: { 'dsh-dot.json': { phone: { number: 13900000000 } } } });
  assert.equal(h2.ctx.dshPhone.number(), '13900000000');
  h2.stop();
  const h3 = harness({ files: { 'dsh-dot.json': { phone: { number: '13900000000' } }, 'dsh-phone.json': { number: '' } } });
  assert.equal(h3.ctx.dshPhone.number(), '', 'cleared by the command, stays cleared');
  h3.stop();
});

test('account tool: get hands out the number and the default password, set records, list hides passwords, audit never has one', async () => {
  const h = harness();
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'ready');
  await h.cmd().handler({ rawInput: 'number 13800138000' });
  const tool = h.tools.find((t) => t.name === 'account');
  assert.ok(tool, 'registered');
  const render = (v) => tool.output.render({}, v)[0].text;
  const g = await tool.execute({ action: 'get', app: '小红书' });
  assert.equal(g.found, false); assert.equal(g.number, '13800138000'); assert.match(g.password, /^[A-HJ-NP-Za-km-np-z2-9]{12}$/);
  assert.equal(render(g), `小红书 还没记过账号。注册用：手机号 13800138000，密码 ${g.password}。注册好了用 account set 记下来。`);
  assert.equal(render(await tool.execute({ action: 'set', app: '小红书', login: '13800138000', password: 'Forced-Other-1' })), '记下了：小红书（登录名、密码）');
  const g2 = await tool.execute({ action: 'get', app: '小红书' });
  assert.equal(render(g2), '小红书：登录名 13800138000，密码 Forced-Other-1');
  assert.equal(render(await tool.execute({ action: 'list' })), '- 小红书：13800138000');
  assert.match(render(await tool.execute({ action: 'set', app: 'x' })), /^account: nothing to record/);
  assert.match((await h.cmd().handler({ rawInput: '' })).text, /accounts: 1 app\(s\)/);
  const log = readFileSync(join(process.env.DSH_HOME, 'dsh-phone-audit.jsonl'), 'utf8');
  assert.match(log, /"kind":"account-get"/); assert.match(log, /"kind":"account-set"/);
  assert.ok(!log.includes(g.password) && !log.includes('Forced-Other-1'), 'no password in the audit log');
  h.stop();
});

test('zoomPng: crops screen px (clamped), enlarges ≤ 3× (bilinear), encodes a valid PNG; decodePng reads every filter', async () => {
  const zlib = await import('node:zlib');
  const red = [255, 0, 0, 255], white = [255, 255, 255, 255];
  for (const f of [0, 1, 2]) {
    const img = decodePng(png(8, 6, (x, y) => (x >= 4 && y >= 3 ? red : white), f));
    assert.deepEqual([img.width, img.height, img.bpp], [8, 6, 4]);
    assert.deepEqual([...img.pixels.subarray((3 * 8 + 4) * 4, (3 * 8 + 4) * 4 + 4)], red, `filter ${f}`);
  }
  const src = png(8, 6, (x, y) => (x >= 4 && y >= 3 ? red : white));
  const z = zoomPng(src, { x: 4, y: 3, w: 2, h: 2, scale: 2 });
  assert.deepEqual({ x: z.x, y: z.y, w: z.w, h: z.h, scale: z.scale, width: z.width, height: z.height }, { x: 4, y: 3, w: 2, h: 2, scale: 2, width: 4, height: 4 });
  const out = decodePng(z.png);
  assert.equal(out.width, 4); assert.ok(out.pixels.every((v, i) => v === red[i % 4]), 'all red inside the red block');
  // valid chunk CRCs (encodePng computes them)
  if (zlib.crc32) for (let o = 8; o < z.png.length;) { const len = z.png.readUInt32BE(o); assert.equal(z.png.readUInt32BE(o + 8 + len), zlib.crc32(z.png.subarray(o + 4, o + 8 + len))); o += 12 + len; }
  assert.equal(zoomPng(src, { x: 6, y: 5, w: 100, h: 100, scale: 9 }).scale, 3, 'scale capped at 3');
  const c = zoomPng(src, { x: 6, y: 5, w: 100, h: 100, scale: 1 });
  assert.deepEqual([c.w, c.h], [2, 1], 'clamped to the image');
  assert.equal(zoomPng(src, { x: 0, y: 0, w: 4, h: 2 }).scale, 3, 'default: as large as fits, at most 3×');
  assert.match(zoomPng(Buffer.from('nope'), { x: 0, y: 0, w: 1, h: 1 }).error, /not a PNG/);
  assert.equal(blankPng(encodePng({ width: 3, height: 2, bpp: 3, pixels: Buffer.alloc(18, 255) })), true);
});

test('phone_zoom tool: a part of the screen, enlarged, through the attachment store; says why when it cannot', async () => {
  const h = harness();
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'ready');
  const tool = h.tools.find((t) => t.name === 'phone_zoom');
  assert.ok(tool, 'registered');
  assert.equal(tool.parameters.properties.scale.maximum, 3);
  h.ctx.dshPhone.screenshot = async () => png(8, 6, (x) => (x < 4 ? [0, 0, 255, 255] : [255, 255, 255, 255]));
  const none = await tool.execute({ x: 0, y: 0, w: 4, h: 4 });
  assert.match(tool.output.render({}, none)[0].text, /^没放大成：没有附件仓库/);
  const saved = [];
  const get0 = h.ctx.get;
  h.ctx.get = (n) => (n === 'attachments' ? { saveImages: async (inputs) => { saved.push(...inputs); return inputs.map(() => ({ id: 'att-1', mediaType: 'image/png' })); } } : get0(n));
  const v = await tool.execute({ x: 0, y: 0, w: 4, h: 4, scale: 2 });
  assert.equal(saved.length, 1); assert.equal(saved[0].mediaType, 'image/png');
  assert.deepEqual([decodePng(Buffer.from(saved[0].data)).width, decodePng(Buffer.from(saved[0].data)).height], [8, 8]);
  assert.deepEqual(tool.output.render({}, v), [{ type: 'text', text: '屏幕 (0, 0) 起 4×4，放大 2 倍：' }, { type: 'image', attachment: { id: 'att-1', mediaType: 'image/png' } }]);
  assert.equal(JSON.stringify(v).includes('"png"'), false, 'the bytes are not in the value');
  assert.match(readFileSync(join(process.env.DSH_HOME, 'dsh-phone-audit.jsonl'), 'utf8'), /"kind":"phone-zoom"/);
  assert.match(h.sections[0].text(), /phone_zoom 放大截图的一块，不用去电脑里裁图/);
  h.stop();
});

const audits = () => readFileSync(join(process.env.DSH_HOME, 'dsh-phone-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'phone-lease' || e.kind === 'qq-send-blocked');

test('phone lease: one session drives the phone; another waits, then is refused; turn end and idle free it; her conversation goes first', async () => {
  const h = harness({ config: { leaseWaitMs: 300, leaseIdleMs: 700 } });
  const T = 'mcp__dot-phone__mobile_click_on_screen_at_coordinates';
  assert.equal((await h.gate(T, {}, 'errand')).via, 'next');
  const refused = await h.gate('mcp__dot-phone__mobile_take_screenshot', {}, 'interlude');
  assert.equal(refused.kind, 'deny');
  assert.match(refused.reason, /^手机正被另一件事占着（在用 mobile_click_on_screen_at_coordinates），稍后再试$/);
  assert.equal((await h.gate(T, {}, 'errand')).via, 'next', 'the holder keeps going');
  // the holder's turn ends: the waiting one gets it
  const waiting = h.gate(T, {}, 'interlude');
  setTimeout(() => h.turnEnd('errand'), 50);
  assert.equal((await waiting).via, 'next');
  // two wait; her conversation is first in line though it came second
  h.ctx.dshPhone.setPriority('her');
  const order = [];
  const a = h.gate(T, {}, 'errand').then((r) => order.push(['errand', r.kind]));
  await new Promise((r) => setTimeout(r, 20));
  const b = h.gate(T, {}, 'her').then((r) => order.push(['her', r.kind]));
  setTimeout(() => h.turnEnd('interlude'), 60);
  await Promise.all([a, b]);
  assert.deepEqual(order, [['her', 'allow'], ['errand', 'deny']]);
  // idle: the holder stops touching it for leaseIdleMs
  await new Promise((r) => setTimeout(r, 750));
  assert.equal((await h.gate(T, {}, 'errand')).via, 'next');
  assert.equal((await h.gate(T, {})).via, 'next', 'no session id: no lease');
  assert.deepEqual([...new Set(audits().map((e) => e.event))].sort(), ['acquired', 'expired', 'refused', 'waited']);
  h.stop();
});

test('phone QQ: typing or Enter with QQ in front is refused (search excepted); other apps and qqSendOnPhone pass', async () => {
  let top = 'com.tencent.mobileqq/.activity.SplashActivity';
  const run = async (config) => {
    const h = harness({ config });
    h.ctx.dshPhone.adbExec = async (args) => ({ stdout: args.join(' ').includes('dumpsys activity') ? `  topResumedActivity=ActivityRecord{1 u0 ${top} t9}\n` : '' });
    return h;
  };
  const h = await run({});
  const typed = await h.gate('mcp__dot-phone__mobile_type_keys', { text: '你好', submit: true }, 's');
  assert.deepEqual(typed, { kind: 'deny', reason: '在手机 QQ 里不发消息，给人发 QQ 用 qq_send。' });
  assert.equal((await h.gate('mcp__dot-phone__mobile_press_button', { button: 'ENTER' }, 's')).kind, 'deny');
  assert.equal((await h.gate('mcp__dot-phone__mobile_click_on_screen_at_coordinates', { x: 1, y: 2 }, 's')).via, 'next', 'reading: taps pass');
  top = 'com.tencent.mobileqq/com.tencent.mobileqq.search.activity.UniteSearchActivity';
  assert.equal((await h.gate('mcp__dot-phone__mobile_type_keys', { text: '宽' }, 's')).via, 'next', 'QQ search may type');
  top = 'com.android.chrome/com.google.android.apps.chrome.Main';
  assert.equal((await h.gate('mcp__dot-phone__mobile_type_keys', { text: 'hi' }, 's')).via, 'next');
  assert.ok(audits().some((e) => e.kind === 'qq-send-blocked' && e.tool === 'mobile_type_keys'));
  h.stop();
  top = 'com.tencent.mobileqq/.activity.SplashActivity';
  const h2 = await run({ qqSendOnPhone: true });
  assert.equal((await h2.gate('mcp__dot-phone__mobile_type_keys', { text: 'hi' }, 's')).via, 'next');
  h2.stop();
});

test('phone: the device section — everyone with the phone gets it, her parts (wake, stickers, memory) only in her sessions, a qq-bridge sandbox nothing', async () => {
  const h = harness({ running: true });
  const owners = { s1: 'dot', s2: 'other', s3: 'qqb-sandbox', s4: 'qqb-owner' };
  const get = h.ctx.get;
  h.ctx.get = (n) => ({ dshDotCompat: { ownerOf: (c) => owners[c.agent.session.id] }, dshDot: {}, dshQq: {}, dotMemory: {} }[n] ?? get(n));
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'attached and ready');
  const text = (id) => h.sections[0].text({ agent: { session: { id, header: { cwd: '/x' } } } });
  assert.match(text('s1'), /表情包|sticker/, 'hers: the sticker album');
  assert.match(text('s2'), /设备 dot，/, 'another plugin\'s session: the phone itself');
  assert.doesNotMatch(text('s2'), /表情包|sticker/, 'but not her album');
  assert.match(text('s4'), /设备 dot，/);
  assert.doesNotMatch(text('s4'), /表情包|sticker/);
  assert.equal(text('s3'), '', 'a qq-bridge sandbox session does not see the phone');
  h.stop();
});
