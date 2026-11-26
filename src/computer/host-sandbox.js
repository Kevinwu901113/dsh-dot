// dsh-dot/host-sandbox: what her hands run on this machine itself (a thing given with device 'host') runs in a
// read-only, offline box unless he said yes to that very command. The gate (dot/gates.js classifyHost) still sorts
// commands into "only looks" (not asked about) and the rest (asked of him), but that sorting is for not bothering him,
// not for safety: a "look" that is not one (11-26: `rg --pre`, `sort -o`, `uniq in out`, `tree -o` all passed as
// looks) fails here instead of writing or reaching out. macOS: the system's own sandbox (sandbox-exec, Seatbelt —
// marked deprecated, still what other coding agents use for this). Elsewhere there is no box, and the gate asks him
// about every command instead (sandboxAvailable false).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
let forced = null, probed = null;
/**
 * Can a command on this machine be boxed? Not taken on trust: the first time it is asked, the box is tried — a plain
 * look must run in it and a write must be refused. A box that does not hold (the tool gone, the profile refused, a
 * write let through) counts as none, and every command on this machine is asked of him instead. (tests: setSandboxAvailable)
 */
export const sandboxAvailable = () => forced ?? (probed ??= probe());
export const setSandboxAvailable = (v) => { forced = v; };
export const sandboxProbe = () => probedWhy;
let probedWhy = '';
function probe() {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) { probedWhy = 'no sandbox-exec here'; return false; }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dot-box-')), target = join(dir, 'written');
  try {
    const run = (argv) => spawnSync(SANDBOX_EXEC, ['-p', profile(), ...argv], { timeout: 5000, encoding: 'utf8' });
    const look = run(['/bin/ls', '/']);
    if (look.status !== 0) { probedWhy = `a look did not run in the box: ${String(look.stderr || look.error?.message || look.status).trim().slice(0, 160)}`; return false; }
    run(['/bin/sh', '-c', `echo x > '${target}'`]);
    if (existsSync(target)) { probedWhy = 'a write got through the box'; return false; }
    probedWhy = 'ok';
    return true;
  } catch (err) { probedWhy = `probe failed: ${err.message}`; return false; } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* left in tmp */ } }
}

// Where keys and logins live: not even read in the box (the gate asks about naming them too).
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.kube', 'Library/Keychains', 'Library/Cookies'];
const SECRET_FILES = ['.netrc', '.npmrc', '.pypirc', '.git-credentials'];
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The Seatbelt profile: everything may be read and run except the key folders; nothing written but /dev's sinks; no network. */
export function profile(home = homedir()) {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    '(allow file-write-data (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    `(deny file-read* ${SECRET_DIRS.map((d) => `(subpath ${q(join(home, d))})`).join(' ')} ${SECRET_FILES.map((f) => `(literal ${q(join(home, f))})`).join(' ')} (subpath ${q(join(home, '.dsh'))}))`,
    // dsh's own folder for her hands is where they start; reading it is harmless, the rest of ~/.dsh holds keys.
    `(allow file-read* (subpath ${q(join(home, '.dsh', 'dsh-dot-hands'))}))`,
  ].join('\n');
}

/** argv run in the box; env additions that keep read-only tools from trying to write (git's optional index refresh). */
export const boxed = (argv, home = homedir()) => ({ argv: [SANDBOX_EXEC, '-p', profile(home), ...argv], env: { GIT_OPTIONAL_LOCKS: '0' } });

// Commands he said yes to, by their text: the gate lets one through after his yes, the subprocess runs that one
// command outside the box, once, within a few minutes. Anything else of theirs on this machine is boxed.
const YES_MS = 5 * 60_000;
const yes = new Map();
export function letThrough(command) { const c = String(command ?? '').trim(); if (c) yes.set(c, Date.now() + YES_MS); }
export function takeLetThrough(command) {
  const c = String(command ?? '').trim(), until = yes.get(c);
  for (const [k, t] of yes) if (t < Date.now()) yes.delete(k);
  if (!until || until < Date.now()) return false;
  yes.delete(c);
  return true;
}
/** The command line of `bash -c <cmd>` (or -lc), else the argv joined. */
export const commandOf = (argv) => (argv?.length >= 3 && /^-l?c$/.test(argv[1]) ? String(argv[2]) : (argv ?? []).join(' '));
