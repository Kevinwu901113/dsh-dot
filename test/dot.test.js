import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, isSilent, stripSilent, contentText } from '../src/dot/core.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ blocked = [], state = {}, targets = [{ targetId: 'me', name: 'Kevin' }] } = {}) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  writeFileSync(join(dsh, 'dsh-dot-state.json'), JSON.stringify(state));
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const effects = [], audit = [], sent = [], listeners = [];
  const budgetSvc = { blockedScopes: [...blocked], status() { return { blockedScopes: this.blockedScopes }; }, unblock(s) { this.blockedScopes = this.blockedScopes.filter((x) => x !== s); } };
  const dshIm = {
    listBots: async () => [{ botId: 'bot_1', channel: 'qq' }],
    listTargets: async () => targets,
    send: async (bot, target, text) => { sent.push({ bot, target, text }); return { sent: true }; },
  };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); },
    effect(fn) { effects.push(fn()); },
    prompts: [], sections: [],
    systemPrompt: { context(c) { ctx.prompts.push(c); }, section(c) { ctx.sections.push(c); return () => {}; }, getSectionOrder: () => 0 },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (name) => ({ budget: budgetSvc, schedule: {}, dshIm, systemPrompt: ctx.systemPrompt, dshComputer: ctx.dshComputer }[name]),
    dshComputer: { audit: (e) => audit.push(e), status: () => ({ state: 'ready', publicLiveViewUrl: 'https://mac.ts.net/vnc' }), onStatus: () => () => {} },
  };
  const emitAs = (id, cwd, type, data) => listeners.forEach((fn) => fn({ id, header: { cwd } }, { type, data }));
  const emit = (cwd, type, data) => emitAs('s1', cwd, type, data);
  return { ctx, home, effects, audit, sent, budgetSvc, emit, emitAs, config: { home, budgetPollSeconds: 0.05, notifyBatchMs: 5, notifyHours: '' } };
}
const stop = (h) => { for (const d of h.effects) if (typeof d === 'function') d(); };
const msg = (text) => ({ message: { content: [{ type: 'text', text }] } });

test('silence marker detection', () => {
  for (const t of ['DOT_SILENT', '`DOT_SILENT`', '**DOT_SILENT**', ' DOT_SILENT。']) assert.ok(isSilent(t), t);
  assert.ok(!isSilent('新版本 1.2 发布了 DOT_SILENT'));
  assert.equal(stripSilent('新版本 1.2 发布了\nDOT_SILENT'), '新版本 1.2 发布了');
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }]), 'ab');
});

test('working rules are a prompt section for sessions in home; no AGENTS.md is written', () => {
  const h = harness();
  apply(h.ctx, h.config);
  assert.ok(!existsSync(join(h.home, 'AGENTS.md')));
  const sec = h.ctx.sections.find((s) => s.name === 'dot:rules');
  assert.match(sec.text({ agent: { session: { id: 'a', header: { cwd: h.home } } } }), /schedule_create[\s\S]*DOT_SILENT[\s\S]*一句一行/);
  assert.equal(sec.text({ agent: { session: { id: 'b', header: { cwd: '/elsewhere' } } } }), '');
  stop(h);
});

test('scheduled turn in home: result goes to IM; DOT_SILENT stays silent; other turns ignored', async () => {
  const h = harness();
  apply(h.ctx, h.config);
  const run = (cwd, source, reply) => {
    h.emit(cwd, 'turn/start', { turn: 1 });
    h.emit(cwd, 'user/message', { source: { kind: source } });
    h.emit(cwd, 'assistant/message', msg('正在检查…'));
    h.emit(cwd, 'assistant/message', msg(reply));
    h.emit(cwd, 'turn/end', { turn: 1, reason: 'completed' });
  };
  run(h.home, 'schedule', 'X 更新了 v2.0：https://x.example');
  run(h.home, 'schedule', 'DOT_SILENT');
  run(h.home, 'user', '普通对话回复');
  run('/elsewhere', 'schedule', '别的目录');
  run(h.home, 'schedule', 'X 有新提交<sep/>看了一眼 是修锁的那个');
  await wait(20);
  assert.deepEqual(h.sent.map((s) => s.text), ['X 更新了 v2.0：https://x.example', 'X 有新提交', '看了一眼 是修锁的那个'], '<sep/> splits into separate messages');
  assert.deepEqual(h.sent[0], { bot: 'bot_1', target: 'me', text: 'X 更新了 v2.0：https://x.example' });
  assert.ok(h.audit.some((e) => e.event === 'silent'));
  stop(h);
});

test('approval during a scheduled turn is announced with the live view link', async () => {
  const h = harness();
  apply(h.ctx, h.config);
  h.emit(h.home, 'turn/start', { turn: 1 });
  h.emit(h.home, 'user/message', { source: { kind: 'schedule' } });
  h.emit(h.home, 'approval/asked', { id: 'a1', toolName: 'mcp__vm__browser_click', reason: 'dsh-computer: sensitive browser action browser_click' });
  await wait(20);
  assert.match(h.sent[0].text, /审批：mcp__vm__browser_click[\s\S]*sensitive browser action[\s\S]*https:\/\/mac\.ts\.net\/vnc/);
  // The gate already includes the link in its reason: not repeated.
  h.emit(h.home, 'approval/asked', { id: 'a2', toolName: 'bash', reason: 'risky\n实时画面 / live view: https://mac.ts.net/vnc' });
  await wait(20);
  assert.equal((h.sent[1].text.match(/mac\.ts\.net\/vnc/g) || []).length, 1);
  stop(h);
});

test('budget block and unblock are announced once', async () => {
  const h = harness({ blocked: ['daily'] });
  apply(h.ctx, h.config);
  await wait(200);
  assert.equal(h.sent.filter((s) => /预算已用完/.test(s.text)).length, 1);
  h.budgetSvc.blockedScopes = [];
  await wait(150);
  assert.ok(h.sent.some((s) => /已解除/.test(s.text)));
  stop(h);
});

test('midnight: yesterday\'s daily block is lifted automatically', async () => {
  const h = harness({ blocked: ['daily'], state: { blocked: ['daily'], blockedOn: '2000-1-1' } });
  apply(h.ctx, h.config);
  await wait(150);
  assert.deepEqual(h.budgetSvc.blockedScopes, []);
  assert.ok(h.sent.some((s) => /新的一天/.test(s.text)));
  assert.ok(!h.sent.some((s) => /预算已用完/.test(s.text)), 'a standing block is not re-announced');
  stop(h);
});

test('no saved target: nothing sent, /dot explains', async () => {
  const h = harness({ targets: [] });
  let cmd;
  h.ctx.get = ((get) => (n) => (n === 'commands' ? { register: (c) => { cmd = c; return () => {}; } } : get(n)))(h.ctx.get);
  apply(h.ctx, h.config);
  const out = await cmd.handler({ rawInput: '' });
  assert.match(out.text, /IM: not ready \(no saved delivery target/);
  stop(h);
});

test('scheduled turns get the silence rule in the prompt; others do not', () => {
  const h = harness();
  apply(h.ctx, h.config);
  const rule = h.ctx.prompts.find((c) => c.name === 'dot:scheduled-turn');
  const at = (sid) => rule.text({ agent: { session: { id: sid } } });
  h.emit(h.home, 'turn/start', { turn: 1 });
  assert.equal(at('s1'), '', 'a user turn gets no rule');
  h.emit(h.home, 'turn/end', { turn: 1 });
  // dsh order: the reminder is spliced into the inbox, then the turn starts and the prompt is assembled.
  h.emit(h.home, 'agent/inbox/spliced', { target: 'next-turn', inserted: [{ source: { kind: 'schedule' } }] });
  h.emit(h.home, 'turn/start', { turn: 2 });
  assert.match(at('s1'), /DOT_SILENT/);
  assert.equal(at('other'), '');
  assert.equal(rule.text({}), '');
  stop(h);
});

test('scope: a session an IM bot opened elsewhere is dot\'s too; the desktop UI elsewhere is not', async () => {
  const h = harness();
  apply(h.ctx, h.config);
  const rules = h.ctx.sections.find((s) => s.name === 'dot:rules');
  const at = (id, cwd) => rules.text({ agent: { session: { id, header: { cwd } } } });
  // dsh-im relays the first message with rpcId "<channel>-<uuid>" into the inbox before the turn starts.
  h.emitAs('wx', '/Users/x/.dsh/im', 'agent/inbox/spliced', { inserted: [{ role: 'user', source: { kind: 'user', rpcId: 'weixin-c6d37277-7e04-421c-b080-dbc1c5f57eb6' } }] });
  assert.match(at('wx', '/Users/x/.dsh/im'), /dot 的工作方式/);
  h.emitAs('ui', '/Users/x/code', 'agent/inbox/spliced', { inserted: [{ role: 'user', source: { kind: 'user', rpcId: 'rpc-1234' } }] });
  assert.equal(at('ui', '/Users/x/code'), '');
  // a scheduled turn in that IM session is delivered like one in home
  h.emitAs('wx', '/Users/x/.dsh/im', 'agent/inbox/spliced', { inserted: [{ source: { kind: 'schedule' } }] });
  h.emitAs('wx', '/Users/x/.dsh/im', 'turn/start', { turn: 2 });
  h.emitAs('wx', '/Users/x/.dsh/im', 'user/message', { source: { kind: 'schedule' } });
  h.emitAs('wx', '/Users/x/.dsh/im', 'assistant/message', msg('X 更新了'));
  h.emitAs('wx', '/Users/x/.dsh/im', 'turn/end', { turn: 2, reason: 'completed' });
  await wait(20);
  assert.deepEqual(h.sent.map((s) => s.text), ['X 更新了']);
  stop(h);
});

test('a phone notification wakes her latest session with the notification text; nothing is relayed', async () => {
  const { notificationText, PHONE_NOTIFICATION_SOURCE } = await import('../src/dot/core.js');
  const h = harness();
  const followups = [];
  let onNotification;
  h.ctx.get = ((orig) => (name) => name === 'dshPhone' ? { onNotification: (fn) => { onNotification = fn; return () => {}; }, onStatus: () => () => {}, status: () => ({ state: 'ready' }) } : name === 'sessionController' ? { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => followups.push({ id, m }) } }) } : orig(name))(h.ctx.get);
  apply(h.ctx, h.config);
  assert.ok(onNotification, 'subscribed');
  // no session yet → dropped
  onNotification({ pkg: 'com.tencent.mobileqq', title: '宽', text: 'hi' });
  await wait(10);
  assert.equal(followups.length, 0);
  assert.ok(h.audit.some((e) => e.event === 'notification-dropped'));
  // a turn in home → that session is hers
  h.emit(h.home, 'turn/start', { turn: 1 });
  h.emit(h.home, 'user/message', { source: { kind: 'user' } });
  h.emit(h.home, 'assistant/message', msg('在'));
  h.emit(h.home, 'turn/end', { turn: 1, reason: 'completed' });
  onNotification({ pkg: 'com.tencent.mobileqq', title: '宽', text: '你会主动给我发消息吗' });
  onNotification({ pkg: 'com.max.xiaoheihe', title: '小黑盒', text: '你关注的游戏更新了' });
  await wait(40);
  assert.equal(followups.length, 1, 'a burst wakes her once');
  assert.equal(followups[0].id, 's1');
  assert.deepEqual(followups[0].m.source, PHONE_NOTIFICATION_SOURCE);
  assert.match(followups[0].m.content[0].text, /^\[手机通知\] 2 个对话\n· QQ · 宽：你会主动给我发消息吗\n· 小黑盒 · 小黑盒：你关注的游戏更新了/);
  onNotification({ pkg: 'com.tencent.mobileqq', title: '宽', text: '在吗' });
  await wait(40);
  assert.equal(followups.length, 2);
  assert.match(followups[1].m.content[0].text, /^\[手机通知\] QQ · 宽：在吗/);
  // she is busy: what arrives during her turn is held, then delivered once, grouped by conversation, in order
  h.emit(h.home, 'turn/start', { turn: 2 });
  h.emit(h.home, 'user/message', { source: { kind: 'dsh-dot', form: 'phone-notification' } });
  onNotification({ key: 'k1', pkg: 'com.tencent.mobileqq', title: '宽', text: '对' });
  await wait(30);
  onNotification({ key: 'k1', pkg: 'com.tencent.mobileqq', title: '宽(2条新消息)', text: '刚刚在帮你测试延迟' });
  onNotification({ key: 'k2', pkg: 'com.max.xiaoheihe', title: '小黑盒', text: '有人回复了你' });
  await wait(30);
  assert.equal(followups.length, 2, 'nothing while the turn runs');
  assert.ok(h.audit.some((e) => e.event === 'notification-held' && e.why === 'turn running'));
  h.emit(h.home, 'assistant/message', msg('DOT_SILENT'));
  h.emit(h.home, 'turn/end', { turn: 2, reason: 'completed' });
  await wait(120);
  assert.equal(followups.length, 3);
  assert.equal(followups[2].m.content[0].text, '[手机通知] 2 个对话\n· QQ · 宽：\n- 对\n- 刚刚在帮你测试延迟\n· 小黑盒 · 小黑盒：有人回复了你\n（你上一轮期间来的。要回就自己去 App 里回，和平时一样；不想理就只回 DOT_SILENT。）');
  assert.match(notificationText({ pkg: 'x.y', title: '', text: '' }), /x\.y：（无内容）/);
  assert.equal(h.sent.length, 0);
  stop(h);
});

test('conversationTitle and groupNotifications', async () => {
  const { conversationTitle, groupNotifications } = await import('../src/dot/core.js');
  assert.equal(conversationTitle('宽(2条新消息)'), '宽');
  assert.equal(conversationTitle('宽（3条）'), '宽');
  assert.equal(conversationTitle('群聊'), '群聊');
  const g = groupNotifications([
    { key: 'a', pkg: 'p', title: '宽', text: '1' }, { key: 'a', pkg: 'p', title: '宽(2条新消息)', text: '2' }, { key: 'a', pkg: 'p', title: '宽(2条新消息)', text: '2' },
    { pkg: 'q', title: 'x', text: 'y' },
  ]);
  assert.deepEqual(g, [{ pkg: 'p', title: '宽', texts: ['1', '2'] }, { pkg: 'q', title: 'x', texts: ['y'] }]);
});

test('phone check: /dot check asks her to pick up the phone when it is up and she is idle; not while busy', async () => {
  const { PHONE_CHECK_SOURCE } = await import('../src/dot/core.js');
  const h = harness();
  const followups = [];
  h.ctx.get = ((orig) => (name) => name === 'dshPhone' ? { isReady: true, onNotification: () => () => {}, onStatus: () => () => {}, status: () => ({ state: 'ready' }) } : name === 'sessionController' ? { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => followups.push({ id, m }) } }) } : orig(name))(h.ctx.get);
  let cmd;
  h.ctx.get = ((orig) => (name) => name === 'commands' ? { register: (c) => { cmd = c; return () => {}; } } : orig(name))(h.ctx.get);
  apply(h.ctx, h.config);
  await cmd.handler({ rawInput: 'check' });
  await wait(20);
  assert.equal(followups.length, 0, 'no session yet');
  h.emit(h.home, 'turn/start', { turn: 1 }); h.emit(h.home, 'user/message', { source: { kind: 'user' } }); h.emit(h.home, 'turn/end', { turn: 1 });
  h.emit(h.home, 'turn/start', { turn: 2 });
  await cmd.handler({ rawInput: 'check' });
  await wait(20);
  assert.equal(followups.length, 0, 'busy: not now');
  h.emit(h.home, 'turn/end', { turn: 2 });
  await cmd.handler({ rawInput: 'check' });
  await wait(20);
  assert.equal(followups.length, 1);
  assert.deepEqual(followups[0].m.source, PHONE_CHECK_SOURCE);
  assert.match(followups[0].m.content[0].text, /^\[拿起手机\]/);
  assert.ok(h.audit.some((e) => e.event === 'phone-check'));
  stop(h);
});

test('owner QQ messages enter as the owner\'s own words (human input); others stay notifications; no phone check during a goal', async () => {
  const { ownerSource, PHONE_NOTIFICATION_SOURCE } = await import('../src/dot/core.js');
  assert.equal(ownerSource().kind, 'user');
  assert.match(ownerSource().rpcId, /^qq-/);
  const h = harness();
  const followups = [];
  let onMessage, goal = null;
  let cmd;
  h.ctx.get = ((orig) => (name) => name === 'dshQq' ? { connected: true, owner: '20002', onMessage: (fn) => { onMessage = fn; return () => {}; } }
    : name === 'dshPhone' ? { isReady: true, onNotification: () => () => {}, onStatus: () => () => {}, status: () => ({ state: 'ready' }) }
    : name === 'sessionController' ? { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => followups.push(m) } }) }
    : name === 'goals' ? { get: () => goal }
    : name === 'commands' ? { register: (c) => { cmd = c; return () => {}; } }
    : orig(name))(h.ctx.get);
  apply(h.ctx, { ...h.config, notifyHours: '00:00-00:01' }); // quiet hours: only the owner gets through
  h.emit(h.home, 'turn/start', { turn: 1 }); h.emit(h.home, 'user/message', { source: { kind: 'user' } }); h.emit(h.home, 'turn/end', { turn: 1 });
  onMessage({ kind: 'private', userId: '20002', who: '宽', text: '做个长任务：刷 20 个帖子', fromOwner: true, at: new Date().toISOString() });
  onMessage({ kind: 'private', userId: '20002', who: '宽', text: '每 5 个跟我说一声', fromOwner: true, at: new Date().toISOString() });
  onMessage({ kind: 'private', userId: '30003', who: '路人', text: '在吗', fromOwner: false, at: new Date().toISOString() });
  await wait(40);
  assert.equal(followups.length, 1, 'quiet hours hold the stranger; the owner gets through');
  assert.equal(followups[0].source.kind, 'user');
  assert.equal(followups[0].content[0].text, '做个长任务：刷 20 个帖子\n每 5 个跟我说一声', 'exactly what he typed');
  // daytime: a stranger is a notification, not human input
  const h2 = harness();
  const f2 = [];
  let on2;
  h2.ctx.get = ((orig) => (name) => name === 'dshQq' ? { connected: true, owner: '20002', onMessage: (fn) => { on2 = fn; return () => {}; } }
    : name === 'sessionController' ? { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => f2.push(m) } }) } : orig(name))(h2.ctx.get);
  apply(h2.ctx, h2.config);
  h2.emit(h2.home, 'turn/start', { turn: 1 }); h2.emit(h2.home, 'user/message', { source: { kind: 'user' } }); h2.emit(h2.home, 'turn/end', { turn: 1 });
  on2({ kind: 'private', userId: '30003', who: '路人', text: '在吗', fromOwner: false, at: new Date().toISOString() });
  await wait(40);
  assert.deepEqual(f2[0].source, PHONE_NOTIFICATION_SOURCE);
  assert.match(f2[0].content[0].text, /^\[手机通知\] QQ · 路人（30003）：在吗/);
  stop(h2);
  // a goal is active: /dot check does not cut in
  goal = { phase: 'active' };
  apply(h.ctx, { ...h.config, notifyHours: '' });
  await cmd.handler({ rawInput: 'check' });
  await wait(30);
  assert.equal(followups.length, 1);
  assert.ok(h.audit.some((e) => e.event === 'phone-check-skipped' && e.why === 'goal active'));
  stop(h);
});

test('working rules tell her to use a goal for long tasks', async () => {
  const { WORKING_RULES } = await import('../src/dot/core.js');
  assert.match(WORKING_RULES, /create_goal/);
  assert.match(WORKING_RULES, /一轮就能做完的事不用建目标/);
});

test('errands: app notifications and phone checks run in her errand session; only the conclusion reaches her conversation', async () => {
  const { ERRAND_NOTE_SOURCE, PHONE_CHECK_SOURCE, PHONE_NOTIFICATION_SOURCE } = await import('../src/dot/core.js');
  const h = harness();
  const followups = [], injected = [], created = [];
  let onNotification;
  const agentFor = (id) => ({ session: { id }, followup: (m) => followups.push({ id, m }), inject: (m) => injected.push({ id, m }) });
  const controller = {
    create: async (req) => { created.push(req); return { sessionId: 'errand-1' }; },
    rename: async () => ({}),
    resolveAgent: async (id) => ({ agent: agentFor(id) }),
  };
  h.ctx.get = ((orig) => (name) => name === 'dshPhone' ? { isReady: true, onNotification: (fn) => { onNotification = fn; return () => {}; }, onStatus: () => () => {}, status: () => ({ state: 'ready' }) } : name === 'sessionController' ? controller : orig(name))(h.ctx.get);
  apply(h.ctx, { ...h.config, phoneCheckEveryMinutes: 30 });
  // her conversation is s1
  h.emit(h.home, 'turn/start', { turn: 1 });
  h.emit(h.home, 'user/message', { source: { kind: 'user' } });
  h.emit(h.home, 'turn/end', { turn: 1, reason: 'completed' });
  onNotification({ pkg: 'com.tencent.mobileqq', title: '宽', text: '在吗' });
  onNotification({ pkg: 'com.max.xiaoheihe', title: '小黑盒', text: 'steam 史低' });
  await wait(40);
  assert.deepEqual(created, [{ cwd: h.home }], 'the errand session is created in her home');
  assert.deepEqual(followups.map((f) => [f.id, f.m.content[0].text.split('\n')[0]]), [['s1', '[手机通知] QQ · 宽：在吗'], ['errand-1', '[手机通知] 小黑盒 · 小黑盒：steam 史低']]);
  // the errand turn ends with a finding: it is injected (not followed up) into her conversation
  h.emitAs('errand-1', h.home, 'turn/start', { turn: 1 });
  h.emitAs('errand-1', h.home, 'user/message', { source: PHONE_NOTIFICATION_SOURCE });
  h.emitAs('errand-1', h.home, 'assistant/message', msg('小黑盒在推 steam 史低，看了一眼没想买的'));
  h.emitAs('errand-1', h.home, 'turn/end', { turn: 1, reason: 'completed' });
  await wait(20);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].id, 's1', 'the errand never becomes her conversation');
  assert.deepEqual(injected[0].m.source, ERRAND_NOTE_SOURCE);
  assert.match(injected[0].m.content[0].text, /^\[刚才手机响了，你去看了\] 小黑盒在推 steam 史低/);
  // a silent errand leaves nothing
  h.emitAs('errand-1', h.home, 'turn/start', { turn: 2 });
  h.emitAs('errand-1', h.home, 'user/message', { source: PHONE_CHECK_SOURCE });
  h.emitAs('errand-1', h.home, 'assistant/message', msg('DOT_SILENT'));
  h.emitAs('errand-1', h.home, 'turn/end', { turn: 2, reason: 'completed' });
  await wait(20);
  assert.equal(injected.length, 1);
  stop(h);
});

test('phone check goes to the errand session', async () => {
  const h = harness();
  const followups = [];
  const controller = { create: async () => ({ sessionId: 'errand-9' }), resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => followups.push({ id, m }) } }) };
  let handler;
  h.ctx.get = ((orig) => (name) => name === 'dshPhone' ? { isReady: true, onNotification: () => () => {}, onStatus: () => () => {}, status: () => ({ state: 'ready' }) } : name === 'sessionController' ? controller : name === 'commands' ? { register: (c) => { handler = c.handler; return () => {}; } } : orig(name))(h.ctx.get);
  apply(h.ctx, { ...h.config, phoneCheckEveryMinutes: 30 });
  h.emit(h.home, 'turn/start', { turn: 1 });
  h.emit(h.home, 'turn/end', { turn: 1, reason: 'completed' });
  await handler({ rawInput: 'check' });
  await wait(30);
  assert.deepEqual(followups.map((f) => f.id), ['errand-9']);
  assert.match(followups[0].m.content[0].text, /^\[拿起手机\]/);
  stop(h);
});

test('with memory: the people in a QQ message are touched and their card rides along; deliveries wait during a handoff', async () => {
  const h = harness();
  const followups = [], touched = [];
  let onMessage;
  const controller = { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => followups.push({ id, m }) } }) };
  const dotMemory = { touch: (e) => touched.push(e), cardsFor: (items) => (items.some((n) => n.handles?.includes('qq:42')) ? '阿满（qq:42）：聊过' : '') };
  const services = { sessionController: controller, dotMemory, dshQq: { connected: true, onMessage: (fn) => { onMessage = fn; return () => {}; } } };
  h.ctx.get = ((orig) => (name) => services[name] ?? orig(name))(h.ctx.get);
  h.ctx.provide = (n, v) => { services[n] = v; };
  apply(h.ctx, h.config);
  h.emit(h.home, 'turn/start', { turn: 1 });
  h.emit(h.home, 'turn/end', { turn: 1, reason: 'completed' });
  onMessage({ kind: 'group', userId: '42', groupId: '9', who: '阿满', text: '有人吗', at: new Date().toISOString() });
  await wait(40);
  assert.deepEqual(touched[0], { handles: ['qq:42'], platform: 'qq', name: '阿满', tier: 'talked', kind: 'group' });
  assert.match(followups[0].m.content[0].text, /群 9 · 阿满：有人吗[\s\S]*你记得的人：\n阿满（qq:42）：聊过/);
  const release = services.dshDot.freeze();
  onMessage({ kind: 'group', userId: '42', groupId: '9', who: '阿满', text: '还在吗', at: new Date().toISOString() });
  await wait(40);
  assert.equal(followups.length, 1, 'held while frozen');
  services.dshDot.setSession('s-new');
  release();
  await wait(40);
  assert.equal(followups.length, 2);
  assert.equal(followups[1].id, 's-new', 'released into the new session');
  stop(h);
});

test('the owner on her phone: a notification from a name that resolves to the owner enters as his words', async () => {
  const h = harness();
  const followups = [], injected = [];
  let onNotification;
  const controller = { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => followups.push({ id, m }), inject: (m) => injected.push(m) } }) };
  const dotMemory = { touch: (e) => ({ id: 'u1', tier: e.handles[0] === 'qq:name:宽' ? 'owner' : 'talked' }), cardsFor: () => '' };
  const services = { sessionController: controller, dotMemory, dshPhone: { onNotification: (fn) => { onNotification = fn; return () => {}; }, onStatus: () => () => {} } };
  h.ctx.get = ((orig) => (name) => services[name] ?? orig(name))(h.ctx.get);
  apply(h.ctx, h.config);
  h.emit(h.home, 'turn/start', { turn: 1 });
  h.emit(h.home, 'turn/end', { turn: 1, reason: 'completed' });
  onNotification({ pkg: 'com.tencent.mobileqq', title: '宽', text: '在吗' });
  onNotification({ pkg: 'com.tencent.mobileqq', title: '阿满', text: '有人吗' });
  await wait(40);
  const own = followups.find((f) => f.m.source?.kind === 'user');
  assert.equal(own.m.content[0].text, '在吗', 'his words, as typed');
  assert.match(injected[0].content[0].text, /手机 QQ 里回/);
  assert.ok(followups.some((f) => /\[手机通知\] QQ · 阿满：有人吗/.test(f.m.content[0].text)));
  stop(h);
});

test('panel: `/dsh-dot/` and `/dsh-dot/api/state` on dsh\'s web server; state gathers the services that exist', async () => {
  const { apply } = await import('../src/dot/core.js');
  const h = harness();
  const routes = [];
  const webServer = { register: (r) => { routes.push(r); return () => {}; } };
  // dsh's connection service decides who may read the panel: here, whoever carries dsh's login cookie.
  const svc = {
    webServer,
    connection: { requestRejection: (req) => (/\bdsh=owner\b/.test(String(req.headers?.cookie ?? '')) ? undefined : 401) },
    dshPhone: { status: () => ({ state: 'ready' }) },
    dshQq: { status: () => ({ connected: true, selfId: '2450548644' }) },
    dshInterlude: { status: () => ({ state: { current: '在看帖' }, today: { rounds: 2, maxRounds: 12, plays: 1, browses: 0, contacts: 0, tokensIn: 100, tokensOut: 10 }, intents: [], script: [{ head: '2026-10-27 22:00 · advance', text: '她……' }], cursor: Date.now() }) },
    dotMemory: { panel: async () => ({ gen: 2, owner: { entries: ['a'], chars: 2, limit: 1375 }, self: { entries: [], chars: 0, limit: 2200 }, people: 3, contacts: 1, pending: 0, merges: 0, fragments: 9, sinceCursor: 1, consolidations: 1, ledger: { in: 5, out: 1, calls: 1 }, conversation: { session: 's1', tokens: 1234, handoffAt: 150000 }, diary: [{ day: '2026-10-27 周二', text: '今天没什么事。' }], dailyAt: '23:30' }) },
  };
  const provided = {};
  h.ctx.provide = (n, v) => { provided[n] = v; };
  h.ctx.get = ((get) => (n) => svc[n] ?? provided[n] ?? get(n))(h.ctx.get);
  apply(h.ctx, h.config);
  try {
  const route = routes.find((r) => r.path === '/dsh-dot/panel');
  assert.ok(route && route.kind === 'prefix');
  const call = async (url, reqHeaders = { cookie: 'dsh=owner' }) => { let status = 0, body = '', headers = {}; const res = { writeHead(s, hd) { status = s; headers = hd ?? {}; return res; }, end(b) { body = String(b ?? ''); } }; await route.handler({ method: 'GET', url, headers: reqHeaders }, res); return { status, body, headers }; };
  assert.equal((await call('/dsh-dot/panel/', {})).status, 401, 'no dsh login, no panel');
  assert.equal((await call('/dsh-dot/panel/api/state', { 'x-forwarded-host': 'dsh.local', 'x-forwarded-for': '127.0.0.1' })).status, 401, 'forwarded headers are not an identity');
  const page = await call('/dsh-dot/panel/');
  assert.equal(page.status, 200); assert.match(page.headers['content-type'], /text\/html/); assert.match(page.body, /她现在/);
  const state = await call('/dsh-dot/panel/api/state');
  assert.equal(state.status, 200);
  const s = JSON.parse(state.body);
  assert.equal(s.devices.phone.state, 'ready'); assert.equal(s.devices.qq.selfId, '2450548644');
  assert.equal(s.interlude.state.current, '在看帖'); assert.equal(s.memory.diary[0].text, '今天没什么事。');
  assert.deepEqual(s.dot.today, { day: s.dot.today.day, woke: 0, owner: 0 });
  assert.equal((await call('/dsh-dot/panel/nope')).status, 404);
  } finally { stop(h); }
});
