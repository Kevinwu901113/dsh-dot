// dsh-dot/core: the glue that turns dsh into an always-on personal agent ("dot").
//
//   - home: <home>/AGENTS.md (identity, duties — dsh loads it for sessions in <home>) and <home>/watch.json
//   - main session: the session your IM chat is bound to (dsh-bridge), else the latest in <home>
//   - precheck: model-free change detection on watched pages → wakes the main session
//   - budget: when dsh-budget blocks, pause wake-ups and tell you over IM; auto-lift `daily` at midnight
//   - computer: requires dsh-computer (no VM, no unattended work) and reports VM failures
//   - /dot: status, `/dot check` runs the precheck now
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createIm, SILENT } from './im.js';
import { createPrechecker } from './precheck.js';

export const name = 'dsh-dot';
// dshComputer is required on purpose: without the VM boundary "leave it running" is not safe.
export const inject = ['sessionController', 'sessions', 'dshComputer'];

export const defaults = {
  home: '',                 // default ~/dot
  mainSession: '',          // pin a session id; default: IM-bound session, else latest session in home
  quietHours: '23:00-08:00',// wake-ups found here are held until it ends ('' = never quiet)
  precheckSeconds: 60,      // how often watch.json is scanned (each watch has its own everyMinutes)
  budgetPollSeconds: 15,
  autoUnblockDaily: true,   // lift dsh-budget's `daily` block at local midnight so tomorrow's tasks run
  notifyWebhook: '',
};

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh');
const inside = (root, p) => { const r = relative(root, p); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
const today = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/** 'HH:MM-HH:MM' (may wrap midnight) → is `date` inside it? */
export function inQuietHours(spec, date = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec || '').trim());
  if (!m) return false;
  const start = +m[1] * 60 + +m[2], end = +m[3] * 60 + +m[4], now = date.getHours() * 60 + date.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

function createStore(file) {
  let data = {};
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  let timer = null;
  const flush = () => { timer = null; try { writeFileSync(file, JSON.stringify(data, null, 2)); } catch {} };
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; if (!timer) timer = setTimeout(flush, 500); },
    flush,
  };
}

export function apply(ctx, config = {}) {
  const cfg = { ...defaults, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined && v !== '')) };
  const logger = ctx.logger('dsh-dot');
  const computer = ctx.dshComputer;
  const audit = (event, data = {}) => computer.audit?.({ kind: 'dot', event, ...data });
  const home = cfg.home || join(homedir(), 'dot');
  const store = createStore(join(dshHome(), 'dsh-dot-state.json'));
  const im = createIm({ logger, webhook: cfg.notifyWebhook });

  // 1. Home with editable templates (never overwritten).
  mkdirSync(home, { recursive: true });
  for (const f of ['AGENTS.md', 'watch.json']) {
    if (!existsSync(join(home, f))) { try { copyFileSync(join(TEMPLATES, f), join(home, f)); } catch {} }
  }
  for (const [svc, pkg] of [['budget', 'dsh-budget'], ['schedule', '@deepseek-ai/dsh-experimental-schedule-bundle']]) {
    if (ctx.get(svc) === undefined) logger.warn(`${pkg} is not installed: ${svc === 'budget' ? 'no spending limit' : 'no scheduled tasks'} (see the dsh-dot README install command)`);
  }

  // 2. Main session.
  ctx.on('session/event', (session) => {
    const cwd = session?.header?.cwd;
    if (cwd && inside(home, cwd) && store.get('homeSession') !== session.id) store.set('homeSession', String(session.id));
  });
  const mainSession = () => cfg.mainSession || im.boundSessions()[0]?.sessionId || store.get('homeSession');

  // 3. Wake-ups (held while quiet or budget-blocked).
  let blocked = store.get('blocked') ?? []; // survives restarts so a standing block is not re-announced
  const pending = () => store.get('pending') ?? [];
  async function deliver(text) {
    const id = mainSession();
    if (!id) {
      if (store.get('warnedNoMain') !== today()) {
        store.set('warnedNoMain', today());
        await im.notify('dot: 还没有主会话', `在 IM 里和 dot 说一句话，或在 dsh 里从 ${home} 开一个会话，dot 才知道把消息投到哪。`);
      }
      return false;
    }
    const resolved = await ctx.sessionController.resolveAgent(id);
    if ('error' in resolved) { logger.warn(`main session ${id}: ${resolved.error?.message ?? resolved.error}`); return false; }
    resolved.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    await ctx.sessions.flush(resolved.agent.session);
    audit('wake', { session: id, text: text.slice(0, 200) });
    return true;
  }
  async function wake(key, text) {
    if (blocked.length || inQuietHours(cfg.quietHours)) {
      store.set('pending', [...pending().filter((p) => p.key !== key), { key, text, at: new Date().toISOString() }]);
      audit('held', { key, reason: blocked.length ? 'budget' : 'quiet-hours' });
      return;
    }
    if (!(await deliver(text))) store.set('pending', [...pending().filter((p) => p.key !== key), { key, text, at: new Date().toISOString() }]);
  }
  async function flushPending() {
    if (blocked.length || inQuietHours(cfg.quietHours) || !pending().length) return;
    const items = pending();
    store.set('pending', []);
    const text = items.length === 1 ? items[0].text
      : `[DOT] 期间累积了 ${items.length} 条待处理事项：\n\n${items.map((p, i) => `${i + 1}. ${p.text}`).join('\n\n')}`;
    if (!(await deliver(text))) store.set('pending', items);
  }

  // 4. Precheck.
  const pre = createPrechecker({
    file: join(home, 'watch.json'), store, logger,
    onChange: (w, change) => {
      audit('change', { watch: w.name, url: w.url });
      void wake(`watch:${w.url}`, [
        `[DOT 预检查] 关注项「${w.name}」（${w.url}）的内容有变化（${change.at}）。`,
        w.prompt || '请在你的电脑上打开这个页面，找出和上次相比新增或变化的内容。',
        '有值得告诉用户的，就简要汇报（附链接）；只是无关紧要的变动，就只回复 ' + SILENT + '。',
        change.before ? `\n上次摘录：${change.before.slice(0, 300)}\n本次摘录：${change.after.slice(0, 300)}` : '',
      ].join('\n'));
    },
  });

  // 5. Budget.
  async function pollBudget() {
    const budget = ctx.get('budget');
    if (!budget?.status) return;
    let now;
    try { now = budget.status().blockedScopes ?? []; } catch { return; }
    // Midnight: yesterday's daily overspend must not cancel today's work.
    if (cfg.autoUnblockDaily && now.includes('daily') && store.get('blockedOn') && store.get('blockedOn') !== today()) {
      try { budget.unblock('daily'); now = now.filter((s) => s !== 'daily'); } catch {}
      audit('budget-auto-unblock', { scope: 'daily' });
      await im.notify('dot: 新的一天，已恢复', '昨天的日预算阻断已自动解除，定时任务照常运行。');
    }
    const added = now.filter((s) => !blocked.includes(s));
    if (added.length) {
      store.set('blockedOn', today());
      audit('budget-blocked', { scopes: now });
      await im.notify('⛔ dot: 预算已用完，已暂停', `超出的预算：${now.join('、')}。暂停期间的提醒会攒着，解除后一起处理。\n在 dsh 里发送 /budget unblock ${added[0]} 可立即恢复${cfg.autoUnblockDaily && added.includes('daily') ? '；日预算会在明天零点自动恢复' : ''}。`);
    }
    if (blocked.length && !now.length) { audit('budget-unblocked'); await im.notify('dot: 预算阻断已解除', '恢复工作。'); }
    blocked = now;
    store.set('blocked', now);
    await flushPending();
  }

  // 6. Computer health.
  ctx.effect(() => computer.onStatus?.((s) => {
    if (s.state === 'error') void im.notify('⚠️ dot: 虚拟机出错', `${s.error ?? '未知错误'}\n日志：~/.dsh/dsh-computer.log`);
  }) ?? (() => {}), 'dsh-dot: computer status');

  // Timers.
  ctx.effect(() => {
    const a = setInterval(() => { void pre.tick().then(flushPending).catch((e) => logger.warn(e.message)); }, cfg.precheckSeconds * 1000);
    const b = setInterval(() => { void pollBudget().catch((e) => logger.warn(e.message)); }, cfg.budgetPollSeconds * 1000);
    return () => { clearInterval(a); clearInterval(b); store.flush(); };
  }, 'dsh-dot: timers');

  // 7. /dot command.
  const commands = ctx.get('commands');
  if (commands?.register) {
    ctx.effect(() => commands.register({
      name: 'dot',
      description: 'dot status; "check" runs the page precheck now; "flush" delivers held items',
      input: { hint: '[check | flush]' },
      handler: async ({ rawInput }) => {
        const arg = String(rawInput ?? '').trim();
        if (arg === 'check') { store.set('force', Date.now()); for (const w of pre.watches()) { const k = `watch:${w.url}`; const v = store.get(k); if (v) store.set(k, { ...v, at: 0 }); } await pre.tick(); }
        if (arg === 'flush') await flushPending();
        const vm = computer.status?.() ?? {};
        const lines = [
          `home: ${home}`,
          `main session: ${mainSession() ?? '(none yet)'}`,
          `computer: ${vm.state ?? '?'}${vm.publicLiveViewUrl ? ` · ${vm.publicLiveViewUrl}` : ''}`,
          `IM: ${im.status().linked ? `linked, ${im.status().chats} chat(s) bound` : `not linked (${im.status().error ?? 'waiting'})`}${cfg.notifyWebhook ? ' · webhook fallback' : ''}`,
          `budget: ${ctx.get('budget') ? (blocked.length ? `BLOCKED (${blocked.join(', ')})` : 'ok') : 'not installed'}`,
          `quiet hours: ${cfg.quietHours || 'off'}${inQuietHours(cfg.quietHours) ? ' (now)' : ''}`,
          `watches: ${pre.watches().map((w) => `${w.name} /${w.everyMinutes}m`).join('; ') || '(none — edit watch.json)'}`,
          `held: ${pending().length}`,
        ];
        return { kind: 'success', text: lines.join('\n') };
      },
    }), 'dsh-dot: /dot command');
  }

  logger.info(`dot ready — home ${home}`);
}
