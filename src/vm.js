// dsh-computer/vm: owns the lifecycle of the agent's persistent computer.
// Backend: a microsandbox microVM by default (bundled, no Docker needed), Docker as fallback.
// The service is provided immediately so tools register at boot; `ready` settles once the VM
// answers. Disposal never stops the machine: files, logins and running apps outlive dsh restarts.
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { createMicrosandboxBackend } from './backends/microsandbox.js';
import { createDockerBackend } from './backends/docker.js';
import { createAudit } from './audit.js';

export const name = 'dsh-computer-vm';

export const defaults = {
  backend: 'auto', // auto | microsandbox | docker
  name: 'dsh-computer',
  image: 'ghcr.io/agent-infra/sandbox:latest',
  port: 18080,
  user: 'gem',
  memory: '4G',
  cpus: 2,
  mounts: [],
  readyTimeoutMs: 240_000,
  // Base URL that reaches the computer's web services from elsewhere (e.g. `tailscale serve` →
  // https://my-mac.tailnet.ts.net). Used in approval messages and status; unset = local only.
  publicUrl: '',
  // Turn off AIO services the agent does not use (Jupyter, code-server, Node REPLs).
  slim: true,
  // docker backend only
  homeVolume: 'dsh-computer-home',
  shmSize: '2g',
};

const PROFILE_DIR = '/home/gem/.config/browser';
const LIVE_VIEW_PATH = '/vnc/index.html?autoconnect=true&resize=scale';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** Optional user settings file: $DSH_HOME/dsh-computer.json (handy for the desktop app, which has no shell env). */
export function readSettingsFile() {
  const file = join(dshHome(), 'dsh-computer.json');
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; }
}

/**
 * Mirror the plugin's log lines into $DSH_HOME/dsh-computer.log: the desktop app does not expose
 * the Host log, and VM lifecycle problems are otherwise invisible. Kept under ~1 MB.
 */
function withFileLog(logger) {
  const file = join(dshHome(), 'dsh-computer.log');
  try { if (statSync(file).size > 1_000_000) rmSync(file, { force: true }); } catch {}
  const write = (level, args) => {
    try { appendFileSync(file, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}\n`); } catch {}
  };
  const wrapped = Object.create(logger);
  for (const level of ['debug', 'info', 'warn', 'error']) {
    wrapped[level] = (...args) => { write(level, args); return logger[level]?.(...args); };
  }
  return wrapped;
}

const stateFile = () => join(dshHome(), 'dsh-computer-state.json');
export const lockFile = () => join(dshHome(), 'dsh-computer.remount.lock');
export const auditFile = () => join(dshHome(), 'dsh-computer-audit.jsonl');

function readState() {
  try { return JSON.parse(readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function writeState(state) {
  try { mkdirSync(dshHome(), { recursive: true }); writeFileSync(stateFile(), JSON.stringify(state, null, 2)); } catch {}
}

const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };

/**
 * May this host folder be shared with the VM automatically? Only real directories under the
 * user's home, never the home itself, and never credential/app-data locations.
 */
export function shareable(dir) {
  const home = homedir();
  if (!isAbsolute(dir) || dir === home || !inside(home, dir)) return false;
  const top = relative(home, dir).split(sep)[0];
  if (top.startsWith('.') || ['Library', 'Applications'].includes(top)) return false;
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/** GET a loopback URL without any proxy; resolves to the HTTP status (0 on error). */
function probe(url) {
  return new Promise((done) => {
    const req = http.get(url, { timeout: 3000 }, (res) => { res.resume(); done(res.statusCode ?? 0); });
    req.on('error', () => done(0));
    req.on('timeout', () => { req.destroy(); done(0); });
  });
}

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  do {
    if ((await probe(url)) === 200) return true;
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() < end);
  return false;
}

/** Host folders shared with the VM. Defaults to the folder dsh starts in, or ~/dsh-computer/workspace. */
export function resolveMounts(config) {
  if (config.mounts?.length) return config.mounts.map((m) => resolve(m.replace(/^~(?=$|[\\/])/, homedir())));
  // The desktop app's Host runs inside $DSH_HOME/profiles/desktop: only share a cwd that passes the same rules.
  const cwd = process.cwd();
  if (shareable(cwd)) return [cwd];
  const fallback = join(homedir(), 'dsh-computer', 'workspace');
  mkdirSync(fallback, { recursive: true });
  return [fallback];
}

function pickBackend(config, logger) {
  let kind = config.backend;
  if (kind === 'auto') {
    // microsandbox ships for Apple silicon, Linux (KVM) and Windows (WHP); Intel Macs fall back to Docker.
    kind = process.platform === 'darwin' && process.arch !== 'arm64' ? 'docker' : 'microsandbox';
  }
  return kind === 'docker' ? createDockerBackend(config, logger) : createMicrosandboxBackend(config, logger);
}

/** Phase 1 (gates shell tools): VM exists, runs and accepts commands. */
export async function ensureShell(config, computer, logger) {
  const waitHealthy = (ms) => waitFor(`${computer.baseUrl}/v1/sandbox`, ms);
  return computer.backend.ensure({ mounts: computer.mounts, port: config.port, waitHealthy });
}

/** Phase 2 (browser / live view): the image's web services answer; repairs common failures. */
export async function ensureServices(config, computer, logger) {
  const base = computer.baseUrl;
  const waitHealthy = (ms) => waitFor(`${base}/v1/sandbox`, ms);
  if (!(await waitHealthy(config.readyTimeoutMs))) {
    // Hosts without IPv6 make AIO's nginx fail on "listen [::]"; drop those lines and retry once.
    logger.warn('VM services not healthy yet; retrying nginx without IPv6 listeners');
    await computer.backend.rootShell('for f in $(grep -rln "listen \\[::\\]" /opt/gem /etc/nginx 2>/dev/null); do sed -i "/listen \\[::\\]/d" $f; done; supervisorctl -c /opt/gem/supervisord.conf restart nginx').catch(() => {});
    if (!(await waitHealthy(60_000))) throw new Error(`dsh-computer: VM services did not become healthy on ${base}`);
  }
  // Two stale locks keep the browser down after a restart, because /tmp and the profile persist:
  // an X lock left by the previous boot stops the X server (tigervnc) and with it the desktop, and a
  // profile SingletonLock naming an earlier host stops Chrome. Clear both and start them once.
  if (!(await waitFor(`${base}/cdp/json/version`, 20_000))) {
    logger.info('browser not up; clearing stale X and profile locks and restarting the desktop');
    const sv = 'supervisorctl -c /opt/gem/supervisord.conf';
    await computer.backend.rootShell([
      `if ! pgrep -x Xvnc >/dev/null && ! pgrep -x Xtigervnc >/dev/null; then rm -f /tmp/.X*-lock /tmp/.X11-unix/X*; ${sv} start tigervnc openbox autocutsel-clipboard autocutsel-primary; fi`,
      `rm -f ${PROFILE_DIR}/Singleton*`,
      `${sv} restart agent-browser || ${sv} start agent-browser`,
    ].join('; ')).catch(() => {});
    if (!(await waitFor(`${base}/cdp/json/version`, 30_000))) logger.warn('browser still not reachable; shell tools work, browser tools may fail');
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...defaults, ...readSettingsFile(), ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) };
  const logger = withFileLog(ctx.logger('dsh-computer'));
  const backend = pickBackend(cfg, logger);
  const base = `http://127.0.0.1:${cfg.port}`;
  // Folders actually bound into the VM: what earlier runs recorded, plus the configured defaults.
  const state = readState();
  const recorded = state.mounts || [];
  // Explicitly configured folders are honored as given; recorded/default ones must pass `shareable`.
  const explicit = new Set(cfg.mounts?.length ? resolveMounts(cfg) : []);
  const allowed = (m) => explicit.has(m) || shareable(m);
  const initialMounts = [...new Set([...recorded, ...resolveMounts(cfg)])].filter(allowed);
  // An existing VM bound to a folder that is no longer allowed gets rebound without it.
  const disallowedBound = recorded.filter((m) => !allowed(m));
  const computer = {
    backend,
    container: cfg.name,
    user: cfg.user,
    mounts: initialMounts,
    lockFile: lockFile(),
    port: cfg.port,
    baseUrl: base,
    liveViewUrl: `${base}${LIVE_VIEW_PATH}`,
    publicLiveViewUrl: cfg.publicUrl ? `${String(cfg.publicUrl).replace(/\/+$/, '')}${LIVE_VIEW_PATH}` : undefined,
    cdpUrl: `${base}/cdp`,
    mcpUrl: `${base}/mcp`,
    isReady: false,
  };
  computer.audit = createAudit(auditFile());

  // Status for other plugins (dot, IM bridges): one snapshot shape plus change notifications.
  const listeners = new Set();
  computer.status = () => ({
    state: computer.error ? 'error' : computer.remounting ? 'remounting' : !computer.isReady ? 'starting' : computer.servicesReady ? 'ready' : 'shell-only',
    backend: backend.kind,
    liveViewUrl: computer.liveViewUrl,
    publicLiveViewUrl: computer.publicLiveViewUrl,
    mounts: [...computer.mounts],
    error: (computer.error || computer.servicesError)?.message,
  });
  computer.onStatus = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  let lastState;
  const changed = () => {
    const snap = computer.status();
    if (snap.state === lastState) return;
    lastState = snap.state;
    computer.audit({ kind: 'status', state: snap.state, error: snap.error });
    for (const fn of listeners) { try { fn(snap); } catch {} }
  };
  computer.notifyStatus = changed;

  let markReady;
  computer.ready = new Promise((r) => (markReady = r));
  try { rmSync(computer.lockFile, { force: true }); } catch {}

  /** Covered by an existing shared folder? */
  computer.isShared = (dir) => computer.mounts.some((m) => inside(m, dir));

  /**
   * Share `dir` with the VM (backend permitting). Creates the remount lock synchronously, so any
   * command spawned right after waits for the swap; resolves when the VM is back.
   */
  let pending = null;
  computer.ensureShared = (dir) => {
    if (computer.isShared(dir) || !shareable(dir) || !backend.remount || computer.error) return null;
    const previous = [...computer.mounts];
    const next = [...previous.filter((m) => !inside(dir, m)), dir]; // a parent replaces its children
    computer.mounts = next; // later spawns map paths as shared; they wait on the lock meanwhile
    try { writeFileSync(computer.lockFile, String(process.pid)); } catch {}
    computer.remounting = true; changed();
    const run = (pending || computer.ready).then(() =>
      backend.remount({ mounts: next, previous, port: cfg.port, waitHealthy: (ms) => waitFor(`${base}/v1/sandbox`, ms) }));
    pending = run.then(
      () => { writeState({ mounts: next }); logger.info(`shared with the computer: ${dir}`); computer.audit({ kind: 'mount', action: 'share', dir, mounts: next }); },
      (err) => { computer.mounts = previous; writeState({ mounts: previous }); logger.error(`could not share ${dir}: ${err.message}`); computer.audit({ kind: 'mount', action: 'share-failed', dir, error: err.message }); },
    ).finally(() => {
      try { rmSync(computer.lockFile, { force: true }); } catch {}
      computer.remounting = false; changed();
      ensureServices(cfg, computer, logger).catch((e) => logger.warn(e.message));
    });
    return pending;
  };

  ctx.provide('dshComputer', computer);
  logger.info(`backend: ${backend.kind} (${backend.bin}); shared folders: ${computer.mounts.join(', ')}`);
  ensureShell(cfg, computer, logger).then(
    async (result) => {
      // An existing VM is bound to what it was bound to before, not to this run's defaults:
      // backends that know the real bindings report them; otherwise trust the recorded state.
      if (!result?.fresh && result?.mounts) computer.mounts = result.mounts.filter(allowed);
      const bound = result?.mounts ?? recorded;
      const missing = result?.fresh ? [] : computer.mounts.filter((m) => !bound.includes(m));
      if ((disallowedBound.length || missing.length) && backend.remount && !result?.fresh) {
        if (disallowedBound.length) logger.warn(`unsharing folder(s) that may not be shared: ${disallowedBound.join(', ')}`);
        if (missing.length) logger.info(`sharing folder(s) not yet bound to the existing computer: ${missing.join(', ')}`);
        // Hold every command (incl. the host-side readiness probe) until the VM is back.
        try { writeFileSync(computer.lockFile, String(process.pid)); } catch {}
        await backend.remount({ mounts: computer.mounts, previous: recorded, port: cfg.port, waitHealthy: (ms) => waitFor(`${base}/v1/sandbox`, ms) })
          .then(() => { logger.info(`now shared: ${computer.mounts.join(', ')}`); computer.audit({ kind: 'mount', action: 'rebind', unshared: disallowedBound, shared: missing, mounts: computer.mounts }); })
          .catch((err) => { computer.mounts = bound.filter(allowed); logger.error(`could not rebind folders: ${err.message}`); })
          .finally(() => { try { rmSync(computer.lockFile, { force: true }); } catch {} });
      }
      writeState({ mounts: computer.mounts });
      computer.isReady = true; markReady(true); changed();
      logger.info('computer shell ready');
      return ensureServices(cfg, computer, logger).then(
        () => { computer.servicesReady = true; logger.info(`computer ready — live view: ${computer.liveViewUrl}`); changed(); },
        (err) => { computer.servicesError = err; logger.error(err.message); changed(); },
      );
    },
    (err) => { computer.error = err; markReady(false); logger.error(err.message); changed(); },
  );
}
