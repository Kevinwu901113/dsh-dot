// Public tool-name prefixes of the MCP servers dsh-dot mounts. dsh names an MCP tool
// `mcp__<serverName>__<tool>` (only [A-Za-z0-9_-] survive, so the hyphen is kept as-is); the
// serverNames carry a `dot-` namespace so another plugin's `vm` / `phone` server cannot collide.
// A rename is one line here plus the serverName in vm.js / phone.js.
export const VM_SERVER = 'dot-vm';
export const PHONE_SERVER = 'dot-phone';
export const VM_TOOL_PREFIX = `mcp__${VM_SERVER}__`;
export const PHONE_TOOL_PREFIX = `mcp__${PHONE_SERVER}__`;
