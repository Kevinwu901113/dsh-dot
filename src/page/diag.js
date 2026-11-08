// Diagnostics for a user to send the author: a zip of logs and state (redacted), and a short text
// summary to paste in an issue or a group chat. What she remembers, her diary, people and chats are
// left out unless `withPrivate` (then her memory notes and the QQ audit, still redacted).
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { arch, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { dshHome, fileError, readAll } from '../settings.js';
import { SECRET_KEY } from '../settings-schema.js';
import { report as doctorReport } from '../doctor.js';
import { zip } from './zip.js';

const MB = 1024 * 1024;

/** Mask what must not leave the machine: keys, tokens, bearer strings, key= in URLs, phone numbers, e-mails. */
export function redact(text) {
  return String(text)
    .replace(/("(?:[^"\\]*?(?:key|token|secret|password|passwd|cookie)[^"\\]*?)"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, '$1 ***')
    .replace(/([?&](?:key|token|access_token|api_key|apikey|sig|signature)=)[^&\s"']+/gi, '$1***')
    .replace(/\b(sk|pk|ak)-[A-Za-z0-9]{12,}\b/g, '$1-***')
    .replace(/(?<![\d.])1[3-9]\d{9}(?![\d.])/g, (m) => `${m.slice(0, 3)}****${m.slice(-4)}`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***');
}

/** The settings object with secret-looking keys masked. */
export function redactSettings(all) {
  const walk = (v) => Array.isArray(v) ? v.map(walk)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && x !== '' ? '***' : walk(x)]))
      : v;
  return walk(all);
}

/** The last `maxBytes` of a file (whole lines), or null when missing. */
export function tail(file, maxBytes = 2 * MB) {
  try {
    const size = statSync(file).size;
    if (size <= maxBytes) return readFileSync(file, 'utf8');
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      readSync(fd, buf, 0, maxBytes, size - maxBytes);
      const text = buf.toString('utf8');
      return `[… ${Math.round((size - maxBytes) / 1024)} KB earlier left out]\n${text.slice(text.indexOf('\n') + 1)}`;
    } finally { closeSync(fd); }
  } catch { return null; }
}
const lastLines = (text, n) => (text == null ? null : text.split(/\r?\n/).slice(-n).join('\n'));

/** Versions of what matters for a bug report. */
export function versions({ pluginVersion, dshVersion, phone, computer } = {}) {
  return {
    plugin: pluginVersion ?? '?', dsh: dshVersion ?? '?', node: process.version,
    os: `${platform()} ${release()} ${arch()}`, ramGb: Math.round(totalmem() / 1024 ** 3),
    phone: phone ? { state: phone.state, api: phone.api, abi: phone.abi, emulator: phone.emulatorVersion } : 'off',
    computer: computer ? { state: computer.state, backend: computer.backend, image: computer.image } : 'off',
  };
}

/**
 * Build the zip. `ctx`: { home (DSH_HOME), dotHome, status: { phone, computer, qq, dot }, doctor: items,
 * info: versions() result, withPrivate }.
 */
export function bundle({ home = dshHome(), dotHome, status = {}, doctor = [], info = {}, withPrivate = false, now = new Date() }) {
  const files = [];
  const add = (name, text) => { if (text != null && text !== '') files.push({ name, data: redact(text) }); };
  add('README.txt', [
    'dsh-dot 诊断包',
    `生成时间：${now.toISOString()}`,
    '已打码：密钥、令牌、密码、邮箱、手机号。',
    withPrivate ? '包含她的记忆笔记和 QQ 审计（用户勾选）。' : '不含记忆、日记、人物、聊天记录。',
  ].join('\n'));
  add('versions.json', JSON.stringify(info, null, 2));
  add('status.json', JSON.stringify(status, null, 2));
  add('doctor.txt', doctor.length ? doctorReport(doctor) : '');
  const err = fileError();
  add('settings.json', JSON.stringify({ fileError: err || undefined, settings: redactSettings(readAll()) }, null, 2));
  for (const f of ['dsh-phone.log', 'dsh-computer.log', 'dsh-qq.log', 'dsh-dot-prompts.log']) add(`logs/${f}`, tail(join(home, f)));
  add('logs/emulator.log', lastLines(tail(join(home, 'phone', 'emulator.log'), 4 * MB), 3000));
  add('logs/dsh-phone-audit.jsonl', lastLines(tail(join(home, 'dsh-phone-audit.jsonl')), 2000));
  add('logs/dsh-computer-audit.jsonl', lastLines(tail(join(home, 'dsh-computer-audit.jsonl')), 500));
  add('state/dsh-phone-shade.json', tail(join(home, 'dsh-phone-shade.json'), 256 * 1024));
  add('state/dsh-computer-state.json', tail(join(home, 'dsh-computer-state.json'), 64 * 1024));
  if (withPrivate) {
    add('private/dsh-qq-audit.jsonl', lastLines(tail(join(home, 'dsh-qq-audit.jsonl')), 1000));
    if (dotHome) for (const f of ['memory/memory.md']) {
      const p = join(dotHome, f);
      if (existsSync(p)) add(`private/${f}`, tail(p, 256 * 1024));
    }
  }
  return zip(files, now);
}

/** A few lines to paste: versions, component states, doctor problems, each component's last error. */
export function summary({ status = {}, doctor = [], info = {} }) {
  const lines = [`dsh-dot ${info.plugin ?? '?'} · dsh ${info.dsh ?? '?'} · ${info.os ?? ''} · ${info.ramGb ?? '?'} GB`];
  for (const [name, s] of Object.entries(status)) {
    if (!s) { lines.push(`${name}: 关`); continue; }
    lines.push(`${name}: ${s.state ?? '?'}${s.stage ? `/${s.stage}` : ''}${s.error ? ` — ${String(s.error).split('\n')[0].slice(0, 200)}` : ''}`);
  }
  const problems = doctor.filter((i) => i.level !== 'ok');
  if (problems.length) lines.push('体检：', ...problems.map((i) => `  ${i.level === 'bad' ? '❌' : '⚠️'} ${i.name}：${i.detail}`));
  else if (doctor.length) lines.push('体检：都没问题');
  const err = fileError();
  if (err) lines.push(`dsh-dot.json 格式错误：${err}`);
  return redact(lines.join('\n'));
}
