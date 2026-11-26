// dsh-dot/build: which build of the plugin this is. A published or packed copy carries dsh-dot-build.json (written by
// scripts/pack.mjs: the commit it was packed from); a checkout has none and says only its package version. Two builds
// with the same version number (0.25.2 was both main and dev, 11-26) are told apart by the commit.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (p) => { try { return require(p); } catch { return null; } };
const pkg = read('../package.json') ?? {};
const stamp = (() => { try { return JSON.parse(readFileSync(new URL('../dsh-dot-build.json', import.meta.url), 'utf8')); } catch { return null; } })();

/** { version, commit ('' for a checkout), branch, packedAt } */
export const build = Object.freeze({ version: pkg.version ?? '?', commit: stamp?.commit ?? '', branch: stamp?.branch ?? '', packedAt: stamp?.packedAt ?? '' });
/** "0.25.3-dev.1 (dev 1a2b3c4)" — what the dot page and the doctor show. */
export const buildText = () => `${build.version}${build.commit ? ` (${build.branch ? `${build.branch} ` : ''}${build.commit.slice(0, 7)})` : ''}`;
