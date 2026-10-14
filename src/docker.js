// Docker CLI helpers. The desktop app is often launched from Finder with a minimal PATH,
// so the docker binary is resolved from the usual install locations, not just PATH.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CANDIDATES = [
  process.env.DSH_COMPUTER_DOCKER,
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  join(homedir(), '.docker/bin/docker'),
  join(homedir(), '.orbstack/bin/docker'),
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  '/usr/bin/docker',
  'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
].filter(Boolean);

/** @returns absolute path of the docker CLI, or 'docker' to fall back to PATH lookup. */
export function resolveDockerBin() {
  return CANDIDATES.find((p) => existsSync(p)) ?? 'docker';
}

/**
 * Run one docker CLI command.
 * @returns trimmed stdout.
 * @throws with stderr attached when the command exits non-zero.
 */
export async function docker(bin, args, opts = {}) {
  try {
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout ?? 120_000, signal: opts.signal });
    return stdout.trim();
  } catch (err) {
    const detail = (err.stderr || err.message || '').toString().trim();
    throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${detail}`, { cause: err });
  }
}

/** @returns true when docker exits 0 for the given args. */
export async function dockerOk(bin, args) {
  try { await docker(bin, args, { timeout: 30_000 }); return true; } catch { return false; }
}
