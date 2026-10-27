// dsh-computer/gate: risk gate in front of every tool call. Risky calls become `ask`, so dsh routes
// them through `ctx.approval` to whatever answerer is connected (web UI, an IM plugin, …). The
// reason carries the live-view link, so the person can watch or take over before deciding.

import { clip } from './audit.js';

export const name = 'dot-gate';
export const inject = ['tools', 'dshComputer'];

export const defaults = {
  // off: never ask · risky: ask for risky shell commands and sensitive browser actions · browser: ask for every VM browser action
  mode: 'risky',
  // Tools whose arguments reach a shell in the VM. dsh's own `bash` is routed into the VM; the VM's
  // MCP server also exposes its own shell and code runners, which must pass the same gate.
  shellTools: ['bash', 'mcp__vm__sandbox_execute_bash', 'mcp__vm__sandbox_execute_code'],
  shellPatterns: [
    String.raw`\brm\s+-[a-zA-Z]*[rf]`, String.raw`\bsudo\b`, String.raw`\b(curl|wget)\b[^|]*\|\s*(ba)?sh`,
    String.raw`\bssh\b`, String.raw`\bscp\b`, String.raw`\bgit\s+push\b`, String.raw`\bdd\s+if=`, String.raw`\bmkfs`,
  ],
  sensitivePatterns: [
    String.raw`pay|checkout|purchase|order|transfer|password|passwd|login|sign[\s_-]?in|delete|unsubscribe`,
    '支付|付款|下单|购买|转账|密码|登录|删除|注销',
  ],
  // Browser tools that only read are never gated in `risky` mode.
  readOnlyBrowserTools: ['browser_get_markdown', 'browser_screenshot', 'browser_get_text', 'browser_get_clickable_elements', 'browser_tab_list', 'browser_get_download_list'],
};

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
  const shell = cfg.shellPatterns.map((p) => new RegExp(p, 'i'));
  const sensitive = cfg.sensitivePatterns.map((p) => new RegExp(p, 'i'));
  // Prefer the reachable-from-anywhere link (IM approvals are read on a phone); keep the local one too.
  // Read at ask time: the live view mounts on dsh's web server after this plugin starts.
  const watch = () => {
    const local = vm.liveViewUrl ?? '(starting)';
    return vm.publicLiveViewUrl ? `\n实时画面 / live view: ${vm.publicLiveViewUrl}\n(本机 / local: ${local})` : `\n实时画面 / live view: ${local}`;
  };
  const ask = (exec, reason) => {
    audit({ kind: 'approval-asked', tool: exec.name, session: sessionOf(exec), args: clip(exec.arguments, 300), reason });
    return { kind: 'ask', reason: `${reason}${watch()}` };
  };

  ctx.on('tools/pre-execute', async (exec, next) => {
    const args = JSON.stringify(exec.input ?? exec.args ?? exec.arguments ?? {});
    if (cfg.shellTools.includes(exec.name) && shell.some((r) => r.test(args))) {
      return ask(exec, 'dsh-computer: risky shell command in the VM');
    }
    if (exec.name.startsWith('mcp__vm__browser_')) {
      const tool = exec.name.slice('mcp__vm__'.length);
      if (cfg.mode === 'browser') return ask(exec, `dsh-computer: browser action ${tool}`);
      if (!cfg.readOnlyBrowserTools.includes(tool) && sensitive.some((r) => r.test(args))) {
        return ask(exec, `dsh-computer: sensitive browser action ${tool}`);
      }
    }
    return next();
  });
}
