// dsh-computer/subprocess: `ctx.subprocess` provider that runs every managed process inside the
// agent's computer. It reuses the official local provider for handle, stdio and collect semantics
// and only rewrites argv into the backend's exec command (`msb exec` / `docker exec`), so spawn()
// stays synchronous as the seam requires.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess';
import { clip } from './audit.js';

const run = promisify(execFile);
const PROC_DIR = '/tmp/.dsh-computer-procs';
const VM_HOME = '/home/gem';
const REMOUNT_WAIT_MS = 120_000;

const STAGE = { downloading: '下载', installing: '安装', starting: '开机', remounting: '重新挂载' };
/** What a command gets while the computer is not up yet: what is happening, and not to wait. */
export function notReady(status = {}) {
  const what = STAGE[status.stage] ?? STAGE[status.state] ?? '准备';
  const pct = status.progress?.total ? `，${Math.round((status.progress.done / status.progress.total) * 100)}%` : '';
  return `电脑还在${what}中${pct}，现在跑不了命令。不用等它，也别自己去装或启动；先直接回话，好了会告诉你`;
}

export default class DshComputerSubprocess extends LocalSubprocessRuntime {
  static inject = ['dshComputer'];

  constructor(ctx) {
    super(ctx);
    this.vm = ctx.dshComputer;
    this.backend = this.vm.backend;
    this.log = ctx.logger('dsh-computer');
    // Whose command is this (by its cwd): src/compat/qq-bridge.js, when that component is on.
    this.compat = () => { try { return ctx.get?.('dshDotCompat'); } catch { return undefined; } };
    this.log.info(`subprocess routed into computer "${this.vm.container}" (${this.backend.kind})`);
  }

  /**
   * Where a command from this cwd goes: 'vm' (hers and everyone else's: into her computer),
   * 'vm-noshare' (a qq-bridge session: into the VM, but its folder is never shared in — sharing
   * re-creates the VM and her QQ inside it would drop, and nothing under qq-bridge's state/ belongs
   * in there), or 'host' (a qq-bridge owner chat with compat.ownerComputer 'host': dsh's own local
   * runner, as if this plugin were not installed).
   */
  routeFor(cwd) {
    const c = this.compat();
    const owner = c?.ownerOfCwd?.(cwd) ?? 'other';
    if (owner === 'qqb-owner' && c.ownerComputer === 'host') return 'host';
    return owner === 'qqb-owner' || owner === 'qqb-sandbox' ? 'vm-noshare' : 'vm';
  }

  /**
   * Map a host cwd into the VM. A workspace that is not shared yet gets shared now (the VM is
   * re-created with the extra folder; the spawn waits on the remount lock). Folders that may not
   * be shared — or must not be (route 'vm-noshare') — run in the VM home.
   */
  vmCwd(cwd, route = this.routeFor(cwd)) {
    if (route === 'vm' && !this.vm.isShared(cwd)) this.vm.ensureShared?.(cwd);
    return this.vm.isShared(cwd) ? this.backend.toGuestPath(cwd) : VM_HOME;
  }

  /** Must this spawn wait (a remount in flight)? Booting is not waited for: see usable(). */
  mustWait() {
    try { return existsSync(this.vm.lockFile); } catch { return false; }
  }

  /**
   * A command while the computer is still being installed or booting (minutes, on a first run)
   * fails at once with a reason she can act on, instead of holding her turn — waiting here could
   * not be cancelled and outlived the stop button. A failed computer fails the same way.
   */
  usable() {
    if (this.vm.error) throw new Error(`电脑出错了，现在跑不了命令（${this.vm.error.message}）。不用等，先直接回话；/phone doctor 或左侧栏 dot 页面看详情`);
    if (!this.vm.isReady) throw new Error(notReady(this.vm.status?.()));
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
    this.usable();
    // A remount (a new folder shared) takes seconds; bounded, and the stop button ends it.
    for (const until = Date.now() + REMOUNT_WAIT_MS; this.mustWait();) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      if (Date.now() > until) throw new Error('电脑在重新挂载文件夹，2 分钟还没好；稍后再试');
      await new Promise((r) => setTimeout(r, 500));
      this.usable();
    }
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

  // spawn() must return synchronously; during a remount a host-side shell waits until the VM
  // accepts commands again, then hands over to the exec command. A booting computer fails fast.
  holdUntilReady(argv) {
    this.usable();
    if (!this.mustWait()) return argv;
    return [...this.backend.waitPrefix(this.vm.user, this.vm.lockFile), ...argv];
  }

  spawn(spec) {
    if (this.routeFor(spec.cwd) === 'host') return this.spawnOnHost(spec);
    const id = randomUUID();
    const cwd = this.vmCwd(spec.cwd);
    this.vm.audit?.({ kind: 'exec', argv: clip(spec.argv.join(' ')), cwd });
    const inner = this.backend.execArgv({ user: this.vm.user, cwd, env: spec.env, argv: this.wrap(spec.argv, id) });
    const argv = this.holdUntilReady(inner);
    const handle = super.spawn({ ...spec, argv, cwd: process.cwd(), env: undefined });
    const terminate = handle.terminate.bind(handle);
    handle.terminate = () => { void this.killRemote(id, 'TERM'); terminate(); };
    spec.signal?.addEventListener('abort', () => void this.killRemote(id, 'TERM'), { once: true });
    handle.done?.then?.(() => this.killRemote(id, 'KILL'), () => this.killRemote(id, 'KILL'));
    return handle;
  }

  /**
   * Route 'host': dsh's own local runner. resolveExecutable() has no cwd to route by, so argv[0]
   * may be the VM's answer (`/bin/bash`); one that does not exist here goes back to its bare name
   * for the host's PATH.
   */
  hostArgv(argv) {
    const [cmd, ...rest] = argv;
    return isAbsolute(cmd) && !existsSync(cmd) ? [basename(cmd), ...rest] : argv;
  }

  spawnOnHost(spec) {
    this.vm.audit?.({ kind: 'exec-host', argv: clip(spec.argv.join(' ')), cwd: spec.cwd });
    return super.spawn({ ...spec, argv: this.hostArgv(spec.argv) });
  }

  async spawnTerminal(spec) {
    const route = this.routeFor(spec.cwd);
    if (route === 'host') return super.spawnTerminal({ ...spec, argv: this.hostArgv(spec.argv) });
    this.usable();
    const shared = route !== 'vm' || this.vm.isShared(spec.cwd) ? null : this.vm.ensureShared?.(spec.cwd);
    if (shared) await shared;
    const argv = this.backend.execArgv({ user: this.vm.user, cwd: this.vmCwd(spec.cwd), env: spec.env, argv: spec.argv, tty: true });
    this.vm.audit?.({ kind: 'terminal', argv: clip(spec.argv.join(' ')) });
    return super.spawnTerminal({ ...spec, argv, cwd: process.cwd(), env: undefined });
  }
}
