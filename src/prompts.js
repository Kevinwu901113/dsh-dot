// Every text she is given lives in src/prompts/<id>.txt; <home>/prompts/<id>.txt, when it exists,
// is used instead (home = dot's home, default ~/dot). Files are re-read when their mtime changes,
// so an edit shows on her next turn. `{name}` is a placeholder; a line that is only a placeholder
// whose value is '' disappears. A few files are tables, one `key=value` per line (`table()`).
// An override may start with `# base: <hash>`, the built-in it was based on (sha256, 12 hex): when
// the built-in changes, list() says `stale`, so an upgrade does not hide behind an old copy.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sectionOf } from './settings.js';

export const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), 'prompts');
const ID = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const PLACEHOLDER = /\{([A-Za-z]\w*)\}/g;

let home = '';
let logger = { warn: (m) => console.warn(`dsh-dot/prompts: ${m}`) };
/** dot's home (the overrides live in <home>/prompts) and where warnings go. */
export function configure(o = {}) {
  if (o.home) home = o.home;
  if (o.logger?.warn) logger = o.logger;
}
export const promptHome = () => home || process.env.DSH_DOT_HOME || sectionOf('dot').home || join(homedir(), 'dot');
export const overrideDir = () => join(promptHome(), 'prompts');
export const builtinPath = (id) => join(BUILTIN, `${id}.txt`);
export const overridePath = (id) => join(overrideDir(), `${id}.txt`);

const cache = new Map(); // path → { mtimeMs, text }
function readText(path) {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile()) return null;
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\n$/, '');
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, text });
  return text;
}

const MARK = /^# base: ([0-9a-f]{12})(?:\n|$)/;
const baseOf = (id) => createHash('sha256').update(readText(builtinPath(id))).digest('hex').slice(0, 12);
/** `text` as an override of `id`, marked with the current built-in as its base. */
export const stamp = (id, text) => `# base: ${baseOf(id)}\n${String(text).replace(/\r\n/g, '\n').replace(MARK, '').replace(/\n*$/, '')}\n`;

const warned = new Set();
/** Fill `{name}` from vars; a missing one stays as written and is warned about once. */
export function fill(text, vars = {}, id = '') {
  const lines = text.split('\n').filter((l) => { const m = /^\{([A-Za-z]\w*)\}$/.exec(l); return !(m && vars[m[1]] === ''); });
  return lines.join('\n').replace(PLACEHOLDER, (m, k) => {
    if (Object.hasOwn(vars, k)) return String(vars[k]);
    if (!warned.has(`${id}:${k}`)) { warned.add(`${id}:${k}`); logger.warn(`${id}: no value for {${k}}, left as is`); }
    return m;
  });
}

/** The prompt `id`, filled with `vars`. */
export const prompt = (id, vars = {}) => fill(raw(id), vars, id);

/** A `key=value` per line file as an object, each value filled with `vars`. */
export function table(id, vars = {}) {
  const out = {};
  for (const line of raw(id).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = fill(line.slice(i + 1), vars, id);
  }
  return out;
}

const drafts = new Map(); // id → unsaved text, only while the prompts page previews it
/** Run `fn` with `text` standing in for prompt `id` (the prompts page's preview of an unsaved edit). */
export async function withDraft(id, text, fn) {
  raw(id);
  drafts.set(id, String(text).replace(/\r\n/g, '\n').replace(/\n$/, ''));
  try { return await fn(); } finally { drafts.delete(id); }
}

/** The file's text as is (override first), no placeholders filled. Unknown id → throws. */
export function raw(id) {
  if (!ID.test(id) || !statSync(builtinPath(id), { throwIfNoEntry: false })) throw new Error(`unknown prompt: ${id}`);
  return drafts.get(id) ?? readText(overridePath(id))?.replace(MARK, '') ?? readText(builtinPath(id));
}

/** Every prompt: id, built-in file, override file (or null); an override's base is `stale` or missing (`unbased`). */
export function list() {
  return readdirSync(BUILTIN).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort().map((id) => {
    const text = readText(overridePath(id)), base = text === null ? null : MARK.exec(text)?.[1];
    return { id, builtin: builtinPath(id), override: text === null ? null : overridePath(id), ...(base ? base !== baseOf(id) && { stale: true } : text !== null && { unbased: true }) };
  });
}

/** One line per kind of override to look at ([] when all are current). */
export function overrideNotes() {
  const all = list(), ids = (k) => all.filter((x) => x[k]).map((x) => x.id).join(' ');
  return [['stale', '默认已更新'], ['unbased', '未记录基线']].filter(([k]) => ids(k)).map(([k, t]) => `${t}：${ids(k)}`);
}

/** Lines only in the override `-`, only in the built-in `+` (LCS). */
function diff(a, b) {
  const x = a.split('\n'), y = b.split('\n'), L = Array.from({ length: x.length + 1 }, () => Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  for (let i = 0, j = 0; i < x.length || j < y.length;) {
    if (i < x.length && j < y.length && x[i] === y[j]) { out.push(`  ${x[i++]}`); j++; }
    else if (i < x.length && (j === y.length || L[i + 1][j] >= L[i][j + 1])) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  return out.join('\n');
}

/** /dot prompts rebase <id> [--reset]: show the override against today's built-in and mark it reviewed, or delete it. */
export function rebase(id, reset = false) {
  raw(id); // unknown id → throws
  const text = readText(overridePath(id));
  if (text === null) return `${id} 没有覆盖`;
  if (reset) { rmSync(overridePath(id)); return `已删除覆盖，${id} 回到内置版本`; }
  writeFileSync(overridePath(id), stamp(id, text));
  return `${id}（- 你的覆盖 / + 现在的内置）：\n${diff(text.replace(MARK, ''), readText(builtinPath(id)))}\n\n已记下基线；要换回内置：/dot prompts rebase ${id} --reset`;
}
