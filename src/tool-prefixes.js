// Public tool-name prefixes of the MCP servers dsh-dot mounts. dsh names an MCP tool
// `mcp__<serverName>__<tool>` (only [A-Za-z0-9_-] survive, so the hyphen is kept as-is); the
// serverNames carry a `dot-` namespace so another plugin's `vm` / `phone` server cannot collide.
// A rename is one line here plus the serverName in vm.js / phone.js.
export const VM_SERVER = 'dot-vm';
export const PHONE_SERVER = 'dot-phone';
export const VM_TOOL_PREFIX = `mcp__${VM_SERVER}__`;
export const PHONE_TOOL_PREFIX = `mcp__${PHONE_SERVER}__`;
// SnowLuma's own MCP server (qq.js, backend 'snowluma'): her 219 OneBot actions, gated by qqToolGate.
export const QQ_SERVER = 'dot-qq';
export const QQ_TOOL_PREFIX = `mcp__${QQ_SERVER}__`;
// dot's own phone tool (phone.js): a part of the screen, enlarged. Read-only, so observation turns allow it.
export const PHONE_ZOOM_TOOL = 'phone_zoom';
/** Typing on her phone, through the input method (src/phone/typing.js): the one way text goes in. */
export const PHONE_TYPE_TOOL = 'phone_type';

// Every model-facing tool this plugin registers, by who may use it (src/compat/qq-bridge.js hides the
// rest per session; test/compat.test.js checks the list against the register() calls in src/).
//   DOT_TOOLS / DOT_TOOL_PREFIXES: hers alone — her memory, her accounts, her QQ (qq_send and her
//                                  SnowLuma actions), her day. Never in another plugin's session.
//   DEVICE_TOOL_PREFIXES:          her phone and her computer — hers, and a qq-bridge owner chat's.
export const DOT_TOOLS = ['memory', 'recall', 'account', 'hands', 'keep_line', 'qq_send', 'qq_sticker_keep'];
export const DOT_TOOL_PREFIXES = [QQ_TOOL_PREFIX];
/** The agent preset her conversations are made with when lean (declared in cordis.patch.yml: preset-dot). */
export const HER_PRESET = 'dot';
/** Is this tool one a lean conversation of hers keeps (HER_TOOLS, and her QQ's own actions)? */
export const isHerTool = (n) => HER_TOOLS.includes(n) || String(n ?? '').startsWith(QQ_TOOL_PREFIX);
// What her conversation keeps when it is lean (dot.lean, a conversation begun since it was turned on): her one verb
// for getting things done (hands), what is speech or her own judgement (her QQ, what she remembers, what she keeps),
// and what only works from her own conversation — a schedule wakes the session that made it, a goal drives it.
// Everything else the host offers (shell jobs, subagents, workflows, file search, plugin management, the web …) is
// not hers to see: looking things up is something her hands do (hands device: web). Her own files are still here.
export const HER_TOOLS = ['hands', 'qq_send', 'qq_sticker_keep', 'memory', 'recall', 'keep_line',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view', 'create_goal', 'update_goal', 'get_goal',
  'read', 'write', 'edit'];
export const DEVICE_TOOL_PREFIXES = [PHONE_TOOL_PREFIX, VM_TOOL_PREFIX];
