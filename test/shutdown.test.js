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
    apply(ctx, { home: ${JSON.stringify(home)}, abi: 'arm64-v8a', acceptLicense: true, mcp: false, notifications: false, keepAppsAlive: false, liveView: false, bootTimeoutMs: 5000 });
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

test('phone live view: a waiting frame request and a running screen stream do not keep dsh alive after close()', () => {
  const code = `
    const { mountLiveView, LIVE_VIEW_PATH } = await import(${JSON.stringify(src('phone/live-view.js'))});
    const http = await import('node:http');
    const { spawn } = await import('node:child_process');
    let route;
    // The screen stream is a real child process that would run for a minute; the frame request waits 25 s by itself.
    const openStream = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const view = mountLiveView({ webServer: { register: (r) => { route = r; return () => {}; } }, connection: { requestRejection: () => undefined }, screenshot: async () => { throw new Error('offline'); }, openStream, shell: async () => '', ready: () => true, logger: {}, name: 't' });
    // dsh's web server stays up in this test (it is dsh's, not ours); only our waiting request, stream and loop must let go.
    const server = http.createServer((req, res) => route.handler(req, res));
    server.unref();
    await new Promise((r) => server.listen(18191, '127.0.0.1', r));
    const answered = new Promise((r) => http.get('http://127.0.0.1:18191' + LIVE_VIEW_PATH + '/frame?after=0', { agent: false, headers: { connection: 'close' } }, (res) => { res.resume(); r(res.statusCode); }).on('error', () => r(0)));
    await new Promise((r) => setTimeout(r, 300));
    view.close();
    console.log('status', await answered);
  `;
  const r = exitsWithin(code, 8000);
  assert.ok(r.ok, `dsh did not exit after close (${r.ms} ms): ${r.out}`);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
  assert.match(r.out, /status 204/, 'the waiting request was answered, not left hanging');
});

test('/dot prompts: a running editor page does not keep dsh alive, and goes with it', () => {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  const code = `
    process.env.DSH_HOME = ${JSON.stringify(dsh)};
    const { promptsPage } = await import(${JSON.stringify(src('dot/core.js'))});
    const page = promptsPage({ home: ${JSON.stringify(join(dsh, 'dot'))}, port: 18192 });
    await page.start();
    void page.stop(); // what the dispose effect does
  `;
  const r = exitsWithin(code, 15000);
  assert.ok(r.ok, `dsh did not exit after dispose (${r.ms} ms): ${r.out}`);
});
