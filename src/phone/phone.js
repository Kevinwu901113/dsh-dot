// dsh-dot/phone: the character's own phone — an Android emulator this plugin installs, boots and
// keeps alive, exposed to the model as mcp__phone__* (mobile-mcp over adb). Nothing to install by
// hand: on first start the plugin fetches the emulator, platform-tools and one system image from
// Google's repository (after the SDK license is accepted), writes the AVD itself (no Java, no
// sdkmanager), boots it, and mounts the MCP server once the phone answers. The phone's window is its
// live view; state (apps, logins) lives in the AVD's data partition and survives dsh restarts.
import { spawn, execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, platform, arch as osArch } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createAudit } from '../computer/audit.js';

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
  acceptLicense: false,     // Android SDK license (https://developer.android.com/studio/terms); `/phone accept` also sets it
  channel: 'stable',        // emulator release channel
  bootTimeoutMs: 300_000,
  restartDelayMs: 10_000,   // relaunch the emulator this long after it exits by itself
  mcp: true,                // mount mobile-mcp as mcp__phone__*
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
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
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
    'hw.audioInput': 'no', 'hw.audioOutput': 'yes', 'hw.camera.back': 'none', 'hw.camera.front': 'none',
    'hw.gps': 'yes', 'hw.battery': 'yes', 'hw.sdCard': 'no', 'fastboot.forceColdBoot': 'no', 'showDeviceFrame': 'no',
  };
  return `${Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/** Approval decision for a phone tool call (null = allow). */
export function phoneGate(exec, cfg) {
  if (!exec.name.startsWith('mcp__phone__')) return null;
  const tool = exec.name.slice('mcp__phone__'.length);
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

/** Download `url` to `file` (streaming; a .part file until complete). */
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
  const cfg = { ...defaults, ...readSettingsFile(), ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) };
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
  phone.status = () => ({ state: phone.state, serial, error: phone.error, api: cfg.api, abi, window: cfg.window, home });
  phone.onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  let markReady;
  phone.ready = new Promise((r) => (markReady = r));
  phone.adbExec = (args, opts) => exec(paths.adb, ['-s', serial, ...args], opts);
  phone.shell = async (cmd) => (await phone.adbExec(['shell', cmd])).stdout;
  /** PNG of the screen right now. */
  phone.screenshot = async () => Buffer.from((await phone.adbExec(['exec-out', 'screencap', '-p'], { encoding: 'buffer' })).stdout);
  phone.accept = () => { cfg.acceptLicense = true; writeSettings({ acceptLicense: true }); audit({ kind: 'license', accepted: true }); if (phone.state === 'needs-license') void start(); };

  const installed = () => existsSync(paths.emulator) && existsSync(paths.adb) && existsSync(join(paths.sysdir, 'system.img'));

  async function ensureSdk() {
    if (installed()) return;
    if (!cfg.acceptLicense) {
      setState('needs-license', `the Android SDK license (${LICENSE_URL}) has not been accepted — reply /phone accept to install the phone`);
      throw new Error('license not accepted');
    }
    setState('downloading');
    const [repoXml, sysImgXml] = await Promise.all([
      fetchImpl(`${REPO}/repository2-3.xml`).then((r) => r.text()),
      fetchImpl(`${REPO}/sys-img/${cfg.tag}/sys-img2-3.xml`).then((r) => r.text()),
    ]);
    const dl = resolveDownloads({ repoXml, sysImgXml, osTag, abi, api: cfg.api, tag: cfg.tag, channel: cfg.channel });
    logger.info(`installing: emulator ${dl.emulator.version}, platform-tools, ${dl.systemImage.path} (${dl.systemImage.sizeMb} MB) → ${home}`);
    const progress = (what) => (got, total) => logger.info(`${what}: ${Math.round(got / 1048576)}${total ? `/${Math.round(total / 1048576)}` : ''} MB`);
    const fetchZip = async (what, url) => { const file = join(paths.downloads, url.split('/').pop()); if (!existsSync(file)) await download(url, file, fetchImpl, progress(what)); return file; };
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

  function ensureAvd() {
    const dir = join(paths.avdHome, `${cfg.avd}.avd`);
    if (existsSync(join(dir, 'config.ini'))) return;
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
  async function settle() {
    // Keep the screen on and animations off: the model reads screenshots, not motion.
    for (const cmd of ['svc power stayon true', 'settings put system screen_off_timeout 2147483647', 'settings put global window_animation_scale 0', 'settings put global transition_animation_scale 0', 'settings put global animator_duration_scale 0', 'input keyevent KEYCODE_WAKEUP', 'wm dismiss-keyguard']) {
      try { await exec(paths.adb, ['-s', serial, 'shell', cmd], { env: env(), timeout: 10_000 }); } catch { /* best effort */ }
    }
  }
  async function mountMcp() {
    if (!cfg.mcp || mcpFork) return;
    let mcpClient, entry;
    try {
      entry = createRequire(import.meta.url).resolve('@mobilenext/mobile-mcp/lib/index.js');
      mcpClient = deps.mcpClient ?? await import('@deepseek-ai/dsh-mcp-client');
    } catch (err) { logger.error(`mcp__phone__* unavailable: ${err.message}`); return; }
    mcpFork = ctx.plugin(mcpClient, {
      transport: 'stdio', serverName: 'phone', command: process.execPath, args: [entry], cwd: home,
      env: { ANDROID_HOME: home, ANDROID_SDK_ROOT: home, ANDROID_SERIAL: serial },
      toolCallTimeoutMs: cfg.toolCallTimeoutMs, failOnStartupError: false, reconnect: { maxAttempts: 1000 },
    });
    logger.info('mcp__phone__* mounted (mobile-mcp over adb)');
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
        const args = ['-avd', cfg.avd, '-port', String(cfg.port), '-no-boot-anim', '-gpu', cfg.gpu, '-netdelay', 'none', '-netspeed', 'full', ...(cfg.window ? [] : ['-no-window'])];
        child = spawnImpl(paths.emulator, args, { env: env(), stdio: ['ignore', 'pipe', 'pipe'], detached: false });
        child.stdout?.on('data', (d) => logger.debug(`emulator: ${String(d).trim()}`));
        child.stderr?.on('data', (d) => logger.debug(`emulator: ${String(d).trim()}`));
        child.on('exit', (code) => {
          child = null;
          if (stopping) return;
          setState('error', `the emulator exited (code ${code})`);
          logger.warn(`emulator exited with ${code}; relaunching in ${cfg.restartDelayMs / 1000}s`);
          setTimeout(() => { if (!stopping) void start(); }, cfg.restartDelayMs);
        });
      }
      await waitBooted();
      await settle();
      setState('ready');
      markReady();
      logger.info(`phone ready — ${serial}, Android API ${cfg.api} (${abi}), ${cfg.window ? 'window on the desktop' : 'headless'}`);
      await mountMcp();
    } catch (err) {
      if (phone.state !== 'needs-license') { setState('error', err.message); logger.error(`phone failed: ${err.message}`); }
    }
  }
  phone.restart = async () => {
    try { await exec(paths.adb, ['-s', serial, 'emu', 'kill'], { env: env(), timeout: 10_000 }); } catch { child?.kill(); }
  };

  ctx.provide('dshPhone', phone);

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
        ? `你有一部自己的手机：Android 模拟器，设备 ${serial}，工具 mcp__phone__*。用法：先 mobile_list_elements_on_screen 看屏幕上有什么（带坐标），再 mobile_click_on_screen_at_coordinates 点；看不清就 mobile_take_screenshot；mobile_launch_app 打开 App，mobile_press_button BACK/HOME 返回。遇到验证码、人脸、短信验证就停下来告诉用户，不要自己绕。`
        : ''),
    }), 'dsh-dot/phone: device section');
  });

  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'phone',
      description: 'the phone: status; "accept" accepts the Android SDK license and installs it; "restart" reboots the emulator; "screenshot" saves the screen to the phone home',
      input: { hint: '[accept | restart | screenshot]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        let extra = '';
        if (arg === 'accept') { phone.accept(); extra = '\nlicense accepted; installing/booting now (watch ~/.dsh/dsh-phone.log)'; }
        else if (arg === 'restart') { await phone.restart(); extra = '\nrestarting'; }
        else if (arg === 'screenshot' && phone.isReady) { const file = join(home, 'last.png'); writeFileSync(file, await phone.screenshot()); extra = `\nsaved ${file}`; }
        const s = phone.status();
        return { kind: 'success', text: `phone: ${s.state}${s.error ? ` — ${s.error}` : ''}\nserial: ${serial} · Android API ${cfg.api} (${abi}) · ${cfg.window ? 'window' : 'headless'} · home: ${home}\nlicense: ${cfg.acceptLicense ? 'accepted' : `not accepted (${LICENSE_URL})`} · mcp: ${mcpFork ? 'mounted' : 'not mounted'}${extra}` };
      },
    }), 'dsh-dot/phone: /phone command');
  });

  ctx.effect(() => {
    void start();
    return () => {
      stopping = true;
      // The phone keeps running across dsh restarts, like the computer does; only the MCP child is ours.
      mcpFork?.dispose?.();
    };
  }, 'dsh-dot/phone: emulator lifecycle');
}
