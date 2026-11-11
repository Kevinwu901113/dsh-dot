// One settings file for every component: $DSH_HOME/dsh-dot.json (default ~/.dsh/dsh-dot.json).
// It lives outside the plugin package, so upgrades never touch it, and the desktop app (which has no
// shell environment) can still be configured. Each component reads its own section:
//   { "phone": { "dataGb": 32 }, "computer": { "rootDisk": "32G" }, "interlude": { "activeHours": "09:00-01:00" } }
// Order, weakest first: component defaults → the component's older file (dsh-phone.json …) →
// the bundled cordis.patch.yml → this file. Values set by commands (/phone size, /dot memory recall …)
// are applied by each component on top. Read once at startup: restart dsh after editing.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** The file's parse error, or '' when it is missing or valid: shown on /phone and the dot page. */
export function fileError() {
  const file = settingsPath();
  if (!existsSync(file)) return '';
  try { const all = JSON.parse(readFileSync(file, 'utf8')); return all && typeof all === 'object' && !Array.isArray(all) ? '' : 'not a JSON object'; } catch (err) { return err.message; }
}

/**
 * Merge values into sections and write the file atomically. `patch`: { section: { key: value } };
 * a value of null removes the key (back to the default). Comments ('_' keys) and unknown keys stay.
 * A broken file is not overwritten unless `overwriteBroken` (then it is kept as dsh-dot.json.broken-<time>).
 */
export function writeSections(patch, { overwriteBroken = false } = {}) {
  const file = settingsPath();
  let all = {};
  if (existsSync(file)) {
    const err = fileError();
    if (err && !overwriteBroken) throw new Error(`${file} is not valid JSON (${err}); fix it or overwrite it`);
    if (err) copyFileSync(file, `${file}.broken-${Date.now()}`);
    else all = JSON.parse(readFileSync(file, 'utf8'));
  }
  for (const [section, values] of Object.entries(patch)) {
    const cur = all[section] && typeof all[section] === 'object' && !Array.isArray(all[section]) ? { ...all[section] } : {};
    for (const [k, v] of Object.entries(values)) { if (v === null) delete cur[k]; else cur[k] = v; }
    if (Object.keys(cur).length) all[section] = cur; else delete all[section];
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  renameSync(tmp, file);
  return all;
}
