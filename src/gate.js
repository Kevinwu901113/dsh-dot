// dsh-computer/gate: risk gate in front of every tool call. Risky calls become `ask`, so dsh routes
// them through `ctx.approval` to whatever answerer is connected (web UI, an IM plugin, …). The
// reason carries the live-view link, so the person can watch or take over before deciding.

export const name = 'dsh-computer-gate';
export const inject = ['tools', 'dshComputer'];

export const defaults = {
  // off: never ask · risky: ask for risky shell commands and sensitive browser actions · browser: ask for every VM browser action
  mode: 'risky',
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
  if (cfg.mode === 'off') return;
  const shell = cfg.shellPatterns.map((p) => new RegExp(p, 'i'));
  const sensitive = cfg.sensitivePatterns.map((p) => new RegExp(p, 'i'));
  const vm = ctx.dshComputer;
  const watch = `\n实时画面 / live view: ${vm.liveViewUrl}`;

  ctx.on('tools/pre-execute', async (exec, next) => {
    const args = JSON.stringify(exec.input ?? exec.args ?? exec.arguments ?? {});
    if (exec.name === 'bash' && shell.some((r) => r.test(args))) {
      return { kind: 'ask', reason: `dsh-computer: risky shell command in the VM${watch}` };
    }
    if (exec.name.startsWith('mcp__vm__browser_')) {
      const tool = exec.name.slice('mcp__vm__'.length);
      if (cfg.mode === 'browser') return { kind: 'ask', reason: `dsh-computer: browser action ${tool}${watch}` };
      if (!cfg.readOnlyBrowserTools.includes(tool) && sensitive.some((r) => r.test(args))) {
        return { kind: 'ask', reason: `dsh-computer: sensitive browser action ${tool}${watch}` };
      }
    }
    return next();
  });
}
