// What the dot page shows and lets people change in ~/.dsh/dsh-dot.json, one entry per key.
// Defaults are NOT repeated here: each comes from the component's own `defaults` table (the one place
// they live), looked up at read time. test/settings-schema.test.js checks every entry names a real
// key there. Keys left out stay settable by hand (docs/SETTINGS.md lists them all).
//
// apply: when a change takes effect —
//   live             at once
//   restart-phone    after /phone restart (the page offers the button)
//   restart-dsh      after dsh restarts (component config is read at start)
//   create           only for a phone / computer not created yet
import { defaults as phoneDefaults } from './phone/phone.js';
import { defaults as computerDefaults } from './computer/vm.js';
import { defaults as gateDefaults } from './computer/gate.js';
import { defaults as qqDefaults } from './qq/qq.js';
import { defaults as dotDefaults } from './dot/core.js';
import { defaults as compatDefaults } from './compat/qq-bridge.js';
import { defaults as llmDefaults } from './llm-gate.js';

export const COMPONENT_DEFAULTS = { phone: phoneDefaults, computer: computerDefaults, gate: gateDefaults, qq: qqDefaults, dot: dotDefaults, compat: compatDefaults, llm: llmDefaults };

const choice = (...values) => ({ type: 'enum', values });
const e = (section, key, group, type, apply, zh, extra = {}) => ({ section, key, group, apply, zh, ...(typeof type === 'string' ? { type } : type), ...extra });

export const SCHEMA = [
  // phone
  e('phone', 'dataGb', '手机·资源', 'int', 'create', '存储（GB）', { min: 8, max: 256 }),
  e('phone', 'ramMb', '手机·资源', 'int', 'create', '内存（MB）', { min: 1536, max: 16384 }),
  e('phone', 'window', '手机·显示', 'bool', 'restart-phone', '另外弹出模拟器自己的窗口（默认不弹：画面在 dot 页面和右侧面板里看）'),
  e('phone', 'gpu', '手机·显示', choice('', 'auto', 'host', 'swiftshader_indirect', 'angle_indirect'), 'restart-phone', '渲染方式（空 = Windows 软件渲染、其他自动；显卡崩溃时选 swiftshader_indirect）'),
  e('phone', 'connectivityCheck', '手机·网络', { type: 'enum-or-text', values: ['cn', 'google'] }, 'restart-phone', '联网检测地址（cn 国内 / google 系统默认 / 自填返回 204 的地址）'),
  e('phone', 'dnsServer', '手机·网络', 'text', 'restart-phone', 'DNS（空 = 用电脑的；校园网等封了外部 DNS 的别填）'),
  e('phone', 'proxy', '手机·网络', { type: 'enum-or-text', values: ['', 'system'] }, 'restart-phone', '代理（空 = 不走；system = 电脑的系统代理；或 http://host:port）'),
  e('phone', 'quickBoot', '手机·稳定性', 'bool', 'restart-phone', '快速启动（快照）：开机快，被强杀后可能读到坏快照'),
  e('phone', 'adbPort', '手机·稳定性', 'int', 'restart-phone', 'adb 端口（和别的模拟器的 adb 冲突时换；0 = 5037）', { min: 0, max: 65535 }),
  e('phone', 'port', '手机·稳定性', 'int', 'restart-phone', '模拟器端口（被 BlueStacks 等占了时换偶数，如 5556）', { min: 5554, max: 5682 }),
  e('phone', 'bootTimeoutMs', '手机·稳定性', 'int', 'restart-phone', '开机超时（毫秒）', { min: 120000, max: 3600000 }),
  e('phone', 'locale', '手机·其他', 'text', 'restart-phone', '语言'),
  e('phone', 'timezone', '手机·其他', 'text', 'restart-phone', '时区'),
  e('phone', 'number', '手机·其他', 'text', 'live', '她的手机号（注册、登录 App 用）'),
  e('phone', 'keepAppsAlive', '手机·其他', 'bool', 'restart-phone', '不让后台 App 被冻结（聊天 App 收消息靠它）'),
  e('phone', 'publicUrl', '手机·其他', 'text', 'restart-dsh', '对外的 dsh 地址（实时画面链接用）'),
  // computer
  e('computer', 'image', '电脑', { type: 'enum-or-text', values: ['enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest', 'ghcr.io/agent-infra/sandbox:latest'] }, 'create', '镜像源（国内镜像 / 官方 ghcr）'),
  e('computer', 'memory', '电脑', 'text', 'restart-dsh', '内存上限（如 4G）'),
  e('computer', 'cpus', '电脑', 'int', 'restart-dsh', 'CPU 核数', { min: 1, max: 32 }),
  e('computer', 'rootDisk', '电脑', 'text', 'create', '磁盘（如 16G）'),
  e('computer', 'autoShare', '电脑', 'bool', 'restart-dsh', '命令在哪个文件夹跑，就把那个文件夹共享进电脑（默认关：只共享 mounts 里列的，没列就只有 ~/dsh-computer/workspace；关掉后，以前自动共享的会在下次开机时撤掉）'),
  e('computer', 'backend', '电脑', choice('auto', 'microsandbox', 'docker'), 'restart-dsh', '虚拟机后端'),
  e('computer', 'publicUrl', '电脑', 'text', 'restart-dsh', '对外的 dsh 地址'),
  e('computer', 'apiKey', '电脑', 'text', 'restart-dsh', '网关密钥（空 = 每台机器自动生成）', { secret: true }),
  // gate
  e('gate', 'mode', '审批', choice('off', 'risky', 'browser'), 'restart-dsh', '电脑操作审批（off 不问 / risky 危险的问 / browser 浏览器操作也问）'),
  // qq
  e('qq', 'backend', 'QQ', choice('napcat', 'snowluma'), 'restart-dsh', '后端'),
  e('qq', 'qq', 'QQ', 'text', 'restart-dsh', '她的 QQ 号'),
  e('qq', 'owner', 'QQ', 'text', 'live', '你的 QQ 号'),
  e('qq', 'githubProxy', 'QQ', 'text', 'restart-dsh', 'GitHub 下载加速前缀（如 https://ghfast.top/）'),
  e('qq', 'groupPolicy', 'QQ', choice('mention', 'score', 'all', 'none'), 'live', '群消息什么时候叫醒她'),
  e('qq', 'scoreThreshold', 'QQ', 'int', 'live', 'score 模式的插话门槛（0–10）', { min: 0, max: 10 }),
  e('qq', 'sendPolicy', 'QQ', choice('reply', 'always', 'off'), 'live', '发消息审批'),
  e('qq', 'replyWindowMinutes', 'QQ', 'int', 'live', 'reply 模式：多久内算对方找过她（分钟）', { min: 1, max: 1440 }),
  e('qq', 'imageSeeMax', 'QQ', 'int', 'live', '每条消息最多看几张图（0 = 只看文字）', { min: 0, max: 10 }),
  e('qq', 'typingMsPerChar', 'QQ', 'int', 'live', '分条发送的打字停顿（毫秒/字，0 = 一次发完）', { min: 0, max: 500 }),
  e('qq', 'ignore', 'QQ', 'text', 'live', '不回复的 QQ 号（别的机器人；逗号分开。qq-bridge 的机器人号会自动认出，不用填）'),
  e('qq', 'loopMax', 'QQ', 'int', 'live', '防互刷（只管群聊）：和同一个号在一个群里一来一回几轮、中间没别人说话就停（0 = 不管）', { min: 0, max: 50 }),
  e('qq', 'loopCooldownMinutes', 'QQ', 'int', 'live', '防互刷：停多少分钟', { min: 1, max: 1440 }),
  e('qq', 'token', 'QQ', 'text', 'restart-dsh', 'OneBot 令牌', { secret: true, hidden: true }),
  // dot
  e('dot', 'phoneHomeAfterMs', 'dot', 'int', 'restart-dsh', '她在手机上的最后一步过后多久，手机自己回到桌面（毫秒，0 = 不回）', { min: 0, max: 3600000 }),
  e('dot', 'awakeHours', 'dot', 'text', 'restart-dsh', '她平时的作息：醒着的时段（如 08:00-23:00，可跨午夜）。过了点、安静下来她才睡着；睡着后别人的通知留到她醒来，你找她能叫醒；睡着后写日记、整理记忆'),
  e('dot', 'sleepAfterQuietMinutes', 'dot', 'int', 'restart-dsh', '过了平时的点，安静多久算睡着（分钟）', { min: 1, max: 240 }),
  e('dot', 'replyCheck', 'dot', 'bool', 'restart-dsh', '她发给你的话先过一遍代码：去掉括号写的动作；话里有 persona.checks.txt 列的说法时退回让她改一次（直接写的和用 qq_send 发的都一样）'),
  e('dot', 'lean', 'dot', 'bool', 'restart-dsh', '她的新对话用自带的 dot 预设来建：只带她自己的工具（交代手、QQ、记忆、定时、目标、自己的文件；查资料也交给手），DSH 其余的工具不给她。已有的对话不变，新的一段才生效'),
  e('dot', 'howto', 'dot', 'bool', 'restart-dsh', '手艺簿：记下她的手在手机本身、各个 App、电脑上做事的经验，下次到那里时给它'),
  e('dot', 'thingCostCap', 'dot', 'int', 'restart-dsh', '一件事花到这么多折算 token 就停下问你要不要接着做（以 DeepSeek 空闲时段的未命中输入为 1：缓存命中 0.02、输出 4；100 万 ≈ 空闲 1 元、高峰 2 元；0 = 不管）', { min: 0 }),
  e('dot', 'ackHoldMs', 'dot', 'int', 'restart-dsh', '你的话让她去做一件事时，回你之前等多久：这之前做完的，只回一次、带着结果（毫秒，0 = 马上回）', { min: 0, max: 120000 }),
  e('dot', 'sayDetailChars', 'dot', 'int', 'restart-dsh', '一件事做完，替她说话那次调用拿到的细节最多多少字（结果只从事情簿来）', { min: 0, max: 4000 }),
  e('dot', 'sayPast', 'dot', 'int', 'restart-dsh', '替她说话那次调用看几段以前聊到差不多的事时她是怎么回的（按他最后一句话找；0 = 不看）', { min: 0, max: 12 }),
  e('dot', 'sayPastWaitMs', 'dot', 'int', 'restart-dsh', '找以前那几段最多等多久（毫秒），到点没找到就不带', { min: 0, max: 10000 }),
  e('dot', 'sameErrorNudge', 'dot', 'int', 'restart-dsh', '她的手连着碰到同一个错这么多次，提醒它换办法或照实收尾（没做到）；0 = 不提醒', { min: 0, max: 50 }),
  e('dot', 'sameErrorStop', 'dot', 'int', 'restart-dsh', '连着碰到同一个错这么多次，这件事由代码停下、记为没做成；0 = 不停', { min: 0, max: 100 }),
  e('dot', 'replayKeep', 'dot', 'int', 'restart-dsh', '留下她对话最近几次发给模型的完整请求，供 /dot replay 重放（存在 ~/.dsh/dot-replay/decide/；含对话全文；0 = 不留）', { min: 0, max: 500 }),
  e('dot', 'pushesKept', 'dot', 'int', 'restart-dsh', 'App 自己的推送（不是人发来的）不叫醒她：留最近几条，下次她醒着有事时一起给她看', { min: 0, max: 50 }),
  // llm (the model-request gate, src/llm-gate.js: one per dsh, whichever components are on)
  e('llm', 'workEffort', '模型请求', choice('', 'off', 'low', 'high', 'max'), 'restart-dsh', '她后台干活时的思考强度（整理记忆、用法笔记；她的手用 dot.handsEffort）。和对话分开：你在对话里把思考关掉，不影响这里。空 = 跟随 dsh 的模型选择；模型不支持所选强度时也跟随'),
  e('llm', 'backgroundRpm', '模型请求', 'int', 'restart-dsh', '她后台的请求每分钟最多几次（整理记忆、她的手、群聊评分；和你的对话不限；0 = 不限速）', { min: 0, max: 600 }),
  e('llm', 'foregroundQuietSeconds', '模型请求', 'int', 'restart-dsh', '你们的对话发完请求后，后台再等几秒（秒）', { min: 0, max: 600 }),
  e('llm', 'maxBackgroundWaitSeconds', '模型请求', 'int', 'restart-dsh', '一个后台请求最多被压后多久（秒；最多 270：再长她的手会被当成卡住，dot.turnStallMs 是 300 秒）', { min: 10, max: 270 }),
  e('llm', 'holdRetries', '模型请求', 'bool', 'restart-dsh', '对话被限流（429）后，dsh 的快速重试先等到这一分钟有余量再发（最多等 retryHoldMaxSeconds，默认 30 秒）'),
  // compat (living next to qq-bridge)
  e('compat', 'qqBridge', '兼容·qq-bridge', choice('auto', true, false), 'restart-dsh', '认 qq-bridge（auto = 装了就认）'),
  e('compat', 'qqBridgeRoot', '兼容·qq-bridge', 'text', 'restart-dsh', 'qq-bridge 的目录（自动找不到时填；里面有 config.json）'),
  e('compat', 'ownerDevices', '兼容·qq-bridge', 'bool', 'live', 'qq-bridge 管理员私聊（封闭 agent 模式）能用她的手机和电脑'),
  e('compat', 'ownerComputer', '兼容·qq-bridge', choice('vm', 'host'), 'live', '管理员私聊里的命令在哪跑：vm = 她的电脑（不共享 qq-bridge 的目录）/ host = 本机'),
  e('compat', 'hideBridgeTools', '兼容·qq-bridge', 'bool', 'live', '她的会话里不出现 qq-bridge 的工具（mcp__snowluma__* 等）'),
];

/** Keys whose values never leave the machine as they are (diagnostics, logs). */
export const SECRET_KEY = /key|token|secret|password|passwd|cookie/i;

export function defaultOf(entry) {
  return COMPONENT_DEFAULTS[entry.section]?.[entry.key];
}

/** Check one value against its entry: returns the normalized value, or throws with a reason people can read. */
export function validate(entry, value) {
  if (value === null) return null; // back to the default
  const fail = (why) => { throw new Error(`${entry.section}.${entry.key}: ${why}`); };
  switch (entry.type) {
    case 'bool': if (typeof value !== 'boolean') fail('要 true / false'); return value;
    case 'int': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (!Number.isInteger(n)) fail('要整数');
      if (entry.min !== undefined && n < entry.min) fail(`不能小于 ${entry.min}`);
      if (entry.max !== undefined && n > entry.max) fail(`不能大于 ${entry.max}`);
      return n;
    }
    case 'enum': {
      // A <select> hands back strings; an enum of true/false (compat.qqBridge) takes them as booleans.
      const v = value === 'true' && entry.values.includes(true) ? true : value === 'false' && entry.values.includes(false) ? false : value;
      if (!entry.values.includes(v)) fail(`只能是 ${entry.values.map((x) => (x === '' ? '（空）' : String(x))).join(' / ')}`); return v;
    }
    case 'enum-or-text': case 'text': if (typeof value !== 'string') fail('要文字'); return value.trim();
    default: return value;
  }
}

/**
 * The page's view: every entry with its default, the value set in the file (undefined = default) and
 * which components are on. `fileValues`: the parsed dsh-dot.json ({} when missing or broken).
 */
export function describe(fileValues = {}) {
  return SCHEMA.filter((s) => !s.hidden).map((s) => ({
    ...s, default: defaultOf(s),
    value: fileValues?.[s.section]?.[s.key],
  }));
}

/** Validate a patch { section: { key: value|null } } against the schema; unknown keys are refused. */
export function validatePatch(patch) {
  const out = {};
  for (const [section, values] of Object.entries(patch ?? {})) {
    for (const [key, value] of Object.entries(values ?? {})) {
      const entry = SCHEMA.find((s) => s.section === section && s.key === key && !s.hidden);
      if (!entry) throw new Error(`${section}.${key}: 页面不能改这一项（手改 ~/.dsh/dsh-dot.json）`);
      (out[section] ??= {})[key] = validate(entry, value);
    }
  }
  return out;
}
