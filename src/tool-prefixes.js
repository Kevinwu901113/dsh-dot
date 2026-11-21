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
/** Her one way of saying something to anyone (src/dot/say.js): the words are written by a call that is only her card. */
export const SAY_TOOL = 'say';
/** Her hands' one way of coming back to her with a question (src/dot/hands.js): theirs alone. */
export const HANDS_ASK_TOOL = 'ask_her';
/** Her hands' one way of saying a thing is done, and what came of it (dot/hands.js finish). */
export const HANDS_DONE_TOOL = 'done';
/** His yes to something of hers that needs it (src/dot/consent.js): she records it, in a turn his words opened. */
export const HIS_OK_TOOL = 'his_ok';
// What her hands keep (compat hides the rest from their sessions): her devices' tools and her accounts come from this
// plugin; of the host's, the shell (it runs in her computer), looking things up, and reading a file or a picture.
// Everything else the host offers — subagents, workflows, schedules, messages, plugin management, asking the user —
// is not theirs: they do one thing she gave them and come back.
export const HANDS_HOST_TOOLS = ['bash', 'job_output', 'job_kill', 'web_search', 'web_fetch', 'read', 'read_image'];

// Every model-facing tool this plugin registers, by who may use it (src/compat/qq-bridge.js hides the
// rest per session; test/compat.test.js checks the list against the register() calls in src/).
//   DOT_TOOLS / DOT_TOOL_PREFIXES: hers alone — her memory, her accounts, her QQ (qq_send and her
//                                  SnowLuma actions), her day. Never in another plugin's session.
//   DEVICE_TOOL_PREFIXES:          her phone and her computer — hers, and a qq-bridge owner chat's.
export const DOT_TOOLS = ['memory', 'recall', 'account', 'hands', HANDS_ASK_TOOL, HANDS_DONE_TOOL, HIS_OK_TOOL, SAY_TOOL, 'keep_line', 'qq_send', 'qq_sticker_keep'];
export const DOT_TOOL_PREFIXES = [QQ_TOOL_PREFIX];
/** The agent preset her conversations are made with when lean (declared in cordis.patch.yml: preset-dot). */
export const HER_PRESET = 'dot';
/** The agent preset her hands' sessions are made with (cordis.patch.yml: preset-dot-hands). */
export const HANDS_PRESET = 'dot-hands';
/** Is this tool one a lean conversation of hers keeps (HER_TOOLS, and her QQ's own actions)? */
export const isHerTool = (n) => HER_TOOLS.includes(n) || String(n ?? '').startsWith(QQ_TOOL_PREFIX);
// What her conversation keeps when it is lean (dot.lean, a conversation begun since it was turned on): her one verb
// for getting things done (hands), her one way of speaking (say — qq_send, which takes words as written, is not hers
// to call), her own judgement (what she remembers, what she keeps),
// and what only works from her own conversation — a schedule wakes the session that made it, a goal drives it.
// Everything else the host offers (shell jobs, subagents, workflows, file search, plugin management, the web …) is
// not hers to see: looking things up is something her hands do (hands device: web). Her own files are still here.
export const HER_TOOLS = ['hands', SAY_TOOL, HIS_OK_TOOL, 'qq_sticker_keep', 'memory', 'recall', 'keep_line',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view', 'create_goal', 'update_goal', 'get_goal',
  'read', 'write', 'edit'];
export const DEVICE_TOOL_PREFIXES = [PHONE_TOOL_PREFIX, VM_TOOL_PREFIX];
