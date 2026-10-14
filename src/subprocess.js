// dsh-computer/subprocess: `ctx.subprocess` provider that runs every managed process inside the
// agent's computer. It reuses the official local provider for handle, stdio and collect semantics
// and only rewrites argv into the backend's exec command (`msb exec` / `docker exec`), so spawn()
// stays synchronous as the seam requires.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';

const run = promisify(execFile);
const PROC_DIR = '/tmp/.dsh-computer-procs';
const VM_HOME = '/home/gem';

export default class DshComputerSubprocess extends LocalSubprocessRuntime {
  static inject = ['dshComputer'];

  constructor(ctx) {
    super(ctx);
    this.vm = ctx.dshComputer;
    this.backend = this.vm.backend;
    this.log = ctx.logger('dsh-computer');
    this.log.info(`subprocess routed into computer "${this.vm.container}" (${this.backend.kind})`);
  }

  /**
   * Map a host cwd into the VM. A workspace that is not shared yet gets shared now (the VM is
   * re-created with the extra folder; the spawn waits on the remount lock). Folders that may not
   * be shared run in the VM home.
   */
  vmCwd(cwd) {
    if (!this.vm.isShared(cwd)) this.vm.ensureShared?.(cwd);
    return this.vm.isShared(cwd) ? this.backend.toGuestPath(cwd) : VM_HOME;
  }

  /** Must this spawn wait (VM booting, or a remount in flight)? */
  mustWait() {
    if (!this.vm.isReady) return true;
    try { return existsSync(this.vm.lockFile); } catch { return false; }
  }

  // Ending the host-side exec client does not reliably stop the process inside the VM, so every
  // process starts in its own session with its group id recorded; teardown signals that group.
  wrap(argv, id) {
    const script = `mkdir -p ${PROC_DIR}; echo $$ > ${PROC_DIR}/${id}; exec "$@"`;
    return ['setsid', '/bin/sh', '-c', script, 'dsh-computer', ...argv];
  }

  async killRemote(id, signal) {
    await this.backend.rootShell(`p=$(cat ${PROC_DIR}/${id} 2>/dev/null) && kill -s ${signal} -- -$p 2>/dev/null; rm -f ${PROC_DIR}/${id}`).catch(() => {});
  }

  async resolveExecutable(command, env, signal) {
    await this.vm.ready;
    while (this.mustWait()) await new Promise((r) => setTimeout(r, 500));
    const probe = command.startsWith('/') ? 'test -x "$1" && printf %s "$1"' : 'command -v -- "$1"';
    const argv = this.backend.execArgv({ user: this.vm.user, cwd: VM_HOME, env, argv: ['/bin/sh', '-lc', probe, 'sh', command] });
    try {
      const { stdout } = await run(argv[0], argv.slice(1), { signal });
      const found = stdout.trim().split('\n').pop();
      if (found) return found;
    } catch {}
    throw new SubprocessExecutableNotFoundError(`dsh-computer: "${command}" not found in computer "${this.vm.container}"`);
  }

  async terminalEnvironment() {
    return { platform: 'posix', defaultShell: '/bin/bash' };
  }

  // spawn() must return synchronously; while the computer is still booting, a host-side shell
  // waits (up to 15 min) until the VM accepts commands, then hands over to the exec command.
  holdUntilReady(argv) {
    if (this.vm.error) throw this.vm.error;
    if (!this.mustWait()) return argv;
    return [...this.backend.waitPrefix(this.vm.user, this.vm.lockFile), ...argv];
  }

  spawn(spec) {
    const id = randomUUID();
    const cwd = this.vmCwd(spec.cwd);
    const inner = this.backend.execArgv({ user: this.vm.user, cwd, env: spec.env, argv: this.wrap(spec.argv, id) });
    const argv = this.holdUntilReady(inner);
    const handle = super.spawn({ ...spec, argv, cwd: process.cwd(), env: undefined });
    const terminate = handle.terminate.bind(handle);
    handle.terminate = () => { void this.killRemote(id, 'TERM'); terminate(); };
    spec.signal?.addEventListener('abort', () => void this.killRemote(id, 'TERM'), { once: true });
    handle.done?.then?.(() => this.killRemote(id, 'KILL'), () => this.killRemote(id, 'KILL'));
    return handle;
  }

  async spawnTerminal(spec) {
    await this.vm.ready;
    const shared = this.vm.isShared(spec.cwd) ? null : this.vm.ensureShared?.(spec.cwd);
    if (shared) await shared;
    const argv = this.backend.execArgv({ user: this.vm.user, cwd: this.vmCwd(spec.cwd), env: spec.env, argv: spec.argv, tty: true });
    return super.spawnTerminal({ ...spec, argv, cwd: process.cwd(), env: undefined });
  }
}
