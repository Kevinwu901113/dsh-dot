#!/usr/bin/env node
// Pack the plugin as a tgz that knows where it came from: dsh-dot-build.json (version, commit, branch, time) is
// written next to package.json, packed with it, and removed again. Install that tgz into a dsh profile
// (`"dsh-dot-life": "file:<path>.tgz"`) instead of copying a checkout over node_modules, so the profile's
// package.json and lockfile name the build that runs (11-26: they said 0.25.1 while dev's 0.25.2 ran).
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty && !process.argv.includes('--dirty')) { console.error('working tree has changes; commit first (or pass --dirty)'); process.exit(1); }
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stampFile = join(root, 'dsh-dot-build.json');
writeFileSync(stampFile, `${JSON.stringify({ version, commit: git('rev-parse', 'HEAD') + (dirty ? '+dirty' : ''), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), packedAt: new Date().toISOString() }, null, 1)}\n`);
try {
  const out = execFileSync('npm', ['pack', '--json', ...(process.argv.includes('--dest') ? ['--pack-destination', process.argv[process.argv.indexOf('--dest') + 1]] : [])], { cwd: root, encoding: 'utf8' });
  console.log(JSON.parse(out)[0].filename);
} finally { rmSync(stampFile, { force: true }); }
