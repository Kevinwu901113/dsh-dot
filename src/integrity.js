// dsh-dot/integrity: are the plugin's files on disk still the ones this process started from?
// The code is read once, when dsh starts; the prompt files are read from disk every time they are used. When the
// files are replaced under a running dsh (an install, an update, a restore of another version), the code that runs
// names prompts the disk no longer has, and every turn of hers breaks on the first of them (11-22: 0.25.0 running
// over a disk put back to 0.23.2 — "unknown prompt: phone.hers", and silence on his side all afternoon). What was
// here at the start is kept, so the difference can be said plainly: which version started, which is on disk now.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const versionOnDisk = () => { try { return String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? ''); } catch { return ''; } };
const promptsOnDisk = () => { try { return readdirSync(join(ROOT, 'src', 'prompts')).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)); } catch { return []; } };

/** What was on disk when this process loaded the plugin: its version and its prompt files. */
export const LOADED = Object.freeze({ version: versionOnDisk(), prompts: new Set(promptsOnDisk()) });

/** null while the disk is as it was at the start; else { loaded, disk, missing: ids of prompt files that are gone }. */
export function drift({ version = versionOnDisk(), prompts = promptsOnDisk() } = {}) {
  const now = new Set(prompts), missing = [...LOADED.prompts].filter((id) => !now.has(id));
  return version === LOADED.version && !missing.length ? null : { loaded: LOADED.version, disk: version, missing };
}
