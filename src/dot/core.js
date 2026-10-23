// dsh-dot/core: the glue that turns dsh into an always-on personal agent ("dot").
//
// Everything with an existing plugin is left to that plugin:
//   identity     → dsh-interlude's Canon (or dsh's own persona config); dot adds only its working rules
//   schedules    → official schedule service, built into dsh >= 0.2.1 (schedule_create, cron, restores cold sessions)
//   IM           → dsh-im (chats, approvals by reply, proactive delivery service `dshIm`)
//   spending cap (optional) → dsh-budget (`overLimit: block`)
//   computer     → dsh-computer (VM, approval gates, live view, audit log)
// What is left, because no plugin does it:
//   1. results of scheduled turns in <home> go to IM through dsh-im's public `send()`,
//      unless the reply is only DOT_SILENT (nothing worth reporting);
//   2. an approval asked during such a turn is announced on IM with the live-view link;
//   3. dsh-budget blocks are announced on IM, and the `daily` block is lifted at local midnight;
//   4. VM failures are announced on IM; /dot shows the status.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-dot';
// Devices are optional components: the computer (dshComputer) and the phone (dshPhone). dot works
// with either; with neither it still relays, but says so in /dot.
export const inject = [];

export const SILENT = 'DOT_SILENT';

/** Source of the message that wakes her for a phone notification; such turns are not pushed to IM. */
export const PHONE_NOTIFICATION_SOURCE = Object.freeze({ kind: 'dsh-dot', form: 'phone-notification' });

const APP_NAMES = { 'com.tencent.mobileqq': 'QQ', 'com.tencent.mm': '微信', 'com.max.xiaoheihe': '小黑盒', 'tv.danmaku.bili': 'B站', 'com.sina.weibo': '微博', 'com.xingin.xhs': '小红书', 'com.zhihu.android': '知乎', 'com.ss.android.ugc.aweme': '抖音', 'com.taobao.taobao': '淘宝', 'com.eg.android.AlipayGphone': '支付宝', 'org.telegram.messenger': 'Telegram', 'com.android.chrome': 'Chrome' };

/** The wake-up text for one or more notifications that arrived together: what the phone showed, and that she decides. */
export function notificationText(list) {
  const items = Array.isArray(list) ? list : [list];
  const line = (n) => `${APP_NAMES[n.pkg] ?? n.pkg}${n.title ? ` · ${n.title}` : ''}：${n.text || '（无内容）'}`;
  const head = items.length === 1 ? `[手机通知] ${line(items[0])}` : `[手机通知] ${items.length} 条\n${items.map((n) => `- ${line(n)}`).join('\n')}`;
  return `${head}\n（你手机上弹出来的。要回就自己去 App 里回，和平时一样；不想理就只回 ${SILENT}。）`;
}

/** Model-facing rule for a turn started by a scheduled task. */
export const SCHEDULED_RULE = '这一轮由定时任务触发，用户不在对话里。做完检查后：如果和上次相比没有值得告诉用户的新内容，'
  + `最终回复只写 ${SILENT}（这条不会发给用户）；有新内容才简要汇报并附链接。`;

/** Standing working rules for sessions in <home>: a prompt section, so no AGENTS.md is needed. */
export const workingRules = ({ computer = true, phone = false } = {}) => [
  '# dot 的工作方式',
  [computer ? '你有一台自己的电脑（虚拟机）：命令和浏览器都在那台电脑里运行，用户可以随时看到实时画面。' : '', phone ? '你有一部自己的手机（Android）：App 都在手机上，用 mcp__phone__* 操作。' : '', '用户主要在 IM 里和你说话。'].filter(Boolean).join(''),
  '- 定时任务：用户的要求里只要带有未来的时间点或周期（"2 分钟后"、"明天早上"、"每天 8 点"、"每周一"），一律用 `schedule_create` 建任务（带时区），现在不要去做。建好后只回复任务内容和触发时间。到点你会收到提醒，那时再去做。',
  `- 静默协议：被定时任务叫醒时，如果检查后没有值得告诉用户的内容，最终回复只写 ${SILENT}，这条不会发给用户。有内容就简要说，附链接。用户主动跟你说话时，正常回复。`,
  computer ? '- 用你的电脑：网页在你电脑的浏览器里打开（`mcp__vm__browser_*` 工具），需要登录、扫码或验证码时，告诉用户并请他在实时画面里接管。' : '',
  phone ? '- 用你的手机：App 里的事在手机上做（`mcp__phone__*` 工具）；遇到验证码、人脸、短信验证就停下来告诉用户。' : '',
  '- 花钱和危险操作：付款、删除、对外发消息等都会弹审批，等用户批准；不要试图绕过。',
  '- 回复可以拆成几句很短的话，一句一行（IM 里直接投递，不要写 <sep/> 之类的分隔标记）。',
].filter(Boolean).join('\n');
export const WORKING_RULES = workingRules();

export const defaults = {
  home: '',             // default ~/dot
  scope: 'home+im',     // which sessions are dot's: 'home' (cwd inside home), 'im' (opened from an IM bot), 'home+im', 'all'
  imBot: '',            // dsh-im Bot ID; default: the first bot that has a saved delivery target
  imTarget: '',         // dsh-im Target ID; default: that bot's first saved target
  budgetPollSeconds: 15,
  autoUnblockDaily: true,
  notifyBatchMs: 3000,  // notifications arriving within this window wake her once, together
  notifyHours: '',      // 'HH:MM-HH:MM': outside it the phone stays silent (she sleeps); '' = always
};

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
/** dsh-im tags messages it relays with an rpcId of `<channel>-<uuid>`; the desktop UI does not. */
export const IM_RPC = /^(weixin|wechat|qq|feishu|lark|dingtalk|wecom|wework|telegram|discord|slack|whatsapp|email|office)-/i;
export const isImMessage = (m) => IM_RPC.test(String(m?.source?.rpcId ?? ''));
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
/** 'HH:MM-HH:MM' (may wrap midnight) → is `date` inside it? Empty spec = always. */
export function inHours(spec, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!m) return true;
  const start = +m[1] * 60 + +m[2], end = +m[3] * 60 + +m[4], now = date.getHours() * 60 + date.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
const today = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** Text of a message content array (or string). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter((p) => p?.type === 'text').map((p) => p.text ?? '').join('');
}

/** `DOT_SILENT` alone, tolerating markdown decoration and punctuation around it. */
export const isSilent = (text) => typeof text === 'string'
  && text.replace(/[`*\s。."'“”]/g, '').replace(/^_+|_+$/g, '') === SILENT;

/** Drop a trailing marker after real content. */
export const stripSilent = (text) => text.replace(new RegExp(`\\s*${SILENT}\\s*$`), '').trim();

function createStore(file) {
  let data = {};
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { void error; /* first run */ }
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; try { writeFileSync(file, JSON.stringify(data, null, 2)); } catch (error) { void error; /* state is best-effort */ } },
  };
}

/**
 * Reach the user through dsh-im's public delivery service.
 * @param {() => object | undefined} getIm - returns the `dshIm` service when installed.
 */
export function createNotifier(getIm, cfg, logger) {
  async function target() {
    const im = getIm();
    if (!im?.send) return { error: 'dsh-im is not installed' };
    if (cfg.imBot && cfg.imTarget) return { im, bot: cfg.imBot, target: cfg.imTarget };
    try {
      // listBots() returns [{ botId, channel }].
      const bots = cfg.imBot ? [cfg.imBot] : (await im.listBots()).map((b) => (typeof b === 'string' ? b : b?.botId)).filter(Boolean);
      for (const bot of bots) {
        const targets = await im.listTargets(bot);
        const t = cfg.imTarget ? targets.find((x) => x.targetId === cfg.imTarget) : targets[0];
        if (t) return { im, bot, target: t.targetId, name: t.name };
      }
    } catch (err) {
      return { error: err.message };
    }
    return { error: 'no saved delivery target (dsh-im settings → bot → 新建目标)' };
  }
  async function send(text, format = 'markdown') {
    const t = await target();
    if (t.error) { logger.warn(`not delivered (${t.error}): ${text.slice(0, 80)}`); return false; }
    try {
      // "<sep/>" (HDSI's convention for several sends in one moment) becomes separate messages.
      const parts = text.split(/<sep\s*\/>/i).map((p) => p.trim()).filter(Boolean);
      let ok = false;
      for (const part of parts.length ? parts : [text]) ok = (await t.im.send(t.bot, t.target, part, { format }))?.sent === true || ok;
      return ok;
    } catch (err) {
      logger.warn(`dsh-im send failed: ${err.message}`);
      return false;
    }
  }
  return { send, target };
}

export function apply(ctx, config = {}) {
  const cfg = { ...defaults, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '')) };
  const logger = ctx.logger('dsh-dot');
  const computer = () => ctx.get('dshComputer');
  const phone = () => ctx.get('dshPhone');
  const audit = (event, data = {}) => (computer()?.audit ?? phone()?.audit)?.({ kind: 'dot', event, ...data });
  const home = cfg.home || join(homedir(), 'dot');
  const store = createStore(join(dshHome(), 'dsh-dot-state.json'));
  const im = createNotifier(() => ctx.get('dshIm'), cfg, logger);

  mkdirSync(home, { recursive: true });
  for (const [svc, pkg] of [['dshIm', '@xmanrui/dsh-im'], ['schedule', 'the schedule service (built into dsh >= 0.2.1)']]) {
    if (ctx.get(svc) === undefined) logger.warn(`${pkg} is not installed (see the dsh-dot README install command)`);
  }
  if (ctx.get('budget') === undefined) logger.info('dsh-budget not installed: no spending cap, budget notices disabled (optional)');

  // Which sessions are dot's. 'home': cwd inside <home>. 'im': any session a dsh-im bot opened,
  // whatever its workspace (the bot's first message carries an IM rpcId, which arrives in the inbox
  // before the turn starts). Treat them the same: an IM conversation is dot's wherever it lands.
  const imSessions = new Set();
  let lastSession = store.get('lastSession') || ''; // her most recent session: where phone notifications wake her (remembered across restarts)
  const wantHome = cfg.scope === 'all' || String(cfg.scope).includes('home');
  const wantIm = cfg.scope === 'all' || String(cfg.scope).includes('im');
  const isDotSession = (id, cwd) => cfg.scope === 'all' || (wantHome && cwd && inside(home, cwd)) || (wantIm && imSessions.has(id));

  // 1 + 2. Scheduled turns in dot's sessions: silence or deliver; announce approvals.
  const turns = new Map(); // session id → { turn, scheduled, text }
  const incoming = new Set(); // sessions whose inbox holds a reminder for the next turn
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    const cwd = session?.header?.cwd;
    if (!id || !event) return;
    if (wantIm && event.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(isImMessage)) imSessions.add(id);
    if (wantIm && event.type === 'user/message' && isImMessage(event.data)) imSessions.add(id);
    if (!isDotSession(id, cwd)) return;
    if (event.type === 'turn/end' && lastSession !== id) { lastSession = id; store.set('lastSession', id); }
    // A reminder enters the inbox before its turn starts, and the prompt is assembled at turn
    // start, before the user/message event: note it here so the turn knows from its first step.
    if (event.type === 'agent/inbox/spliced') {
      if ((event.data?.inserted ?? []).some((m) => m?.source?.kind === 'schedule')) incoming.add(id);
      return;
    }
    if (event.type === 'turn/start') {
      turns.set(id, { turn: event.data?.turn, scheduled: incoming.delete(id), text: '' });
      return;
    }
    const t = turns.get(id);
    if (!t) return;
    if (event.type === 'user/message' && event.data?.source?.kind === 'schedule') { t.scheduled = true; return; }
    if (!t.scheduled) return;
    if (event.type === 'assistant/message' && !event.data?.interrupted) {
      const text = contentText(event.data?.message?.content);
      if (text.trim()) t.text = text; // the last non-empty reply of the turn is its answer
      return;
    }
    if (event.type === 'approval/asked') {
      // Payload: { id, toolName, reason? }. dsh-computer's gate puts the live-view link in reason.
      const onPhone = String(event.data?.toolName ?? '').startsWith('mcp__phone__');
      const vm = (onPhone ? phone()?.status?.() : computer()?.status?.()) ?? {};
      const link = vm.publicLiveViewUrl || vm.liveViewUrl;
      const reason = String(event.data?.reason ?? '').trim();
      const lines = [`🔐 dot 需要你审批：${event.data?.toolName ?? '工具调用'}`, reason, '在 DeepSeek Harness 里批准或拒绝。'];
      if (link && !reason.includes(link)) lines.push(`实时画面：${link}`);
      void im.send(lines.filter(Boolean).join('\n'), 'plain');
      audit('approval-notified', { session: id, tool: event.data?.toolName });
      return;
    }
    if (event.type === 'turn/end' && (event.data?.turn === undefined || event.data.turn === t.turn)) {
      turns.delete(id);
      const text = t.text.trim();
      if (!text || isSilent(text)) { audit('silent', { session: id }); return; }
      void im.send(stripSilent(text)).then((sent) => audit('delivered', { session: id, sent }));
    }
  });

  // Working rules are a system-prompt section for sessions in <home> (static per session, so the
  // cached prefix holds). The silence rule is additionally put in front of the model on the turn a
  // schedule wakes, as a dynamic context; only those turns get it.
  const inHome = (c) => { const s = c.agent?.session; return isDotSession(s?.id, s?.header?.cwd) || turns.has(s?.id); };
  ctx.inject(['systemPrompt'], (scope) => {
    scope.effect(() => scope.systemPrompt.section({
      name: 'dot:rules',
      order: (scope.systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 0) + 2,
      text: (c) => (inHome(c) ? workingRules({ computer: Boolean(computer()), phone: Boolean(phone()) }) : ''),
    }), 'dsh-dot: working rules section');
    scope.systemPrompt.context({
      name: 'dot:scheduled-turn',
      order: 900,
      text: (c) => (turns.get(c.agent?.session?.id)?.scheduled ? SCHEDULED_RULE : ''),
    });
  });

  // 3. Budget.
  let blocked = store.get('blocked') ?? []; // persisted so a standing block is not re-announced after a restart
  async function pollBudget() {
    const budget = ctx.get('budget');
    if (!budget?.status) return;
    let now;
    try { now = budget.status().blockedScopes ?? []; } catch (error) { void error; return; }
    if (cfg.autoUnblockDaily && now.includes('daily') && store.get('blockedOn') && store.get('blockedOn') !== today()) {
      try { budget.unblock('daily'); now = now.filter((s) => s !== 'daily'); } catch (error) { logger.warn(`auto-unblock failed: ${error.message}`); }
      audit('budget-auto-unblock', { scope: 'daily' });
      await im.send('✅ dot: 新的一天，昨天的日预算阻断已自动解除，定时任务照常运行。', 'plain');
    }
    const added = now.filter((s) => !blocked.includes(s));
    if (added.length) {
      store.set('blockedOn', today());
      audit('budget-blocked', { scopes: now });
      await im.send(`⛔ dot: 预算已用完，已暂停（${now.join('、')}）。\n在 DeepSeek Harness 里发送 /budget unblock ${added[0]} 可立即恢复${cfg.autoUnblockDaily && added.includes('daily') ? '；日预算会在明天零点自动恢复' : ''}。`, 'plain');
    }
    if (blocked.length && !now.length) { audit('budget-unblocked'); await im.send('▶️ dot: 预算阻断已解除，恢复工作。', 'plain'); }
    if (String(blocked) !== String(now)) store.set('blocked', now);
    blocked = now;
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void pollBudget().catch((e) => logger.warn(e.message)); }, cfg.budgetPollSeconds * 1000);
    return () => clearInterval(timer);
  }, 'dsh-dot: budget watch');

  // 4. Device health (whichever devices are installed; they may come up after dot).
  ctx.inject(['dshComputer'], (c) => c.effect(() => c.dshComputer.onStatus?.((s) => {
    if (s.state === 'error') void im.send(`⚠️ dot: 虚拟机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-computer.log`, 'plain');
  }) ?? (() => {}), 'dsh-dot: computer status'));
  // 5. Her phone rings: a new notification wakes her in her latest session. She reads and answers in
  // the app herself; the dsh reply is not relayed anywhere.
  let waking = Promise.resolve();
  let batch = [], batchTimer = null;
  const flush = () => {
    const items = batch; batch = []; batchTimer = null;
    if (!items.length) return;
    const controller = ctx.get('sessionController');
    const id = lastSession;
    const pkgs = [...new Set(items.map((n) => n.pkg))];
    if (!controller || !id) { audit('notification-dropped', { pkgs, why: id ? 'no sessionController' : 'no session yet' }); return; }
    waking = waking.then(async () => {
      const found = await controller.resolveAgent(id);
      if (!found || 'error' in found) { audit('notification-dropped', { pkgs, why: found?.error?.message ?? 'session not found' }); return; }
      found.agent.followup(createUserMessage({ content: [{ type: 'text', text: notificationText(items) }], source: PHONE_NOTIFICATION_SOURCE }));
      audit('notification-woke', { session: id, count: items.length, pkgs, sinceSeenMs: Date.now() - Date.parse(items[0].at), sincePostedMs: items[0].postedAt ? Date.now() - items[0].postedAt : undefined });
    }).catch((err) => { logger.warn(`wake for notification failed: ${err.message}`); audit('notification-dropped', { pkgs, why: err.message }); });
  };
  const wake = (n) => {
    if (cfg.notifyHours && !inHours(cfg.notifyHours)) { audit('notification-held', { pkg: n.pkg, why: 'outside notifyHours' }); return; }
    batch.push(n);
    if (!batchTimer) batchTimer = setTimeout(flush, cfg.notifyBatchMs);
  };
  ctx.inject(['dshPhone'], (c) => c.effect(() => c.dshPhone.onNotification?.(wake) ?? (() => {}), 'dsh-dot: phone notifications'));
  ctx.inject(['dshPhone'], (c) => c.effect(() => c.dshPhone.onStatus?.((s) => {
    if (s.state === 'error') void im.send(`⚠️ dot: 手机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-phone.log`, 'plain');
    if (s.state === 'needs-license') void im.send('📱 dot: 手机还没装好——需要先接受 Android SDK 许可。在 dsh 里发 /phone accept。', 'plain');
  }) ?? (() => {}), 'dsh-dot: phone status'));

  // /dot
  // The command registry can come up after dot, so register through a child that waits for it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'dot',
      description: 'dot status; "test" sends a test message to your IM',
      input: { hint: '[test]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        const t = await im.target();
        let test = '';
        if (arg === 'test') test = `\ntest message: ${(await im.send('👋 dot 测试消息：IM 通道正常。', 'plain')) ? 'sent' : 'FAILED'}`;
        const vm = computer()?.status?.();
        const ph = phone()?.status?.();
        const lines = [
          `computer: ${vm ? `${vm.state}${vm.publicLiveViewUrl ? ` · ${vm.publicLiveViewUrl}` : ''}` : 'not installed (optional)'} · phone: ${ph ? `${ph.state}${ph.error ? ` (${ph.error})` : ''}` : 'not installed (optional)'}`,
          `IM: ${t.error ? `not ready (${t.error})` : `${t.name ?? t.target} via ${t.bot}`}`,
          `scope: ${cfg.scope} · home: ${home} · im sessions seen: ${imSessions.size}`,
          `budget: ${ctx.get('budget') ? (blocked.length ? `BLOCKED (${blocked.join(', ')})` : 'ok') : 'not installed (optional)'}`,
          `schedule: ${ctx.get('schedule') ? 'ok' : 'not installed'}`,
        ];
        return { kind: 'success', text: lines.join('\n') + test };
      },
    }), 'dsh-dot: /dot command');
  });

  logger.info(`dot ready — home ${home}`);
}
