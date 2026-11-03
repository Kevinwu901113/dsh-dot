// dsh-dot/phone accounts: her app logins, kept on the host ($DSH_HOME/dsh-dot-accounts.json, 0600),
// never in her memory (consolidation drops passwords anyway). One generated default password at
// `_default`, used everywhere unless an app forced another one, which she then records with `set`.
//   { "_default": { "password": "…", "at": "YYYY-MM-DD" }, "<app>": { "login", "password", "note", "at" } }
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const accountsFile = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-dot-accounts.json');

// No 0/O/o, 1/l/I: she reads it off a screen and types it on a phone keyboard.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
/** 12 letters and digits, at least one upper, one lower, one digit (what most sign-up forms ask). */
export function generatePassword(n = 12, rand = randomInt) {
  for (;;) {
    const p = Array.from({ length: n }, () => ALPHABET[rand(ALPHABET.length)]).join('');
    if (/[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p)) return p;
  }
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** The store. `number()` is her phone number ('' = none), handed out by `get` for registering. */
export function createAccounts({ file = accountsFile(), number = () => '' } = {}) {
  const read = () => {
    try { const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; return all && typeof all === 'object' && !Array.isArray(all) ? all : {}; } catch { return {}; }
  };
  // Atomic: a half-written file would lose every password.
  const write = (all) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, file);
  };
  const keyOf = (all, app) => {
    const a = String(app ?? '').trim();
    if (!a || a.startsWith('_')) throw new Error('app: the app\'s name, e.g. "小红书"');
    return Object.keys(all).find((k) => !k.startsWith('_') && k.toLowerCase() === a.toLowerCase()) ?? a;
  };
  const defaultPassword = () => {
    const all = read();
    if (typeof all._default?.password === 'string' && all._default.password) return all._default.password;
    all._default = { password: generatePassword(), at: today() };
    write(all);
    return all._default.password;
  };
  return {
    file,
    defaultPassword,
    /** The app's account, or (none recorded) the default password and her number to register with. */
    get(app) {
      const all = read(), key = keyOf(all, app), a = all[key];
      if (a) return { app: key, found: true, login: a.login ?? '', password: a.password ?? '', note: a.note ?? '', at: a.at ?? '' };
      return { app: key, found: false, password: defaultPassword(), number: String(number() ?? '') };
    },
    /** Record (or update) what she registered with; only the given fields change. */
    set(app, { login, password, note } = {}) {
      const all = read(), key = keyOf(all, app);
      const patch = Object.fromEntries(Object.entries({ login, password, note }).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
      if (!Object.keys(patch).length) throw new Error('nothing to record: give login, password or note');
      all[key] = { ...all[key], ...patch, at: today() };
      write(all);
      return { app: key, changed: Object.keys(patch) };
    },
    /** Apps and logins, no passwords. */
    list() { return Object.entries(read()).filter(([k]) => !k.startsWith('_')).map(([app, a]) => ({ app, login: a?.login ?? '', note: a?.note ?? '', at: a?.at ?? '' })); },
    count() { return Object.keys(read()).filter((k) => !k.startsWith('_')).length; },
  };
}

/** What the `account` tool shows her. */
export function renderAccount(v) {
  if (!v) return '';
  if (v.error) return `account: ${v.error}`;
  if (v.action === 'list') return v.accounts.length ? v.accounts.map((a) => `- ${a.app}：${a.login || '（没记登录名）'}${a.note ? `（${a.note}）` : ''}`).join('\n') : '（还没有记过账号）';
  if (v.action === 'set') return `记下了：${v.app}（${v.changed.map((k) => ({ login: '登录名', password: '密码', note: '备注' }[k])).join('、')}）`;
  if (v.found) return `${v.app}：登录名 ${v.login || '（没记）'}，密码 ${v.password || '（没记）'}${v.note ? `（${v.note}）` : ''}`;
  return `${v.app} 还没记过账号。注册用：手机号 ${v.number || '（没设，问他要）'}，密码 ${v.password}。注册好了用 account set 记下来。`;
}
