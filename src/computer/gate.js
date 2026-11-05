// dsh-computer/gate: risk gate in front of every tool call that reaches the VM. Risky calls become
// `ask`, so dsh routes them through `ctx.approval` to whatever answerer is connected (web UI, an IM
// plugin, …). The reason carries the live-view link, so the person can watch or take over first.
//
// Every tool the VM's MCP server offers is classified — read-only, shell, file, browser action — and
// a tool this file has never heard of is treated as an action, not waved through. Patterns are the
// second layer, not the first: a shell command is judged as text, a file operation by what it does
// and where, a browser action by what the page is about, and the protected locations in the VM
// (keys, browser profile, credentials) are watched in every argument of every tool.
//
// The shell is gated by territory: the VM is her computer, so using it (scripts, `python -c`, cron,
// services, `rm -rf` in her own folders) runs. What asks is leaving the machine or fetching code to
// run (curl|sh, ssh/scp, git push), wrecking the disk (dd, mkfs, shred, > /dev/sd*), the protected
// locations, and destructive operations (rm, mv, truncate, chmod/chown, `>`) on a folder shared with
// the host — those are his files — or on her whole home.

import { posix } from 'node:path';
import { VM_TOOL_PREFIX } from '../tool-prefixes.js';
import { clip } from './audit.js';
import { sectionOf } from '../settings.js';

export const name = 'dot-gate';
export const inject = ['tools', 'dshComputer'];

export const defaults = {
  // off: never ask · risky: ask for risky shell commands, destructive/sensitive file operations and
  // sensitive browser actions · browser: ask for every VM browser action as well
  mode: 'risky',
  // Tools whose arguments reach a shell in the VM. dsh's own `bash` is routed into the VM; the VM's
  // MCP server also exposes its own shell and code runners, which must pass the same gate.
  shellTools: ['bash', `${VM_TOOL_PREFIX}sandbox_execute_bash`, `${VM_TOOL_PREFIX}sandbox_execute_code`],
  // Leaving the machine, fetching code to run, wrecking the disk. Destructive operations on shared
  // folders are judged separately (sharedTouch), with the real mount paths at call time.
  shellPatterns: [
    String.raw`\bsudo\b`, String.raw`\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b`,
    String.raw`\b(curl|wget)\b[^|]*\|\s*(python|node|perl)`, String.raw`\bbase64\s+(-d|--decode)\b[^|]*\|`,
    String.raw`\bssh\b`, String.raw`\bscp\b`, String.raw`\bgit\s+push\b`, String.raw`\bdd\s+if=`, String.raw`\bmkfs`,
    String.raw`\b(shred|wipe)\b`, String.raw`>\s*/dev/sd`,
  ],
  // Her home in the VM: wiping all of it (her QQ login, browser profile, everything installed) asks.
  vmHome: '/home/gem',
  // VM tools that read or write files directly (no shell): asked when the operation is destructive
  // or touches a protected location.
  fileTools: [`${VM_TOOL_PREFIX}sandbox_file_operations`, `${VM_TOOL_PREFIX}sandbox_str_replace_editor`],
  destructivePatterns: [String.raw`"(operation|action|command|op)"\s*:\s*"(delete|remove|rm|move|rename|mv|chmod|chown|truncate)`, String.raw`\bdelete\b|\bremove\b|\brmdir\b`],
  // Locations in the VM whose mention in any argument of any VM tool asks: her keys, logins and the
  // browser profile (cookies, saved passwords), system credentials.
  protectedPaths: [
    String.raw`(^|[\s"'=:/])~?/?\.ssh\b`, String.raw`\.gnupg\b`, String.raw`\.aws\b`, String.raw`\.config/browser\b`, String.raw`\.config/(google-chrome|chromium)\b`,
    String.raw`\b(Login Data|Cookies|Web Data)\b`, String.raw`\.git-credentials\b`, String.raw`\.npmrc\b`, String.raw`\.netrc\b`, String.raw`\.docker/config\.json`,
    String.raw`(^|[\s"'=:/])\.env(\.|\b)`, String.raw`/etc/(passwd|shadow|sudoers|ssh/)`, String.raw`\.napcat\b|napcat/config\b`,
  ],
  sensitivePatterns: [
    String.raw`pay|checkout|purchase|order|transfer|password|passwd|login|sign[\s_-]?in|delete|unsubscribe|wallet|bank|credit`,
    '支付|付款|下单|购买|转账|密码|登录|删除|注销|钱包|银行|充值|红包',
  ],
  // VM tools that only look: never gated in `risky` mode (the `browser` mode still asks for browser ones).
  readOnlyTools: [
    'browser_get_info', 'browser_gui_screenshot', 'browser_get_markdown', 'browser_get_text', 'browser_read_links', 'browser_tab_list',
    'browser_get_clickable_elements', 'browser_get_download_list', 'browser_screenshot', 'browser_scroll', 'browser_hover',
    'sandbox_get_context', 'sandbox_get_packages', 'sandbox_convert_to_markdown', 'sandbox_load_skill',
  ],
  // VM tools that always ask in `risky` mode: arbitrary code in a page the browser is logged into
  // (can read every cookie and form on it), and raw desktop input outside the browser's own tools.
  alwaysAskTools: ['browser_evaluate', 'browser_gui_execute_action'],
};

/** Browser/desktop action tools this file knows; any other mcp__dot-vm__ tool is audited once as unknown and treated like them. */
const KNOWN_ACTIONS = new Set(['browser_navigate', 'browser_go_back', 'browser_go_forward', 'browser_form_input_fill', 'browser_new_tab', 'browser_switch_tab', 'browser_close_tab', 'browser_click', 'browser_select', 'browser_close', 'browser_press_key']);

const DESTRUCTIVE = new Set(['rm', 'rmdir', 'unlink', 'mv', 'truncate', 'chmod', 'chown', 'chgrp', 'shred']);
const PREFIXES = new Set(['sudo', 'env', 'nice', 'nohup', 'time', 'command', 'xargs', 'doas']);
const NULL_SINKS = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

/** Words of one shell segment, quotes removed (rough: no expansion, no escapes beyond quotes). */
const words = (seg) => [...seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
/** The command text of a shell tool's arguments (JSON), or the text itself. */
export function commandOf(args) {
  try { const a = JSON.parse(args); if (typeof a === 'string') return a; for (const k of ['command', 'cmd', 'script', 'code']) if (typeof a?.[k] === 'string') return a[k]; } catch { /* not JSON */ }
  return String(args ?? '');
}
const insideOf = (root, p) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * Does this shell command destroy (rm, mv, truncate, chmod/chown, `>`) something in a shared folder, or
 * her whole VM home? Returns the path it would hit, or ''. Rough by design: segments split on
 * ; && || | and newlines, `cd` followed, a target that cannot be resolved ($VAR, `$(…)`) counts as the
 * working folder.
 * @param {string} command
 * @param {{ shared: string[], cwd?: string, home?: string }} where - shared folders as the VM sees them; the working folder.
 */
export function sharedTouch(command, { shared = [], cwd = '', home = defaults.vmHome } = {}) {
  const roots = shared.filter(Boolean).map((p) => p.replace(/\/+$/, '') || '/');
  let dir = cwd || home;
  const resolve = (t) => {
    if (/^\$\{?HOME\b\}?/.test(t) || t === '~' || t.startsWith('~/')) return posix.normalize(t.replace(/^(\$\{?HOME\}?|~)/, home));
    if (t.startsWith('$') || t.startsWith('`')) return dir;
    return posix.normalize(t.startsWith('/') ? t : posix.join(dir, t));
  };
  const hits = (t) => {
    const p = resolve(t).replace(/\/+$/, '') || '/';
    const base = p.replace(/\/?[^/]*[*?[].*$/, '') || '/'; // a glob reaches everything under where it starts
    if (base === '/' || base === home) return p;
    return roots.some((r) => insideOf(r, p) || insideOf(base, r)) ? p : '';
  };
  for (const seg of String(command).split(/\n|;|&&|\|\||\|/)) {
    // Redirects that overwrite (not >>, not >&, not to /dev/null).
    for (const m of seg.matchAll(/(?<![>&0-9])[0-9]?>(?![>&])\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g)) {
      const t = m[1].replace(/^["']|["']$/g, '');
      if (!NULL_SINKS.test(t)) { const h = hits(t); if (h) return h; }
    }
    const w = words(seg.replace(/[0-9]?>{1,2}\s*("[^"]*"|'[^']*'|[^\s;&|<>]+)/g, ' ').replace(/[0-9]?>&[0-9-]/g, ' '));
    while (w.length && (/^\w+=/.test(w[0]) || PREFIXES.has(w[0]))) w.shift();
    const cmd = (w[0] ?? '').split('/').pop();
    const rest = w.slice(1).filter((x) => !x.startsWith('-'));
    if (cmd === 'cd') { dir = rest[0] ? resolve(rest[0]) : home; continue; }
    if (cmd === 'find' && w.some((x) => x === '-delete' || x === 'rm')) { const h = hits(rest[0] ?? '.'); if (h) return h; continue; }
    if (!DESTRUCTIVE.has(cmd)) continue;
    const targets = cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp' ? rest.slice(1) : rest;
    for (const t of targets) { const h = hits(t); if (h) return h; }
  }
  return '';
}

export function compile(cfg) {
  const rx = (list) => (list ?? []).map((p) => new RegExp(p, 'i'));
  return { shell: rx(cfg.shellPatterns), destructive: rx(cfg.destructivePatterns), protectedPaths: rx(cfg.protectedPaths), sensitive: rx(cfg.sensitivePatterns) };
}

/**
 * Decide for one tool call: null (allow) or the reason to ask. Pure.
 * @param {{ name: string, args: string, shared?: string[], cwd?: string }} call - tool name, its
 *   arguments as JSON text, the folders shared with the host as the VM sees them, the shell's working folder.
 */
export function decide(call, cfg, compiled = compile(cfg)) {
  if (cfg.mode === 'off') return null;
  const { name: tool, args } = call;
  const vmTool = tool.startsWith(VM_TOOL_PREFIX) ? tool.slice(VM_TOOL_PREFIX.length) : '';
  if (!vmTool && !cfg.shellTools.includes(tool)) return null;
  // A protected location in any argument of any VM tool is a reason on its own.
  if (compiled.protectedPaths.some((r) => r.test(args))) return `dsh-computer: touches a protected location in the VM (${vmTool || tool})`;
  if (cfg.shellTools.includes(tool)) {
    if (compiled.shell.some((r) => r.test(args))) return 'dsh-computer: risky shell command in the VM';
    const hit = sharedTouch(commandOf(args), { shared: call.shared ?? [], cwd: call.cwd, home: cfg.vmHome });
    return hit ? `dsh-computer: destructive command on ${hit === cfg.vmHome || hit === '/' ? 'her whole computer' : 'a folder shared with the host'} (${hit})` : null;
  }
  if (cfg.fileTools.includes(tool)) return compiled.destructive.some((r) => r.test(args)) ? `dsh-computer: destructive file operation (${vmTool})` : null;
  if (cfg.readOnlyTools.includes(vmTool)) return cfg.mode === 'browser' && vmTool.startsWith('browser_') ? `dsh-computer: browser action ${vmTool}` : null;
  if (cfg.alwaysAskTools.includes(vmTool)) return `dsh-computer: ${vmTool} (runs code or raw input in her computer)`;
  // Everything else acts on the browser or the desktop — known action tools and unknown tools alike.
  if (cfg.mode === 'browser') return `dsh-computer: browser action ${vmTool}`;
  return compiled.sensitive.some((r) => r.test(args)) ? `dsh-computer: sensitive browser action ${vmTool}` : null;
}

export function apply(ctx, config = {}) {
  const cfg = { ...defaults, ...config, ...sectionOf('gate', (m) => ctx.logger?.('dsh-dot/gate')?.warn?.(m)) };
  const vm = ctx.dshComputer;
  const audit = (entry) => vm.audit?.(entry);
  const sessionOf = (exec) => exec.agent?.session?.id;

  // Audit every VM-side tool call and its outcome (denied asks surface here as failures).
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'bash' && !exec.name.startsWith(VM_TOOL_PREFIX)) return;
    audit({
      kind: 'tool', tool: exec.name, session: sessionOf(exec), args: clip(exec.arguments, 300),
      ok: !result.isError, ...(result.isError ? { error: clip(result.error?.code ?? result.error?.message ?? result.error, 200) } : {}),
    });
  });

  if (cfg.mode === 'off') return;
  const compiled = compile(cfg);
  // Prefer the reachable-from-anywhere link (IM approvals are read on a phone); keep the local one too.
  // Read at ask time: the live view mounts on dsh's web server after this plugin starts.
  const watch = () => {
    const local = vm.liveViewUrl ?? '(starting)';
    return vm.publicLiveViewUrl ? `\n实时画面 / live view: ${vm.publicLiveViewUrl}\n(本机 / local: ${local})` : `\n实时画面 / live view: ${local}`;
  };
  const classified = new Set([...cfg.readOnlyTools, ...cfg.alwaysAskTools, ...KNOWN_ACTIONS, ...cfg.shellTools, ...cfg.fileTools].map((t) => t.replace(new RegExp(`^${VM_TOOL_PREFIX}`), '')));
  const unknown = new Set();

  // The host folders shared into the VM, as the VM sees them (read per call: a remount adds one).
  const guest = (p) => (vm.backend?.toGuestPath ? vm.backend.toGuestPath(p) : p);
  const sharedNow = () => (vm.mounts ?? vm.status?.()?.mounts ?? []).map(guest);
  // dsh's bash runs in the session's folder, which the VM shares on first use (subprocess.js vmCwd);
  // the VM's own shell tools start in her home unless told otherwise.
  const cwdOf = (exec, input) => {
    const given = input?.cwd ?? input?.workdir ?? input?.exec_dir;
    if (typeof given === 'string' && given) return exec.name === 'bash' ? guest(given) : given;
    const host = exec.name === 'bash' ? exec.agent?.session?.header?.cwd : '';
    return host ? guest(host) : cfg.vmHome;
  };
  ctx.on('tools/pre-execute', async (exec, next) => {
    const input = exec.input ?? exec.args ?? exec.arguments ?? {};
    const args = typeof input === 'string' ? input : JSON.stringify(input);
    const vmTool = exec.name.startsWith(VM_TOOL_PREFIX) ? exec.name.slice(VM_TOOL_PREFIX.length) : '';
    if (vmTool && !classified.has(vmTool) && !unknown.has(vmTool)) {
      unknown.add(vmTool);
      audit({ kind: 'unknown-vm-tool', tool: exec.name, note: 'not classified here; treated as a browser/desktop action' });
    }
    const shell = cfg.shellTools.includes(exec.name);
    let parsed = input;
    if (typeof input === 'string') try { parsed = JSON.parse(input); } catch { parsed = {}; }
    const cwd = shell ? cwdOf(exec, parsed) : '';
    // A bash session folder not shared yet will be by the time the command runs.
    const shared = shell ? [...sharedNow(), ...(exec.name === 'bash' && exec.agent?.session?.header?.cwd ? [cwd] : [])] : [];
    const reason = decide({ name: exec.name, args, shared, cwd }, cfg, compiled);
    if (!reason) return next();
    audit({ kind: 'approval-asked', tool: exec.name, session: sessionOf(exec), args: clip(exec.arguments, 300), reason });
    return { kind: 'ask', reason: `${reason}${watch()}` };
  });
}
