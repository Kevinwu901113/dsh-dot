// The Host must be able to exit once dispose is done: the desktop updater refuses to install when it
// does not ("Host did not complete graceful task teardown"). These run the real code in a child
// Node process and time its natural exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = (p) => pathToFileURL(resolve('src', p)).href;
const exitsWithin = (code, ms) => {
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: ms, encoding: 'utf8' });
  return { ok: r.status === 0 && r.signal === null, ms: Date.now() - started, out: `${r.stdout}${r.stderr}` };
};

test('phone: a long-lived emulator (left running across restarts) does not keep dsh alive after dispose', () => {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  const home = join(dsh, 'phone');
  // A fake SDK whose "emulator" runs for a minute and whose adb answers boot immediately.
  for (const f of ['system-images/android-35/google_apis/arm64-v8a/system.img']) { mkdirSync(join(home, f, '..'), { recursive: true }); writeFileSync(join(home, f), ''); }
  mkdirSync(join(home, 'emulator'), { recursive: true }); mkdirSync(join(home, 'platform-tools'), { recursive: true });
  writeFileSync(join(home, 'emulator/emulator'), '#!/bin/sh\nexec sleep 61.5\n', { mode: 0o755 });
  writeFileSync(join(home, 'platform-tools/adb'), '#!/bin/sh\ncase "$*" in *devices*) echo "List of devices attached";; *boot_completed*) echo 1;; esac\n', { mode: 0o755 });
  const code = `
    process.env.DSH_HOME = ${JSON.stringify(dsh)};
    const { apply } = await import(${JSON.stringify(src('phone/phone.js'))});
    const effects = [];
    const ctx = { logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }), on: () => () => {}, effect(fn) { effects.push(fn()); },
      provide() {}, plugin() { return { dispose() {} }; }, inject() {}, get: () => undefined };
    apply(ctx, { home: ${JSON.stringify(home)}, abi: 'arm64-v8a', acceptLicense: true, mcp: false, notifications: false, keepAppsAlive: false, liveViewPort: 0, bootTimeoutMs: 5000 });
    const until = async (p) => { for (let i = 0; i < 300 && !p(); i++) await new Promise((r) => setTimeout(r, 20)); };
    const { execSync } = await import('node:child_process');
    await until(() => { try { return execSync('pgrep -f "[s]leep 61[.]5"').length > 0; } catch { return false; } });
    for (const d of effects) if (typeof d === 'function') d();
  `;
  const r = exitsWithin(code, 8000);
  try { spawnSync('pkill', ['-f', '[s]leep 61[.]5']); } catch {}
  assert.ok(r.ok, `dsh did not exit after dispose (${r.ms} ms): ${r.out}`);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
});

test('phone live view: an open /stream does not keep dsh alive after close()', () => {
  const code = `
    const { startLiveView } = await import(${JSON.stringify(src('phone/live-view.js'))});
    const http = await import('node:http');
    const view = startLiveView({ port: 18191, screenshot: async () => Buffer.from('png'), shell: async () => '', ready: () => true, logger: {}, name: 't' });
    await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => http.get('http://127.0.0.1:18191/stream?fps=2', (res) => { res.on('data', () => {}); res.on('error', () => {}); r(); }).on('error', () => {}));
    view.close();
  `;
  const r = exitsWithin(code, 8000);
  assert.ok(r.ok, `dsh did not exit after close (${r.ms} ms): ${r.out}`);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
});
