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

export const COMPONENT_DEFAULTS = { phone: phoneDefaults, computer: computerDefaults, gate: gateDefaults, qq: qqDefaults, dot: dotDefaults, compat: compatDefaults };

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
  e('phone', 'qqSendOnPhone', '手机·其他', 'bool', 'restart-dsh', '允许在手机 QQ 里发消息（默认只看，发用 qq_send）'),
  e('phone', 'publicUrl', '手机·其他', 'text', 'restart-dsh', '对外的 dsh 地址（实时画面链接用）'),
  // computer
  e('computer', 'image', '电脑', { type: 'enum-or-text', values: ['enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest', 'ghcr.io/agent-infra/sandbox:latest'] }, 'create', '镜像源（国内镜像 / 官方 ghcr）'),
  e('computer', 'memory', '电脑', 'text', 'restart-dsh', '内存上限（如 4G）'),
  e('computer', 'cpus', '电脑', 'int', 'restart-dsh', 'CPU 核数', { min: 1, max: 32 }),
  e('computer', 'rootDisk', '电脑', 'text', 'create', '磁盘（如 16G）'),
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
  e('qq', 'tidy', 'QQ', 'bool', 'live', '去掉句号、引号、破折号等书面符号'),
  e('qq', 'dropLatinLeaks', 'QQ', 'bool', 'live', '不发整条都是英文的气泡'),
  e('qq', 'ignore', 'QQ', 'text', 'live', '不回复的 QQ 号（别的机器人；逗号分开。qq-bridge 的机器人号会自动认出，不用填）'),
  e('qq', 'loopMax', 'QQ', 'int', 'live', '防互刷（只管群聊）：和同一个号在一个群里一来一回几轮、中间没别人说话就停（0 = 不管）', { min: 0, max: 50 }),
  e('qq', 'loopCooldownMinutes', 'QQ', 'int', 'live', '防互刷：停多少分钟', { min: 1, max: 1440 }),
  e('qq', 'token', 'QQ', 'text', 'restart-dsh', 'OneBot 令牌', { secret: true, hidden: true }),
  // dot
  e('dot', 'phoneCheckEveryMinutes', 'dot', 'int', 'restart-dsh', '隔多久拿起手机看一眼（分钟，0 = 不看）', { min: 0, max: 1440 }),
  e('dot', 'notifyHours', 'dot', 'text', 'restart-dsh', '只在这个时段被通知叫醒（如 08:00-23:00；空 = 一直）'),
  e('dot', 'manuals', 'dot', 'bool', 'restart-dsh', '手机、电脑说明书在第一次用时才给（省 token）'),
  e('dot', 'howto', 'dot', 'bool', 'restart-dsh', '记录她自己的 App 使用经验'),
  e('dot', 'approvalWaitMs', 'dot', 'int', 'restart-dsh', '没人回的审批多久算拒绝（毫秒，0 = 一直等）', { min: 0 }),
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
