// dsh-dot/phone: the character's own phone — an Android emulator this plugin installs, boots and
// keeps alive, exposed to the model as mcp__dot-phone__* (mobile-mcp over adb). Nothing to install by
// hand: on first start the plugin fetches the emulator, platform-tools and one system image from
// Google's repository (after the SDK license is accepted), writes the AVD itself (no Java, no
// sdkmanager), boots it, and mounts the MCP server once the phone answers. The phone's window is its
// live view; state (apps, logins) lives in the AVD's data partition and survives dsh restarts.
import { PHONE_SERVER, PHONE_TOOL_PREFIX, PHONE_ZOOM_TOOL } from '../tool-prefixes.js';
import { spawn, execFile } from 'node:child_process';
import { chmodSync, closeSync, readdirSync, createWriteStream, existsSync, openSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, platform, arch as osArch } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { deflateSync, inflateSync } from 'node:zlib';
import { createAudit } from '../computer/audit.js';
import { systemProxyEnv } from '../computer/backends/proxy.js';
import { mountLiveView, LIVE_VIEW_PATH } from './live-view.js';
import { localUrl, publicUrlOf } from '../web-auth.js';
import { createShadeWatch, createPolicy, parseShade } from './notifications.js';
import { sectionOf, setValues } from '../settings.js';
import { prompt } from '../prompts.js';
import { createAccounts, renderAccount } from './accounts.js';

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
  dataGb: 16,               // her storage (/data), fixed when the phone is created: /phone accept <GB> or /phone size <GB> before that
  port: 5554,               // console port; the adb serial is emulator-<port>
  window: true,             // show the emulator window (the phone's live view); false = headless
  gpu: 'auto',
  locale: 'zh-CN',          // the phone's language (emulator -change-locale)
  timezone: 'Asia/Shanghai',
  number: '',               // her phone number for registering and logging into apps ('' = none); /phone number also sets it
  // Apps she installs herself, the way a person does: her browser may install downloaded APKs.
  // Packages granted "install unknown apps" at boot; [] = she must grant it in Settings first.
  installers: ['com.android.chrome', 'com.google.android.documentsui', 'com.android.documentsui'],
  keepAppsAlive: true,      // no doze / standby / freezer for her apps, so chat apps keep receiving in the background
  keepAliveEveryMinutes: 10, // re-apply for apps installed since boot
  acceptLicense: false,     // Android SDK license (https://developer.android.com/studio/terms); `/phone accept` also sets it
  channel: 'stable',        // emulator release channel
  bootTimeoutMs: 300_000,
  restartDelayMs: 10_000,   // relaunch the emulator this long after it exits by itself
  aliveEveryMs: 15_000,     // once ready, adb is asked this often whether the emulator still answers; 3 misses = relaunch
  liveView: true,           // the live view page (screen + tap/swipe/type) at /dsh-dot/phone/ on dsh's own web server, behind dsh's login
  publicUrl: '',            // the public origin of THIS dsh (your own exposure, e.g. tailscale serve of dsh's port); the live view is <publicUrl>/dsh-dot/phone/
  // Notifications: the phone's notification shade is polled (adb dumpsys) and new ones are handed to
  // listeners (dot wakes her for them). notifyApps: packages that count; [] = every non-system app.
  notifications: true,      // watch the shade at all
  notifyPollMs: 4000,       // reconcile snapshot interval (events trigger immediate reads); 0 = events only
  notifyApps: [],           // [] = every app she installs, now or later, until muted
  notifyMuted: [],          // packages whose notifications never wake her (also /phone notify mute <pkg>, persisted)
  notifyCatchUpMs: 12 * 3600_000, // at start, notifications that arrived while dsh was down (no older than this) still wake her
  // One session drives the phone at a time (her conversation, an errand, an interlude round all act as her).
  leaseIdleMs: 120_000,     // the lease lapses this long after its holder's last phone call (or when its turn ends)
  leaseWaitMs: 60_000,      // another session's phone call waits this long for it, then is refused
  qqSendOnPhone: false,     // false = in the phone's QQ she reads; she sends with qq_send
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
export const shadeFile = () => join(dshHome(), 'dsh-phone-shade.json');

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

/** A phone call that would type or send in the foreground app: typing, Enter (alone or in a batch). */
export const typesText = (tool, input) => tool === 'mobile_type_keys' || (['mobile_press_button', 'mobile_batch_commands'].includes(tool) && /ENTER|type_keys/i.test(JSON.stringify(input ?? '')));

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

/**
 * Decode an 8-bit RGB/RGBA, non-interlaced PNG (the screencap formats) → { width, height, bpp, pixels }
 * with `pixels` the unfiltered rows; anything else → null. CRCs are not checked.
 */
export function decodePng(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20), depth = buf[24], color = buf[25], interlace = buf[28];
    const bpp = color === 6 ? 4 : color === 2 ? 3 : 0;
    if (!bpp || depth !== 8 || interlace || !width || !height) return null;
    const idat = [];
    for (let o = 8; o + 8 <= buf.length;) { const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8); if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len)); if (type === 'IEND') break; o += 12 + len; }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    if (raw.length < (stride + 1) * height) return null;
    const pixels = Buffer.alloc(stride * height);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)], line = pixels.subarray(y * stride, (y + 1) * stride);
      raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
      if (f) for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let add = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : 0;
        if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        line[i] = (line[i] + add) & 0xff;
      }
      prev = line;
    }
    return { width, height, bpp, pixels };
  } catch { return null; }
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** Encode 8-bit RGB (bpp 3) or RGBA (bpp 4) rows as a PNG. */
export function encodePng({ width, height, bpp, pixels }) {
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = bpp === 4 ? 6 : 2;
  const stride = width * bpp, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const ZOOM_MAX_SCALE = 3;
const ZOOM_LONG_EDGE = 1200; // default output size: the long edge, unless scale says otherwise
/**
 * Crop {x, y, w, h} (screen px; clamped to the image) out of a PNG and enlarge it `scale` times
 * (bilinear; ≤ ZOOM_MAX_SCALE; default: as large as fits ZOOM_LONG_EDGE, at least 1×).
 * → { png, x, y, w, h, scale, width, height } or { error }.
 */
export function zoomPng(buf, { x, y, w, h, scale } = {}) {
  const img = decodePng(buf);
  if (!img) return { error: 'the screenshot is not a PNG this can read' };
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(Number(x) || 0))), y0 = Math.max(0, Math.min(img.height - 1, Math.round(Number(y) || 0)));
  const cw = Math.max(1, Math.min(img.width - x0, Math.round(Number(w) || 0))), ch = Math.max(1, Math.min(img.height - y0, Math.round(Number(h) || 0)));
  const k = Math.min(ZOOM_MAX_SCALE, Math.max(1, Number(scale) > 0 ? Number(scale) : ZOOM_LONG_EDGE / Math.max(cw, ch)));
  const ow = Math.max(1, Math.round(cw * k)), oh = Math.max(1, Math.round(ch * k)), { bpp } = img;
  const out = Buffer.alloc(ow * oh * bpp), src = img.pixels, stride = img.width * bpp;
  for (let j = 0; j < oh; j++) {
    const sy = Math.min(ch - 1, Math.max(0, (j + 0.5) / k - 0.5)), y1 = Math.floor(sy), y2 = Math.min(ch - 1, y1 + 1), fy = sy - y1;
    for (let i = 0; i < ow; i++) {
      const sx = Math.min(cw - 1, Math.max(0, (i + 0.5) / k - 0.5)), x1 = Math.floor(sx), x2 = Math.min(cw - 1, x1 + 1), fx = sx - x1;
      const a = (y0 + y1) * stride + (x0 + x1) * bpp, b = (y0 + y1) * stride + (x0 + x2) * bpp, c = (y0 + y2) * stride + (x0 + x1) * bpp, d = (y0 + y2) * stride + (x0 + x2) * bpp;
      for (let n = 0; n < bpp; n++) out[(j * ow + i) * bpp + n] = Math.round((src[a + n] * (1 - fx) + src[b + n] * fx) * (1 - fy) + (src[c + n] * (1 - fx) + src[d + n] * fx) * fy);
    }
  }
  return { png: encodePng({ width: ow, height: oh, bpp, pixels: out }), x: x0, y: y0, w: cw, h: ch, scale: Math.round(k * 100) / 100, width: ow, height: oh };
}

/**
 * Is this PNG one flat colour, all white or all black? (`screencap` gives that mid-transition or with
 * the screen off.) Decodes 8-bit RGB/RGBA, the screencap formats; anything else counts as not blank.
 */
export function blankPng(buf) {
  const img = decodePng(buf);
  if (!img) return false;
  const { pixels, bpp } = img;
  const first = pixels[0];
  if (first !== 0 && first !== 255) return false;
  for (let i = 0; i < pixels.length; i += bpp) if (pixels[i] !== first || pixels[i + 1] !== first || pixels[i + 2] !== first) return false;
  return true;
}

/** One screenshot; a blank one (all white/black) is taken once more after `waitMs`. */
export async function screencapRetry(grab, { waitMs = 400, wait = sleep } = {}) {
  const png = await grab();
  if (!blankPng(png)) return png;
  await wait(waitMs);
  return grab();
}

/** Her system-prompt section about the phone (only while it is ready): the device, her number, accounts, how each app adds her stickers. */
/**
 * The phone section. Parts that only hold with a sibling component are said only when it is there
 * (the phone also runs alone, next to someone else's character): notifications wake her only
 * through dot, the sticker album is fed by qq, and "remember it" needs memory. Defaults: all on.
 */
export const deviceText = (serial, number = '', has = {}) => {
  const { dot = true, qq = true, memory = true } = has;
  return prompt('phone.device', {
    serial,
    phonePrefix: PHONE_TOOL_PREFIX,
    notify: prompt(dot ? 'phone.device.wake' : 'phone.device.no-wake'),
    number: number ? prompt('phone.device.number', { number }) : '',
    stickers: qq ? prompt('phone.stickers', { learned: memory ? prompt('phone.stickers.learned') : '' }) : '',
  });
};

/** A phone number as typed (spaces, dashes allowed); '' clears it. Throws on anything else. */
export function parseNumber(s) {
  const n = String(s ?? '').replace(/[\s-]/g, '');
  if (n === '' || n === '-' || n === 'none') return '';
  if (!/^\+?\d{5,15}$/.test(n)) throw new Error('phone number: digits only (5–15, an optional leading +)');
  return n;
}

export function apply(ctx, config = {}, deps = {}) {
  const logger = withFileLog(ctx.logger('dsh-dot/phone'));
  const settings = readSettingsFile();
  const user = sectionOf('phone', (m) => logger.warn(m));
  const cfg = { ...defaults, ...settings, ...setValues(config, { dropEmptyArrays: true }), ...user };
  if (cfg.enabled === false) { logger.info('off (dsh-dot.json: phone.enabled = false)'); return; }
  // The license, once accepted (settings file), stays accepted whatever the patch's default says.
  cfg.acceptLicense = Boolean(cfg.acceptLicense || settings.acceptLicense);
  // The storage size the owner chose (/phone size, /phone accept <GB>) wins over any file.
  if (settings.dataGb) cfg.dataGb = settings.dataGb;
  // …and so does the number set by /phone number.
  if (Object.hasOwn(settings, 'number')) cfg.number = settings.number;
  cfg.number = String(cfg.number ?? '');
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
  // The console port is claimed at start (see claimPort): another emulator may already sit on cfg.port.
  let port = cfg.port;
  let serial = `emulator-${port}`;
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
  /** The resumed activity, "pkg/.Activity" ('' when unknown). */
  phone.foreground = async () => { try { return /([\w.]+\/[\w.$]+)/.exec(await phone.shell("dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity'"))?.[1] ?? ''; } catch { return ''; } };
  /** PNG of the screen right now (a blank frame — mid-transition, screen waking — is retaken once). */
  phone.screenshot = () => screencapRetry(async () => Buffer.from((await phone.adbExec(['exec-out', 'screencap', '-p'], { encoding: 'buffer' })).stdout));
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
    // The emulator ignores a poster change while an app has the camera open: go to the home screen
    // first (the scanner releases the camera when paused); the next 扫一扫 then shows the new picture.
    try { await phone.adbExec(['shell', 'input', 'keyevent', 'KEYCODE_HOME']); await new Promise((r) => setTimeout(r, 1500)); } catch {}
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
    catchUpMs: cfg.notifyCatchUpMs,
    load: () => { try { return JSON.parse(readFileSync(shadeFile(), 'utf8')); } catch { return null; } },
    save: (known) => { try { writeFileSync(shadeFile(), JSON.stringify(known)); } catch (err) { logger.warn(`shade file: ${err.message}`); } },
    wanted: (n) => policy.wanted(n),
    onChange: (kind, n) => {
      if (kind === 'removed') return;
      recent.push(n); if (recent.length > 20) recent.shift();
      audit({ kind: 'notification', change: kind, pkg: n.pkg, title: n.title, text: n.text.slice(0, 200), postedAt: n.postedAt ? new Date(n.postedAt).toISOString() : undefined, lagMs: n.lagMs });
      for (const fn of notifyListeners) { try { fn(n); } catch (err) { logger.warn(`notification listener: ${err.message}`); } }
    },
    logger,
  });
  /** The size of her storage: what the existing phone was built with, or what a new one will get. */
  phone.storage = () => {
    const ini = join(paths.avdHome, `${cfg.avd}.avd`, 'config.ini');
    const built = existsSync(ini) ? /^disk\.dataPartition\.size=(\d+)G$/m.exec(readFileSync(ini, 'utf8'))?.[1] : undefined;
    return built ? { gb: Number(built), fixed: true } : { gb: cfg.dataGb, fixed: false };
  };
  /** Choose the storage size before the phone is created (8–256 GB). Throws once it exists. */
  phone.setStorage = (gb) => {
    const n = Number(gb);
    if (!Number.isInteger(n) || n < 8 || n > 256) throw new Error('storage size: a whole number of GB from 8 to 256');
    const st = phone.storage();
    if (st.fixed) throw new Error(`her phone already exists with ${st.gb} GB; the size is fixed when a phone is created (an Android emulator does not grow an existing data partition)`);
    cfg.dataGb = n; writeSettings({ dataGb: n }); audit({ kind: 'storage', gb: n });
  };
  /** Her phone number ('' = none) and her app accounts (host-side, see accounts.js). */
  phone.number = () => cfg.number;
  phone.setNumber = (n) => { cfg.number = parseNumber(n); writeSettings({ number: cfg.number }); audit({ kind: 'number', set: Boolean(cfg.number) }); return cfg.number; };
  phone.accounts = deps.accounts ?? createAccounts({ number: () => cfg.number });
  phone.accept = () => { cfg.acceptLicense = true; writeSettings({ acceptLicense: true }); audit({ kind: 'license', accepted: true }); if (phone.state === 'needs-license' || phone.state === 'error') void start(); };

  const installed = () => existsSync(paths.emulator) && existsSync(paths.adb) && existsSync(join(paths.sysdir, 'system.img'));

  async function ensureSdk() {
    if (installed()) return;
    if (!cfg.acceptLicense) {
      setState('needs-license', `the Android SDK license (${LICENSE_URL}) has not been accepted — reply /phone accept to install the phone (storage ${cfg.dataGb} GB; /phone accept <GB> to choose another size — it cannot grow later)`);
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
  /** The emulator's scene poster list (resources/Toren1BD.posters, read at launch) and the folder her camera images go in. */
  const posterFiles = () => { const dir = join(dirname(paths.emulator), 'resources'); return { dir, posters: join(dir, 'Toren1BD.posters') }; };
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
  /** Console ports of every emulator adb lists. MuMu, LDPlayer, BlueStacks and other AVDs show up as emulator-<port> too. */
  async function listedPorts() {
    try { const { stdout } = await exec(paths.adb, ['devices'], { env: env(), timeout: 10_000 }); return [...String(stdout).matchAll(/^emulator-(\d+)\s+\S+/gm)].map((m) => Number(m[1])); } catch { return []; }
  }
  /** The AVD behind emulator-<p>, from its console; '' for anything that is not an Android emulator console (MuMu and the like). */
  async function avdNameAt(p) {
    try { const { stdout } = await exec(paths.adb, ['-s', `emulator-${p}`, 'emu', 'avd', 'name'], { env: env(), timeout: 5_000 }); return String(stdout).split(/\r?\n/)[0].trim(); } catch { return ''; }
  }
  /**
   * Her AVD if it is already up (left from a previous dsh run): attach. Otherwise the first console port
   * from cfg.port that nothing listed is using. Never attach to an emulator just because it holds the port:
   * that is the user's own emulator, and settle() would rewrite its settings.
   */
  async function claimPort() {
    const listed = await listedPorts();
    for (const p of listed) if ((await avdNameAt(p)) === cfg.avd) return { port: p, attach: true };
    for (let p = cfg.port; p <= 5584; p += 2) if (!listed.includes(p)) return { port: p, attach: false };
    throw new Error('no free emulator port: adb lists an emulator on every console port 5554–5584');
  }
  const setPort = (p) => { port = p; serial = `emulator-${p}`; phone.serial = serial; };
  /** Is her emulator (on the claimed port) still listed by adb? */
  async function alreadyRunning() { return (await listedPorts()).includes(port); }
  async function start() {
    try {
      await ensureSdk();
      ensureAvd();
      setState('booting');
      const claim = child ? { port, attach: true } : await claimPort();
      if (claim.port !== cfg.port && !claim.attach) logger.warn(`emulator-${cfg.port} belongs to another emulator; hers takes console port ${claim.port}`);
      setPort(claim.port);
      if (claim.attach) {
        logger.info(`${serial} is already running (AVD ${cfg.avd}); attaching`);
      } else {
        ensureCameraScene();
        const args = ['-avd', cfg.avd, '-port', String(port), '-no-boot-anim', '-gpu', cfg.gpu, '-netdelay', 'none', '-netspeed', 'full', ...(cfg.locale ? ['-change-locale', cfg.locale] : []), ...(cfg.timezone ? ['-timezone', cfg.timezone] : []), ...(cfg.window ? [] : ['-no-window'])];
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
      watchAlive();
      await mountMcp();
    } catch (err) {
      if (phone.state !== 'needs-license') {
        const message = /fetch failed|curl|ENOTFOUND|ECONN|timed out/i.test(err.message) && phone.state === 'downloading' ? `download failed (${err.message}) — dl.google.com must be reachable; set HTTPS_PROXY or the system proxy and /phone retry` : err.message;
        setState('error', message); logger.error(`phone failed: ${message}`);
      }
    }
  }
  // An attached emulator (left from an earlier run) is not our child: when QEMU hangs and crashes
  // (11-03: all QEMU threads unresponsive 15 s, then a crash dump), nothing fires 'exit' and the
  // phone stayed "ready" while every adb call said "device not found". So: once ready, ask adb every
  // aliveEveryMs; three misses in a row = gone → error, shade off, relaunch like an exit.
  let aliveTimer = null;
  function watchAlive() {
    if (aliveTimer) clearInterval(aliveTimer);
    let misses = 0;
    aliveTimer = setInterval(async () => {
      if (stopping || phone.state !== 'ready') return;
      let ok = false;
      try { ok = /^device\s*$/.test(String((await exec(paths.adb, ['-s', serial, 'get-state'], { env: env(), timeout: 8_000 })).stdout)); } catch {}
      if (ok) { misses = 0; return; }
      if (++misses < 3) return;
      clearInterval(aliveTimer); aliveTimer = null;
      shade.stop?.();
      audit({ kind: 'emulator-gone', serial });
      setState('error', 'the emulator is gone (crashed or killed); relaunching');
      logger.warn(`${serial} no longer answers adb; relaunching in ${cfg.restartDelayMs / 1000}s`);
      const ours = child; child = null; ours?.removeAllListeners('exit'); try { ours?.kill('SIGKILL'); } catch {}
      setTimeout(() => { if (!stopping) void start(); }, cfg.restartDelayMs).unref?.();
    }, cfg.aliveEveryMs);
    aliveTimer.unref?.();
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

  // One session drives the phone at a time: any phone call takes the lease — looking too, since a
  // screenshot mid-way through another session's steps shows a screen she did not put there. It lapses
  // leaseIdleMs after the holder's last call or when the holder's turn ends; a call from another
  // session waits up to leaseWaitMs, then is refused. Her conversation (setPriority) goes first.
  const lease = { holder: '', tool: '', at: 0, priority: '' };
  const waiting = new Set();
  const lapse = () => { audit({ kind: 'phone-lease', event: 'expired', session: lease.holder, holder: lease.holder }); lease.holder = ''; };
  phone.setPriority = (id) => { lease.priority = id || ''; };
  /** For hooks that answer a phone call ahead of this one (interlude's observation allow): null, or why it is refused. */
  phone.lease = (id, tool) => (id ? takeLease(id, tool) : null);
  async function takeLease(id, tool) {
    const until = Date.now() + cfg.leaseWaitMs;
    for (;;) {
      if (lease.holder && lease.holder !== id && Date.now() - lease.at > cfg.leaseIdleMs) lapse();
      const first = waiting.has(lease.priority) ? lease.priority : waiting.values().next().value;
      if (lease.holder === id || (!lease.holder && (first ?? id) === id)) {
        waiting.delete(id);
        if (lease.holder !== id) audit({ kind: 'phone-lease', event: 'acquired', session: id, holder: id });
        Object.assign(lease, { holder: id, tool, at: Date.now() });
        return null;
      }
      if (Date.now() >= until) { waiting.delete(id); audit({ kind: 'phone-lease', event: 'refused', session: id, holder: lease.holder }); return `手机正被另一件事占着（${lease.holder ? `在用 ${lease.tool}` : '有别的事排在前面'}），稍后再试`; }
      if (!waiting.has(id)) { waiting.add(id); audit({ kind: 'phone-lease', event: 'waited', session: id, holder: lease.holder }); }
      await sleep(Math.min(50, until - Date.now()));
    }
  }
  ctx.on('session/event', (session, event) => { if (event?.type === 'turn/end' && session?.id && session.id === lease.holder) lapse(); });
  // Prepended: a listener ahead of it that answers without next() (interlude's observation `allow`) would skip it.
  ctx.on('tools/pre-execute', async (exec_, next) => {
    const tool = exec_.name.startsWith(PHONE_TOOL_PREFIX) ? exec_.name.slice(PHONE_TOOL_PREFIX.length) : exec_.name === PHONE_ZOOM_TOOL ? exec_.name : '';
    const id = exec_.agent?.session?.id;
    if (!tool) return next();
    const refused = id ? await takeLease(id, tool) : null;
    if (refused) return { kind: 'deny', reason: refused };
    // QQ goes one way on the phone: she reads there, and sends with qq_send (QQ's search box still types).
    if (!cfg.qqSendOnPhone && typesText(tool, exec_.input ?? exec_.args ?? exec_.arguments) && /^com\.tencent\.mobileqq\/(?!.*search)/i.test(await phone.foreground())) {
      audit({ kind: 'qq-send-blocked', session: id, tool });
      return { kind: 'deny', reason: '在手机 QQ 里不发消息，给人发 QQ 用 qq_send。' };
    }
    return next();
  }, { prepend: true });

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'phone:device',
      order: 60,
      text: () => (phone.state === 'ready'
        ? deviceText(serial, cfg.number, { dot: Boolean(ctx.get?.('dshDot')), qq: Boolean(ctx.get?.('dshQq')), memory: Boolean(ctx.get?.('dotMemory')) })
        : ''),
    }), 'dsh-dot/phone: device section');
  });

  // Her app accounts. Registered whatever the emulator's state, so her conversation and errands both have it.
  // The password is in the result she reads, never in the audit log.
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'account',
      description: '你各个 App 的账号密码（存在主机上，不进记忆）。action：get 取某个 App 的登录名和密码——没记过的会给你手机号和你的默认密码，拿去注册；set 在注册成功、或 App 逼你改了密码后马上记下（login、password、note 只填变了的）；list 列出记过哪些 App 和登录名（不含密码）。app 写 App 的名字，比如 "小红书"。',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'set', 'list'] }, app: { type: 'string' }, login: { type: 'string' }, password: { type: 'string' }, note: { type: 'string' } }, required: ['action'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderAccount(v) }] },
      async execute(args) {
        const action = args.action;
        try {
          if (action === 'list') return { action, accounts: phone.accounts.list() };
          if (action === 'get') { const r = phone.accounts.get(args.app); audit({ kind: 'account-get', app: r.app, found: r.found }); return { action, ...r }; }
          if (action === 'set') { const r = phone.accounts.set(args.app, args); audit({ kind: 'account-set', app: r.app, login: args.login, changed: r.changed }); return { action, ...r }; }
          return { action: String(action), error: 'action: get, set or list' };
        } catch (err) { return { action: String(action), error: err.message }; }
      },
    }), 'dsh-dot/phone: account tool');
  });

  // A part of the screen, enlarged: mobile-mcp only scales the whole screenshot down (scale ≤ 1, maxSize),
  // so small text and details were cropped in the computer instead. The image goes through the
  // attachment store, like mobile_take_screenshot's (dsh-mcp-client); without one, no zoom.
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: PHONE_ZOOM_TOOL,
      description: '把手机屏幕的一块放大来看（现截一张）。x、y 是那块的左上角，w、h 是宽和高，单位是屏幕像素（和 mobile_list_elements_on_screen 的坐标一样）；scale 是放大倍数，最多 3，不填就放到看得清的大小。小字、图里的细节看不清时用。',
      parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, scale: { type: 'number', exclusiveMinimum: 0, maximum: ZOOM_MAX_SCALE } }, required: ['x', 'y', 'w', 'h'], additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { error: { type: 'string' } }, additionalProperties: true },
        render: (_a, v) => (v.error ? [{ type: 'text', text: `没放大成：${v.error}` }] : [{ type: 'text', text: `屏幕 (${v.x}, ${v.y}) 起 ${v.w}×${v.h}，放大 ${v.scale} 倍：` }, { type: 'image', attachment: v.image }]),
      },
      async execute(args) {
        if (!phone.isReady) return { error: `手机还没就绪（${phone.state}）` };
        const store = ctx.get?.('attachments');
        if (typeof store?.saveImages !== 'function') return { error: '没有附件仓库（ctx.attachments），图传不过去；用 mobile_take_screenshot' };
        try {
          const z = zoomPng(await phone.screenshot(), args);
          if (z.error) return { error: z.error };
          const { png, ...at } = z;
          const [image] = await store.saveImages([{ data: new Uint8Array(png), mediaType: 'image/png', name: 'phone-zoom' }]);
          audit({ kind: 'phone-zoom', ...at, bytes: png.length });
          return { ...at, image };
        } catch (err) { return { error: err.message }; }
      },
    }), 'dsh-dot/phone: zoom tool');
  });

  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'phone',
      description: 'the phone: status; "accept [GB]" accepts the Android SDK license and installs it (with that much storage, default 16); "size <GB>" sets the storage of a phone not yet created; "number <digits>" sets her phone number ("number -" clears it); "restart" reboots the emulator; "screenshot" saves the screen to the phone home',
      input: { hint: '[accept [GB] | size <GB> | number <digits> | retry | restart | screenshot | notifications | notify [mute|wake <pkg>]]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        let extra = '';
        const [verb0, arg1] = arg.split(/\s+/);
        if (verb0 === 'accept') {
          try { if (arg1) phone.setStorage(arg1); } catch (err) { return { kind: 'success', text: `phone: ${err.message}` }; }
          phone.accept(); extra = `\nlicense accepted; installing/booting now with ${phone.storage().gb} GB of storage (watch ~/.dsh/dsh-phone.log)`;
        }
        else if (verb0 === 'size') {
          if (!arg1) { const st = phone.storage(); extra = `\nstorage: ${st.gb} GB${st.fixed ? ' (fixed: the phone exists)' : ' (used when the phone is created)'}`; }
          else { try { phone.setStorage(arg1); extra = `\nstorage set to ${arg1} GB for when the phone is created`; } catch (err) { extra = `\n${err.message}`; } }
        }
        else if (verb0 === 'number') {
          const rest = arg.slice('number'.length).trim();
          if (rest) { try { phone.setNumber(rest); extra = `\nnumber ${cfg.number ? `set to ${cfg.number}` : 'cleared'}`; } catch (err) { extra = `\n${err.message}`; } }
        }
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
        return { kind: 'success', text: `phone: ${s.state}${s.error ? ` — ${s.error}` : ''}\nserial: ${serial} · Android API ${cfg.api} (${abi}) · ${cfg.window ? 'window' : 'headless'} · home: ${home}\nlive view: ${phone.publicLiveViewUrl ?? phone.liveViewUrl ?? 'off'}\nstorage: ${phone.storage().gb} GB · license: ${cfg.acceptLicense ? 'accepted' : `not accepted (${LICENSE_URL})`} · mcp: ${mcpFork ? 'mounted' : 'not mounted'}\nnumber: ${cfg.number || '(none: /phone number <digits>)'} · accounts: ${phone.accounts.count()} app(s) in ${phone.accounts.file ?? 'the account store'}${extra}` };
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
      if (aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
      // The phone keeps running across dsh restarts, like the computer does; only the MCP child is ours.
      mcpFork?.dispose?.();
    };
  }, 'dsh-dot/phone: emulator lifecycle');
}
