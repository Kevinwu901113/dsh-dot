// dsh-dot/phone: the character's own phone — an Android emulator this plugin installs, boots and
// keeps alive, exposed to the model as mcp__dot-phone__* (mobile-mcp over adb). Nothing to install by
// hand: on first start the plugin fetches the emulator, platform-tools and one system image from
// Google's repository (after the SDK license is accepted), writes the AVD itself (no Java, no
// sdkmanager), boots it, and mounts the MCP server once the phone answers. The phone's window is its
// live view; state (apps, logins) lives in the AVD's data partition and survives dsh restarts.
import { PHONE_SERVER, PHONE_TOOL_PREFIX } from '../tool-prefixes.js';
import { spawn, execFile } from 'node:child_process';
import { chmodSync, closeSync, readdirSync, createWriteStream, existsSync, openSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, platform, arch as osArch } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createAudit } from '../computer/audit.js';
import { systemProxyEnv } from '../computer/backends/proxy.js';
import { mountLiveView, LIVE_VIEW_PATH } from './live-view.js';
import { localUrl, publicUrlOf } from '../web-auth.js';
import { createShadeWatch, createPolicy, parseShade } from './notifications.js';

/** The virtual scene's "wall" poster, moved to 1.5 m straight in front of the camera's start pose (1 m square). */
const WALL_POSTER = ['poster wall', 'size 1 1', 'position 0 0 -1.5', 'rotation 0 0 0', 'default poster.png', ''].join('\n');

/** @deprecated name kept for callers; see notifications.js */
export const parseNotifications = parseShade;

export const name = 'dot-phone';
export const inject = [];

export const defaults = {
  home: '',                 // where the SDK pieces and the AVD live; default $DSH_HOME/phone
  api: 35,                  // Android API level of the system image (35 = Android 15)
  tag: 'google_apis',       // system image flavour; google_apis has no Play Store (fewer checks, sideload apks)
  abi: '',                  // arm64-v8a | x86_64; default follows the host CPU
  avd: 'dot',               // AVD name; also the phone's name
  device: 'pixel_6',        // hw.device.name
  ramMb: 3072,
  dataGb: 8,
  port: 5554,               // console port; the adb serial is emulator-<port>
  window: true,             // show the emulator window (the phone's live view); false = headless
  gpu: 'auto',
  locale: 'zh-CN',          // the phone's language (emulator -change-locale)
  timezone: 'Asia/Shanghai',
  // Apps she installs herself, the way a person does: her browser may install downloaded APKs.
  // Packages granted "install unknown apps" at boot; [] = she must grant it in Settings first.
  installers: ['com.android.chrome', 'com.google.android.documentsui', 'com.android.documentsui'],
  keepAppsAlive: true,      // no doze / standby / freezer for her apps, so chat apps keep receiving in the background
  keepAliveEveryMinutes: 10, // re-apply for apps installed since boot
  acceptLicense: false,     // Android SDK license (https://developer.android.com/studio/terms); `/phone accept` also sets it
  channel: 'stable',        // emulator release channel
  bootTimeoutMs: 300_000,
  restartDelayMs: 10_000,   // relaunch the emulator this long after it exits by itself
  liveView: true,           // the live view page (screen + tap/swipe/type) at /dsh-dot/phone/ on dsh's own web server, behind dsh's login
  publicUrl: '',            // the public origin of THIS dsh (your own exposure, e.g. tailscale serve of dsh's port); the live view is <publicUrl>/dsh-dot/phone/
  // Notifications: the phone's notification shade is polled (adb dumpsys) and new ones are handed to
  // listeners (dot wakes her for them). notifyApps: packages that count; [] = every non-system app.
  notifications: true,      // watch the shade at all
  notifyPollMs: 4000,       // reconcile snapshot interval (events trigger immediate reads); 0 = events only
  notifyApps: [],           // [] = every app she installs, now or later, until muted
  notifyMuted: [],          // packages whose notifications never wake her (also /phone notify mute <pkg>, persisted)
  mcp: true,                // mount mobile-mcp as mcp__dot-phone__*
  toolCallTimeoutMs: 60_000,
  // Gate: phone tools that are asked for approval (dsh-computer-style), and typed text that is.
  askTools: ['mobile_install_app', 'mobile_uninstall_app'],
  sensitivePatterns: ['password', '密码', '支付', '付款', 'pay', '转账', '验证码', 'otp', 'credit card', '银行卡'],
};

const REPO = 'https://dl.google.com/android/repository';
const LICENSE_URL = 'https://developer.android.com/studio/terms';
const CHANNELS = { stable: 'channel-0', beta: 'channel-1', dev: 'channel-2', canary: 'channel-3' };

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
export const settingsFile = () => join(dshHome(), 'dsh-phone.json');
export const auditFile = () => join(dshHome(), 'dsh-phone-audit.jsonl');

/** Optional user settings file ($DSH_HOME/dsh-phone.json), for the desktop app which has no shell env. */
export function readSettingsFile() {
  try { return existsSync(settingsFile()) ? JSON.parse(readFileSync(settingsFile(), 'utf8')) : {}; } catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettingsFile(), ...patch };
  mkdirSync(dirname(settingsFile()), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2), { mode: 0o600 });
  try { chmodSync(settingsFile(), 0o600); } catch {}
  return next;
}

/** Host OS tag used in Google's archive names and the matching default ABI. */
export function hostTarget(os = platform(), cpu = osArch()) {
  const osTag = os === 'darwin' ? 'darwin' : os === 'win32' ? 'windows' : 'linux';
  const abi = cpu === 'arm64' ? 'arm64-v8a' : 'x86_64';
  return { osTag, abi };
}

/**
 * Pick the three archives to fetch from Google's repository indexes (repository2-3.xml for the
 * emulator and platform-tools; sys-img2-3.xml of the tag for the system image).
 * @returns {{emulator: {url: string, version: string}, platformTools: {url: string}, systemImage: {url: string, path: string, sizeMb: number}}}
 */
export function resolveDownloads({ repoXml, sysImgXml, osTag, abi, api, tag = 'google_apis', channel = 'stable' }) {
  const wantChannel = CHANNELS[channel] ?? CHANNELS.stable;
  const pkgs = (xml, path) => [...xml.matchAll(new RegExp(`<remotePackage path="${path.replace(/[.*+?^${}()|[\]\\;]/g, '\\$&')}">([\\s\\S]*?)</remotePackage>`, 'g'))].map((m) => m[1]);
  const channelOf = (blk) => /<channelRef ref="(channel-\d)"/.exec(blk)?.[1] ?? 'channel-0';
  const urls = (blk) => [...blk.matchAll(/<url>([^<]+)<\/url>/g)].map((m) => m[1]);
  const version = (blk) => { const m = /<revision>\s*<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/.exec(blk); return m ? `${m[1]}.${m[2]}.${m[3]}` : '?'; };
  const emulatorOs = osTag === 'windows' ? 'windows' : osTag;
  const emuBlocks = pkgs(repoXml, 'emulator').filter((b) => channelOf(b) === wantChannel);
  const emuBlock = emuBlocks.find((b) => urls(b).some((u) => u.includes(`-${emulatorOs}_${abi === 'arm64-v8a' ? 'aarch64' : 'x64'}-`))) ?? emuBlocks[0];
  if (!emuBlock) throw new Error(`no emulator package on the ${channel} channel`);
  const emuUrl = urls(emuBlock).find((u) => u.includes(`-${emulatorOs}_${abi === 'arm64-v8a' ? 'aarch64' : 'x64'}-`));
  if (!emuUrl) throw new Error(`no emulator build for ${emulatorOs}/${abi}`);
  const ptBlock = pkgs(repoXml, 'platform-tools').find((b) => channelOf(b) === 'channel-0') ?? pkgs(repoXml, 'platform-tools')[0];
  const ptUrl = ptBlock && urls(ptBlock).find((u) => u.includes(osTag === 'windows' ? '-win.' : `-${osTag}.`));
  if (!ptUrl) throw new Error(`no platform-tools build for ${osTag}`);
  const path = `system-images;android-${api};${tag};${abi}`;
  const imgBlock = pkgs(sysImgXml, path).find((b) => channelOf(b) === 'channel-0') ?? pkgs(sysImgXml, path)[0];
  if (!imgBlock) throw new Error(`no system image ${path}`);
  const size = Number(/<size>(\d+)<\/size>/.exec(imgBlock)?.[1] ?? 0);
  return {
    emulator: { url: `${REPO}/${emuUrl}`, version: version(emuBlock) },
    platformTools: { url: `${REPO}/${ptUrl}` },
    systemImage: { url: `${REPO}/sys-img/${tag}/${urls(imgBlock)[0]}`, path, sizeMb: Math.round(size / 1048576) },
  };
}

/** The AVD's config.ini — what avdmanager would write, minus Java. */
export function avdConfig({ avd, api, tag, abi, device, ramMb, dataGb }) {
  const cpuArch = abi === 'arm64-v8a' ? 'arm64' : 'x86_64';
  const lines = {
    AvdId: avd, 'avd.ini.displayname': avd, 'avd.ini.encoding': 'UTF-8',
    'abi.type': abi, 'hw.cpu.arch': cpuArch, 'hw.cpu.ncore': 4,
    'image.sysdir.1': `system-images/android-${api}/${tag}/${abi}/`, 'tag.id': tag, 'tag.display': tag === 'google_apis' ? 'Google APIs' : tag,
    'PlayStore.enabled': 'false', 'hw.device.name': device, 'hw.device.manufacturer': 'Google',
    'hw.lcd.width': 1080, 'hw.lcd.height': 2400, 'hw.lcd.density': 420, 'skin.name': '1080x2400', 'skin.dynamic': 'yes',
    'hw.ramSize': ramMb, 'vm.heapSize': 256, 'disk.dataPartition.size': `${dataGb}G`,
    'hw.keyboard': 'yes', 'hw.mainKeys': 'no', 'hw.dPad': 'no', 'hw.trackBall': 'no',
    'hw.gpu.enabled': 'yes', 'hw.gpu.mode': 'auto', 'hw.initialOrientation': 'portrait',
    'hw.accelerometer': 'yes', 'hw.gyroscope': 'yes', 'hw.sensors.orientation': 'yes', 'hw.sensors.proximity': 'yes',
    // The back camera is the emulator's virtual scene: a room with a poster on the wall. Whatever PNG
    // dsh-dot puts on that poster (a login QR, say) is what an app's camera sees — a real scan, not an album import.
    'hw.audioInput': 'no', 'hw.audioOutput': 'yes', 'hw.camera.back': 'virtualscene', 'hw.camera.front': 'none',
    'hw.gps': 'yes', 'hw.battery': 'yes', 'hw.sdCard': 'no', 'fastboot.forceColdBoot': 'no', 'showDeviceFrame': 'no',
  };
  return `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/** Approval decision for a phone tool call (null = allow). */
export function phoneGate(exec, cfg) {
  if (!exec.name.startsWith(PHONE_TOOL_PREFIX)) return null;
  const tool = exec.name.slice(PHONE_TOOL_PREFIX.length);
  if (cfg.askTools.includes(tool)) return `dsh-dot/phone: ${tool}`;
  if (tool === 'mobile_type_keys') {
    const text = JSON.stringify(exec.input ?? exec.args ?? exec.arguments ?? {});
    if (cfg.sensitivePatterns.some((p) => new RegExp(p, 'i').test(text))) return 'dsh-dot/phone: typing something that looks sensitive';
  }
  return null;
}

/** Phone tools an observation turn may use: look, scroll, open an app, go back; never type, install or open URLs. */
export const OBSERVATION_TOOLS = ['mobile_list_available_devices', 'mobile_get_screen_size', 'mobile_get_orientation', 'mobile_list_apps', 'mobile_launch_app', 'mobile_take_screenshot', 'mobile_list_elements_on_screen', 'mobile_click_on_screen_at_coordinates', 'mobile_swipe_on_screen', 'mobile_press_button'];


function withFileLog(logger) {
  const file = join(dshHome(), 'dsh-phone.log');
  try { if (statSync(file).size > 1_000_000) rmSync(file, { force: true }); } catch {}
  const write = (level, args) => { try { appendFileSync(file, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}\n`); } catch {} };
  const wrapped = Object.create(logger);
  for (const level of ['debug', 'info', 'warn', 'error']) wrapped[level] = (...args) => { write(level, args); return logger[level]?.(...args); };
  return wrapped;
}

const run = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Google's repository is unreachable from some networks without a proxy. Node's fetch ignores the
 * OS proxy (Clash, Surge…), curl honors HTTPS_PROXY; so the real downloads go through curl with
 * the system proxy translated into env, resumable (-C -) because the system image is 1.7 GB.
 */
const curlEnv = () => ({ ...process.env, ...systemProxyEnv() });
async function curlText(url) {
  const { stdout } = await run('curl', ['-sSL', '--fail', '--retry', '3', '--max-time', '120', url], { env: curlEnv(), maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
async function curlDownload(url, file, onProgress) {
  mkdirSync(dirname(file), { recursive: true });
  const part = `${file}.part`;
  const tick = setInterval(() => { try { onProgress?.(statSync(part).size, 0); } catch { /* not started yet */ } }, 5000);
  try { await run('curl', ['-sSL', '--fail', '--retry', '5', '--retry-all-errors', '-C', '-', '-o', part, url], { env: curlEnv(), timeout: 0 }); } finally { clearInterval(tick); }
  renameSync(part, file);
}

/** Download `url` to `file` with Node's fetch (tests inject it; production uses curl above). */
async function download(url, file, fetchImpl, onProgress) {
  mkdirSync(dirname(file), { recursive: true });
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let got = 0, lastTick = 0;
  const counter = new Transform({ transform(chunk, _e, cb) { got += chunk.length; if (Date.now() - lastTick > 5000) { lastTick = Date.now(); onProgress?.(got, total); } cb(null, chunk); } });
  await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
}

/** Unzip with what the host has: bsdtar/unzip on macOS and Linux, PowerShell on Windows. */
async function unzip(zip, into) {
  mkdirSync(into, { recursive: true });
  if (platform() === 'win32') return run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${into}'`]);
  try { return await run('unzip', ['-oq', zip, '-d', into]); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return run('tar', ['-xf', zip, '-C', into]);
}

export function apply(ctx, config = {}, deps = {}) {
  const settings = readSettingsFile();
  const cfg = { ...defaults, ...settings, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) };
  // The license, once accepted (settings file), stays accepted whatever the patch's default says.
  cfg.acceptLicense = Boolean(cfg.acceptLicense || settings.acceptLicense);
  const logger = withFileLog(ctx.logger('dsh-dot/phone'));
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const spawnImpl = deps.spawn ?? spawn;
  const exec = deps.run ?? run;
  const home = cfg.home || join(dshHome(), 'phone');
  const { osTag, abi: hostAbi } = hostTarget();
  const abi = cfg.abi || hostAbi;
  const exe = (p) => (osTag === 'windows' ? `${p}.exe` : p);
  const paths = {
    sdk: home,
    emulator: join(home, 'emulator', exe('emulator')),
    adb: join(home, 'platform-tools', exe('adb')),
    sysdir: join(home, 'system-images', `android-${cfg.api}`, cfg.tag, abi),
    avdHome: join(home, 'avd'),
    downloads: join(home, 'downloads'),
  };
  const serial = `emulator-${cfg.port}`;
  const audit = createAudit(auditFile());

  const phone = {
    serial, home, abi, api: cfg.api, avd: cfg.avd, adb: paths.adb,
    state: 'starting', error: undefined, isReady: false, licenseUrl: LICENSE_URL,
    liveViewUrl: undefined, // filled when the live view mounts (dsh's origin + /dsh-dot/phone/)
    publicLiveViewUrl: cfg.liveView ? publicUrlOf(cfg.publicUrl, `${LIVE_VIEW_PATH}/`) : undefined,
    audit,
  };
  const listeners = new Set();
  let lastState;
  const setState = (state, error) => {
    phone.state = state; phone.error = error; phone.isReady = state === 'ready';
    if (state === lastState) return;
    lastState = state;
    audit({ kind: 'status', state, error });
    for (const fn of listeners) { try { fn(phone.status()); } catch {} }
  };
  phone.status = () => ({ state: phone.state, serial, error: phone.error, api: cfg.api, abi, window: cfg.window, home, liveViewUrl: phone.liveViewUrl, publicLiveViewUrl: phone.publicLiveViewUrl });
  phone.onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  let markReady;
  phone.ready = new Promise((r) => (markReady = r));
  phone.adbExec = (args, opts) => exec(paths.adb, ['-s', serial, ...args], opts);
  phone.shell = async (cmd) => (await phone.adbExec(['shell', cmd])).stdout;
  /** Third-party packages on her phone — the apps she installed herself (cached a minute). */
  let appsCache = { at: 0, pkgs: [] };
  phone.apps = async () => {
    if (!phone.isReady) return [];
    if (Date.now() - appsCache.at < 60000) return appsCache.pkgs;
    try { appsCache = { at: Date.now(), pkgs: (await phone.shell('pm list packages -3')).split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean) }; } catch (error) { void error; }
    return appsCache.pkgs;
  };
  /** PNG of the screen right now. */
  phone.screenshot = async () => Buffer.from((await phone.adbExec(['exec-out', 'screencap', '-p'], { encoding: 'buffer' })).stdout);
  /**
   * Put a PNG in front of her camera, live: the emulator console's `virtualscene-image wall <png>`
   * swaps the "wall" poster's picture while the phone runs, and ensureCameraScene (before launch) has
   * moved that poster to 1.5 m straight in front of the camera's start pose. After this, QQ → 扫一扫
   * sees the image filling the view. Returns the image path.
   */
  phone.showToCamera = async (png) => {
    const f = posterFiles();
    mkdirSync(f.dir, { recursive: true });
    // A new file name every time too, so no cached picture is ever taken for the new one.
    const file = join(f.dir, `dsh-dot-poster-${Date.now()}.png`);
    writeFileSync(file, png);
    // Clear first: after the first picture an emulator process takes a new one only from a cleared poster.
    try { await phone.adbExec(['emu', 'virtualscene-image', 'wall']); } catch {}
    const out = String((await phone.adbExec(['emu', 'virtualscene-image', 'wall', file])).stdout ?? '');
    if (/\bKO\b/.test(out)) throw new Error(`the emulator refused the camera image: ${out.trim()}`);
    for (const n of readdirSync(f.dir)) if (/^dsh-dot-poster(-\d+)?\.png$/.test(n) && join(f.dir, n) !== file) { try { rmSync(join(f.dir, n), { force: true }); } catch {} }
    return file;
  };
  phone.clearCamera = async () => { try { await phone.adbExec(['emu', 'virtualscene-image', 'wall']); } catch {} };
  // Notifications: what her phone shows her (see notifications.js). Listeners get posted and
  // updated ones once each; the policy decides which apps count.
  const notifyListeners = new Set();
  const recent = [];
  const policy = createPolicy({ only: cfg.notifyApps, muted: [...(cfg.notifyMuted ?? []), ...(settings.notifyMuted ?? [])] });
  phone.notifyPolicy = () => ({ muted: policy.muted(), apps: policy.apps() });
  phone.setNotifyPolicy = (pkg, p) => { policy.set(pkg, p); writeSettings({ notifyMuted: policy.muted() }); audit({ kind: 'notify-policy', pkg, policy: p }); };
  phone.onNotification = (fn) => { notifyListeners.add(fn); return () => notifyListeners.delete(fn); };
  phone.notifications = () => [...recent];
  const shade = createShadeWatch({
    readShade: async () => (await phone.adbExec(['shell', 'dumpsys', 'notification', '--noredact'], { env: env(), timeout: 10_000 })).stdout,
    tailEvents: (onEvent) => {
      // `-T 1`: from now, not the buffer's history. Restarted if it dies while the phone is up.
      let proc = null, stopped = false;
      const open = () => {
        if (stopped) return;
        if (!phone.isReady) { setTimeout(open, 5000).unref?.(); return; } // the phone is restarting: try again once it is up
        try { proc = spawnImpl(paths.adb, ['-s', serial, 'logcat', '-b', 'events', '-v', 'raw', '-T', '1', 'notification_enqueue:I', '*:S'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { logger.warn(`notification tail: ${err.message}`); return; }
        proc.stdout?.on('data', (d) => { if (String(d).includes('[')) onEvent(); });
        proc.on('exit', () => { proc = null; if (!stopped) setTimeout(open, 5000).unref?.(); });
      };
      open();
      return () => { stopped = true; proc?.kill(); proc = null; };
    },
    pollMs: cfg.notifyPollMs,
    wanted: (n) => policy.wanted(n),
    onChange: (kind, n) => {
      if (kind === 'removed') return;
      recent.push(n); if (recent.length > 20) recent.shift();
      audit({ kind: 'notification', change: kind, pkg: n.pkg, title: n.title, text: n.text.slice(0, 200), postedAt: n.postedAt ? new Date(n.postedAt).toISOString() : undefined, lagMs: n.lagMs });
      for (const fn of notifyListeners) { try { fn(n); } catch (err) { logger.warn(`notification listener: ${err.message}`); } }
    },
    logger,
  });
  phone.accept = () => { cfg.acceptLicense = true; writeSettings({ acceptLicense: true }); audit({ kind: 'license', accepted: true }); if (phone.state === 'needs-license' || phone.state === 'error') void start(); };

  const installed = () => existsSync(paths.emulator) && existsSync(paths.adb) && existsSync(join(paths.sysdir, 'system.img'));

  async function ensureSdk() {
    if (installed()) return;
    if (!cfg.acceptLicense) {
      setState('needs-license', `the Android SDK license (${LICENSE_URL}) has not been accepted — reply /phone accept to install the phone`);
      throw new Error('license not accepted');
    }
    setState('downloading');
    const text = (url) => (deps.fetch ? fetchImpl(url).then((r) => r.text()) : curlText(url));
    const proxy = systemProxyEnv().HTTPS_PROXY;
    if (proxy) logger.info(`downloading through the system proxy ${proxy}`);
    const [repoXml, sysImgXml] = await Promise.all([text(`${REPO}/repository2-3.xml`), text(`${REPO}/sys-img/${cfg.tag}/sys-img2-3.xml`)]);
    const dl = resolveDownloads({ repoXml, sysImgXml, osTag, abi, api: cfg.api, tag: cfg.tag, channel: cfg.channel });
    logger.info(`installing: emulator ${dl.emulator.version}, platform-tools, ${dl.systemImage.path} (${dl.systemImage.sizeMb} MB) → ${home}`);
    const progress = (what) => (got, total) => logger.info(`${what}: ${Math.round(got / 1048576)}${total ? `/${Math.round(total / 1048576)}` : ''} MB`);
    const fetchZip = async (what, url) => { const file = join(paths.downloads, url.split('/').pop()); if (!existsSync(file)) await (deps.fetch ? download(url, file, fetchImpl, progress(what)) : curlDownload(url, file, progress(what))); return file; };
    if (!existsSync(paths.adb)) await unzip(await fetchZip('platform-tools', dl.platformTools.url), home);
    if (!existsSync(paths.emulator)) await unzip(await fetchZip('emulator', dl.emulator.url), home);
    if (!existsSync(join(paths.sysdir, 'system.img'))) {
      const tmp = join(home, 'downloads', 'sysimg');
      rmSync(tmp, { recursive: true, force: true });
      await unzip(await fetchZip('system image', dl.systemImage.url), tmp);
      mkdirSync(dirname(paths.sysdir), { recursive: true });
      renameSync(join(tmp, abi), paths.sysdir);
    }
    mkdirSync(join(home, 'platforms'), { recursive: true }); // the emulator expects the folder to exist
    rmSync(paths.downloads, { recursive: true, force: true });
    audit({ kind: 'installed', emulator: dl.emulator.version, systemImage: dl.systemImage.path });
  }

  /** The poster file of the virtual-scene camera (read when an app opens the camera) and the PNG it shows. */
  /** The emulator's scene poster list (resources/Toren1BD.posters, read at launch) and the image dsh-dot shows her camera. */
  const posterFiles = () => { const dir = join(dirname(paths.emulator), 'resources'); return { dir, posters: join(dir, 'Toren1BD.posters'), png: join(dir, 'dsh-dot-poster.png') }; };
  /** Before launch: the stock "wall" poster (behind the camera's start pose) moves in front of it; "table" stays. The original is kept as .orig. */
  function ensureCameraScene() {
    try {
      const f = posterFiles();
      if (!existsSync(f.posters)) return;
      if (!existsSync(`${f.posters}.orig`)) writeFileSync(`${f.posters}.orig`, readFileSync(f.posters));
      const stock = readFileSync(`${f.posters}.orig`, 'utf8');
      const table = /poster table[\s\S]*?(?=\n\s*\n|\n?$)/.exec(stock)?.[0];
      const want = `${WALL_POSTER}${table ? `\n${table.trimEnd()}\n` : ''}`;
      if (readFileSync(f.posters, 'utf8') !== want) writeFileSync(f.posters, want);
    } catch (err) { logger.warn(`camera scene: ${err.message}`); }
  }
  function ensureAvd() {
    const dir = join(paths.avdHome, `${cfg.avd}.avd`);
    if (existsSync(join(dir, 'config.ini'))) {
      // An AVD created before the camera existed: give it one (takes effect at the emulator's next start).
      try {
        const ini = readFileSync(join(dir, 'config.ini'), 'utf8');
        if (/^hw\.camera\.back=none$/m.test(ini)) { writeFileSync(join(dir, 'config.ini'), ini.replace(/^hw\.camera\.back=none$/m, 'hw.camera.back=virtualscene')); audit({ kind: 'avd-camera-enabled', avd: cfg.avd }); }
      } catch (err) { logger.warn(`could not enable the camera on ${cfg.avd}: ${err.message}`); }
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.ini'), avdConfig({ ...cfg, abi }));
    writeFileSync(join(paths.avdHome, `${cfg.avd}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${cfg.avd}.avd\ntarget=android-${cfg.api}\n`);
    audit({ kind: 'avd-created', avd: cfg.avd, api: cfg.api, abi });
  }

  const env = () => ({ ...process.env, ANDROID_HOME: home, ANDROID_SDK_ROOT: home, ANDROID_AVD_HOME: paths.avdHome, ANDROID_SERIAL: serial, PATH: `${join(home, 'platform-tools')}${osTag === 'windows' ? ';' : ':'}${process.env.PATH ?? ''}` });

  let child = null, stopping = false, mcpFork = null;
  async function waitBooted() {
    const deadline = Date.now() + cfg.bootTimeoutMs;
    while (Date.now() < deadline) {
      if (stopping) throw new Error('stopped');
      try {
        const { stdout } = await exec(paths.adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], { env: env(), timeout: 10_000 });
        if (String(stdout).trim() === '1') return;
      } catch { /* adb not up yet, or the device not listed yet */ }
      await sleep(3000);
    }
    throw new Error(`the phone did not finish booting in ${Math.round(cfg.bootTimeoutMs / 1000)}s`);
  }
  const sh = async (cmd) => { try { return (await exec(paths.adb, ['-s', serial, 'shell', cmd], { env: env(), timeout: 10_000 })).stdout; } catch { return ''; } };
  async function settle() {
    // Keep the screen on and animations off: the model reads screenshots, not motion.
    for (const cmd of ['svc power stayon true', 'settings put system screen_off_timeout 2147483647', 'settings put global window_animation_scale 0', 'settings put global transition_animation_scale 0', 'settings put global animator_duration_scale 0', 'input keyevent KEYCODE_WAKEUP', 'wm dismiss-keyguard',
      // She gets her apps herself — download the APK in her browser, tap install — so the browser and the file manager may install.
      ...cfg.installers.map((pkg) => `appops set ${pkg} REQUEST_INSTALL_PACKAGES allow`),
      // Her apps must stay connected in the background: no doze, no standby buckets, no adaptive battery.
      // (The emulator has no battery to save; Android would still freeze QQ a few minutes after she
      // leaves it, and a frozen chat app receives nothing until it is opened again.)
      ...(cfg.keepAppsAlive ? ['dumpsys deviceidle disable', 'settings put global app_standby_enabled 0', 'settings put global adaptive_battery_management_enabled 0', 'settings put global cached_apps_freezer disabled'] : [])]) {
      await sh(cmd);
    }
    if (cfg.keepAppsAlive) await keepAppsAlive();
  }
  /** Per-app background allowances for every third-party app on the phone — the ones she installed included. */
  async function keepAppsAlive() {
    const pkgs = (await sh('pm list packages -3')).split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean);
    for (const pkg of pkgs) {
      for (const cmd of [`dumpsys deviceidle whitelist +${pkg}`, `cmd appops set ${pkg} RUN_ANY_IN_BACKGROUND allow`, `cmd appops set ${pkg} RUN_IN_BACKGROUND allow`, `am set-standby-bucket ${pkg} active`]) await sh(cmd);
    }
    return pkgs;
  }
  async function mountMcp() {
    if (!cfg.mcp || mcpFork) return;
    let mcpClient, entry;
    try {
      entry = createRequire(import.meta.url).resolve('@mobilenext/mobile-mcp/lib/index.js');
      mcpClient = deps.mcpClient ?? await import('@deepseek-ai/dsh-mcp-client');
    } catch (err) { logger.error(`${PHONE_TOOL_PREFIX}* unavailable: ${err.message}`); return; }
    mcpFork = ctx.plugin(mcpClient, {
      transport: 'stdio', serverName: PHONE_SERVER, command: process.execPath, args: [entry], cwd: home,
      // ELECTRON_RUN_AS_NODE: inside the desktop app process.execPath is Electron; this makes it run as plain Node.
      env: { ANDROID_HOME: home, ANDROID_SDK_ROOT: home, ANDROID_SERIAL: serial, ELECTRON_RUN_AS_NODE: '1' },
      toolCallTimeoutMs: cfg.toolCallTimeoutMs, failOnStartupError: false, reconnect: { maxAttempts: 1000 },
    });
    logger.info(`${PHONE_TOOL_PREFIX}* mounted (mobile-mcp over adb)`);
  }
  /** Is this AVD already up (left from a previous dsh run)? Then attach instead of launching twice. */
  async function alreadyRunning() {
    try { const { stdout } = await exec(paths.adb, ['devices'], { env: env(), timeout: 10_000 }); return new RegExp(`^${serial}\\s+(device|offline)`, 'm').test(String(stdout)); } catch { return false; }
  }
  async function start() {
    try {
      await ensureSdk();
      ensureAvd();
      setState('booting');
      if (await alreadyRunning()) {
        logger.info(`${serial} is already running; attaching`);
      } else {
        ensureCameraScene();
        const args = ['-avd', cfg.avd, '-port', String(cfg.port), '-no-boot-anim', '-gpu', cfg.gpu, '-netdelay', 'none', '-netspeed', 'full', ...(cfg.locale ? ['-change-locale', cfg.locale] : []), ...(cfg.timezone ? ['-timezone', cfg.timezone] : []), ...(cfg.window ? [] : ['-no-window'])];
        // The phone outlives dsh (see the lifecycle effect), so it must not hold dsh's event loop:
        // no pipes back to us (output goes to emulator.log), its own process group, and unref'd.
        // A piped, referenced child kept the Host alive after shutdown until the desktop updater
        // timed out ("Host did not complete graceful task teardown").
        mkdirSync(home, { recursive: true });
        const log = openSync(join(home, 'emulator.log'), 'a');
        try { child = spawnImpl(paths.emulator, args, { env: env(), stdio: ['ignore', log, log], detached: true }); } finally { closeSync(log); }
        child.unref?.();
        child.on('exit', (code) => {
          child = null;
          if (stopping) return;
          setState('error', `the emulator exited (code ${code})`);
          logger.warn(`emulator exited with ${code}; relaunching in ${cfg.restartDelayMs / 1000}s`);
          setTimeout(() => { if (!stopping) void start(); }, cfg.restartDelayMs).unref?.();
        });
      }
      await waitBooted();
      await settle();
      if (stopping) return; // disposed while booting: leave nothing running on our side
      setState('ready');
      markReady();
      if (cfg.notifications) shade.start();
      logger.info(`phone ready — ${serial}, Android API ${cfg.api} (${abi}), ${cfg.window ? 'window on the desktop' : 'headless'}`);
      await mountMcp();
    } catch (err) {
      if (phone.state !== 'needs-license') {
        const message = /fetch failed|curl|ENOTFOUND|ECONN|timed out/i.test(err.message) && phone.state === 'downloading' ? `download failed (${err.message}) — dl.google.com must be reachable; set HTTPS_PROXY or the system proxy and /phone retry` : err.message;
        setState('error', message); logger.error(`phone failed: ${message}`);
      }
    }
  }
  /**
   * Stop the emulator and start it again. An emulator dsh attached to (left from an earlier run) is
   * not our child, so nothing would relaunch it on exit: wait until adb no longer lists it, then start.
   */
  phone.restart = async () => {
    setState('booting');
    const ours = child;
    if (ours) ours.removeAllListeners('exit'); // its own relaunch-on-exit must not race this one
    child = null;
    try { await exec(paths.adb, ['-s', serial, 'emu', 'kill'], { env: env(), timeout: 10_000 }); } catch { ours?.kill(); }
    for (let i = 0; i < 30 && (await alreadyRunning()); i++) await new Promise((r) => setTimeout(r, 1000));
    try { ours?.kill('SIGKILL'); } catch {}
    void start();
  };

  ctx.provide('dshPhone', phone);
  // The live view rides on dsh's own web server and login (see src/web-auth.js): no port of its own.
  if (cfg.liveView) {
    ctx.inject(['webServer', 'connection'], (c) => c.effect(() => {
      const view = (deps.mountLiveView ?? mountLiveView)({ webServer: c.webServer, connection: c.connection, screenshot: phone.screenshot, shell: phone.shell, ready: () => phone.isReady, logger, name: cfg.avd });
      phone.liveViewUrl = localUrl(c.webServer, `${LIVE_VIEW_PATH}/`) || `${LIVE_VIEW_PATH}/`;
      return () => { view.close(); phone.liveViewUrl = undefined; };
    }, 'dsh-dot/phone: live view'));
  }

  // Approval gate for phone tools: installs/uninstalls, and typing that looks like a secret or a payment.
  ctx.on('tools/pre-execute', async (exec_, next) => {
    const reason = phoneGate(exec_, cfg);
    if (!reason) return next();
    audit({ kind: 'approval-asked', tool: exec_.name, session: exec_.agent?.session?.id, reason });
    return { kind: 'ask', reason };
  });

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'phone:device',
      order: 60,
      text: () => (phone.state === 'ready'
        ? `你有一部自己的手机：Android（设备 ${serial}，工具 ${PHONE_TOOL_PREFIX}*）。手机上来了通知（QQ 消息之类）会直接叫醒你，用不着定闹钟去看——但 App 开在前台时不会有通知，所以每次用完 App 记得按 HOME 回到桌面。用法：先 mobile_list_elements_on_screen 看屏幕上有什么（带坐标），再 mobile_click_on_screen_at_coordinates 点；看不清就 mobile_take_screenshot；mobile_launch_app 打开 App，mobile_press_button BACK/HOME 返回。这部手机没有应用商店：想要什么 App 就像人一样自己装——用手机上的浏览器打开官网下载安装包，点开安装（浏览器已被允许安装）。登录、验证码、人脸、短信验证由用户来做：停下来告诉他，不要自己绕。`
        : ''),
    }), 'dsh-dot/phone: device section');
  });

  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'phone',
      description: 'the phone: status; "accept" accepts the Android SDK license and installs it; "restart" reboots the emulator; "screenshot" saves the screen to the phone home',
      input: { hint: '[accept | retry | restart | screenshot | notifications | notify [mute|wake <pkg>]]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        let extra = '';
        if (arg === 'accept') { phone.accept(); extra = '\nlicense accepted; installing/booting now (watch ~/.dsh/dsh-phone.log)'; }
        else if (arg === 'retry') { if (phone.state === 'error') { void start(); extra = '\nretrying'; } else extra = `\nnothing to retry (state ${phone.state})`; }
        else if (arg === 'restart') { await phone.restart(); extra = '\nrestarting'; }
        else if (arg === 'screenshot' && phone.isReady) { const file = join(home, 'last.png'); writeFileSync(file, await phone.screenshot()); extra = `\nsaved ${file}`; }
        if (arg === 'notifications') extra = `\n${recent.length ? recent.map((n) => `${n.at.slice(11, 19)} ${n.pkg}: ${n.title} — ${n.text}${n.lagMs !== undefined ? ` (seen ${(n.lagMs / 1000).toFixed(1)}s after the app posted it)` : ''}`).join('\n') : '(none since start)'}`;
        else if (/^notify\b/.test(arg)) {
          const [, verb, pkg] = arg.split(/\s+/);
          if ((verb === 'mute' || verb === 'wake') && pkg) { phone.setNotifyPolicy(pkg, verb); extra = `\n${pkg}: ${verb}`; }
          const pol = phone.notifyPolicy();
          extra += `\nnotifications wake her from every app except: ${pol.muted.length ? pol.muted.join(', ') : '(none muted)'}\napps seen: ${pol.apps.length ? pol.apps.map((a) => `${a.pkg} ×${a.count} (${a.policy})`).join(', ') : '(none yet)'}\n/phone notify mute <pkg> · /phone notify wake <pkg>`;
        }
        const s = phone.status();
        return { kind: 'success', text: `phone: ${s.state}${s.error ? ` — ${s.error}` : ''}\nserial: ${serial} · Android API ${cfg.api} (${abi}) · ${cfg.window ? 'window' : 'headless'} · home: ${home}\nlive view: ${phone.publicLiveViewUrl ?? phone.liveViewUrl ?? 'off'}\nlicense: ${cfg.acceptLicense ? 'accepted' : `not accepted (${LICENSE_URL})`} · mcp: ${mcpFork ? 'mounted' : 'not mounted'}${extra}` };
      },
    }), 'dsh-dot/phone: /phone command');
  });

  ctx.effect(() => () => shade.stop(), 'dsh-dot/phone: notification watch');
  ctx.effect(() => {
    const timer = cfg.keepAppsAlive && cfg.keepAliveEveryMinutes > 0 ? setInterval(() => { if (phone.isReady) void keepAppsAlive(); }, cfg.keepAliveEveryMinutes * 60000) : null;
    return () => { if (timer) clearInterval(timer); };
  }, 'dsh-dot/phone: keep apps alive');
  ctx.effect(() => {
    void start();
    return () => {
      stopping = true;
      // The phone keeps running across dsh restarts, like the computer does; only the MCP child is ours.
      mcpFork?.dispose?.();
    };
  }, 'dsh-dot/phone: emulator lifecycle');
}
