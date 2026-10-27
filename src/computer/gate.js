// dsh-computer/gate: risk gate in front of every tool call that reaches the VM. Risky calls become
// `ask`, so dsh routes them through `ctx.approval` to whatever answerer is connected (web UI, an IM
// plugin, …). The reason carries the live-view link, so the person can watch or take over first.
//
// Every tool the VM's MCP server offers is classified — read-only, shell, file, browser action — and
// a tool this file has never heard of is treated as an action, not waved through. Patterns are the
// second layer, not the first: a shell command is judged as text, a file operation by what it does
// and where, a browser action by what the page is about, and the protected locations in the VM
// (keys, browser profile, credentials) are watched in every argument of every tool.

import { clip } from './audit.js';

export const name = 'dot-gate';
export const inject = ['tools', 'dshComputer'];

export const defaults = {
  // off: never ask · risky: ask for risky shell commands, destructive/sensitive file operations and
  // sensitive browser actions · browser: ask for every VM browser action as well
  mode: 'risky',
  // Tools whose arguments reach a shell in the VM. dsh's own `bash` is routed into the VM; the VM's
  // MCP server also exposes its own shell and code runners, which must pass the same gate.
  shellTools: ['bash', 'mcp__vm__sandbox_execute_bash', 'mcp__vm__sandbox_execute_code'],
  shellPatterns: [
    String.raw`\brm\s+-[a-zA-Z]*[rf]`, String.raw`\bsudo\b`, String.raw`\b(curl|wget)\b[^|]*\|\s*(ba|z|da)?sh\b`,
    String.raw`\b(curl|wget)\b[^|]*\|\s*(python|node|perl)`, String.raw`\bbase64\s+(-d|--decode)\b[^|]*\|`,
    String.raw`\beval\b`, String.raw`\b(python3?|node|perl|ruby)\s+-[ce]\b`, String.raw`\bchmod\s+[0-7]*[+]?[xs]`,
    String.raw`\bssh\b`, String.raw`\bscp\b`, String.raw`\bgit\s+push\b`, String.raw`\bdd\s+if=`, String.raw`\bmkfs`,
    String.raw`\bcrontab\b`, String.raw`\bnohup\b`, String.raw`\bsystemctl\b`, String.raw`\bsupervisorctl\b`,
    String.raw`\b(shred|wipe|truncate)\b`, String.raw`>\s*/dev/sd`,
  ],
  // VM tools that read or write files directly (no shell): asked when the operation is destructive
  // or touches a protected location.
  fileTools: ['mcp__vm__sandbox_file_operations', 'mcp__vm__sandbox_str_replace_editor'],
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

/** Browser/desktop action tools this file knows; any other mcp__vm__ tool is audited once as unknown and treated like them. */
const KNOWN_ACTIONS = new Set(['browser_navigate', 'browser_go_back', 'browser_go_forward', 'browser_form_input_fill', 'browser_new_tab', 'browser_switch_tab', 'browser_close_tab', 'browser_click', 'browser_select', 'browser_close', 'browser_press_key']);

export function compile(cfg) {
  const rx = (list) => (list ?? []).map((p) => new RegExp(p, 'i'));
  return { shell: rx(cfg.shellPatterns), destructive: rx(cfg.destructivePatterns), protectedPaths: rx(cfg.protectedPaths), sensitive: rx(cfg.sensitivePatterns) };
}

/**
 * Decide for one tool call: null (allow) or the reason to ask. Pure.
 * @param {{ name: string, args: string }} call - tool name and its arguments as JSON text.
 */
export function decide(call, cfg, compiled = compile(cfg)) {
  if (cfg.mode === 'off') return null;
  const { name: tool, args } = call;
  const vmTool = tool.startsWith('mcp__vm__') ? tool.slice('mcp__vm__'.length) : '';
  if (!vmTool && !cfg.shellTools.includes(tool)) return null;
  // A protected location in any argument of any VM tool is a reason on its own.
  if (compiled.protectedPaths.some((r) => r.test(args))) return `dsh-computer: touches a protected location in the VM (${vmTool || tool})`;
  if (cfg.shellTools.includes(tool)) return compiled.shell.some((r) => r.test(args)) ? 'dsh-computer: risky shell command in the VM' : null;
  if (cfg.fileTools.includes(tool)) return compiled.destructive.some((r) => r.test(args)) ? `dsh-computer: destructive file operation (${vmTool})` : null;
  if (cfg.readOnlyTools.includes(vmTool)) return cfg.mode === 'browser' && vmTool.startsWith('browser_') ? `dsh-computer: browser action ${vmTool}` : null;
  if (cfg.alwaysAskTools.includes(vmTool)) return `dsh-computer: ${vmTool} (runs code or raw input in her computer)`;
  // Everything else acts on the browser or the desktop — known action tools and unknown tools alike.
  if (cfg.mode === 'browser') return `dsh-computer: browser action ${vmTool}`;
  return compiled.sensitive.some((r) => r.test(args)) ? `dsh-computer: sensitive browser action ${vmTool}` : null;
}

export function apply(ctx, config = {}) {
  const cfg = { ...defaults, ...config };
  const vm = ctx.dshComputer;
  const audit = (entry) => vm.audit?.(entry);
  const sessionOf = (exec) => exec.agent?.session?.id;

  // Audit every VM-side tool call and its outcome (denied asks surface here as failures).
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== 'bash' && !exec.name.startsWith('mcp__vm__')) return;
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
  const classified = new Set([...cfg.readOnlyTools, ...cfg.alwaysAskTools, ...KNOWN_ACTIONS, ...cfg.shellTools, ...cfg.fileTools].map((t) => t.replace(/^mcp__vm__/, '')));
  const unknown = new Set();

  ctx.on('tools/pre-execute', async (exec, next) => {
    const args = JSON.stringify(exec.input ?? exec.args ?? exec.arguments ?? {});
    const vmTool = exec.name.startsWith('mcp__vm__') ? exec.name.slice('mcp__vm__'.length) : '';
    if (vmTool && !classified.has(vmTool) && !unknown.has(vmTool)) {
      unknown.add(vmTool);
      audit({ kind: 'unknown-vm-tool', tool: exec.name, note: 'not classified here; treated as a browser/desktop action' });
    }
    const reason = decide({ name: exec.name, args }, cfg, compiled);
    if (!reason) return next();
    audit({ kind: 'approval-asked', tool: exec.name, session: sessionOf(exec), args: clip(exec.arguments, 300), reason });
    return { kind: 'ask', reason: `${reason}${watch()}` };
  });
}
