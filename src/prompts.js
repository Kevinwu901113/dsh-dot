// Every text she is given lives in src/prompts/<id>.txt; <home>/prompts/<id>.txt, when it exists,
// is used instead (home = dot's home, default ~/dot). Files are re-read when their mtime changes,
// so an edit shows on her next turn. `{name}` is a placeholder; a line that is only a placeholder
// whose value is '' disappears. A few files are tables, one `key=value` per line (`table()`).
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  return drafts.get(id) ?? readText(overridePath(id)) ?? readText(builtinPath(id));
}

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

/** Every prompt: id, built-in file, override file (or null). */
export function list() {
  return readdirSync(BUILTIN).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort()
    .map((id) => ({ id, builtin: builtinPath(id), override: statSync(overridePath(id), { throwIfNoEntry: false })?.isFile() ? overridePath(id) : null }));
}
