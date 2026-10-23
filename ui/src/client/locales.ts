/** Copy for the agent's computer view. */
export const NS = 'dshComputer'

export const zh = {
  title: '虚拟机',
  open: '虚拟机',
  description: '查看并操作 agent 的电脑',
  toggle: '虚拟机画面',
  checking: '正在连接虚拟机…',
  offline: '虚拟机还没有就绪（首次启动可能需要几分钟）。',
  retry: '重试',
  reload: '刷新画面',
  external: '在系统浏览器中打开',
  builtin: '用内置浏览器打开',
  ready: '运行中',
  starting: '启动中',
  phoneTitle: '手机',
  phoneOpen: '手机',
  phoneDescription: '查看并操作 agent 的手机',
  phoneToggle: '手机画面',
  phoneChecking: '正在连接手机…',
  phoneOffline: '手机还没有就绪（第一次要先在对话里发 /phone accept，下载约 2 GB）。',
} satisfies Record<string, string>

export const en = {
  title: 'Computer',
  open: 'Computer',
  description: "View and control the agent's computer",
  toggle: 'Computer screen',
  checking: 'Connecting to the computer…',
  offline: 'The computer is not ready yet (the first start can take a few minutes).',
  retry: 'Retry',
  reload: 'Reload screen',
  external: 'Open in system browser',
  builtin: 'Open in built-in browser',
  ready: 'Running',
  starting: 'Starting',
  phoneTitle: 'Phone',
  phoneOpen: 'Phone',
  phoneDescription: "View and control the agent's phone",
  phoneToggle: 'Phone screen',
  phoneChecking: 'Connecting to the phone…',
  phoneOffline: 'The phone is not ready yet (first time: send /phone accept in a chat; it downloads about 2 GB).',
} satisfies Record<keyof typeof zh, string>
