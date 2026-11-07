// dsh-dot/doctor: before (and whenever) her phone and computer are installed, check what the host
// has to give them — hardware virtualization, disk, memory (Windows: commit charge), the adb and
// emulator ports, the download servers — and say in plain words what is wrong and the command that
// fixes it. `/dot doctor` runs it; dot also runs it once on first start and tells him what failed.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statfsSync } from 'node:fs';
import { arch, freemem, platform, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { systemProxyEnv } from '../computer/backends/proxy.js';

const run = promisify(execFile);
const GB = 1024 ** 3;
const gb = (bytes) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;
const parseGb = (v) => { const m = /^(\d+(?:\.\d+)?)\s*([GM])?/i.exec(String(v ?? '')); return m ? Number(m[1]) / (m[2]?.toUpperCase() === 'M' ? 1024 : 1) : 0; };

/** One finding: level ok | warn | bad, what was seen, and (when not ok) how to fix it. */
const item = (name, level, detail, fix = '') => ({ name, level, detail, fix });

/**
 * Everything the doctor needs from the outside, injectable for tests:
 * { os, arch, exec(cmd, args, opts) → { stdout }, statfs(path) → { bavail, bsize }, totalmem(), freemem(), exists(path), canRw(path), env }
 */
export function hostDeps(over = {}) {
  return {
    os: platform(), arch: arch(), totalmem, freemem,
    exec: (cmd, args, opts = {}) => run(cmd, args, { timeout: 15_000, windowsHide: true, ...opts }),
    statfs: (p) => statfsSync(p),
    exists: existsSync,
    canRw: (p) => { try { accessSync(p, constants.R_OK | constants.W_OK); return true; } catch { return false; } },
    proxyEnv: () => ({ ...process.env, ...systemProxyEnv() }),
    ...over,
  };
}

async function checkVirtualization(h, phone) {
  const name = '硬件虚拟化';
  if (h.os === 'darwin') {
    if (h.arch === 'arm64') return item(name, 'ok', 'Apple silicon');
    const out = await h.exec('sysctl', ['-n', 'kern.hv_support']).then((r) => r.stdout.trim(), () => '');
    return out === '1' ? item(name, 'ok', 'Intel Mac, Hypervisor.framework 可用') : item(name, 'bad', 'Intel Mac 没有 Hypervisor.framework', '这台 Mac 跑不了手机和电脑虚拟机');
  }
  if (h.os === 'linux') {
    if (!h.exists('/dev/kvm')) return item(name, 'bad', '没有 /dev/kvm', 'BIOS 里打开 VT-x / AMD-V；云服务器要选支持嵌套虚拟化的机型');
    return h.canRw('/dev/kvm') ? item(name, 'ok', '/dev/kvm 可用') : item(name, 'bad', '/dev/kvm 没有读写权限', 'sudo usermod -aG kvm $USER，然后重新登录');
  }
  if (h.os === 'win32') {
    const fix = '用管理员 PowerShell 运行：\nEnable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart\nbcdedit /set "{current}" hypervisorlaunchtype auto\n然后重启；还不行就进 BIOS 打开 VT-x / AMD-V（SVM）';
    // The emulator's own check is the most direct, once it is installed.
    const emulator = phone?.paths?.emulator;
    if (emulator && h.exists(emulator)) {
      const r = await h.exec(emulator, ['-accel-check']).then((x) => ({ ok: true, out: x.stdout }), (e) => ({ ok: false, out: String(e.stdout || e.message) }));
      const said = r.out.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? '';
      return r.ok ? item(name, 'ok', `模拟器自检通过（${said}）`) : item(name, 'bad', `模拟器自检失败：${said}`, fix);
    }
    const out = await h.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).HypervisorPresent']).then((r) => r.stdout.trim(), () => '');
    if (/true/i.test(out)) return item(name, 'ok', 'Windows 虚拟机监控程序在运行（WHPX）');
    if (/false/i.test(out)) return item(name, 'bad', 'Windows 虚拟机监控程序没开（WHPX）', fix);
    return item(name, 'warn', '查不到虚拟化状态', fix);
  }
  return item(name, 'warn', `没见过的系统 ${h.os}`);
}

/** Free disk where her phone/computer live, against what a not-yet-installed one will take. */
function checkDisk(h, where, needs) {
  const name = '磁盘空间';
  let free;
  try { const s = h.statfs(where); free = Number(s.bavail) * Number(s.bsize); } catch (err) { return item(name, 'warn', `查不到 ${where} 的剩余空间（${err.message}）`); }
  const need = needs.reduce((a, n) => a + n.gb, 0) * GB;
  const what = needs.map((n) => `${n.what} 约 ${n.gb} GB`).join('，');
  if (!needs.length) return item(name, free < 2 * GB ? 'warn' : 'ok', `剩余 ${gb(free)}`, free < 2 * GB ? '空间快满了，手机和电脑写不下东西会出错；清理一下' : '');
  if (free < need) return item(name, 'bad', `剩余 ${gb(free)}，还要装的：${what}`, `清理出 ${gb(need - free)} 以上；或把手机存储设小：/phone accept 8`);
  if (free < need + 5 * GB) return item(name, 'warn', `剩余 ${gb(free)}，装完只剩 ${gb(free - need)}（${what}）`, '装得下，但余量很少');
  return item(name, 'ok', `剩余 ${gb(free)}（${what}）`);
}

/** RAM for what is configured; on Windows the emulator commits all its guest RAM up front (page file). */
async function checkMemory(h, wantGb) {
  const name = '内存';
  const total = h.totalmem();
  const want = wantGb * GB;
  const out = [];
  const tight = '少开几个程序；或在 ~/.dsh/dsh-dot.json 调小：phone.ramMb（默认 3072）、computer.memory（默认 4G），不要电脑就设 computer 为 off';
  if (total < want + 3 * GB) out.push(item(name, 'bad', `总共 ${gb(total)}，手机+电脑要 ${wantGb} GB，系统自己还要几 GB`, tight));
  else if (total < want + 6 * GB) out.push(item(name, 'warn', `总共 ${gb(total)}，手机+电脑要 ${wantGb} GB，比较紧`, tight));
  else out.push(item(name, 'ok', `总共 ${gb(total)}，手机+电脑要 ${wantGb} GB`));
  if (h.os === 'win32') {
    // KB: what can still be committed (RAM + page file) — the emulator fails to start below its RAM.
    const r = await h.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', '$o=Get-CimInstance Win32_OperatingSystem; "$($o.FreeVirtualMemory) $($o.TotalVirtualMemorySize)"']).then((x) => x.stdout.trim().split(/\s+/).map(Number), () => []);
    const [freeKb, totalKb] = r;
    if (freeKb > 0) {
      const freeCommit = freeKb * 1024;
      const fix = '加大页面文件：系统属性 → 高级 → 性能设置 → 高级 → 虚拟内存，设为"系统管理的大小"或至少 16 GB；或者关掉一些程序';
      if (freeCommit < want + GB) out.push(item('可提交内存（页面文件）', 'bad', `还能分配 ${gb(freeCommit)}（上限 ${gb(totalKb * 1024)}），模拟器启动时要一次性占下它的全部内存`, fix));
      else if (freeCommit < want + 4 * GB) out.push(item('可提交内存（页面文件）', 'warn', `还能分配 ${gb(freeCommit)}，比较紧`, fix));
      else out.push(item('可提交内存（页面文件）', 'ok', `还能分配 ${gb(freeCommit)}`));
    }
  }
  return out;
}

/** Who listens on a TCP port: { pid, name } or null. */
async function listener(h, port) {
  if (h.os === 'win32') {
    const net = await h.exec('netstat', ['-ano', '-p', 'tcp']).then((r) => r.stdout, () => '');
    const line = net.split(/\r?\n/).find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
    const pid = line?.trim().split(/\s+/).pop();
    if (!pid) return null;
    const task = await h.exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).then((r) => r.stdout, () => '');
    return { pid, name: /^"([^"]+)"/.exec(task.trim())?.[1] ?? `PID ${pid}` };
  }
  const out = await h.exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']).then((r) => r.stdout, () => '');
  const pid = /^p(\d+)/m.exec(out)?.[1];
  return pid ? { pid, name: /^c(.+)$/m.exec(out)?.[1] ?? `PID ${pid}` } : null;
}

const OWN = /^(adb|emulator|qemu-system[\w-]*|crashpad_handler)(\.exe)?$/i;
async function checkPorts(h, phone) {
  const out = [];
  const adbPort = phone?.adbPort || 5037;
  const port = phone?.port ?? 5554;
  const other = await listener(h, 5037);
  if (other && adbPort !== 5037) out.push(item('adb 端口', 'ok', `5037 被 ${other.name} 占着（模拟器、手机助手常自带旧 adb）；插件用自己的 ${adbPort}，不受影响`));
  else if (other && !OWN.test(other.name)) out.push(item('adb 端口', 'warn', `5037 被 ${other.name} 占着`, '在 ~/.dsh/dsh-dot.json 设 phone.adbPort 为 5137，让插件用自己的 adb'));
  const own = adbPort !== 5037 ? await listener(h, adbPort) : null;
  if (own && !OWN.test(own.name)) out.push(item('adb 端口', 'bad', `插件要用的 ${adbPort} 被 ${own.name} 占了`, `在 ~/.dsh/dsh-dot.json 把 phone.adbPort 换成别的，比如 ${adbPort + 2}`));
  if (!phone?.running) {
    // emulator-<port>: console on port, adb on port+1. BlueStacks and others like 5555.
    for (const p of [port, port + 1]) {
      const l = await listener(h, p);
      if (l && !OWN.test(l.name)) out.push(item('模拟器端口', 'bad', `${p} 被 ${l.name} 占了，手机的 emulator-${port} 会起不来或被别的模拟器抢走`, `关掉 ${l.name}，或在 ~/.dsh/dsh-dot.json 设 phone.port 为 ${port + 2}`));
    }
  }
  if (!out.length) out.push(item('端口', 'ok', `adb ${adbPort}、模拟器 ${port}/${port + 1} 没有冲突`));
  return out;
}

/** Can the downloads be reached (through the system proxy, as the installers use it)? */
async function checkDownloads(h, targets) {
  const out = [];
  const env = h.proxyEnv();
  const proxy = env.HTTPS_PROXY || env.https_proxy || '';
  for (const t of targets) {
    const started = Date.now();
    const ok = await h.exec('curl', ['-sS', '-o', h.os === 'win32' ? 'NUL' : '/dev/null', '-I', '-L', '-m', '12', '-w', '%{http_code}', t.url], { env, timeout: 20_000 }).then((r) => /^[23]\d\d$/.test(r.stdout.trim().slice(-3)), () => false);
    const ms = Date.now() - started;
    out.push(ok
      ? item(`下载源：${t.what}`, ms > 8000 ? 'warn' : 'ok', `${t.host} 能连上（${(ms / 1000).toFixed(1)} 秒${proxy ? `，经代理 ${proxy}` : ''}）`, ms > 8000 ? '很慢，第一次下载可能要很久' : '')
      : item(`下载源：${t.what}`, 'bad', `连不上 ${t.host}${proxy ? `（已经走了代理 ${proxy}）` : '（没检测到代理）'}`, '开代理（系统代理即可，插件会自动用），或设环境变量 HTTPS_PROXY=http://127.0.0.1:端口 后重启 dsh'));
  }
  return out;
}

/**
 * Run every check. `phone`/`computer` describe what is configured and what is installed:
 * phone: { installed, running, ramMb, dataGb, port, adbPort, paths: { emulator } } (null = phone off)
 * computer: { installed, memory, rootDisk, image, backend } (null = computer off)
 * Returns [{ name, level, detail, fix }].
 */
export async function diagnose({ phone, computer, home }, deps = hostDeps()) {
  const h = deps;
  const needs = [];
  if (phone && !phone.installed) needs.push({ what: `手机（下载 2 + 系统 4 + 存储 ${phone.dataGb}）`, gb: 6 + Number(phone.dataGb || 16) });
  if (computer && !computer.installed) needs.push({ what: '电脑（镜像约 4 + 磁盘）', gb: 4 + Math.ceil(parseGb(computer.rootDisk || '16G') / 2) });
  const wantGb = (phone ? Number(phone.ramMb || 3072) / 1024 : 0) + (computer ? parseGb(computer.memory || '4G') : 0);
  const downloads = [];
  if (phone && !phone.installed) downloads.push({ what: '手机', host: 'dl.google.com', url: 'https://dl.google.com/android/repository/repository2-3.xml' });
  if (computer && !computer.installed && /^ghcr\.io\//.test(computer.image ?? '')) downloads.push({ what: '电脑', host: 'ghcr.io', url: 'https://ghcr.io/v2/' });
  const results = await Promise.all([
    phone || computer ? checkVirtualization(h, phone) : null,
    checkDisk(h, home, needs),
    wantGb ? checkMemory(h, Math.ceil(wantGb)) : [],
    phone ? checkPorts(h, phone) : [],
    checkDownloads(h, downloads),
  ]);
  return results.flat().filter(Boolean);
}

const MARK = { ok: '✅', warn: '⚠️', bad: '❌' };
/** Plain text for /dot doctor and the IM: problems first, each with its fix. */
export function report(items, { onlyProblems = false } = {}) {
  const order = { bad: 0, warn: 1, ok: 2 };
  const shown = [...items].sort((a, b) => order[a.level] - order[b.level]).filter((i) => !onlyProblems || i.level !== 'ok');
  const bad = items.filter((i) => i.level === 'bad').length, warn = items.filter((i) => i.level === 'warn').length;
  const head = bad ? `dot 体检：${bad} 项会导致装不上或用不了${warn ? `，${warn} 项要留意` : ''}` : warn ? `dot 体检：能用，${warn} 项要留意` : 'dot 体检：都没问题';
  return [head, ...shown.map((i) => `${MARK[i.level]} ${i.name}：${i.detail}${i.fix ? `\n   → ${i.fix.replace(/\n/g, '\n     ')}` : ''}`)].join('\n');
}
