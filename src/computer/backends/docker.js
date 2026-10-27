// Docker backend (fallback): the computer is a long-lived container. Used on Intel Macs or when
// DSH_COMPUTER_BACKEND=docker. Docker runs the image ENTRYPOINT itself.
import { docker, dockerOk, resolveDockerBin } from '../docker.js';

function envFlags(env) {
  const flags = [];
  for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') flags.push('-e', `${k}=${v}`);
  return flags;
}

export function createDockerBackend(config, logger) {
  const bin = resolveDockerBin();
  const name = config.name;
  const serviceEnv = { ...(config.apiKey ? { SANDBOX_API_KEY: config.apiKey } : {}), ...(config.slim ? { DISABLE_JUPYTER: 'true', DISABLE_CODE_SERVER: 'true', DISABLE_NODEJS_REPL: 'true' } : {}) };
  async function create(mounts, port) {
    const args = [
      'run', '-d', '--name', name, '--hostname', name, '--restart', 'unless-stopped',
      '--shm-size', config.shmSize, '--security-opt', 'seccomp=unconfined',
      '-p', `127.0.0.1:${port}:8080`,
      '-v', `${config.homeVolume}:/home/gem`,
      '--label', 'dsh-computer=1', '--label', `dsh-computer.mounts=${JSON.stringify(mounts)}`,
      ...envFlags(serviceEnv),
    ];
    for (const m of mounts) args.push('-v', `${m}:${m}`);
    args.push(config.image);
    logger.info(`creating computer "${name}" (mounts: ${mounts.join(', ')})`);
    await docker(bin, args);
  }
  /** Does the running container carry the current gateway key? Env is fixed at `docker run`. */
  async function hasKey() {
    if (!config.apiKey) return true;
    const env = await docker(bin, ['inspect', '-f', '{{json .Config.Env}}', name]).catch(() => '[]');
    try { return JSON.parse(env).includes(`SANDBOX_API_KEY=${config.apiKey}`); } catch { return false; }
  }
  return {
    kind: 'docker',
    bin,
    name,
    toGuestPath: (p) => p,

    execArgv({ user, cwd, env, argv, tty }) {
      return [bin, 'exec', tty ? '-it' : '-i', '-u', user, '-w', cwd, ...envFlags(env), name, ...argv];
    },

    /** Host-shell prefix that blocks until the VM accepts commands as `user`, then execs the rest of argv. */
    waitPrefix(user, lockFile) {
      return ['/bin/sh', '-c', 'i=0; until [ ! -e "$4" ] && "$1" exec -u "$2" "$3" true </dev/null >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 900 ] && { echo "dsh-computer: VM not ready" >&2; exit 125; }; sleep 1; done; shift 4; exec "$@"', 'dsh-computer-wait', bin, user, name, lockFile];
    },

    // Docker cannot add a bind mount to an existing container without recreating it; not supported yet.
    remount: undefined,

    async rootShell(script) {
      return docker(bin, ['exec', '-u', 'root', name, '/bin/bash', '-c', script]);
    },

    async ensure({ mounts, port }) {
      if (!(await dockerOk(bin, ['info', '--format', '{{.ServerVersion}}']))) {
        throw new Error(`dsh-computer: Docker is not running or not installed (looked for "${bin}"). Start Docker Desktop / OrbStack and restart dsh.`);
      }
      const state = await docker(bin, ['inspect', '-f', '{{.State.Status}}', name]).catch(() => 'missing');
      if (state === 'missing') {
        if (!(await dockerOk(bin, ['image', 'inspect', config.image]))) {
          logger.info(`pulling ${config.image} (first run only, a few GB)…`);
          await docker(bin, ['pull', config.image], { timeout: 60 * 60_000 });
        }
        await create(mounts, port);
        return { fresh: true };
      }
      // A container created without the key (older dsh-dot) answers to anyone: re-create it with the
      // key. Its home is a named volume and its folders are recorded in a label, so nothing is lost.
      if (!(await hasKey())) {
        const label = await docker(bin, ['inspect', '-f', '{{index .Config.Labels "dsh-computer.mounts"}}', name]).catch(() => '');
        let bound = [];
        try { bound = JSON.parse(label); } catch {}
        logger.warn(`computer "${name}" runs without a gateway key; re-creating it with one (home volume kept)`);
        await docker(bin, ['rm', '-f', name]);
        await create(Array.isArray(bound) ? bound : mounts, port);
        return { fresh: false, mounts: Array.isArray(bound) ? bound : mounts };
      }
      if (state !== 'running') {
        logger.info(`waking computer "${name}" (was ${state})`);
        await docker(bin, ['start', name]);
      }
      // Docker cannot add mounts later: report what this container was created with.
      const label = await docker(bin, ['inspect', '-f', '{{index .Config.Labels "dsh-computer.mounts"}}', name]).catch(() => '');
      let bound = [];
      try { bound = JSON.parse(label); } catch {}
      return { fresh: false, mounts: Array.isArray(bound) ? bound : [] };
    },
  };
}
