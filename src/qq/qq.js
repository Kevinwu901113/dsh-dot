// dsh-dot/qq: her QQ on her computer. NapCat (a headless QQNT client speaking OneBot 11) runs inside
// the computer VM, logged into the same account as the QQ app on her phone — QQ allows a phone and a
// computer at once, so this is her "电脑端 QQ": messages arrive as events the moment they are sent
// (no notification shade, no background freezing), and she can answer in a second with `qq_send`.
// The phone app stays for everything else. dsh reaches NapCat's WebSocket through the computer's
// gateway (the AIO sandbox proxies `Host: <port>-x` to the VM's loopback port, WebSocket included),
// so nothing is exposed outside 127.0.0.1 and no extra port is opened on the VM.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createAudit } from '../computer/audit.js';

export const name = 'dot-qq';
export const inject = [];

export const defaults = {
  qq: '',                   // the account (QQ number) NapCat logs into — her small account, the same one as on the phone
  owner: '',                // your QQ number: where dot's own notices and her proactive messages go (learned from the first private message if empty)
  wsPort: 3001,             // OneBot 11 WebSocket server port inside the VM (loopback only)
  token: '',                // OneBot access token; generated once and kept in $DSH_HOME/dsh-qq.json
  installer: 'https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh',
  githubProxy: '',          // mirror prefix for the installer's GitHub downloads, e.g. https://ghfast.top/ ; '' = direct
  autoStart: true,          // start NapCat when the computer is ready and the account is set
  groupPolicy: 'mention',   // group messages that wake her: 'mention' (@her), 'all', 'none'
  reconnectMs: 5000,
  requestTimeoutMs: 15000,
};

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
export const settingsFile = () => join(dshHome(), 'dsh-qq.json');
export const auditFile = () => join(dshHome(), 'dsh-qq-audit.jsonl');
export function readSettingsFile() { try { return existsSync(settingsFile()) ? JSON.parse(readFileSync(settingsFile(), 'utf8')) : {}; } catch { return {}; } }
function writeSettings(patch) { const next = { ...readSettingsFile(), ...patch }; mkdirSync(dirname(settingsFile()), { recursive: true }); writeFileSync(settingsFile(), JSON.stringify(next, null, 2)); return next; }

// Paths inside the VM (NapCat's rootless install under $HOME of the user it runs as; we run it as root).
const VM_HOME = '/root';
const NAPCAT = `${VM_HOME}/Napcat`;
const QQ_BIN = `${NAPCAT}/opt/QQ/qq`;
const NAPCAT_DIR = `${NAPCAT}/opt/QQ/resources/app/app_launcher/napcat`;
const CONFIG_DIR = `${NAPCAT_DIR}/config`;
const QR_FILE = `${NAPCAT_DIR}/cache/qrcode.png`;
const LOG_FILE = `${VM_HOME}/napcat.log`;

/** OneBot 11 message segments → plain text the way a person would read them. */
export function segmentsToText(message, selfId = '') {
  if (typeof message === 'string') return message;
  return (Array.isArray(message) ? message : []).map((seg) => {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': return String(d.text ?? '');
      case 'at': return String(d.qq) === String(selfId) ? '@我' : `@${d.name ?? d.qq ?? ''}`;
      case 'image': return `[图片${d.summary ? `:${d.summary}` : ''}${d.url ? ` ${d.url}` : ''}]`;
      case 'face': return '[表情]';
      case 'record': return '[语音]';
      case 'video': return '[视频]';
      case 'file': return `[文件:${d.name ?? ''}]`;
      case 'reply': return '[回复]';
      case 'forward': return '[合并转发]';
      case 'json': case 'xml': return '[卡片]';
      default: return seg?.type ? `[${seg.type}]` : '';
    }
  }).join('').trim();
}

/**
 * Where an image she wants to send lives, as a OneBot image segment `file`:
 *   http(s)://…            → the URL (NapCat downloads it)
 *   phone:screen           → a screenshot of her phone right now
 *   phone:latest           → the newest photo/screenshot/download on her phone
 *   /sdcard/… or phone:/…  → that file on her phone
 *   any other absolute path → that file on her computer (NapCat runs there)
 * @returns {{kind: 'url'|'phone-screen'|'phone-latest'|'phone'|'computer', ref: string}|null}
 */
export function imageSource(ref) {
  const s = String(ref ?? '').trim();
  if (/^https?:\/\//i.test(s)) return { kind: 'url', ref: s };
  if (/^phone:screen(shot)?$/i.test(s)) return { kind: 'phone-screen', ref: s };
  if (/^phone:latest$/i.test(s)) return { kind: 'phone-latest', ref: s };
  const phonePath = /^phone:(\/.+)$/i.exec(s)?.[1] ?? (/^\/(sdcard|storage)\//.test(s) ? s : '');
  if (phonePath) return { kind: 'phone', ref: phonePath };
  if (s.startsWith('/')) return { kind: 'computer', ref: s };
  return null;
}

/** Does a group message count, under the policy? */
export function groupWanted(ev, policy, selfId) {
  if (policy === 'all') return true;
  if (policy === 'none') return false;
  return (Array.isArray(ev.message) ? ev.message : []).some((s) => s?.type === 'at' && String(s.data?.qq) === String(selfId));
}

/** NapCat's OneBot 11 config for this account: one WebSocket server on loopback, token required. */
export function onebotConfig({ port, token }) {
  return {
    network: {
      httpServers: [], httpSseServers: [], httpClients: [],
      websocketServers: [{ name: 'dot', enable: true, host: '127.0.0.1', port, messagePostFormat: 'array', reportSelfMessage: false, token, enableForcePushEvent: true, debug: false, heartInterval: 30000 }],
      websocketClients: [], plugins: [],
    },
    musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
  };
}

/** Parse a `to` the model or dot gives: "user:123", "group:456", "owner", or a bare number (user). */
export function parseTarget(to, owner) {
  const s = String(to ?? '').trim();
  if (!s || s === 'owner') return owner ? { user_id: Number(owner) } : null;
  const m = /^(user|private|group|群|好友)?[:：]?\s*(\d{5,})$/i.exec(s);
  if (!m) return null;
  return /group|群/i.test(m[1] ?? '') ? { group_id: Number(m[2]) } : { user_id: Number(m[2]) };
}

function withFileLog(logger) {
  const file = join(dshHome(), 'dsh-qq.log');
  try { if (statSync(file).size > 1_000_000) rmSync(file, { force: true }); } catch {}
  const write = (level, args) => { try { appendFileSync(file, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}\n`); } catch {} };
  const wrapped = Object.create(logger);
  for (const level of ['debug', 'info', 'warn', 'error']) wrapped[level] = (...args) => { write(level, args); return logger[level]?.(...args); };
  return wrapped;
}

export function apply(ctx, config = {}, deps = {}) {
  const settings = readSettingsFile();
  const cfg = { ...defaults, ...settings, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '')) };
  if (!cfg.token) { cfg.token = randomBytes(24).toString('hex'); writeSettings({ token: cfg.token }); }
  const logger = withFileLog(ctx.logger('dsh-dot/qq'));
  const audit = createAudit(auditFile());
  const computer = () => ctx.get('dshComputer');
  let WebSocketImpl = deps.WebSocket; // the `ws` package, loaded on first connect (tests inject a fake)

  const qq = { state: 'idle', error: undefined, connected: false, selfId: '', qq: cfg.qq, owner: cfg.owner, audit };
  const listeners = new Set();
  qq.onMessage = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  qq.status = () => ({ state: qq.state, connected: qq.connected, qq: qq.qq, owner: qq.owner, selfId: qq.selfId, error: qq.error, wsPort: cfg.wsPort });
  const setState = (state, error) => { if (qq.state !== state || qq.error !== error) { qq.state = state; qq.error = error; audit({ kind: 'status', state, error }); } };

  // ---- the VM side: install, configure, start, stop, QR ----
  const vmShell = async (script, timeoutMs = 120_000) => {
    const c = computer();
    if (!c?.backend?.rootShell) throw new Error('the computer is not available (dsh-dot/computer)');
    return deps.rootShell ? deps.rootShell(script, timeoutMs) : c.backend.rootShell(script);
  };
  qq.installed = async () => { try { return (await vmShell(`test -x ${QQ_BIN} && echo yes || echo no`)).trim() === 'yes'; } catch { return false; } };
  const INSTALL_LOG = `${VM_HOME}/napcat-install.log`;
  const INSTALL_DONE = `${VM_HOME}/napcat-install.done`;
  const MIRRORS = ['', 'https://ghfast.top/', 'https://gh-proxy.com/', 'https://mirror.ghproxy.com/'];
  let installing = null;
  /**
   * Install NapCat in the computer. The work runs detached inside the VM (a host-side `msb exec`
   * is cut off after a couple of minutes; apt + linuxqq take longer) and is polled to completion.
   * GitHub is tried direct first, then through public mirrors; QQ itself comes from Tencent.
   */
  qq.install = () => (installing ??= (async () => {
    setState('installing');
    logger.info('installing NapCat in the computer (apt deps, linuxqq, NapCat.Shell) — several minutes; /qq log follows it');
    try {
      const prefixes = cfg.githubProxy ? [cfg.githubProxy] : MIRRORS;
      const attempts = prefixes.map((pre) => `(curl -fsSL --connect-timeout 15 --max-time 120 -o napcat-install.sh ${JSON.stringify(pre + cfg.installer)} && echo ${JSON.stringify(pre || 'direct')} > github.prefix)`).join(' || ');
      const script = [
        `cd ${VM_HOME}; export HOME=${VM_HOME}; rm -f ${INSTALL_DONE} github.prefix`,
        // A half-finished earlier attempt leaves the folder behind and the installer refuses to touch it.
        `test -x ${QQ_BIN} || rm -rf ${NAPCAT} ${VM_HOME}/NapCat`,
        `{ ${attempts}; } || { echo "cannot download the installer from GitHub (direct or mirrors)"; echo 2 > ${INSTALL_DONE}; exit 2; }`,
        'pre=$(cat github.prefix); [ "$pre" = direct ] && flag="--github-proxy 0" || flag="--github-proxy $pre"',
        'echo "installer fetched via $pre"; bash napcat-install.sh --docker n --cli n $flag --confirm y; rc=$?',
        `test -x ${QQ_BIN} && rc=0; echo $rc > ${INSTALL_DONE}`,
      ].join('\n');
      await vmShell(`cat > ${VM_HOME}/napcat-install-run.sh <<'EOF'\n${script}\nEOF\nnohup bash ${VM_HOME}/napcat-install-run.sh > ${INSTALL_LOG} 2>&1 < /dev/null & disown; echo started`);
      const deadline = Date.now() + 40 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        const rc = (await vmShell(`cat ${INSTALL_DONE} 2>/dev/null || true`)).trim();
        if (rc === '') continue;
        if (rc !== '0') { const tail = await vmShell(`tail -n 25 ${INSTALL_LOG} 2>/dev/null || true`); throw new Error(`installer exited ${rc}:\n${tail.trim().slice(-1200)}`); }
        audit({ kind: 'installed' });
        logger.info('NapCat installed');
        setState('installed');
        return true;
      }
      throw new Error('installer still running after 40 minutes — /qq log');
    } catch (err) { setState('error', `install failed: ${String(err.message).slice(0, 1500)}`); logger.error(`install failed: ${err.message}`); return false; }
    finally { installing = null; }
  })());
  qq.configure = async () => {
    if (!cfg.qq) throw new Error('set the QQ number first: /qq account <number>');
    const ob = JSON.stringify(onebotConfig({ port: cfg.wsPort, token: cfg.token }));
    await vmShell(`mkdir -p ${CONFIG_DIR}; cat > ${CONFIG_DIR}/onebot11_${cfg.qq}.json <<'EOF'\n${ob}\nEOF\n` +
      // WebUI stays on loopback inside the VM with its own token; not reachable from outside anyway.
      `test -f ${CONFIG_DIR}/webui.json || cat > ${CONFIG_DIR}/webui.json <<'EOF'\n${JSON.stringify({ host: '127.0.0.1', port: 6099, token: cfg.token.slice(0, 16), loginRate: 10 })}\nEOF\n`);
  };
  // "[o]pt" keeps pgrep/pkill from matching the shell that runs them (which would say "running" forever, or kill itself).
  qq.running = async () => { try { return (await vmShell('pgrep -f "[o]pt/QQ/qq" >/dev/null && echo yes || echo no')).trim() === 'yes'; } catch { return false; } };
  qq.start = async () => {
    if (!(await qq.installed())) { setState('not-installed', 'NapCat is not installed in the computer — /qq install'); return false; }
    if (!cfg.qq) { setState('needs-account', 'set the QQ number: /qq account <number>'); return false; }
    await qq.configure();
    if (!(await qq.running())) {
      await vmShell(`cd ${VM_HOME}; export HOME=${VM_HOME}; rm -f ${QR_FILE}; setsid nohup xvfb-run -a ${QQ_BIN} --no-sandbox -q ${cfg.qq} > ${LOG_FILE} 2>&1 < /dev/null & disown; sleep 1; echo started`);
      audit({ kind: 'napcat-started', qq: cfg.qq });
      logger.info(`NapCat started for ${cfg.qq}`);
    }
    setState('starting');
    connect();
    return true;
  };
  qq.stop = async () => { closeWs(); try { await vmShell('pkill -f "[o]pt/QQ/qq" || true'); } catch {} setState('stopped'); audit({ kind: 'napcat-stopped' }); };
  /** The login QR NapCat wrote (PNG), or null while there is none (already logged in, or not yet started). */
  /**
   * A fresh login QR. QQ's codes live about a minute, and after a failed or expired attempt NapCat
   * does not always draw another, so: if the file is older than `maxAgeS` or the log shows a login
   * error after it was written, restart NapCat and wait for the new code. Returns { png, ageS } or null.
   */
  qq.qr = async ({ maxAgeS = 45 } = {}) => {
    const probe = async () => {
      const out = await vmShell(`if [ -f ${QR_FILE} ]; then age=$(( $(date +%s) - $(stat -c %Y ${QR_FILE}) )); err=$(awk -v t="$(date -r ${QR_FILE} '+%H:%M:%S')" '/Login Error|登录失败|二维码已过期/ && $2 > t' ${LOG_FILE} 2>/dev/null | tail -1); echo "age=$age"; echo "err=$err"; base64 -w0 ${QR_FILE}; else echo "age=-1"; fi`);
      const age = Number(/age=(-?\d+)/.exec(out)?.[1] ?? -1);
      const err = /err=(.*)/.exec(out)?.[1]?.trim() ?? '';
      const b64 = out.trim().split('\n').pop().trim();
      return { age, err, png: age >= 0 && b64 && !b64.startsWith('age=') && !b64.startsWith('err=') ? Buffer.from(b64, 'base64') : null };
    };
    try {
      let r = await probe();
      if (r.png && r.age <= maxAgeS && !r.err) return { png: r.png, ageS: r.age };
      // Stale, failed, or absent: start over so the code she scans is one QQ still accepts.
      audit({ kind: 'qr-refresh', age: r.age, err: r.err.slice(0, 120) });
      await vmShell(`pkill -f "[o]pt/QQ/qq" || true; sleep 1; rm -f ${QR_FILE}`);
      await vmShell(`cd ${VM_HOME}; export HOME=${VM_HOME}; setsid nohup xvfb-run -a ${QQ_BIN} --no-sandbox -q ${cfg.qq} > ${LOG_FILE} 2>&1 < /dev/null & disown; echo restarted`);
      for (let i = 0; i < 20; i++) { await new Promise((t) => setTimeout(t, 2000)); r = await probe(); if (r.png && r.age <= maxAgeS) return { png: r.png, ageS: r.age }; }
      return null;
    } catch (err) { logger.warn(`qr: ${err.message}`); return null; }
  };
  qq.log = async (lines = 40) => {
    try {
      return await vmShell([
        `if [ -f ${INSTALL_LOG} ] && [ ! -f ${INSTALL_DONE} ]; then echo "== installing =="; tail -n ${lines} ${INSTALL_LOG}; exit 0; fi`,
        `echo "== napcat.log (${LOG_FILE}) =="; tail -n ${lines} ${LOG_FILE} 2>/dev/null || echo "(no log file)"`,
        'echo "== processes =="; pgrep -af "[o]pt/QQ/qq|[X]vfb" || echo "(none)"',
        'echo "== listening =="; (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":3001|:6099" || echo "(nothing on 3001/6099)"',
        `echo "== files =="; ls -la ${QQ_BIN} ${CONFIG_DIR} 2>&1 | head -12; which xvfb-run Xvfb || echo "(no xvfb-run)"`,
      ].join('\n'));
    } catch (err) { return `log unavailable: ${err.message}`; }
  };

  // ---- the OneBot side: one WebSocket through the computer's gateway ----
  let ws = null, closed = false, reconnectTimer = null, echo = 0;
  const pending = new Map(); // echo → { resolve, reject, timer }
  function closeWs() { closed = true; if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; try { ws?.close(); } catch {} ws = null; qq.connected = false; }
  function connect() { void connectAsync(); }
  async function connectAsync() {
    const c = computer();
    if (!c?.port) return;
    if (!WebSocketImpl) { try { WebSocketImpl = (await import('ws')).default; } catch (err) { setState('error', `the ws package is missing: ${err.message}`); return; } }
    closed = false;
    if (ws) return;
    const url = `ws://127.0.0.1:${c.port}/`;
    const socket = new WebSocketImpl(url, { headers: { Host: `${cfg.wsPort}-napcat`, Authorization: `Bearer ${cfg.token}` } });
    ws = socket;
    socket.on('open', () => { logger.info('OneBot connected (NapCat in the computer)'); });
    socket.on('message', (data) => { try { onEvent(JSON.parse(String(data))); } catch (err) { logger.debug(`bad event: ${err.message}`); } });
    socket.on('close', () => { if (ws !== socket) return; ws = null; qq.connected = false; if (qq.state === 'connected') setState('reconnecting'); if (!closed) reconnectTimer = setTimeout(connect, cfg.reconnectMs); });
    socket.on('error', (err) => { logger.debug(`OneBot socket: ${err.message}`); });
  }
  function onEvent(ev) {
    if (ev.echo !== undefined && pending.has(ev.echo)) {
      const p = pending.get(ev.echo); pending.delete(ev.echo); clearTimeout(p.timer);
      if (ev.status === 'ok' || ev.retcode === 0) p.resolve(ev.data); else p.reject(new Error(ev.message || ev.wording || `retcode ${ev.retcode}`));
      return;
    }
    if (ev.post_type === 'meta_event') {
      if (ev.meta_event_type === 'lifecycle' && ev.sub_type === 'connect') { qq.connected = true; qq.selfId = String(ev.self_id ?? ''); setState('connected'); audit({ kind: 'connected', selfId: qq.selfId }); }
      if (ev.meta_event_type === 'heartbeat') { qq.connected = true; qq.selfId ||= String(ev.self_id ?? ''); if (qq.state !== 'connected') setState('connected'); }
      return;
    }
    if (ev.post_type !== 'message') return;
    const selfId = String(ev.self_id ?? qq.selfId);
    if (String(ev.user_id) === selfId) return;
    const text = segmentsToText(ev.message, selfId);
    if (!text) return;
    const isGroup = ev.message_type === 'group';
    if (isGroup && !groupWanted(ev, cfg.groupPolicy, selfId)) return;
    const who = ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
    if (!isGroup && !qq.owner) { qq.owner = String(ev.user_id); writeSettings({ owner: qq.owner }); audit({ kind: 'owner-learned', owner: qq.owner }); }
    const msg = { kind: isGroup ? 'group' : 'private', userId: String(ev.user_id), groupId: isGroup ? String(ev.group_id) : '', who, text, at: new Date().toISOString(), messageId: ev.message_id };
    audit({ kind: 'message', ...msg, text: text.slice(0, 200) });
    for (const fn of listeners) { try { fn(msg); } catch (err) { logger.warn(`qq listener: ${err.message}`); } }
  }
  function call(action, params) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== 1) return reject(new Error('QQ is not connected'));
      const id = `dot-${++echo}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${action}: no reply in ${cfg.requestTimeoutMs} ms`)); }, cfg.requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ action, params, echo: id }));
    });
  }
  /** Send text to "user:123" | "group:456" | "owner" | a number. Several bubbles: split on <sep/>. */
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  /** One OneBot image segment for an image she refers to (see imageSource). */
  async function imageSegment(ref) {
    const src = imageSource(ref);
    if (!src) throw new Error(`can't find image "${ref}" (http(s) URL | phone:screen | phone:latest | /sdcard/… | a path on your computer)`);
    if (src.kind === 'url') return { type: 'image', data: { file: src.ref } };
    if (src.kind === 'computer') return { type: 'image', data: { file: `file://${src.ref}` } };
    const phone = ctx.get('dshPhone');
    if (!phone?.isReady) throw new Error('her phone is not ready');
    let buf;
    if (src.kind === 'phone-screen') buf = await phone.screenshot();
    else {
      let path = src.ref;
      if (src.kind === 'phone-latest') {
        path = (await phone.shell('ls -t /sdcard/DCIM/Camera/* /sdcard/Pictures/Screenshots/* /sdcard/DCIM/Screenshots/* /sdcard/Pictures/* /sdcard/Download/* 2>/dev/null | grep -iE "\\.(jpe?g|png|webp|gif|heic)$" | head -1')).trim();
        if (!path) throw new Error('no photos on her phone yet');
      }
      buf = Buffer.from((await phone.adbExec(['exec-out', 'cat', path], { encoding: 'buffer', maxBuffer: MAX_IMAGE_BYTES * 2 })).stdout);
      if (!buf.length) throw new Error(`empty or missing on the phone: ${path}`);
    }
    if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${Math.round(buf.length / 1048576)} MB > 10 MB)`);
    return { type: 'image', data: { file: `base64://${buf.toString('base64')}` } };
  }
  /** Send to "user:123" | "group:456" | "owner" | a number: text (bubbles split on <sep/>) and/or images, in that order. */
  qq.send = async (to, text = '', images = []) => {
    const target = parseTarget(to, qq.owner);
    if (!target) throw new Error(`bad target "${to}" (user:<number> | group:<number> | owner)`);
    const action = target.group_id ? 'send_group_msg' : 'send_private_msg';
    const parts = String(text ?? '').split(/<sep\s*\/>/i).map((t) => t.trim()).filter(Boolean);
    const ids = [];
    for (const part of parts) ids.push((await call(action, { ...target, message: [{ type: 'text', data: { text: part } }] }))?.message_id);
    for (const ref of [].concat(images ?? []).filter(Boolean)) ids.push((await call(action, { ...target, message: [await imageSegment(ref)] }))?.message_id);
    const n = ids.length;
    if (!n) throw new Error('nothing to send (text and images both empty)');
    audit({ kind: 'sent', to: target, text: parts.join(' / ').slice(0, 200), images: [].concat(images ?? []).map((r) => (String(r).startsWith('http') ? r : String(r).slice(0, 80))) });
    return { sent: n, messageIds: ids };
  };
  qq.setAccount = (n) => { cfg.qq = String(n).trim(); qq.qq = cfg.qq; writeSettings({ qq: cfg.qq }); };
  qq.setOwner = (n) => { qq.owner = String(n).trim(); writeSettings({ owner: qq.owner }); };

  ctx.provide('dshQq', qq);

  // The computer may come up after us; start when it is ready.
  ctx.inject(['dshComputer'], (c) => {
    const boot = async () => { if (!cfg.autoStart || !cfg.qq) { setState(cfg.qq ? 'idle' : 'needs-account', cfg.qq ? undefined : 'set the QQ number: /qq account <number>'); return; } try { await qq.start(); } catch (err) { setState('error', err.message); logger.warn(`qq start failed: ${err.message}`); } };
    c.effect(() => { let gone = false; c.dshComputer.ready?.then(() => { if (!gone) void boot(); }); return () => { gone = true; closeWs(); }; }, 'dsh-dot/qq: boot with the computer');
  });

  // The tool she answers with. Only text, only to a user or a group; nothing that manages friends,
  // groups or files — those are not hers to do from here.
  ctx.inject(['tools'], (scope) => {
    scope.effect(() => scope.tools.register({
      name: 'qq_send',
      description: '用你的 QQ（电脑端在线）发消息：文字和/或图片。to: "user:<QQ号>"、"group:<群号>" 或 "owner"（和你说话的人）。几句话用 <sep/> 分开会作为几条发出。images 是要发的图片，每张直接作为图片发出去（不是链接）：图片网址；"phone:screen"（你手机此刻的屏幕截图）；"phone:latest"（你手机里最新的照片/截图/下载）；手机上的路径 "/sdcard/..."；或你电脑上的绝对路径。只在你确实想回或想说时用。',
      parameters: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' }, images: { type: 'array', items: { type: 'string' } } }, required: ['to'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { sent: { type: 'number' } }, required: ['sent'], additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: `sent ${v?.sent ?? 0} message(s)` }] },
      async execute(args) {
        const r = await qq.send(args.to, args.text ?? '', args.images ?? []);
        return { sent: r.sent };
      },
    }), 'dsh-dot/qq: qq_send tool');
  });

  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'qq:channel',
      order: 61,
      text: () => (qq.connected
        ? `你的 QQ（${qq.qq}）在你电脑上也登着：有人给你发消息会以「[QQ] 谁：内容」叫醒你，回复用 qq_send（立刻送达，to 用 user:<QQ号> 或 owner）。要给人看图就用 qq_send 的 images 直接发图片——网上的图给网址，手机屏幕给 "phone:screen"，手机里刚存的给 "phone:latest"——别发链接让人自己点。别人发来的图片会带一个网址，想看就打开。手机上的 QQ 照常可以看空间、看群。`
        : ''),
    }), 'dsh-dot/qq: channel section');
  });

  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'qq',
      description: 'her QQ on the computer (NapCat): status; "install", "account <number>", "start", "stop", "qr" (login QR → the phone album), "log", "owner <number>"',
      input: { hint: '[install | account <n> | start | stop | qr | log | owner <n>]' },
      handler: async ({ rawInput }) => {
        const [verb, arg] = String(rawInput ?? '').trim().split(/\s+/);
        let extra = '';
        try {
          if (verb === 'install') { void qq.install(); extra = '\ninstalling in the background (several minutes) — /qq log to follow, /qq for the state'; }
          else if (verb === 'account' && arg) { qq.setAccount(arg); extra = `\naccount set: ${arg}; /qq start`; }
          else if (verb === 'owner' && arg) { qq.setOwner(arg); extra = `\nowner set: ${arg}`; }
          else if (verb === 'start') { extra = (await qq.start()) ? '\nstarting; if this account is new here, /qq qr to log in' : `\n${qq.error}`; }
          else if (verb === 'stop') { await qq.stop(); extra = '\nstopped'; }
          else if (verb === 'log') { extra = `\n${await qq.log(30)}`; }
          else if (verb === 'qr') {
            const got = await qq.qr();
            if (!got) extra = '\nno login QR (already logged in, or NapCat could not draw one — /qq log)';
            else {
              // A new file name every time: the phone's gallery caches thumbnails by path, and a stale
              // thumbnail of an expired code is exactly what "一直过期" looks like.
              const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
              const file = join(dshHome(), 'phone', `qq-login-${stamp}.png`);
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, got.png);
              extra = `\nQR saved: ${file} (drawn ${got.ageS}s ago; valid about a minute)`;
              const phone = ctx.get('dshPhone');
              if (phone?.isReady) {
                try {
                  await phone.shell('rm -f /sdcard/Pictures/qq-login*.png; am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures');
                  await phone.adbExec(['push', file, `/sdcard/Pictures/qq-login-${stamp}.png`]);
                  await phone.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Pictures/qq-login-${stamp}.png`);
                  extra += `\nin her phone's album as qq-login-${stamp}.png — QQ → 扫一扫 → 相册 → that one → confirm on the phone. Be quick (≈1 min); /qq qr again for a fresh one.`;
                } catch (err) { extra += `\n(could not push to the phone: ${err.message})`; }
              }
            }
          }
        } catch (err) { extra = `\nerror: ${err.message}`; }
        const s = qq.status();
        return { kind: 'success', text: `qq: ${s.state}${s.error ? ` — ${s.error}` : ''}\naccount: ${s.qq || '(not set)'} · owner: ${s.owner || '(not learned yet)'} · connected: ${s.connected} · ws: ${s.wsPort} in the computer${extra}` };
      },
    }), 'dsh-dot/qq: /qq command');
  });
}
