// One settings file for every component: $DSH_HOME/dsh-dot.json (default ~/.dsh/dsh-dot.json).
// It lives outside the plugin package, so upgrades never touch it, and the desktop app (which has no
// shell environment) can still be configured. Each component reads its own section:
//   { "phone": { "dataGb": 32 }, "computer": { "rootDisk": "32G" }, "interlude": { "activeHours": "09:00-01:00" } }
// Order, weakest first: component defaults → the component's older file (dsh-phone.json …) →
// the bundled cordis.patch.yml → this file. Values set by commands (/phone size, /dot memory recall …)
// are applied by each component on top. Read once at startup: restart dsh after editing.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SECTIONS = ['phone', 'computer', 'gate', 'qq', 'memory', 'interlude', 'dot'];

export const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
export const settingsPath = () => join(dshHome(), 'dsh-dot.json');

/** The whole file, or {} when it is missing. A broken file is reported once per read through `warn`. */
export function readAll(warn) {
  const file = settingsPath();
  if (!existsSync(file)) return {};
  try {
    const all = JSON.parse(readFileSync(file, 'utf8'));
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch (err) {
    warn?.(`${file} ignored: ${err.message}`);
    return {};
  }
}

/** One component's section. Keys starting with '_' (comments) are dropped. */
export function sectionOf(name, warn) {
  const s = readAll(warn)[name];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
  return Object.fromEntries(Object.entries(s).filter(([k, v]) => !k.startsWith('_') && v !== undefined));
}

/** Patch config without the values that mean "not set" (undefined, '', and optionally []). */
export const setValues = (config = {}, { dropEmptyArrays = false, keepEmpty = [] } = {}) =>
  Object.fromEntries(Object.entries(config).filter(([k, v]) =>
    v !== undefined && (v !== '' || keepEmpty.includes(k)) && !(dropEmptyArrays && Array.isArray(v) && !v.length)));
