import { test } from 'node:test';
import { PHONE_TOOL_PREFIX, VM_TOOL_PREFIX } from '../src/tool-prefixes.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inHours, describeNow } from '../src/interlude/core.js';

function fakeStream(text) {
  // A reply starting with "TOOL:" is streamed as an `interval` tool call (arguments in deltas), as dsh-llm does.
  const tool = text.startsWith('TOOL:') ? text.slice(5) : null;
  return (async function* () {
    if (tool !== null) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      for (const part of tool.match(/[\s\S]{1,7}/g) ?? []) yield { type: 'tool-call-delta', index: 0, id: 'c1', name: 'interval', argumentsDelta: part };
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 200 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const part of text.match(/[\s\S]{1,7}/g) ?? []) yield { type: 'text-delta', index: 0, text: part };
    yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 20 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

const CANON = { characterName: 'dot', characterProfile: '用户的常驻助手，话少，不打句号。' };

// Most tests are not about the device account: a JSON reply that says nothing of it is given the empty one
// (`onDevices: []` — "she did nothing on her devices"), as a careful narrator would. Tests of the check itself
// write the field, or pass `rawReplies: true`.
let rawReplies = false;
const accounted = (text) => {
  if (rawReplies) return text;
  const i = text.indexOf('{'), j = text.lastIndexOf('}');
  if (i < 0 || j <= i) return text; // prose
  try {
    const o = JSON.parse(text.slice(i, j + 1));
    if (o && typeof o === 'object' && !('onDevices' in o) && ('script' in o || 'continuity' in o || 'state' in o)) return `${text.slice(0, i)}${JSON.stringify({ ...o, onDevices: [] })}${text.slice(j + 1)}`;
  } catch { /* cut off, or not JSON */ }
  return text;
};

function harness({ reply, canon = CANON, config = {}, targets = [{ targetId: 'me' }], web = null, vm = null, memory = undefined } = {}) {
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  mkdirSync(home, { recursive: true });
  const calls = [], sent = [], listeners = [], prompts = [], sections = [], assemblers = [], effects = [], gates = [], followups = [], audits = [];
  let cmd; const tools = {};
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); if (name === 'system-prompt/assemble') assemblers.push(fn); if (name === 'tools/pre-execute') gates.push(fn); return () => {}; },
    effect(fn) { effects.push(fn()); },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (n) => ({
      systemPrompt: { context: (c) => prompts.push(c), section: (c) => { sections.push(c); return () => {}; }, getSectionOrder: () => 0 },
      commands: { register: (c) => { cmd = c; return () => {}; } },
      tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
      dshIm: { listBots: async () => [{ botId: 'b1' }], listTargets: async () => targets, send: async (b, t, text) => { sent.push({ b, t, text }); return { sent: true }; } },
      dshComputer: { audit(e) { audits.push(e); } },
      dotMemory: memory,
      web,
      sessionController: vm ? { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => { followups.push({ id, m }); vm.onFollowup?.(id, m); } } }) } : undefined,
      sessions: vm ? { flush: async () => {} } : undefined,
    }[n]),
    llm: { stream: (o) => { calls.push(o); return fakeStream(accounted(typeof reply === 'function' ? reply(o) : reply)); } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ticks = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { ticks.push(fn); const h = realSetInterval(() => {}, 1e9); h.unref(); return h; };
  try { apply(ctx, { home, canon, idleMinutes: 0, activeHours: '00:00-24:00', ...config }); } finally { globalThis.setInterval = realSetInterval; }
  const emitAs = (sid, cwd, type, data, extra = {}) => listeners.forEach((fn) => fn({ id: sid, header: { cwd } }, { type, data, ...extra }));
  const emit = (sid, type, data, extra = {}) => emitAs(sid, home, type, data, extra);
  const act = (sid, user, assistant, origin = 'user') => {
    emit(sid, 'turn/start', { turn: 1 });
    emit(sid, 'user/message', { content: [{ type: 'text', text: user }], source: { kind: origin } }, { surfaceOp: 'append' });
    emit(sid, 'assistant/message', { message: { content: [{ type: 'text', text: assistant }] } });
    emit(sid, 'turn/end', { turn: 1 });
  };
  const ctxText = (sid = 's1', cwd = home) => prompts.find((p) => p.name === 'interlude').text({ agent: { session: { id: sid, header: { cwd } } } });
  const canonText = (sid = 's1', cwd = home) => sections.find((p) => p.name === 'interlude:canon').text({ agent: { session: { id: sid, header: { cwd } } } });
  const assemble = async (sid, cwd, names) => { const a = { sections: names.map((name) => ({ name, text: name })), contexts: [], tools: [] }; let out = a; for (const fn of assemblers) out = await fn(a, { agent: { session: { id: sid, header: { cwd } } } }, async () => out); return out.sections.map((x) => x.name); };
  const gate = async (sid, name) => { let out = { kind: 'allow', via: 'next' }; for (const fn of gates) out = await fn({ name, agent: { session: { id: sid } } }, async () => out); return out; };
  return { ctx, home, calls, sent, sections, prompts, audits, emit, emitAs, act, ctxText, canonText, assemble, gate, followups, tick: () => ticks.forEach((f) => f()), cmd: () => cmd, tool: (n = 'doings') => tools[n], stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}

const soon = new Date(Date.now() + 3600000).toISOString();
const GOOD = `\`\`\`json
{"script":"他让我看了两次提交，第二次没变化，我按静默规则没出声。之后我把 dsh-computer 那个锁的问题记在了便签上。","continuity":{"current":"整理便签","recent":["晚点看看锁的修复有没有合进去"],"salient":["盯 dsh-dot 的提交"]},"overlay":[],"intents":[{"at":"${soon}","kind":"reminder","text":"看看锁的修复合进去没有","willingness":0.7}],"contact":null}
\`\`\``;

test('inHours and describeNow', () => {
  assert.ok(inHours('', new Date()));
  assert.ok(inHours('08:00-23:00', new Date(2026, 9, 22, 14, 0)));
  assert.ok(!inHours('08:00-23:00', new Date(2026, 9, 22, 2, 0)));
  assert.ok(inHours('22:00-06:00', new Date(2026, 9, 22, 2, 0)));
  assert.match(describeNow(new Date(2026, 9, 22, 14, 5)), /2026-10-22 14:05 星期四 下午/);
});

test('renderCanon and fetchPreset: HDSI storyDefaults become the Canon; share codes resolve via the hub API', async () => {
  const { renderCanon, fetchPreset } = await import('../src/interlude/core.js');
  assert.equal(renderCanon(null), '');
  const text = renderCanon({ storyDefaults: { characterName: '水濑', characterProfile: '话少', perspective: '清楚自己是被创造的', supportingCast: '希绘' }, examples: '在干嘛\n  › 吃烧烤' });
  assert.match(text, /^# 你是 水濑\n\n## 角色设定\n话少\n\n## 视角/);
  assert.match(text, /## 配角\n希绘/);
  assert.match(text, /## 对话范例[\s\S]*吃烧烤/);
  const fakeFetch = async (url) => ({ json: async () => (url.endsWith('/api/presets')
    ? { rows: [{ slug: '水濑-82c7', share_code: '6QA01PD6', title: '水濑（Minase V0）' }] }
    : { preset: { slug: '水濑-82c7', title: '水濑（Minase V0）', author: 'MomoiCore', license: 'CC-BY-NC', revision: 4, payload: { storyDefaults: { characterName: 'Minase V0', characterProfile: 'x' } } } }) });
  const c = await fetchPreset('https://hub', '6qa0-1pd6', fakeFetch);
  assert.equal(c.storyDefaults.characterName, 'Minase V0');
  assert.equal(c.source.author, 'MomoiCore');
  await assert.rejects(fetchPreset('https://hub', 'ZZZZ-ZZZZ', fakeFetch), /no preset/);
});

test('/interlude preset <code> imports the Canon into <home>/interlude/canon.json and the prompt section follows', async () => {
  const h = harness({ reply: GOOD, canon: null });
  assert.equal(h.canonText(), '', 'no canon yet');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ json: async () => (url.endsWith('/api/presets')
    ? { rows: [{ slug: 's', share_code: 'ABCD-1234', title: 'T' }] }
    : { preset: { slug: 's', title: 'T', author: 'a', license: 'CC-BY-NC', payload: { storyDefaults: { characterName: '肥皂', characterProfile: '贪吃' } } } }) });
  try {
    const r = await h.cmd().handler({ rawInput: 'preset abcd1234' });
    assert.match(r.text, /imported: T by @a/);
  } finally { globalThis.fetch = realFetch; }
  assert.match(h.canonText(), /^# 你是 肥皂/);
  assert.equal(JSON.parse(readFileSync(join(h.home, 'interlude', 'canon.json'), 'utf8')).source.shareCode, 'ABCD-1234');
  const r2 = await h.cmd().handler({ rawInput: 'canon' });
  assert.match(r2.text, /贪吃/);
  h.stop();
});

test('scope: an IM-opened session outside home is an act too (canon + context); other sessions are not', async () => {
  const h = harness({ reply: GOOD });
  const im = { id: 'wx', header: { cwd: '/Users/x/.dsh/im' } };
  h.emitAs('wx', im.header.cwd, 'agent/inbox/spliced', { inserted: [{ role: 'user', source: { kind: 'user', rpcId: 'qq-1234abcd-0000' } }] });
  assert.match(h.canonText('wx', im.header.cwd), /^# 你是 dot/);
  assert.equal(h.canonText('ui', '/Users/x/code'), '');
  h.stop();
});

test('prompt trim: dsh openers are dropped for the character\'s sessions only; canonOnly keeps canon, rules and MCP', async () => {
  const all = ['harness:identity', 'deployment:persona-prefix', 'interlude:canon', 'dot:rules', 'context:file-reference', 'tool:bash', 'mcp:vm'];
  const h = harness({ reply: GOOD });
  assert.deepEqual(await h.assemble('s1', h.home, all), ['interlude:canon', 'dot:rules', 'tool:bash', 'mcp:vm']);
  assert.deepEqual(await h.assemble('ui', '/Users/x/code', all), all, 'untouched elsewhere');
  h.stop();
  const only = harness({ reply: GOOD, config: { canonOnly: true } });
  assert.deepEqual(await only.assemble('s1', only.home, all), ['interlude:canon', 'dot:rules', 'mcp:vm']);
  only.stop();
});

test('doings: grouped by what she did, costed, with his reactions; feedback finds the latest, an id or a bit of text', async () => {
  const { createDoings, tokensOf, yuanOf, labelOf } = await import('../src/interlude/doings.js');
  const dir = mkdtempSync(join(tmpdir(), 'doings-'));
  let t = Date.now();
  const d = createDoings(join(dir, 'doings.json'), { now: () => t });
  const a = d.add({ kind: 'play', app: '小黑盒', action: 'like', what: '耳机测评' });
  d.settle(a, { status: 'done', result: '点了', usage: { inputTokens: 3000, cacheReadTokens: 2000, outputTokens: 100 } });
  t += 1000;
  const b = d.add({ kind: 'play', app: '小黑盒', action: 'like', what: '黑猴更新' });
  d.settle(b, { status: 'done', usage: { in: 1000, cached: 0, out: 50 } });
  t += 1000;
  const c = d.add({ kind: 'try', what: '用画图给自己画个头像', device: 'computer' });
  d.settle(c, { status: 'done', result: '画了一只猫', usage: { inputTokens: 20000, outputTokens: 900 } });
  assert.equal(labelOf({ kind: 'look', device: 'phone' }), '去看（手机）');
  assert.equal(d.feedback('', '画得不错', 'owner').id, c, 'latest done');
  assert.equal(d.feedback(`#${a}`, '别老点赞了', 'owner').id, a);
  assert.equal(d.feedback('黑猴', '这条点得好', 'owner').id, b);
  assert.equal(d.feedback('没有这件', 'x'), null);
  const v = d.view({ rounds: { in: 10000, cached: 0, out: 2000 }, apps: ['小黑盒', 'B站'], price: { in: 1, cached: 0.1, out: 2 } });
  assert.deepEqual(v.last7Days.map((g) => [g.what, g.times, g.tokens, g.reactions]), [['小黑盒 点赞', 2, 6150, 2], ['试点新的', 1, 20900, 1]]);
  assert.deepEqual(v.leftAloneThisWeek, ['B站']);
  assert.equal(v.today.tokens, 6150 + 20900 + 12000);
  assert.equal(v.today.livingTokens, 12000);
  assert.ok(v.today.yuan > 0);
  assert.deepEqual(v.recent.at(-1).feedback, ['他：画得不错']);
  assert.equal(tokensOf(null), 0);
  assert.equal(yuanOf({ in: 1e6, cached: 0, out: 0 }, null), null);
  // persisted
  assert.equal(createDoings(join(dir, 'doings.json')).all().length, 3);
});

test('doings: what was still queued when dsh went down is lost, not queued forever; msLeftInHours', async () => {
  const { createDoings } = await import('../src/interlude/doings.js');
  const { msLeftInHours } = await import('../src/interlude/core.js');
  const file = join(mkdtempSync(join(tmpdir(), 'doings-')), 'doings.json');
  let t = Date.now();
  const d = createDoings(file, { now: () => t });
  d.add({ kind: 'try', what: 'x' });
  t += 3 * 3600000;
  assert.equal(createDoings(file, { now: () => t }).all()[0].status, 'lost');
  assert.equal(msLeftInHours('08:00-23:00', new Date(2026, 10, 7, 22, 30)), 30 * 60000);
  assert.equal(msLeftInHours('22:00-02:00', new Date(2026, 10, 7, 23, 0)), 3 * 3600000);
  assert.equal(msLeftInHours('08:00-23:00', new Date(2026, 10, 7, 23, 30)), 0);
  assert.equal(msLeftInHours(''), Infinity);
});

test('growth: week ids, how much a portrait changed, when the review is due (a missed one caught up), history and rollback', async () => {
  const { weekId, changeRatio, createGrowth, lastDiaryDays, lastMoment } = await import('../src/interlude/growth.js');
  assert.equal(weekId(new Date(2026, 10, 8, 12).getTime()), '2026-W45');
  assert.equal(weekId(new Date(2026, 10, 9, 12).getTime()), '2026-W46');
  assert.equal(weekId(new Date(2027, 0, 1, 12).getTime()), '2026-W53');
  const base = '我叫小点，最近迷上了在电脑上画画，晚上不太刷小黑盒了，和他说话越来越随便。';
  assert.equal(changeRatio(base, base), 0);
  assert.ok(changeRatio(base, base + base) >= 0.5, 'appending as much again is a big change');
  assert.ok(changeRatio(base, base.slice(0, base.length / 2)) >= 0.45, 'cutting half is too');
  assert.ok(changeRatio('甲乙丙丁。戊己庚辛。', '戊己庚辛。甲乙丙丁。') >= 0.4, 'so is reordering');
  assert.equal(changeRatio('A', 'B'), 1);
  assert.deepEqual(lastDiaryDays('## 2026-11-01 周日\na\n\n## 2026-11-07 周六\nb\n', 7, new Date(2026, 10, 3).getTime()), [{ day: '2026-11-07 周六', text: 'b' }]);
  assert.equal(new Date(lastMoment('Sun 21:00', new Date(2026, 10, 9, 10).getTime())).getDate(), 8, 'Monday: last Sunday');
  let t = new Date(2026, 10, 8, 20, 0).getTime(); // Sunday 20:00
  const dir = mkdtempSync(join(tmpdir(), 'growth-'));
  const g = createGrowth({ dir, at: 'Sun 21:00', maxChars: 200, maxChange: 0.35, now: () => t });
  assert.equal(g.due(t), true, 'never reviewed: last week is caught up');
  g.skip('nothing');
  assert.equal(g.due(t), false);
  t += 2 * 3600000;
  assert.equal(g.due(t), true, 'Sunday 22:00');
  assert.equal(g.keep({ portrait: 'x'.repeat(201), changes: '', tidy: [] }).why, 'too long');
  assert.equal(g.keep({ portrait: base, changes: '开始画画', tidy: ['每晚十点逛小黑盒'] }).ok, true);
  assert.equal(g.due(t), false, 'done this week');
  assert.deepEqual(g.tidy(), ['每晚十点逛小黑盒']);
  t += 10 * 86400000; // Wednesday after next: Sunday was missed
  assert.equal(g.due(t), true, 'caught up');
  const far = g.keep({ portrait: '完全不一样的另一个人，爱跑步，讨厌电脑，从不说话。', changes: 'x', tidy: [] });
  assert.equal(far.ok, false); assert.equal(far.why, 'changed too much');
  assert.equal(g.portrait(), base, 'nothing kept');
  const next = `${base}这周学会了用记账 App。`;
  assert.equal(g.keep({ portrait: next, changes: '学会记账', tidy: ['x'] }).week, '2026-W46');
  assert.equal(g.keep({ portrait: `${next}还有画了猫。`, changes: '又一次', tidy: [] }, { force: true }).week, '2026-W46-2', 'a second review of a week keeps the first');
  assert.deepEqual(g.history().map((h) => [h.week, h.changes]), [['2026-W45', '开始画画'], ['2026-W46', '学会记账'], ['2026-W46-2', '又一次']]);
  assert.equal(g.rollback('2026-W45'), true);
  assert.equal(g.portrait(), base);
  assert.deepEqual(g.tidy(), [], 'the tidy list of a discarded portrait goes');
  assert.equal(g.rollback('2020-W01'), false);
  // a portrait with its own headings survives the archive
  t += 7 * 86400000;
  assert.equal(g.keep({ portrait: `${base}\n\n## 小标题`, changes: 'h', tidy: [] }, { force: true }).ok, true);
  assert.match(g.history().at(-1).portrait, /## 小标题$/);
});

test('growth: the weekly review reads her week (never writes memory), keeps her portrait, and the portrait follows the Canon in her prompt', async () => {
  const portrait = '我叫小点。最近迷上了画画，晚上不太刷小黑盒了。';
  const memory = { herLife: () => ['装了小黑盒，常在晚上逛'], forInterlude: () => ['关于他：他叫宽'], knows: () => false };
  const writes = new Proxy(memory, { set() { throw new Error('growth must not write memory'); } });
  const reply = (o) => (o.tools?.[0]?.name === 'growth' ? `TOOL:${JSON.stringify({ portrait, changes: '开始画画', tidy: ['常在晚上逛'] })}` : GOOD);
  const h = harness({ reply, memory: writes });
  mkdirSync(join(h.home, 'memory'), { recursive: true });
  const d = new Date(); const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  writeFileSync(join(h.home, 'memory', 'diary.md'), `## 2020-01-01 周三\n很久以前。\n\n## ${day} 周六\n今天第一次用画图软件画了只猫。\n\n`);
  const r = await h.cmd().handler({ rawInput: 'growth now' });
  assert.match(r.text, /reviewed 20\d\d-W\d\d: 开始画画/);
  assert.ok(existsSync(join(h.home, 'interlude', 'growth', 'current.md')), 'kept outside her own folder');
  assert.ok(!existsSync(join(h.home, 'her', 'growth')));
  const call = h.calls.find((c) => c.tools?.[0]?.name === 'growth');
  const input = JSON.parse(call.messages[0].content[0].text);
  assert.deepEqual(input.diaryThisWeek.map((d) => d.text), ['今天第一次用画图软件画了只猫。']);
  assert.deepEqual(input.yourNotes, ['装了小黑盒，常在晚上逛']);
  assert.match(call.system, /只为讨他喜欢而改的，不算你的变化/);
  assert.match(h.canonText(), /你是 dot/);
  const growthSection = h.sections.find((x) => x.name === 'interlude:growth');
  assert.match(growthSection.text({ agent: { session: { id: 's1', header: { cwd: h.home } } } }), /## 你现在的样子[\s\S]*迷上了画画/);
  assert.equal(growthSection.text({ agent: { session: { id: 'x', header: { cwd: '/elsewhere' } } } }), '', 'only her sessions');
  assert.match((await h.cmd().handler({ rawInput: 'growth' })).text, /迷上了画画[\s\S]*W\d\d：开始画画/);
  h.stop();
});

test('free time: her own time goes to her errands with a budget; QQ and the ledger refused, typing in a social app asks, tell_him only there; past the budget the turn is stopped', async () => {
  const { FREE_SOURCE } = await import('../src/interlude/core.js');
  const h = harness({ reply: GOOD, vm: {}, config: { freeTokenCap: 10000, freeDailyTokens: 30000 } });
  const tasks = [], cancelled = [];
  let fg = 'com.max.xiaoheihe/.MainActivity';
  h.ctx.get = ((get) => (n) => (n === 'dshDot' ? { task: (t) => { tasks.push(t); return 'queued'; }, isErrand: (id) => id === 'e1', session: () => 's1' }
    : n === 'dshPhone' ? { isReady: true, apps: async () => [], foreground: async () => fg }
      : n === 'agents' ? { get: (id) => ({ cancel: () => cancelled.push(id) }) } : get(n)))(h.ctx.get);
  writeFileSync(join(h.home, 'her', '想学的.md'), '画画');
  const r = await h.cmd().handler({ rawInput: 'free' });
  assert.match(r.text, /queued \(budget 10000 tokens\)/);
  assert.equal(tasks[0].kind, 'free'); assert.deepEqual(tasks[0].source, FREE_SOURCE);
  assert.match(tasks[0].text, /自己的时间\] 接下来这段时间是你自己的，没有人要你做什么。/);
  assert.match(tasks[0].text, /想学的\.md · \d+ B/);
  assert.doesNotMatch(tasks[0].text, /点赞|评论|关注/, 'no list of what to do');
  // before it starts, nothing is a free session
  assert.equal((await h.gate('e1', 'qq_send')).via, 'next');
  tasks[0].onStart('e1');
  assert.equal((await h.gate('e1', 'qq_send')).kind, 'deny');
  assert.equal((await h.gate('e1', 'doings')).kind, 'deny');
  assert.equal((await h.gate('e1', 'tell_him')).via, 'next');
  assert.equal((await h.gate('s1', 'tell_him')).kind, 'deny');
  assert.equal((await h.gate('e1', `${PHONE_TOOL_PREFIX}mobile_type_keys`)).kind, 'ask');
  fg = 'com.android.chrome/.Main';
  assert.equal((await h.gate('e1', `${PHONE_TOOL_PREFIX}mobile_type_keys`)).via, 'next', 'typing elsewhere passes to the phone gate');
  // tell_him with speak off: kept, not sent
  const said = await h.tool('tell_him').execute({ text: '我画了只猫', why: '想给他看' });
  assert.equal(said.handed, false);
  // the budget: 9000 tokens → warned; 11000 → stopped
  h.emit('e1', 'assistant/message', { message: { content: [] }, usage: { inputTokens: 8000, outputTokens: 1000 } });
  assert.deepEqual(cancelled, []);
  h.emit('e1', 'assistant/message', { message: { content: [] }, usage: { inputTokens: 2000, outputTokens: 0 } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(cancelled, ['e1']);
  tasks[0].onDone({ status: 'done', queuedAt: Date.now(), startedAt: Date.now(), doneAt: Date.now(), busyWith: '', report: '画了一只猫，存在 her/画/猫.png', cost: { in: 10000, cached: 0, out: 1000 } });
  assert.equal((await h.gate('e1', 'qq_send')).via, 'next', 'over');
  const list = JSON.parse(readFileSync(join(h.home, 'interlude', 'doings.json'), 'utf8'));
  assert.deepEqual(list.map((d) => [d.kind, d.status]), [['free', 'stopped'], ['say', 'kept']], 'stopped by the budget, said so');
  assert.match((await h.cmd().handler({ rawInput: '' })).text, /free time: 1\/2 today, 11000\/30000 tokens/);
  // the daily budget: 11000 of 30000 used; one more would be capped at what is left
  assert.match((await h.cmd().handler({ rawInput: 'free' })).text, /budget 10000 tokens/);
  assert.match((await h.cmd().handler({ rawInput: 'free' })).text, /not queued: already running/, 'one at a time, from queued on');
  h.stop();
});

test('free time: one step past the whole budget stops it without a wake-up message; with no cancel, every tool is refused', async () => {
  const h = harness({ reply: GOOD, vm: {}, config: { freeTokenCap: 10000 } });
  const tasks = [], steered = [];
  h.ctx.get = ((get) => (n) => (n === 'dshDot' ? { task: (t) => { tasks.push(t); return 'queued'; }, isErrand: () => true }
    : n === 'agents' ? { get: () => ({ steer: (m) => steered.push(m) }) } : get(n)))(h.ctx.get); // no cancel on this host
  await h.cmd().handler({ rawInput: 'free' });
  tasks[0].onStart('e1');
  // cached re-reads weigh a tenth: 50000 cached + 4000 fresh + 500 out = 9500 → warned, not stopped
  h.emit('e1', 'assistant/message', { message: { content: [] }, usage: { inputTokens: 4000, cacheReadTokens: 50000, outputTokens: 500 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(steered.length, 1);
  h.emit('e1', 'assistant/message', { message: { content: [] }, usage: { inputTokens: 20000 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(steered.length, 1, 'no second message');
  assert.equal((await h.gate('e1', `${VM_TOOL_PREFIX}browser_navigate`)).kind, 'deny', 'stopped: every tool refused');
  tasks[0].onDone({ status: 'done', queuedAt: Date.now(), startedAt: Date.now(), doneAt: Date.now(), busyWith: '', report: '', cost: null });
  assert.equal(JSON.parse(readFileSync(join(h.home, 'interlude', 'doings.json'), 'utf8')).at(-1).status, 'stopped');
  // one step over both thresholds at once: stopped, no warning steered into an idle agent
  await h.cmd().handler({ rawInput: 'free' });
  tasks[1].onStart('e2');
  h.emit('e2', 'assistant/message', { message: { content: [] }, usage: { inputTokens: 30000 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(steered.length, 1);
  h.stop();
});

test('free time: planned at random moments in her active hours, once a day', async () => {
  const h = harness({ reply: GOOD, config: { freeTimesPerDay: 2, activeHours: '00:00-23:59' } });
  h.ctx.get = ((get) => (n) => (n === 'dshDot' ? { task: () => 'queued', isErrand: () => false } : get(n)))(h.ctx.get);
  h.tick();
  const meta = JSON.parse(readFileSync(join(h.home, 'interlude', 'meta.json'), 'utf8'));
  assert.ok(meta.freeDay, 'planned today');
  const end = new Date(); end.setHours(23, 29, 0, 0);
  for (const at of meta.freeAt) assert.ok(at >= Date.now() - 60000 && at <= end.getTime() + 60000);
  if (Date.now() < end.getTime() - 60000) assert.equal(meta.freeAt.length, 2); else assert.equal(meta.freeAt.length, 0);
  h.stop();
});

test('voice: how she talks is the last thing in her conversation (after the memory and the interlude), from the Canon or the built-in; not in errands', async () => {
  const h = harness({ reply: GOOD, vm: {} });
  h.ctx.get = ((get) => (n) => (n === 'dshDot' ? { task: () => 'queued', isErrand: (id) => id === 'e1' } : get(n)))(h.ctx.get);
  const voice = h.prompts.find((p) => p.name === 'interlude:voice');
  const others = h.prompts.filter((p) => p !== voice);
  assert.ok(others.every((p) => p.order < voice.order), 'after every other context of the interlude');
  assert.ok(voice.order > 905, 'after the memory (904/905)');
  const c = (id, cwd = h.home) => ({ agent: { session: { id, header: { cwd } } } });
  assert.match(voice.text(c('s1')), /接下来是dot在 IM 里回他/);
  assert.equal(voice.text(c('e1')), '', 'errands report, they do not chat');
  assert.equal(voice.text(c('x', '/elsewhere')), '', 'only her sessions');
  h.stop();
  const own = harness({ reply: GOOD, canon: { ...CANON, voice: '（你是小点：短句，一句一行。）' } });
  assert.equal(own.prompts.find((p) => p.name === 'interlude:voice').text(c('s1', own.home)), '（你是小点：短句，一句一行。）');
  own.stop();
  const off = harness({ reply: GOOD, config: { voice: false } });
  assert.equal(off.prompts.find((p) => p.name === 'interlude:voice').text(c('s1', off.home)), '');
  off.stop();
});

test('her card: a home with a canon gets persona.md and persona.checks.txt once; the card is what her prompt opens with; a card she (the user) wrote is never replaced', () => {
  const canon = { characterName: '林夏', characterProfile: '22岁的女大学生。', replyRules: '一条一行。' };
  const h = harness({ canon });
  const card = readFileSync(join(h.home, 'persona.md'), 'utf8');
  assert.match(card, /^# 你是 林夏\n\n## 你是谁\n22岁的女大学生。\n\n## 怎么说话\n一条一行。\n$/);
  assert.equal(h.canonText(), card.trim());
  assert.ok(!existsSync(join(h.home, 'persona.checks.txt')), 'no blacklist in the canon: no checks file');
  assert.ok(h.audits.some((e) => e.event === 'card-migrated' && e.card === true));
  writeFileSync(join(h.home, 'persona.md'), '# 你是 小夏\n自己写的卡\n');
  assert.equal(h.canonText(), '# 你是 小夏\n自己写的卡');
  // the next start does not write it again, and a deleted card falls back to the canon as rendered before
  const again = harness({ canon });
  writeFileSync(join(again.home, 'persona.md'), '');
  assert.match(again.canonText(), /## 角色设定\n22岁的女大学生。/);
});
