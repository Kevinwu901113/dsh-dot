// dsh-dot/core: the glue that turns dsh into an always-on personal agent ("dot").
//
// Everything with an existing plugin is left to that plugin:
//   identity     → dsh loads <home>/AGENTS.md for sessions in <home>
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
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-dot';
// dshComputer is required on purpose: without the VM boundary "leave it running" is not safe.
export const inject = ['dshComputer'];

export const SILENT = 'DOT_SILENT';

/** Model-facing rule for a turn started by a scheduled task. */
export const SCHEDULED_RULE = '这一轮由定时任务触发，用户不在对话里。做完检查后：如果和上次相比没有值得告诉用户的新内容，'
  + `最终回复只写 ${SILENT}（这条不会发给用户）；有新内容才简要汇报并附链接。`;

export const defaults = {
  home: '',             // default ~/dot
  imBot: '',            // dsh-im Bot ID; default: the first bot that has a saved delivery target
  imTarget: '',         // dsh-im Target ID; default: that bot's first saved target
  budgetPollSeconds: 15,
  autoUnblockDaily: true,
};

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
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
      const res = await t.im.send(t.bot, t.target, text, { format });
      return res?.sent === true;
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
  const computer = ctx.dshComputer;
  const audit = (event, data = {}) => computer.audit?.({ kind: 'dot', event, ...data });
  const home = cfg.home || join(homedir(), 'dot');
  const store = createStore(join(dshHome(), 'dsh-dot-state.json'));
  const im = createNotifier(() => ctx.get('dshIm'), cfg, logger);

  // Identity file, editable, never overwritten.
  mkdirSync(home, { recursive: true });
  if (!existsSync(join(home, 'AGENTS.md'))) { try { copyFileSync(join(TEMPLATES, 'AGENTS.md'), join(home, 'AGENTS.md')); } catch (error) { void error; } }
  for (const [svc, pkg] of [['dshIm', '@xmanrui/dsh-im'], ['schedule', 'the schedule service (built into dsh >= 0.2.1)']]) {
    if (ctx.get(svc) === undefined) logger.warn(`${pkg} is not installed (see the dsh-dot README install command)`);
  }
  if (ctx.get('budget') === undefined) logger.info('dsh-budget not installed: no spending cap, budget notices disabled (optional)');

  // 1 + 2. Scheduled turns in <home>: silence or deliver; announce approvals.
  const turns = new Map(); // session id → { turn, scheduled, text }
  const incoming = new Set(); // sessions whose inbox holds a reminder for the next turn
  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    const cwd = session?.header?.cwd;
    if (!id || !cwd || !inside(home, cwd) || !event) return;
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
      const vm = computer.status?.() ?? {};
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

  // The silence rule must be in front of the model on the turn a schedule wakes, not only in
  // AGENTS.md, which the model reads as background. Only those turns get it.
  ctx.inject(['systemPrompt'], (scope) => {
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

  // 4. Computer health.
  ctx.effect(() => computer.onStatus?.((s) => {
    if (s.state === 'error') void im.send(`⚠️ dot: 虚拟机出错\n${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-computer.log`, 'plain');
  }) ?? (() => {}), 'dsh-dot: computer status');

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
        const vm = computer.status?.() ?? {};
        const lines = [
          `home: ${home}`,
          `computer: ${vm.state ?? '?'}${vm.publicLiveViewUrl ? ` · ${vm.publicLiveViewUrl}` : ''}`,
          `IM: ${t.error ? `not ready (${t.error})` : `${t.name ?? t.target} via ${t.bot}`}`,
          `budget: ${ctx.get('budget') ? (blocked.length ? `BLOCKED (${blocked.join(', ')})` : 'ok') : 'not installed (optional)'}`,
          `schedule: ${ctx.get('schedule') ? 'ok' : 'not installed'}`,
        ];
        return { kind: 'success', text: lines.join('\n') + test };
      },
    }), 'dsh-dot: /dot command');
  });

  logger.info(`dot ready — home ${home}`);
}
