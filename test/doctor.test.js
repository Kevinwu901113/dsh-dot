import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, report, hostDeps } from '../src/doctor.js';
import { setupText } from '../src/dot/core.js';
import { progressView } from '../src/phone/phone.js';
import DshComputerSubprocess, { notReady } from '../src/computer/subprocess.js';

const GB = 1024 ** 3;
/** A fake Windows host: commands answered from a table (by "cmd arg0"), the rest fail. */
function windows({ hypervisor = 'True', freeGb = 100, totalGb = 16, commitGb = 20, netstat = '', tasks = {}, curl = '200' } = {}) {
  return hostDeps({
    os: 'win32', arch: 'x64', totalmem: () => totalGb * GB, freemem: () => 8 * GB,
    statfs: () => ({ bavail: freeGb * GB / 4096, bsize: 4096 }), exists: () => false, canRw: () => true, proxyEnv: () => ({}),
    exec: async (cmd, args) => {
      if (cmd === 'powershell' && /HypervisorPresent/.test(args.at(-1))) return { stdout: hypervisor };
      if (cmd === 'powershell' && /FreeVirtualMemory/.test(args.at(-1))) return { stdout: `${commitGb * 1024 * 1024} ${(commitGb + 4) * 1024 * 1024}` };
      if (cmd === 'netstat') return { stdout: netstat };
      if (cmd === 'tasklist') { const pid = /PID eq (\d+)/.exec(args[1])[1]; return { stdout: `"${tasks[pid] ?? 'x.exe'}","${pid}"` }; }
      if (cmd === 'curl') { if (curl === 'fail') throw new Error('could not resolve'); return { stdout: curl }; }
      throw new Error(`unexpected ${cmd}`);
    },
  });
}
const phone = { installed: false, running: false, ramMb: 3072, dataGb: 16, port: 5554, adbPort: 5137, paths: { emulator: 'C:/x/emulator.exe' } };
const computer = { installed: false, memory: '4G', rootDisk: '16G', image: 'ghcr.io/agent-infra/sandbox:latest' };
const levels = (items) => Object.fromEntries(items.map((i) => [i.name, i.level]));

test('doctor: a healthy Windows host passes', async () => {
  const items = await diagnose({ phone, computer, home: 'C:/Users/a/.dsh' }, windows({ totalGb: 32, commitGb: 40 }));
  assert.ok(items.every((i) => i.level === 'ok'), report(items));
  assert.match(report(items), /都没问题/);
});

test('doctor: no WHPX, a full disk, a small page file, BlueStacks on 5555, no route to Google — each with its fix', async () => {
  const netstat = '  TCP    127.0.0.1:5037   0.0.0.0:0  LISTENING  111\r\n  TCP    0.0.0.0:5555   0.0.0.0:0  LISTENING  222\r\n';
  const items = await diagnose({ phone, computer, home: 'C:/Users/a/.dsh' }, windows({ hypervisor: 'False', freeGb: 20, commitGb: 7, netstat, tasks: { 111: 'MuMuPlayer-adb.exe', 222: 'HD-Player.exe' }, curl: 'fail' }));
  const l = levels(items);
  assert.equal(l['硬件虚拟化'], 'bad');
  assert.equal(l['磁盘空间'], 'bad');
  assert.equal(l['可提交内存（页面文件）'], 'bad');
  assert.equal(l['模拟器端口'], 'bad');
  assert.equal(l['下载源：手机'], 'bad');
  const text = report(items);
  assert.match(text, /HypervisorPlatform/);
  assert.match(text, /5555 被 HD-Player\.exe 占了[\s\S]*phone\.port 为 5556/);
  assert.match(text, /5037 被 MuMuPlayer-adb\.exe 占着.*5137，不受影响/);
  assert.match(text, /^dot 体检：6 项会导致装不上/);
  assert.ok(text.indexOf('❌') < text.indexOf('✅'), 'problems first');
});

test('doctor: nothing left to install means no download or disk demands; phone off skips its ports', async () => {
  const items = await diagnose({ phone: null, computer: { ...computer, installed: true }, home: '/h' }, windows({ freeGb: 3 }));
  assert.ok(!items.some((i) => i.name.startsWith('下载源')));
  assert.equal(levels(items)['磁盘空间'], 'ok');
  assert.ok(!items.some((i) => /端口/.test(i.name)));
});

test('doctor: Linux without /dev/kvm', async () => {
  const items = await diagnose({ phone, computer: null, home: '/h' }, hostDeps({ os: 'linux', exists: () => false, totalmem: () => 64 * GB, statfs: () => ({ bavail: 1e9, bsize: 4096 }), exec: async () => ({ stdout: '200' }), proxyEnv: () => ({}) }));
  assert.equal(levels(items)['硬件虚拟化'], 'bad');
});

test('setup context: says what is being installed and not to wait; empty once both are up', () => {
  const t = setupText({ state: 'downloading', progress: { text: '下载系统镜像 820/1450 MB，约 6 分钟' } }, { state: 'starting', stage: 'downloading' });
  assert.match(t, /手机：下载系统镜像 820\/1450 MB/);
  assert.match(t, /电脑：下载镜像中/);
  assert.match(t, /不用等/);
  assert.match(setupText({ state: 'needs-license' }, null), /\/phone accept/);
  assert.equal(setupText({ state: 'ready' }, { state: 'ready' }), '');
  assert.equal(setupText({ state: 'ready' }, { state: 'shell-only' }), '');
});

test('phone download progress: MB, percent and a rough ETA', () => {
  const v = progressView({ what: 'system image', done: 500 * 1048576, total: 1500 * 1048576, startedAt: 0 }, 100_000);
  assert.equal(v.pct, 33);
  assert.equal(v.etaMin, 3);
  assert.equal(v.text, '下载系统镜像 500/1500 MB，约 3 分钟');
});

test('computer subprocess: a booting or failed computer fails a command at once instead of holding the turn', async () => {
  const vm = { isReady: false, error: null, lockFile: '/nonexistent/lock', status: () => ({ state: 'starting', stage: 'downloading' }), backend: {} };
  const sp = Object.create(DshComputerSubprocess.prototype);
  sp.vm = vm; sp.backend = vm.backend;
  const t0 = Date.now();
  await assert.rejects(sp.resolveExecutable('ls', {}, undefined), /电脑还在下载中.*不用等/);
  assert.throws(() => sp.holdUntilReady(['x']), /电脑还在下载中/);
  assert.ok(Date.now() - t0 < 1000);
  vm.error = new Error('no hypervisor');
  await assert.rejects(sp.resolveExecutable('ls', {}, undefined), /电脑出错了.*no hypervisor/);
  assert.match(notReady({ state: 'starting' }), /电脑还在开机中/);
});

test('doctor: a running phone is not counted again against the page file; a crash suggests software rendering', async () => {
  const items = await diagnose({ phone: { ...phone, installed: true, running: true, crashed: 3221225477, gpu: 'auto' }, computer: { ...computer, installed: true, running: false }, home: 'C:/h' }, windows({ totalGb: 16, commitGb: 7.5 }));
  const commit = items.find((i) => i.name === '可提交内存（页面文件）');
  assert.equal(commit.level, 'warn', commit.detail); // 4 GB computer pending, 7.5 free: tight, not failing
  const crash = items.find((i) => i.name === '手机崩溃');
  assert.equal(crash.action.id, 'phone-gpu-software');
});

test('doctor: an unreachable ghcr.io offers the mainland mirror', async () => {
  const items = await diagnose({ phone: null, computer: { ...computer, image: 'ghcr.io/agent-infra/sandbox:latest' }, home: 'C:/h' }, windows({ curl: 'fail' }));
  assert.equal(items.find((i) => i.name === '下载源：电脑').action.id, 'computer-image-cn');
});
