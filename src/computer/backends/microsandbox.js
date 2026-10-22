// microsandbox backend: the computer is a libkrun microVM managed by the `msb` binary that ships
// inside the `microsandbox` npm package, so users need no Docker or other separate install.
// msb boots its own agent as PID 1 and does not run the image ENTRYPOINT; the AIO services are
// therefore started with `msb exec -d` (a runtime-owned job) after create/start.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { systemProxyEnv } from './proxy.js';

const execFileAsync = promisify(execFile);

const PLATFORM_PACKAGES = {
  'darwin-arm64': '@superradcompany/microsandbox-darwin-arm64',
  'linux-x64': '@superradcompany/microsandbox-linux-x64-gnu',
  'linux-arm64': '@superradcompany/microsandbox-linux-arm64-gnu',
  'win32-x64': '@superradcompany/microsandbox-win32-x64-msvc',
  'win32-arm64': '@superradcompany/microsandbox-win32-arm64-msvc',
};

/** Locate the bundled msb binary (env override → platform package → msb on PATH). */
export function resolveMsbBin() {
  if (process.env.DSH_COMPUTER_MSB) return process.env.DSH_COMPUTER_MSB;
  const pkg = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  const exe = process.platform === 'win32' ? 'msb.exe' : 'msb';
  if (pkg) {
    const require = createRequire(import.meta.url);
    const roots = [];
    try { roots.push(createRequire(require.resolve('microsandbox/package.json'))); } catch {}
    roots.push(require);
    for (const r of roots) {
      try {
        const bin = join(dirname(r.resolve(`${pkg}/package.json`)), 'bin', exe);
        if (existsSync(bin)) return bin;
      } catch {}
    }
  }
  return exe;
}

/** Host path → guest path. POSIX hosts keep the same path; Windows drives map to /mnt/<drive>/… (WSL style). */
export function guestPath(hostPath) {
  if (process.platform !== 'win32') return hostPath;
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(hostPath);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : hostPath.replace(/\\/g, '/');
}

function envFlags(env) {
  const flags = [];
  for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') flags.push('-e', `${k}=${v}`);
  return flags;
}

export function createMicrosandboxBackend(config, logger) {
  const bin = resolveMsbBin();
  const name = config.name;

  async function msb(args, opts = {}) {
    const started = Date.now();
    const quiet = args[0] === 'list' || (args[0] === 'exec' && !args.includes('-d'));
    if (!quiet) logger.info(`msb ${args.join(' ')}`);
    try {
      const { stdout } = await execFileAsync(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
        timeout: opts.timeout ?? 120_000,
        env: { ...process.env, ...(opts.env || {}) },
      });
      if (!quiet) logger.info(`msb ${args[0]} ok (${Date.now() - started} ms)`);
      return stdout.trim();
    } catch (err) {
      const detail = `${err.stdout || ''}\n${err.stderr || ''}`.trim() || err.message;
      logger.warn(`msb ${args[0]} failed after ${Date.now() - started} ms: ${detail.slice(0, 500)}`);
      throw new Error(`msb ${args[0]} failed: ${detail}`, { cause: err });
    }
  }

  async function names(running) {
    const out = await msb(['list', '-q', ...(running ? ['--running'] : [])]).catch(() => '');
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  const serviceEnv = config.slim ? { DISABLE_JUPYTER: 'true', DISABLE_CODE_SERVER: 'true', DISABLE_NODEJS_REPL: 'true' } : {};
  const mountSpec = (m) => `${m}:${guestPath(m)}:uid=1000,gid=1000`;

  async function startServices(waitHealthy) {
    if (await waitHealthy(3_000)) return;
    const running = await msb(['exec', '-u', 'root', '--no-tty', '--no-stdin', name, '--', 'sh', '-c', 'pgrep -x supervisord >/dev/null && echo yes || echo no']).catch(() => 'no');
    if (running !== 'yes') {
      // /tmp survives a VM restart; an X lock left by the previous boot makes Xvfb refuse to
      // start, which takes VNC and the browser down with it. Nothing runs yet, so they are stale.
      await msb(['exec', '-u', 'root', '--no-tty', '--no-stdin', name, '--', 'sh', '-c',
        'rm -f /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null; true']).catch((err) => logger.warn(`clearing stale X locks failed: ${err.message}`));
      logger.info('starting VM services (/opt/gem/run.sh)');
      await msb(['exec', '-d', '-u', 'root', ...envFlags(serviceEnv), name, '--', '/opt/gem/run.sh']);
    }
  }

  // Snapshots of this computer live in <msb home>/snapshots/<name>/snap_*/ (group = sandbox name).
  const snapDir = join(process.env.MSB_HOME || join(homedir(), '.microsandbox'), 'snapshots', name);
  /** Snapshots of this computer, newest first: [{ id, member, created }]. */
  function listSnapshots() {
    const out = [];
    try {
      for (const id of readdirSync(snapDir).filter((d) => d.startsWith('snap_'))) {
        try {
          const member = JSON.parse(readFileSync(join(snapDir, id, 'group-member.json'), 'utf8')).name;
          const created = JSON.parse(readFileSync(join(snapDir, id, 'snapshot.json'), 'utf8')).capture?.created_at || '';
          out.push({ id, member, created });
        } catch {}
      }
    } catch {}
    return out.sort((a, b) => b.created.localeCompare(a.created));
  }
  /** A reference to the snapshot `member` that msb accepts (checked with `snapshot inspect`). */
  async function resolvableRef(member) {
    const id = listSnapshots().find((s) => s.member === member)?.id;
    for (const ref of [id, id && join(snapDir, id), `${name}/${member}`].filter(Boolean)) {
      if (await msb(['snapshot', 'inspect', ref]).then(() => true, () => false)) return ref;
    }
    return null;
  }
  function restoreFrom(ref, set, port) {
    // Folders bound when the snapshot was taken but not in `set` are dropped on purpose.
    const args = ['restore', '--name', name, '--allow-missing-resources', '-q', '-u', config.user, '-c', String(config.cpus), '-m', config.memory, '-p', `127.0.0.1:${port}:8080`];
    for (const m of set) args.push('-v', mountSpec(m));
    args.push(ref);
    return msb(args, { timeout: 10 * 60_000 });
  }

  return {
    kind: 'microsandbox',
    bin,
    name,

    toGuestPath: guestPath,

    /** argv (host side) that runs `argv` inside the VM. Synchronous by construction. */
    execArgv({ user, cwd, env, argv, tty }) {
      return [bin, 'exec', '-u', user, '-w', cwd, ...envFlags(env), tty ? '-t' : '--no-tty', name, '--', ...argv];
    },

    /**
     * Host-shell prefix that blocks while a remount is in progress (lock file present) and until the
     * VM accepts commands as `user`, then execs the rest of argv.
     */
    waitPrefix(user, lockFile) {
      return ['/bin/sh', '-c', 'i=0; until [ ! -e "$4" ] && "$1" exec -u "$2" --no-tty --no-stdin "$3" -- true </dev/null >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 900 ] && { echo "dsh-computer: VM not ready" >&2; exit 125; }; sleep 1; done; shift 4; exec "$@"', 'dsh-computer-wait', bin, user, name, lockFile];
    },

    async rootShell(script) {
      return msb(['exec', '-u', 'root', '--no-tty', '--no-stdin', name, '--', '/bin/bash', '-c', script]);
    },

    async ensure({ mounts, port, waitHealthy }) {
      // 1. Host virtualization (Hypervisor.framework / WHP / KVM).
      try {
        await msb(['doctor'], { timeout: 60_000 });
      } catch (err) {
        const hint = process.platform === 'win32'
          ? '以管理员身份运行：Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart 和 bcdedit /set "{current}" hypervisorlaunchtype auto，然后重启。'
          : process.platform === 'darwin' ? 'microsandbox 需要 Apple 芯片的 Mac。' : '需要 /dev/kvm 可用（在 BIOS 开启虚拟化，并把当前用户加入 kvm 组）。';
        throw new Error(`dsh-computer: 本机虚拟化不可用。${hint}\n${err.message}`);
      }

      const all = await names(false);
      // The VM is gone but an earlier remount left a disk snapshot: bring that disk back.
      const saved = all.includes(name) ? null : listSnapshots()[0];
      const savedRef = saved && (await resolvableRef(saved.member));
      if (savedRef) {
        logger.warn(`computer "${name}" missing; restoring its disk from snapshot ${saved.member}`);
        await restoreFrom(savedRef, mounts, port);
      } else if (!all.includes(name)) {
        logger.info(`pulling ${config.image} (first run only, a few GB)…`);
        await msb(['pull', '-q', config.image], { timeout: 60 * 60_000, env: systemProxyEnv() });
        const args = [
          'create', '--name', name, '--hostname', config.name,
          '-m', config.memory, '-c', String(config.cpus),
          '-p', `127.0.0.1:${port}:8080`,
          '--label', 'dsh-computer=1',
          '--label', `dsh-computer.mounts=${JSON.stringify(mounts)}`,
        ];
        for (const m of mounts) args.push('--mount-dir', mountSpec(m));
        for (const [k, v] of Object.entries(serviceEnv)) args.push('-e', `${k}=${v}`);
        args.push(config.image);
        logger.info(`creating computer "${name}" (mounts: ${mounts.join(', ')})`);
        await msb(args, { timeout: 10 * 60_000 });
      } else if (!(await names(true)).includes(name)) {
        logger.info(`waking computer "${name}"`);
        await msb(['start', '-q', name], { timeout: 5 * 60_000 });
      }

      // 2. Start the image's services unless they are already up (or already starting).
      await startServices(waitHealthy);
      // A freshly created/restored VM is bound to exactly `mounts`.
      return { fresh: !all.includes(name) };
    },

    /**
     * Re-create the VM with a new set of shared folders while keeping its disk (logins, installed
     * software): stop → disk snapshot → remove → restore with the new bindings → start services.
     * microsandbox cannot add a mount to an existing sandbox, so this is the only way to share a
     * new workspace without losing state. On failure it restores with the previous folders.
     */
    async remount({ mounts, previous, port, waitHealthy }) {
      const snap = `${name}-${Date.now()}`;
      logger.info(`sharing new folder(s) with the computer: ${mounts.filter((m) => !previous.includes(m)).join(', ')}`);
      await msb(['stop', '-q', name], { timeout: 120_000 }).catch(() => {});
      await msb(['snapshot', 'create', '-q', '--sandbox', name, '--group', name, snap], { timeout: 10 * 60_000 });
      // Never remove the sandbox before the snapshot is known to be restorable.
      const ref = await resolvableRef(snap);
      if (!ref) {
        await msb(['start', '-q', name], { timeout: 5 * 60_000 }).catch(() => {});
        await startServices(waitHealthy);
        throw new Error(`snapshot ${snap} was created but cannot be resolved; kept the computer as it was`);
      }
      await msb(['rm', '-f', '-q', name], { timeout: 120_000 });
      try {
        await restoreFrom(ref, mounts, port);
      } catch (err) {
        logger.error(`restore with new folders failed, restoring previous setup: ${err.message}`);
        await restoreFrom(ref, previous, port);
        await startServices(waitHealthy);
        throw err;
      }
      await startServices(waitHealthy);
      // Snapshots form a chain (each restore layers on the previous one, the first shares the base
      // disk), so older ones cannot be removed without breaking the VM. Each remount adds ~15–20 MB.
    },
  };
}
