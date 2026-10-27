// dsh-computer/key: the gateway credential. The AIO sandbox image's gateway (port 8080 in the VM,
// 127.0.0.1:<port> on this machine) answers to anyone who can reach it unless SANDBOX_API_KEY is
// set at launch: shell, files, browser CDP, MCP, noVNC, web terminal. dsh-dot generates one key per
// machine, keeps it in $DSH_HOME/dsh-computer.key (owner-only) and hands it to the VM at creation and
// at every service start. Every in-process caller (readiness probes, the MCP client, the live-view
// proxy, the QQ bridge) attaches it; nothing else on the machine can.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEY_ENV = 'SANDBOX_API_KEY';
/** Header the image documents for the key; it leaves `Authorization` free for the proxied service. */
export const KEY_HEADER = 'X-AIO-API-Key';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export const keyFile = () => join(dshHome(), 'dsh-computer.key');

/**
 * The machine's gateway key: read it, or create one (48 hex chars, file mode 0600) on first use.
 * `explicit` (settings `apiKey`) wins when set, so an operator can share a key with other tooling.
 */
export function computerApiKey(explicit, file = keyFile()) {
  const given = String(explicit ?? '').trim();
  if (given) return given;
  try {
    if (existsSync(file)) {
      const k = readFileSync(file, 'utf8').trim();
      if (k) return k;
    }
  } catch {}
  const key = randomBytes(24).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${key}\n`, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
  } catch {}
  return key;
}

/** Request headers that authenticate against the gateway. */
export function keyHeaders(key) {
  return key ? { [KEY_HEADER]: key } : {};
}
