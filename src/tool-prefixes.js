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
// Her phone's tools, by what they are, in one place (dot/gates.js judges by these; compat hides by these).
/** Only looking: nothing on the phone changes. Every other phone tool is an action, whatever it is called. */
export const PHONE_LOOK_TOOLS = ['mobile_list_elements_on_screen', 'mobile_take_screenshot', 'mobile_get_screen_size', 'mobile_get_orientation',
  'mobile_list_apps', 'mobile_list_available_devices', 'mobile_get_foreground_app', 'mobile_list_crashes', 'mobile_get_crash', 'mobile_get_device_logs', PHONE_ZOOM_TOOL];
/** The phone server's own ways of putting text in (clipboard and paste under the hood): not offered to her hands, alone or as a step of a batch — phone_type is the one way. */
export const PHONE_PASTE_TOOLS = ['mobile_type_keys', 'mobile_clipboard'];
/** Typing on her phone, through the input method (src/phone/typing.js): the one way text goes in. */
export const PHONE_TYPE_TOOL = 'phone_type';
/** Her one way of saying something to anyone (src/dot/say.js): the words are written by a call that is only her card. */
export const SAY_TOOL = 'say';
/** Her hands' one way of coming back to her with a question (src/dot/hands.js): theirs alone. */
export const HANDS_ASK_TOOL = 'ask_her';
/** Her hands' one way of saying a thing is done, and what came of it (dot/hands.js finish). */
export const HANDS_DONE_TOOL = 'done';
/** Her hands' one way of waiting for something (dot/core.js): a condition and a limit, watched by code — one step, not a look every few seconds. */
export const HANDS_WAIT_TOOL = 'wait_for';
/** His yes to something of hers that needs it (src/dot/consent.js): she records it, in a turn his words opened. */
export const HIS_OK_TOOL = 'his_ok';
// What her hands keep (compat hides the rest from their sessions): her devices' tools and her accounts come from this
// plugin; of the host's, the shell (it runs in her computer), looking things up, and reading a file or a picture.
// Everything else the host offers — subagents, workflows, schedules, messages, plugin management, asking the user —
// is not theirs: they do one thing she gave them and come back.
export const HANDS_HOST_TOOLS = ['bash', 'job_output', 'job_kill', 'web_search', 'web_fetch', 'read', 'read_image'];
/** Of those, the ones that run in her computer (the shell, its jobs, files): theirs only for a thing on her computer, and only while it is up. */
export const HANDS_COMPUTER_HOST_TOOLS = ['bash', 'job_output', 'job_kill', 'job_list', 'read', 'read_image', 'write', 'edit'];
/** Looking things up: theirs whatever the thing is on. */
export const HANDS_WEB_TOOLS = ['web_search', 'web_fetch'];
/**
 * What her hands are offered of her phone's own server, alone or as a step of a batch: looking, pressing, swiping,
 * keys, apps, links. The rest of what that server has (its cloud devices, recording, device logs, folding, location,
 * whatever it adds later) is not theirs — a positive list, so a new tool is not offered until it is put here.
 */
export const PHONE_HANDS_TOOLS = ['mobile_list_available_devices', 'mobile_list_apps', 'mobile_launch_app', 'mobile_terminate_app', 'mobile_list_elements_on_screen',
  'mobile_get_screen_size', 'mobile_get_orientation', 'mobile_set_orientation', 'mobile_get_foreground_app', 'mobile_click_on_screen_at_coordinates',
  'mobile_double_tap_on_screen', 'mobile_long_press_on_screen_at_coordinates', 'mobile_swipe_on_screen', 'mobile_press_button', 'mobile_open_url',
  'mobile_install_app', 'mobile_uninstall_app', 'mobile_batch_commands'];

// Every model-facing tool this plugin registers, by who may use it (src/compat/qq-bridge.js hides the
// rest per session; test/compat.test.js checks the list against the register() calls in src/).
//   DOT_TOOLS / DOT_TOOL_PREFIXES: hers alone — her memory, her accounts, her QQ (qq_send and her
//                                  SnowLuma actions), her day. Never in another plugin's session.
//   DEVICE_TOOL_PREFIXES:          her phone and her computer — hers, and a qq-bridge owner chat's.
export const DOT_TOOLS = ['memory', 'recall', 'account', 'hands', HANDS_ASK_TOOL, HANDS_DONE_TOOL, HANDS_WAIT_TOOL, HIS_OK_TOOL, SAY_TOOL, 'keep_line', 'qq_send', 'qq_sticker_keep'];
export const DOT_TOOL_PREFIXES = [QQ_TOOL_PREFIX];
/** The agent preset her conversations are made with when lean (declared in cordis.patch.yml: preset-dot). */
export const HER_PRESET = 'dot';
/**
 * The agent presets her hands' sessions are made with, one a place (cordis.patch.yml: preset-dot-hands-*). The host's
 * own tools of a session come with its preset and nothing takes them out afterwards (compat's restrict reaches only
 * what a session inherits), so a place's preset carries only what is done there: the web, and for her computer and
 * this machine also the shell, its jobs and reading files. The preset is also how a session's place is known — dsh
 * keeps it on the session (header.agentPreset) from the moment it is made.
 */
export const HANDS_PRESETS = Object.freeze({ phone: 'dot-hands-phone', computer: 'dot-hands-computer', host: 'dot-hands-host', web: 'dot-hands-web' });
/** The place a hands preset is for ('' for any other preset, or none). */
export const handsPlaceOf = (preset) => Object.keys(HANDS_PRESETS).find((k) => HANDS_PRESETS[k] === preset) ?? '';
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
