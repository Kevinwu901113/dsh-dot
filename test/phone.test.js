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
  assert.equal(phoneGate({ name: 'mcp__phone__mobile_take_screenshot' }, cfg), null);
  assert.match(phoneGate({ name: 'mcp__phone__mobile_install_app', input: {} }, cfg), /mobile_install_app/);
  assert.match(phoneGate({ name: 'mcp__phone__mobile_type_keys', input: { text: '我的密码是' } }, cfg), /sensitive/);
  assert.equal(phoneGate({ name: 'mcp__phone__mobile_type_keys', input: { text: '你好' } }, cfg), null);
  assert.equal(phoneGate({ name: 'mcp__vm__browser_click' }, cfg), null);
  assert.ok(OBSERVATION_TOOLS.includes('mobile_take_screenshot') && !OBSERVATION_TOOLS.includes('mobile_type_keys'));
});

function harness({ installed = true, license = true, bootAfter = 1, running = false } = {}) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  const home = join(dsh, 'phone');
  if (installed) {
    for (const f of ['emulator/emulator', 'platform-tools/adb', 'system-images/android-35/google_apis/arm64-v8a/system.img']) { mkdirSync(join(home, f, '..'), { recursive: true }); writeFileSync(join(home, f), ''); }
  }
  const spawned = [], execs = [], effects = [], gates = [], sections = [], plugins = [], logcats = [];
  let cmd, child;
  let polls = 0;
  const run = async (file, args) => {
    execs.push([file.split('/').slice(-1)[0], ...args]);
    if (args[0] === 'devices') return { stdout: running ? 'List of devices attached\nemulator-5554\tdevice\n' : 'List of devices attached\n' };
    if (args.includes('sys.boot_completed')) return { stdout: ++polls >= bootAfter ? '1\n' : '\n' };
    return { stdout: '' };
  };
  const fake = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() { this.emit('exit', 0); } });
  const spawn = (file, args) => { const c = fake(); if (args.includes('logcat')) { logcats.push(c); return c; } child = c; spawned.push({ file, args }); return c; };
  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'tools/pre-execute') gates.push(fn); return () => {}; },
    effect(fn) { effects.push(fn()); },
    provide(n, v) { ctx[n] = v; },
    plugin(p, c) { plugins.push({ p, c }); return { dispose() {} }; },
    inject(deps, fn) { if (deps.every((d) => ctx.get(d))) fn({ ...ctx, ...Object.fromEntries(deps.map((d) => [d, ctx.get(d)])) }); },
    get: (n) => ({ systemPrompt: { section: (c) => { sections.push(c); return () => {}; } }, commands: { register: (c) => { cmd = c; return () => {}; } } }[n]),
  };
  apply(ctx, { home, abi: 'arm64-v8a', acceptLicense: license, bootTimeoutMs: 2000, restartDelayMs: 10, mcp: true, liveViewPort: 18090 }, { spawn, run, fetch: async () => { throw new Error('no network in tests'); }, mcpClient: { name: 'fake-mcp' }, startLiveView: () => ({ url: 'http://127.0.0.1:18090/', close() {} }) });
  const gate = async (name, input) => { let out = { kind: 'allow', via: 'next' }; for (const fn of gates) out = await fn({ name, input }, async () => out); return out; };
  return { ctx, home, spawned, execs, effects, gate, sections, plugins, logcats, cmd: () => cmd, child: () => child, stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}
const until = async (pred, ms = 1500) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 10)); } return pred(); };

test('phone: installed SDK → AVD written, emulator spawned, booted, settled, MCP mounted; section and /phone reflect it', async () => {
  const h = harness();
  assert.ok(await until(() => h.ctx.dshPhone.isReady), 'ready');
  assert.ok(existsSync(join(h.home, 'avd', 'dot.avd', 'config.ini')));
  assert.match(readFileSync(join(h.home, 'avd', 'dot.ini'), 'utf8'), /target=android-35/);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(h.spawned[0].args.slice(0, 4), ['-avd', 'dot', '-port', '5554']);
  assert.ok(h.execs.some((e) => e.some((a) => String(a).includes('stayon'))), 'screen kept on');
  assert.equal(h.plugins.length, 1);
  assert.equal(h.plugins[0].c.serverName, 'phone');
  assert.equal(h.plugins[0].c.transport, 'stdio');
  assert.match(h.plugins[0].c.args[0], /mobile-mcp/);
  assert.match(h.sections[0].text(), /emulator-5554/);
  const out = await h.cmd().handler({ rawInput: '' });
  assert.match(out.text, /phone: ready/);
  assert.match(out.text, /live view: http:\/\/127\.0\.0\.1:18090\//);
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
  assert.equal((await h.gate('mcp__phone__mobile_install_app', {})).kind, 'ask');
  assert.equal((await h.gate('mcp__phone__mobile_swipe_on_screen', {})).via, 'next');
  h.stop();
});

test('live view server: page, status, one stream frame, input mapped to screen pixels, origin check', async () => {
  const { startLiveView, shellQuote } = await import('../src/phone/live-view.js');
  const shells = [];
  const port = 18190 + Math.floor(Math.random() * 100);
  const view = startLiveView({ port, screenshot: async () => Buffer.from('PNG!'), shell: async (c) => { shells.push(c); return c === 'wm size' ? 'Physical size: 1080x2400\n' : ''; }, ready: () => true, logger: {} });
  await new Promise((r) => setTimeout(r, 100));
  const base = `http://127.0.0.1:${port}`;
  assert.match(await (await fetch(`${base}/`)).text(), /<img id="screen" src="stream/);
  assert.deepEqual(await (await fetch(`${base}/status`)).json(), { ready: true, size: null });
  const ac = new AbortController();
  const res = await fetch(`${base}/stream?fps=5`, { signal: ac.signal });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /--frame\r\ncontent-type: image\/png\r\ncontent-length: 4\r\n\r\nPNG!/);
  ac.abort();
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: base, ...headers } });
  assert.equal((await post('/tap', { x: 0.5, y: 0.25 })).status, 204);
  assert.equal(shells.at(-1), 'input tap 540 600');
  assert.equal((await post('/swipe', { from: { x: 0.5, y: 0.8 }, to: { x: 0.5, y: 0.2 }, ms: 300 })).status, 204);
  assert.equal(shells.at(-1), 'input swipe 540 1920 540 480 300');
  assert.equal((await post('/key', { key: 'KEYCODE_BACK' })).status, 204);
  assert.equal((await post('/key', { key: 'rm -rf' })).status, 400);
  assert.equal((await post('/text', { text: 'hi there' })).status, 204);
  assert.equal(shells.at(-1), "input text 'hi%sthere'");
  assert.equal((await post('/tap', { x: 0.5, y: 0.5 }, { origin: 'http://evil.example' })).status, 403);
  assert.equal(shellQuote("a b'c"), "'a%sb'\\''c'");
  view.close();
});

const DUMP = `Notification Manager state:
  Notification List:
  NotificationRecord(0xabc: pkg=com.tencent.mobileqq user=UserHandle{0} id=1 tag=null key=0|com.tencent.mobileqq|1|null|10171: Notification(channel=msg pri=0))
    uid=10171 opPkg=com.tencent.mobileqq
    extras={
      android.title=String (宽)
      android.text=String (hi)
      android.showWhen=Boolean (true)
    }
  NotificationRecord(0xdef: pkg=android user=UserHandle{0} id=17 tag=null key=0|android|17|null|1000: Notification(channel=FOREGROUND))
    extras={
      android.title=String (系统)
      android.text=String (正在运行)
    }
  NotificationRecord(0x222: pkg=com.tencent.mobileqq user=UserHandle{0} id=3 tag=null key=0|com.tencent.mobileqq|3|null|10171: Notification())
    extras={
      android.title=String (群聊)
      android.bigText=String (有人@你)
    }
  mArchive:
  NotificationRecord(0x111: pkg=com.tencent.mobileqq user=UserHandle{0} id=2 tag=null key=0|com.tencent.mobileqq|2|null|10171: Notification())
    extras={
      android.title=String (old)
      android.text=String (old)
    }
`;

test('parseNotifications: active records with title/text, archive excluded', async () => {
  const { parseNotifications } = await import('../src/phone/phone.js');
  const n = parseNotifications(DUMP);
  assert.deepEqual(n.map((x) => [x.pkg, x.title, x.text]), [['com.tencent.mobileqq', '宽', 'hi'], ['android', '系统', '正在运行'], ['com.tencent.mobileqq', '群聊', '有人@你']]);
  assert.equal(n[0].key, '0|com.tencent.mobileqq|1|null|10171');
});

test('phone: new notifications reach listeners once; the shade at start is not news; system apps skipped', async () => {
  let dump = DUMP;
  const h = harness();
  // intercept dumpsys through the run stub: the harness's run returns '' for unknown commands, so wrap
  const got = [];
  h.ctx.dshPhone.adbExec = async (args) => (args.includes('dumpsys') ? { stdout: dump } : { stdout: '' });
  assert.ok(await until(() => h.ctx.dshPhone.isReady));
  h.ctx.dshPhone.onNotification((n) => got.push(n));
  // the watcher runs on an interval of notifyPollMs (4000 in defaults); trigger via a shorter harness? call poll by waiting
  await new Promise((r) => setTimeout(r, 4300));
  assert.equal(got.length, 0, 'what was already there is not announced');
  dump = DUMP.replace('mArchive:', `  NotificationRecord(0x333: pkg=com.tencent.mobileqq user=UserHandle{0} id=9 tag=null key=0|com.tencent.mobileqq|9|null|10171: Notification())
    extras={
      android.title=String (宽)
      android.text=String (你会主动给我发消息吗)
    }
  NotificationRecord(0x444: pkg=android user=UserHandle{0} id=18 tag=null key=0|android|18|null|1000: Notification())
    extras={
      android.title=String (系统)
      android.text=String (更新)
    }
  mArchive:`);
  assert.equal(h.logcats.length, 1, 'logcat tail started once ready');
  h.logcats[0].stdout.emit('data', '[10171,1234,com.tencent.mobileqq,9,NULL,0,Notification(...)]\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(got.map((n) => n.text), ['你会主动给我发消息吗'], 'an enqueue event reads the shade at once');
  assert.match((await h.cmd().handler({ rawInput: 'notifications' })).text, /com\.tencent\.mobileqq: 宽 — 你会主动给我发消息吗/);
  // mute QQ: the next one is seen but not announced; the policy is persisted
  assert.match((await h.cmd().handler({ rawInput: 'notify mute com.tencent.mobileqq' })).text, /except: com\.tencent\.mobileqq/);
  dump = dump.replace('mArchive:', `  NotificationRecord(0x555: pkg=com.tencent.mobileqq user=UserHandle{0} id=10 tag=null key=0|com.tencent.mobileqq|10|null|10171: Notification())
    extras={
      android.title=String (宽)
      android.text=String (在吗)
    }
  mArchive:`);
  h.logcats[0].stdout.emit('data', '[10171,1234,com.tencent.mobileqq,10,NULL,0,Notification(...)]\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(got.length, 1, 'muted app does not wake her');
  assert.deepEqual(JSON.parse(readFileSync(join(process.env.DSH_HOME, 'dsh-phone.json'), 'utf8')).notifyMuted, ['com.tencent.mobileqq']);
  h.stop();
});
