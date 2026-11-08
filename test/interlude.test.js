import { test } from 'node:test';
import { PHONE_TOOL_PREFIX, VM_TOOL_PREFIX } from '../src/tool-prefixes.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, parseReply, renderContext, readScript, buildPrompt, inHours, describeNow, onVmSite, thinWhy, observationPrompt, OBSERVATION_SOURCE, castNames } from '../src/interlude/core.js';

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

function harness({ reply, canon = CANON, config = {}, targets = [{ targetId: 'me' }], web = null, vm = null, memory = undefined } = {}) {
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  mkdirSync(home, { recursive: true });
  const calls = [], sent = [], listeners = [], prompts = [], sections = [], assemblers = [], effects = [], gates = [], followups = [];
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
      dshComputer: { audit() {} },
      dotMemory: memory,
      web,
      sessionController: vm ? { resolveAgent: async (id) => ({ agent: { session: { id }, followup: (m) => { followups.push({ id, m }); vm.onFollowup?.(id, m); } } }) } : undefined,
      sessions: vm ? { flush: async () => {} } : undefined,
    }[n]),
    llm: { stream: (o) => { calls.push(o); return fakeStream(typeof reply === 'function' ? reply(o) : reply); } },
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
  return { ctx, home, calls, sent, sections, prompts, emit, emitAs, act, ctxText, canonText, assemble, gate, followups, tick: () => ticks.forEach((f) => f()), cmd: () => cmd, tool: (n = 'doings') => tools[n], stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}

const soon = new Date(Date.now() + 3600000).toISOString();
const GOOD = `\`\`\`json
{"script":"他让我看了两次提交，第二次没变化，我按静默规则没出声。之后我把 dsh-computer 那个锁的问题记在了便签上。","continuity":{"current":"整理便签","recent":["晚点看看锁的修复有没有合进去"],"salient":["盯 dsh-dot 的提交"]},"overlay":[],"intents":[{"at":"${soon}","kind":"reminder","text":"看看锁的修复合进去没有","willingness":0.7}],"contact":null}
\`\`\``;

test('parseReply normalises intents, contact; rejects past intents and garbage', () => {
  const p = parseReply(GOOD);
  assert.equal(p.state.current, '整理便签');
  assert.equal(p.intents.length, 1);
  assert.equal(p.intents[0].kind, 'reminder');
  assert.equal(parseReply('{"script":"x","intents":[{"at":"2000-01-01T00:00:00Z","text":"old"}],"contact":{"text":"hi","willingness":2}}').intents.length, 0);
  assert.equal(parseReply('{"script":"x","contact":{"text":"hi","willingness":2}}').contact.willingness, 1);
  assert.equal(parseReply('nothing here'), null);
});

test('inHours and describeNow', () => {
  assert.ok(inHours('', new Date()));
  assert.ok(inHours('08:00-23:00', new Date(2026, 9, 22, 14, 0)));
  assert.ok(!inHours('08:00-23:00', new Date(2026, 9, 22, 2, 0)));
  assert.ok(inHours('22:00-06:00', new Date(2026, 9, 22, 2, 0)));
  assert.match(describeNow(new Date(2026, 9, 22, 14, 5)), /2026-10-22 14:05 星期四 下午/);
});

test('renderContext: empty before the first round; restart and near intents shown after', () => {
  assert.equal(renderContext({ state: null, entries: [], intents: [], cursor: 0 }), '');
  const t = renderContext({ state: { mood: 'ok', now: 'x', next: 'y', threads: ['a'] }, entries: ['e1'], intents: [{ at: soon, text: '提醒他' }], cursor: Date.now() - 90 * 60000, restarted: true });
  assert.match(t, /"continuitySnapshotAgeMinutes": 90/);
  assert.match(t, /"hostRestartedSinceSnapshot": true/);
  assert.doesNotMatch(t, /settingOverlay/, 'slow change lives in memory\'s self bank now, not an overlay');
  assert.match(t, /"upcomingPlans"[\s\S]*提醒他/);
  assert.match(t, /"current": "x"/);
  assert.ok(t.length <= 2400);
});

test('follow-up round: writes script, state, intents; later acts in home see the context', async () => {
  const h = harness({ reply: GOOD });
  h.act('s1', '看看 dsh-dot 有没有新提交', '有，787ef54。');
  h.act('s1', '[SCHEDULE REMINDER] 再看一次', 'DOT_SILENT', 'schedule');
  assert.equal(h.ctxText(), '');
  const r = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r.text, /ran: 他让我看了两次提交/);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].system, /^故事设定（Canon）：\n# 你是 dot[\s\S]*不打句号/);
  assert.match(h.canonText(), /^# 你是 dot/, 'the Canon is a prompt section for home sessions');
  assert.equal(h.canonText('x', '/elsewhere'), '', 'and absent elsewhere');
  assert.match(h.calls[0].system, /当前阶段：对话余波/);
  assert.match(h.calls[0].system, /contact：null（宿主关闭了主动联系）/);
  const user = h.calls[0].messages[0].content[0].text;
  assert.match(user, /"owner": "scheduled-task"[\s\S]*DOT_SILENT/);
  const script = readFileSync(join(h.home, 'interlude', 'script.md'), 'utf8');
  assert.match(script, /^## .* · follow-up\n他让我看了两次提交/m);
  const state = JSON.parse(readFileSync(join(h.home, 'interlude', 'state.json'), 'utf8'));
  assert.equal(state.salient[0], '盯 dsh-dot 的提交');
  const intents = JSON.parse(readFileSync(join(h.home, 'interlude', 'intents.json'), 'utf8'));
  assert.equal(intents.length, 1);
  assert.equal(readFileSync(join(h.home, 'interlude', 'pending.jsonl'), 'utf8'), '');
  const text = h.ctxText();
  assert.match(text, /"current": "整理便签"/);
  assert.match(text, /"salient": \[\s*"盯 dsh-dot 的提交"/);
  assert.match(text, /"upcomingPlans"[\s\S]*看看锁的修复合进去没有/);
  assert.equal(h.ctxText('elsewhere', '/tmp/x'), '');
  const r2 = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r2.text, /not run: nothing happened/);
  h.stop();
});

test('advance round runs without any conversation and says so to the model; the fields arrive as an `interval` tool call', async () => {
  const h = harness({ reply: `TOOL:${GOOD.replace(/```(json)?/g, '').trim()}` });
  const r = await h.cmd().handler({ rawInput: 'advance' });
  assert.match(r.text, /ran:/);
  assert.match(h.calls[0].system, /当前阶段：独立的生活推进/);
  assert.match(h.calls[0].system, /把整轮写成对 `interval` 工具的一次调用/);
  assert.equal(h.calls[0].tools[0].name, 'interval');
  assert.deepEqual(h.calls[0].tools[0].parameters.required, ['script', 'continuity', 'intents', 'browserIntents', 'playIntents', 'contact']);
  assert.match(h.calls[0].messages[0].content[0].text, /"currentEvent": \{\s*"type": "none"/);
  assert.equal(h.calls.length, 1, 'a tool call needs no refresh');
  const state = JSON.parse(readFileSync(join(h.home, 'interlude', 'state.json'), 'utf8'));
  assert.equal(state.current, '整理便签');
  const call = JSON.parse(readFileSync(join(h.home, 'interlude', 'calls.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(call.viaTool, true);
  assert.deepEqual(call.usage, { in: 1000, out: 50, cached: 200 });
  const meta = JSON.parse(readFileSync(join(h.home, 'interlude', 'meta.json'), 'utf8'));
  assert.equal(meta.dayTokensIn, 1200); assert.equal(meta.dayTokensOut, 50);
  const st = await h.cmd().handler({ rawInput: '' });
  assert.match(st.text, /today 1200 in \/ 50 out tokens/);
  h.stop();
});

test('her life: the self bank reaches the interlude as herLife with its own contract line', async () => {
  const h = harness({ reply: GOOD, memory: { forInterlude: () => ['关于他：他叫宽'], herLife: () => ['学会了在小黑盒翻角色卡帖', '每天晚上刷一会儿小黑盒'] } });
  await h.cmd().handler({ rawInput: 'advance' });
  const user = h.calls[0].messages[0].content[0].text;
  assert.match(user, /"herLife": \[\s*"学会了在小黑盒翻角色卡帖"/);
  assert.match(user, /"memories": \[\s*"关于他：他叫宽"/);
  assert.match(h.calls[0].system, /她自己的生活：herLife 是她自己记的笔记/);
  h.stop();
});

test('a due intent is resolved by an intent round and removed', async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  const seeded = harness({ reply: GOOD });
  writeFileSync(join(seeded.home, 'interlude', 'intents.json'), JSON.stringify([{ id: 'i1', at: past, kind: 'reminder', text: '提醒他喝水', willingness: 0.8 }]));
  seeded.stop();
  const h = harness({ reply: GOOD, config: { home: seeded.home } }); // GOOD plants a new intent — an intent round must not keep it
  h.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].system, /当前阶段：到期的打算/);
  assert.match(h.calls[0].messages[0].content[0].text, /提醒他喝水/);
  assert.deepEqual(JSON.parse(readFileSync(join(seeded.home, 'interlude', 'intents.json'), 'utf8')), [], 'settled, and no new intent planted by an intent round');
  assert.match(readFileSync(join(seeded.home, 'interlude', 'script.md'), 'utf8'), /· intent\n/);
  h.stop();
});

test('scheduler: follow-up after quiet acts, advance on interval, nothing while a turn runs', async () => {
  const h = harness({ reply: GOOD, config: { advanceEveryMinutes: 0 } });
  h.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.length, 0, 'nothing happened yet');
  h.emit('s1', 'turn/start', { turn: 1 });
  h.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.calls.length, 0, 'a turn is running');
  h.emit('s1', 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: 'hello' }] } });
  h.emit('s1', 'turn/end', { turn: 1 });
  h.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].system, /当前阶段：对话余波/);
  h.stop();
  const adv = harness({ reply: GOOD, config: { advanceEveryMinutes: 1 } });
  adv.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(adv.calls.length, 0, 'interval not elapsed since start cursor');
  adv.stop();
});

test('contact: off by default; on, gated by willingness, hours and daily cap', async () => {
  const withContact = GOOD.replace('"contact":null', '"contact":{"text":"那个锁的问题我记下了<sep/>回头跟你说","willingness":0.9,"reason":"刚整理完便签"}');
  const quiet = harness({ reply: withContact });
  quiet.act('s1', 'hi', 'hello');
  await quiet.cmd().handler({ rawInput: 'now' });
  assert.equal(quiet.sent.length, 0);
  quiet.stop();

  const loud = harness({ reply: withContact, config: { speak: true, maxContactsPerDay: 1 } });
  loud.act('s1', 'hi', 'hello');
  const r = await loud.cmd().handler({ rawInput: 'now' });
  assert.deepEqual(loud.sent.map((s) => s.text), ['那个锁的问题我记下了', '回头跟你说'], '<sep/> becomes separate messages');
  assert.match(r.text, /\(sent\)/);
  loud.act('s1', 'again', 'ok');
  const r2 = await loud.cmd().handler({ rawInput: 'now' });
  assert.match(r2.text, /\(held\)/, 'daily cap');
  assert.equal(loud.sent.length, 2, 'no further sends after the cap');
  loud.stop();

  const timid = harness({ reply: withContact.replace('"willingness":0.9', '"willingness":0.3'), config: { speak: true } });
  timid.act('s1', 'hi', 'hello');
  await timid.cmd().handler({ rawInput: 'now' });
  assert.equal(timid.sent.length, 0, 'willingness below threshold');
  timid.stop();

  const night = harness({ reply: withContact, config: { speak: true, activeHours: '03:00-03:01' } });
  night.act('s1', 'hi', 'hello');
  await night.cmd().handler({ rawInput: 'now' });
  assert.equal(night.sent.length, 0, 'outside active hours');
  night.stop();
});

test('a reply that is not JSON still becomes a script entry; state is untouched', async () => {
  const h = harness({ reply: '今天没什么特别的。' });
  h.act('s1', 'a', 'b');
  const r = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r.text, /ran: 今天没什么特别的/);
  assert.ok(!existsSync(join(h.home, 'interlude', 'state.json')));
  assert.equal(readScript(join(h.home, 'interlude', 'script.md'), 5).length, 1);
  h.stop();
});

test('daily round cap', async () => {
  const h = harness({ reply: GOOD, config: { maxRoundsPerDay: 1 } });
  h.act('s1', 'a', 'b');
  await h.cmd().handler({ rawInput: 'now' });
  h.act('s1', 'c', 'd');
  const r = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r.text, /not run: daily cap/);
  h.stop();
});

test('buildPrompt phases', () => {
  const now = Date.now();
  const ip = buildPrompt({ phase: 'intent', identity: '', state: null, overlay: '', script: '', digest: '', cursor: now - 3600000, now, intent: { text: '提醒他喝水', kind: 'reminder', at: new Date(now).toISOString() }, speak: true, model: 'deepseek-flash' });
  assert.match(ip.system, /当前阶段：到期的打算[\s\S]*contact：null，或者 \{"content"/);
  assert.match(ip.system, /绝不要把四字成语串成一串/, 'DeepSeek length block');
  assert.match(ip.system, /^这一轮不能进行新的浏览。/m, 'browser off by default');
  assert.doesNotMatch(ip.system, /\{[A-Za-z]\w*\}/, 'every placeholder filled');
  assert.match(ip.user, /提醒他喝水/);
  const ap = buildPrompt({ phase: 'advance', identity: '', state: null, overlay: '', script: '', digest: '', cursor: 0, now, speak: false, model: 'claude-x' });
  assert.match(ap.system, /当前阶段：独立的生活推进/);
  assert.match(ap.system, /从她的身体和手头正在做的事开场/, 'Claude length block');
  assert.doesNotMatch(ap.system, /故事设定（Canon）|情绪基调|先写主角的生活/, 'no Canon, no GLM block, no agency when contact is off');
  assert.match(ap.user, /"from": null/);
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

test('/interlude seed opens an empty script with dated entries and refuses once entries exist', async () => {
  const seed = JSON.stringify({ script: '[10-21 23:40] 她把练习册翻过去一页，台灯还亮着\n[10-22 07:50] 闹钟响了三遍才起来，早饭是楼下的包子\n[10-22 12:10] 希绘发来奶茶店的链接，她回了个问号', continuity: { current: '吃午饭', recent: ['下午去文具店'], salient: ['奶茶店'] }, overlay: [], intents: [], contact: null });
  const h = harness({ reply: seed });
  const r = await h.cmd().handler({ rawInput: 'seed' });
  assert.match(r.text, /ran:/);
  assert.match(h.calls[0].system, /第三人称，覆盖最近一天，分 3 到 5 段，每段以 \[MM-DD HH:MM\] 开头。/);
  const script = readFileSync(join(h.home, 'interlude', 'script.md'), 'utf8');
  assert.equal((script.match(/^## /gm) || []).length, 3);
  assert.match(script, /10-21 23:40 .* seed\n她把练习册翻过去一页/);
  assert.match(script, /10-22 12:10 .* seed\n希绘发来奶茶店的链接/);
  const r2 = await h.cmd().handler({ rawInput: 'seed' });
  assert.match(r2.text, /already has entries/);
  assert.match(h.ctxText(), /奶茶店/);
  h.stop();
});

test('parseReply recovers the script from a reply cut off mid-JSON', () => {
  const cut = '```json\n{\n  "script": "她把碗推到床尾，试了最后一次。",\n  "state": {\n    "mood": "困"';
  const r = parseReply(cut);
  assert.equal(r.script, '她把碗推到床尾，试了最后一次。');
  assert.equal(r.state, null);
  assert.equal(r.truncated, true);
});

test('a prose-only reply gets a continuity refresh call; its JSON becomes the snapshot', async () => {
  let n = 0;
  const h = harness({ reply: () => (++n === 1 ? '她把碗推到床尾，试了最后一次。' : '{"continuity":{"current":"窝在被子里","recent":["明天再弄环境"],"salient":["apt-get 卡着"]},"intents":[],"overlay":[]}') });
  h.act('s1', 'hi', 'hello');
  await h.cmd().handler({ rawInput: 'now' });
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].system, /写完后的连续性刷新：剧本已经写好了[\s\S]*不要改写剧本。$/);
  assert.match(h.calls[1].messages[0].content[0].text, /她把碗推到床尾/);
  const state = JSON.parse(readFileSync(join(h.home, 'interlude', 'state.json'), 'utf8'));
  assert.equal(state.current, '窝在被子里');
  assert.match(readFileSync(join(h.home, 'interlude', 'script.md'), 'utf8'), /她把碗推到床尾/);
  h.stop();
});

test('browsing: a browserIntent runs through the web service after the round; the observation is webContext next time, capped per day', async () => {
  const searches = [];
  const web = { search: async (r) => { searches.push(r.query); return { content: 'HDSI rc57 出了', sources: [{ title: 'rel', url: 'https://x/rel', snippet: '修了主动消息' }], truncated: false }; }, fetch: async () => ({ content: 'page' }) };
  const withBrowse = GOOD.replace('"contact":null', '"contact":null,"browserIntents":[{"mode":"search","query":"HDS-Interlude 最新版本","purpose":"看看有没有更新","timing":"deferred"}]');
  const h = harness({ reply: withBrowse, web, config: { browseDailyCap: 1 } });
  h.act('s1', 'hi', 'hello');
  await h.cmd().handler({ rawInput: 'now' });
  assert.match(h.calls[0].system, /这一轮的浏览是延后执行的/);
  assert.deepEqual(searches, ['HDS-Interlude 最新版本']);
  const ctxLines = readFileSync(join(h.home, 'interlude', 'web-context.jsonl'), 'utf8').trim().split('\n');
  assert.equal(ctxLines.length, 1);
  assert.match(ctxLines[0], /修了主动消息/);
  // second round: webContext carries the observation; the cap closes browsing
  h.act('s1', 'again', 'ok');
  await h.cmd().handler({ rawInput: 'now' });
  assert.match(h.calls[1].messages[0].content[0].text, /"webContext"[\s\S]*HDSI rc57 出了/);
  assert.match(h.calls[1].system, /这一轮不能进行新的浏览/);
  assert.equal(searches.length, 1, 'daily cap holds');
  h.stop();
  const off = harness({ reply: withBrowse, web: null });
  off.act('s1', 'hi', 'hello');
  await off.cmd().handler({ rawInput: 'now' });
  assert.match(off.calls[0].system, /这一轮不能进行新的浏览/);
  assert.ok(!existsSync(join(off.home, 'interlude', 'web-context.jsonl')));
  off.stop();
});

test('onVmSite / thinWhy / observationPrompt', () => {
  assert.ok(onVmSite('https://www.bilibili.com/video/1', ['bilibili.com']));
  assert.ok(onVmSite('https://x.com/home', ['*.x.com']));
  assert.ok(!onVmSite('https://notx.com/', ['x.com']));
  assert.ok(!onVmSite('nonsense', ['x.com']));
  assert.equal(thinWhy('short'), 'too short');
  assert.equal(thinWhy(`${'正文 '.repeat(80)} 请先登录`), 'blocked or login wall');
  assert.equal(thinWhy('正文 '.repeat(80)), '');
  assert.match(observationPrompt({ mode: 'visit', url: 'https://x.com/a', purpose: '看看她发了没' }), /幕间观察[\s\S]*https:\/\/x.com\/a[\s\S]*只看不动[\s\S]*没有审批/);
});

test('vm observation: her sites go to the VM, a thin web result upgrades to it; the turn is read-only, approval-free and not an act', async () => {
  const web = { fetch: async () => ({ content: 'please enable javascript' }), search: async () => ({ content: '', sources: [] }) };
  const visit = GOOD.replace('"contact":null', '"contact":null,"browserIntents":[{"mode":"visit","url":"https://www.bilibili.com/u/1","purpose":"看看她更新没","timing":"deferred"}]');
  const h = harness({ reply: visit, web, vm: {}, config: { vmSites: ['bilibili.com'], vmDailyCap: 1 } });
  h.act('s1', 'hi', 'hello');
  // the observation turn, answered as soon as the followup lands
  let seen;
  const pending = h.cmd().handler({ rawInput: 'now' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.followups.length, 1, 'one followup into the last act session');
  assert.equal(h.followups[0].id, 's1');
  assert.deepEqual(h.followups[0].m.source, OBSERVATION_SOURCE);
  assert.match(h.followups[0].m.content[0].text, /bilibili\.com\/u\/1/);
  // while it runs: read-only vm tools pass without reaching the next gate, anything else is denied, other sessions untouched
  assert.deepEqual(await h.gate('s1', 'mcp__dot-vm__browser_get_markdown'), { kind: 'allow' });
  assert.deepEqual(await h.gate('s1', 'phone_zoom'), { kind: 'allow' }, 'looking closer is looking');
  assert.equal((await h.gate('s1', 'mcp__dot-vm__browser_click')).kind, 'deny');
  assert.equal((await h.gate('s1', 'mcp__dot-vm__sandbox_execute_bash')).kind, 'deny');
  assert.equal((await h.gate('s2', 'mcp__dot-vm__browser_click')).via, 'next');
  h.emit('s1', 'turn/start', { turn: 2 });
  h.emit('s1', 'user/message', { content: h.followups[0].m.content, source: OBSERVATION_SOURCE }, { surfaceOp: 'append' });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '她 10 月 20 日发了新视频，标题是《秋天》，播放 1.2 万。' }] } });
  h.emit('s1', 'turn/end', { turn: 2 });
  await pending;
  seen = readFileSync(join(h.home, 'interlude', 'web-context.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].via, 'vm');
  assert.match(seen[0].content, /秋天/);
  // the device logged is the one she really looked with: phone wanted, refused, computer used → vm
  const p = harness({ reply: visit, web, vm: {}, config: { vmSites: ['bilibili.com'], phonePreferred: true } });
  p.ctx.get = ((get) => (n) => (n === 'dshPhone' ? { isReady: true, apps: async () => [] } : get(n)))(p.ctx.get);
  p.act('s1', 'hi', 'hello');
  const pp = p.cmd().handler({ rawInput: 'now' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(p.followups.length, 1);
  assert.match(p.followups[0].m.content[0].text, /dot-phone|手机/, 'she was sent to look on her phone');
  assert.equal((await p.gate('s1', `${PHONE_TOOL_PREFIX}phone_tap`)).kind, 'deny');
  assert.deepEqual(await p.gate('s1', `${VM_TOOL_PREFIX}browser_get_markdown`), { kind: 'allow' });
  p.emit('s1', 'turn/start', { turn: 2 });
  p.emit('s1', 'user/message', { content: p.followups[0].m.content, source: OBSERVATION_SOURCE }, { surfaceOp: 'append' });
  p.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '看到了。' }] } });
  p.emit('s1', 'turn/end', { turn: 2 });
  await pp;
  assert.equal(JSON.parse(readFileSync(join(p.home, 'interlude', 'web-context.jsonl'), 'utf8').trim()).via, 'vm');
  p.stop();
  assert.equal((await h.gate('s1', 'mcp__dot-vm__browser_click')).via, 'next', 'gate released after the turn');
  assert.equal(readFileSync(join(h.home, 'interlude', 'pending.jsonl'), 'utf8').trim(), '', 'the observation turn is not an act');
  // vm cap reached: a second intent on her site is held, not read anonymously
  h.act('s1', 'again', 'ok');
  await h.cmd().handler({ rawInput: 'now' });
  assert.equal(h.followups.length, 1);
  assert.equal(readFileSync(join(h.home, 'interlude', 'web-context.jsonl'), 'utf8').trim().split('\n').length, 1);
  h.stop();
  // auto: a blocked web page on any other host upgrades to the VM
  const other = GOOD.replace('"contact":null', '"contact":null,"browserIntents":[{"mode":"visit","url":"https://example.org/x","purpose":"看看","timing":"deferred"}]');
  const g = harness({ reply: other, web, vm: {} });
  g.act('s1', 'hi', 'hello');
  const p2 = g.cmd().handler({ rawInput: 'now' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(g.followups.length, 1, 'thin web result → vm');
  g.emit('s1', 'turn/start', { turn: 2 });
  g.emit('s1', 'user/message', { content: g.followups[0].m.content, source: OBSERVATION_SOURCE }, { surfaceOp: 'append' });
  g.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '是个示例页。' }] } });
  g.emit('s1', 'turn/end', { turn: 2 });
  await p2;
  g.stop();
  // browser: 'web' never wakes the VM
  const w = harness({ reply: other, web, vm: {}, config: { browser: 'web' } });
  w.act('s1', 'hi', 'hello');
  await w.cmd().handler({ rawInput: 'now' });
  assert.equal(w.followups.length, 0);
  assert.match(readFileSync(join(w.home, 'interlude', 'web-context.jsonl'), 'utf8'), /"thin":"too short"/);
  w.stop();
});

test('play: on by default but only in apps on her phone (none → disabled); a playIntent becomes one normal turn on her phone, gated by actions, apps, willingness and daily cap', async () => {
  const { PLAY_SOURCE, playRules } = await import('../src/interlude/core.js');
  const withPlay = GOOD.replace('"contact":null', '"contact":null,"playIntents":[{"app":"小黑盒","action":"like","target":"那篇讲黑猴更新的帖子","why":"写得认真","willingness":0.8}]');
  // nothing of the known apps on her phone: prompt says disabled, nothing executed
  const off = harness({ reply: withPlay, vm: {} });
  off.ctx.get = ((orig) => (n) => n === 'dshPhone' ? { isReady: true, apps: async () => ['com.android.chrome'] } : orig(n))(off.ctx.get);
  off.act('s1', 'hi', 'hello');
  await off.cmd().handler({ rawInput: 'now' });
  assert.match(off.calls[0].system, /playIntents：\[\]（宿主关闭了她在 App 上玩）/);
  assert.equal(off.followups.length, 0);
  off.stop();
  // on
  // 小黑盒 installed (by her): the default table narrows to it
  const h = harness({ reply: withPlay, vm: {}, config: { maxPlaysPerDay: 1 } });
  h.ctx.get = ((orig) => (n) => n === 'dshPhone' ? { isReady: true, apps: async () => ['com.max.xiaoheihe', 'com.android.chrome'] } : orig(n))(h.ctx.get);
  h.act('s1', 'hi', 'hello');
  await h.cmd().handler({ rawInput: 'now' });
  assert.ok(h.calls[0].system.includes(playRules()), 'the rulebook is in the prompt');
  assert.match(h.calls[0].system, /playIntents：\[\{"app":"小黑盒 之一","action":"like\|comment\|follow\|collect\|post"/);
  assert.equal(h.followups.length, 1);
  assert.deepEqual(h.followups[0].m.source, PLAY_SOURCE);
  assert.match(h.followups[0].m.content[0].text, /^\[\d{2}-\d{2} \d{2}:\d{2} 想玩会儿手机\] 你刚才想：在小黑盒（com\.max\.xiaoheihe）给「那篇讲黑猴更新的帖子」点个赞。因为写得认真。/);
  assert.match(h.followups[0].m.content[0].text, /不私信陌生人、不花钱、不改资料/);
  // the play turn is her act, quiet when DOT_SILENT
  h.emit('s1', 'turn/start', { turn: 2 });
  h.emit('s1', 'user/message', { content: h.followups[0].m.content, source: PLAY_SOURCE }, { surfaceOp: 'append' });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: 'DOT_SILENT' }] } });
  h.emit('s1', 'turn/end', { turn: 2 });
  const pend = readFileSync(join(h.home, 'interlude', 'pending.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(pend.at(-1).origin, 'play');
  assert.equal(pend.at(-1).quiet, true);
  // daily cap: a second one is held
  h.act('s1', 'again', 'ok');
  await h.cmd().handler({ rawInput: 'now' });
  assert.equal(h.followups.length, 1);
  h.stop();
  // a post needs its text, is capped per day (postDailyCap), and is off once 'post' leaves playActions
  const posting = (reply, config = {}) => { const x = harness({ reply, vm: {}, config: { playApps: { 小黑盒: 'com.max.xiaoheihe' }, ...config } }); x.ctx.get = ((orig) => (n) => n === 'dshPhone' ? { isReady: true, apps: async () => ['com.max.xiaoheihe'] } : orig(n))(x.ctx.get); return x; };
  const bare = posting(withPlay.replace('"action":"like"', '"action":"post"'));
  bare.act('s1', 'hi', 'hello');
  await bare.cmd().handler({ rawInput: 'now' });
  assert.equal(bare.followups.length, 0, 'a post without text is held');
  bare.stop();
  const post = posting(withPlay.replace('"action":"like"', '"action":"post"').replace('"why":"写得认真"', '"text":"黑猴这次更新我最喜欢新的那段 boss 战","why":"写得认真"'));
  post.act('s1', 'hi', 'hello');
  await post.cmd().handler({ rawInput: 'now' });
  assert.equal(post.followups.length, 1);
  assert.match(post.followups[0].m.content[0].text, /想发点什么\] 你刚才想：在小黑盒（com\.max\.xiaoheihe）「那篇讲黑猴更新的帖子」发一条：「黑猴这次更新/);
  post.act('s1', 'again', 'ok');
  await post.cmd().handler({ rawInput: 'now' });
  assert.equal(post.followups.length, 1, 'one post a day');
  post.stop();
  const noPost = posting(withPlay.replace('"action":"like"', '"action":"post"').replace('"why":"写得认真"', '"text":"x","why":"写得认真"'), { playActions: ['like', 'comment'] });
  noPost.act('s1', 'hi', 'hello');
  await noPost.cmd().handler({ rawInput: 'now' });
  assert.equal(noPost.followups.length, 0);
  noPost.stop();
});

test('contact marker: what really went out, or her deleting it; the prompt forbids claiming sends', async () => {
  const { fillContact, buildPrompt } = await import('../src/interlude/core.js');
  const { prompt } = await import('../src/prompts.js');
  const s = '她点开 QQ。<contact/>\n发完把手机扣在桌上。';
  assert.equal(fillContact(s, { text: '睡了没<sep/>就问问' }, true).script, '她点开 QQ。「睡了没 / 就问问」\n发完把手机扣在桌上。');
  assert.equal(fillContact(s, { text: '睡了没' }, false).script, '她点开 QQ。（打了几个字，最后没发出去）\n发完把手机扣在桌上。');
  assert.equal(fillContact(s, null, false).script, '她点开 QQ。（想了想，没发）\n发完把手机扣在桌上。');
  assert.equal(fillContact('没有标记', { text: 'x' }, true).marked, false);
  assert.equal(fillContact(s, { text: '睡了没' }, 'handed').script, '她点开 QQ。（想跟他说「睡了没」，等聊天那边看合不合适再说）\n发完把手机扣在桌上。');
  const off = buildPrompt({ phase: 'advance', speak: false, now: Date.now() }).system;
  assert.ok(off.includes(prompt('interlude.round.contact-rule.off')) && !off.includes(prompt('interlude.round.contact-rule')));
  assert.match(off, /^观察到的账本：/m);
  assert.match(off, /^contact：null（宿主关闭了主动联系）。$/m);
  const on = buildPrompt({ phase: 'advance', speak: true, now: Date.now() }).system;
  assert.ok(on.includes(prompt('interlude.round.contact-rule')) && /给用户的消息只写 <contact\/> 标记/.test(on));
  assert.match(on, /^先写主角的生活；/m, 'agency outside follow-up when contact is on');
});

test('fiction follows reality: the round sees what she really did in the last half hour, and on which device', async () => {
  const h = harness({ reply: GOOD });
  h.emit('s1', 'turn/start', { turn: 1 });
  h.emit('s1', 'user/message', { content: [{ type: 'text', text: '[小黑盒] 有人回复了你' }], source: { kind: 'dsh-dot', form: 'phone-notification' } }, { surfaceOp: 'append' });
  h.emit('s1', 'tool/call', { name: `${PHONE_TOOL_PREFIX}phone_tap` });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '回了一句' }] } });
  h.emit('s1', 'turn/end', { turn: 1 });
  await h.cmd().handler({ rawInput: 'now' });
  assert.match(h.calls[0].messages[0].content[0].text, /"owner": "character",\s*"on": "phone",\s*"content": "回了一句"/);
  assert.match(h.calls[0].system, /真实操作手机、回帖时，她就是在拿着手机[\s\S]*对外（评论、QQ、给用户的消息）不要拿虚构生活当事实讲/);
  assert.match(h.calls[0].system, /虚构的人（只在 Canon 里的配角）只在叙述里出现：不给他们发真实消息，不为他们定 intents/);
  await h.cmd().handler({ rawInput: 'advance' });
  assert.match(h.calls[1].messages[0].content[0].text, /"lastHalfHour": \[\s*\{\s*"at": "[^"]+",\s*"on": "phone",\s*"did": "\[小黑盒\] 有人回复了你 → 回了一句"/);
  h.stop();
});

test('fictional people cause no real actions: an intent about someone only in the Canon is dropped and audited', async () => {
  assert.deepEqual(castNames({ storyDefaults: { supportingCast: '主角的父母，工作早出晚归；主角的一位好友，名叫希绘（Nozomi），比较外向。' } }), ['希绘']);
  assert.deepEqual(castNames({ storyDefaults: { supportingCast: '希绘、小林' } }), ['希绘', '小林']);
  assert.deepEqual(castNames({ storyDefaults: { supportingCast: '阿青：邻居\n老周：房东' } }), ['阿青', '老周']);
  assert.deepEqual(castNames({}), []);
  const reply = GOOD.replace('"intents":[', `"intents":[{"at":"${soon}","kind":"reminder","text":"看一眼希绘回没回"},{"at":"${soon}","kind":"reminder","text":"问小林借书"},`);
  const audits = [];
  const h = harness({ reply, canon: { ...CANON, supportingCast: '希绘、小林' }, memory: { knows: (n) => n === '小林' } });
  h.ctx.get = ((get) => (n) => (n === 'dshComputer' ? { audit: (e) => audits.push(e) } : get(n)))(h.ctx.get);
  await h.cmd().handler({ rawInput: 'advance' });
  const intents = JSON.parse(readFileSync(join(h.home, 'interlude', 'intents.json'), 'utf8')).map((i) => i.text);
  assert.deepEqual(intents, ['问小林借书', '看看锁的修复合进去没有'], 'someone she really knows keeps the intent');
  assert.deepEqual(audits.filter((e) => e.event === 'intent-dropped'), [{ kind: 'interlude', event: 'intent-dropped', why: 'fictional person', text: '看一眼希绘回没回' }]);
  h.stop();
});

test('with dsh-dot: plays and device looks are posted as errand tasks (the round does not wait); what comes back, and the delay, is in the next round; contact goes through say()', async () => {
  const reply = GOOD.replace('"contact":null', '"contact":{"text":"降温了<sep/>你那边冷不冷","willingness":0.9},"browserIntents":[{"mode":"visit","url":"https://www.bilibili.com/u/1","purpose":"看看她更新没"}],"playIntents":[{"app":"小黑盒","action":"like","target":"那篇耳机测评","willingness":0.8}]');
  const h = harness({ reply, vm: {}, config: { speak: true } });
  const tasks = [], said = [];
  h.ctx.get = ((get) => (n) => (n === 'dshDot' ? { task: (t) => { tasks.push(t); return 'queued'; }, say: async (text) => { said.push(text); return true; }, isErrand: () => false } : n === 'dshPhone' ? { isReady: true, apps: async () => ['com.max.xiaoheihe', 'tv.danmaku.bili'] } : get(n)))(h.ctx.get);
  h.act('s1', 'hi', 'hello');
  const r = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r.text, /\(sent\)/, 'handed over counts as a contact');
  assert.deepEqual(said, ['降温了\n你那边冷不冷']);
  assert.equal(h.sent.length, 0, 'interlude never sends herself');
  assert.equal(h.followups.length, 0, 'nor acts herself');
  assert.deepEqual(tasks.map((t) => [t.kind, t.source.form, Boolean(t.readOnly)]), [['look', 'observation', true], ['play', 'play', false]]);
  // the look is read-only while the errand runs it
  tasks[0].onStart('e1');
  assert.equal((await h.gate('e1', `${VM_TOOL_PREFIX}browser_click`)).kind, 'deny');
  const t0 = Date.now();
  tasks[0].onDone({ status: 'done', queuedAt: t0, startedAt: t0 + 20 * 60000, doneAt: t0 + 22 * 60000, busyWith: '看小黑盒《帖子A》的 3 条', report: '她 10 月 20 日发了《秋天》' });
  tasks[1].onDone({ status: 'expired', queuedAt: t0, startedAt: null, doneAt: t0 + 30 * 60000, busyWith: '在和他聊天', report: '' });
  assert.equal((await h.gate('e1', `${VM_TOOL_PREFIX}browser_click`)).via, 'next', 'released');
  assert.match(readFileSync(join(h.home, 'interlude', 'web-context.jsonl'), 'utf8'), /秋天/);
  h.act('s1', 'again', 'ok');
  await h.cmd().handler({ rawInput: 'now' });
  const payload = JSON.parse(h.calls[1].messages[0].content[0].text);
  assert.deepEqual(payload.returned.map((x) => [x.kind, x.status, x.busyWith, x.report]), [['look', 'done', '看小黑盒《帖子A》的 3 条', '她 10 月 20 日发了《秋天》'], ['play', 'expired', '在和他聊天', '']]);
  assert.equal(payload.returned[1].startedAt, null);
  assert.match(h.calls[1].system, /returned 是她早先想做[\s\S]*busyWith/);
  h.act('s1', 'third', 'ok');
  await h.cmd().handler({ rawInput: 'now' });
  assert.deepEqual(JSON.parse(h.calls[2].messages[0].content[0].text).returned, [], 'digested once');
  assert.doesNotMatch(h.calls[2].system, /returned 是她早先想做/);
  h.stop();
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

test('tries: a new thing she wants to do goes to her errands with hard limits; its cost, result and his reaction come back as yourDoings', async () => {
  const { TRY_SOURCE } = await import('../src/interlude/core.js');
  const reply = GOOD.replace('"contact":null', '"contact":null,"tries":[{"what":"在电脑上用画图给自己画个新头像","on":"computer","why":"看腻了现在这个","willingness":0.8}]');
  const h = harness({ reply, vm: {}, config: { tryDailyCap: 1 } });
  const tasks = [];
  h.ctx.get = ((get) => (n) => (n === 'dshDot' ? { task: (t) => { tasks.push(t); return 'queued'; }, isErrand: () => false } : get(n)))(h.ctx.get);
  h.act('s1', 'hi', 'hello');
  await h.cmd().handler({ rawInput: 'now' });
  assert.match(h.calls[0].system, /tries：\[\{"what"/);
  assert.match(h.calls[0].system, /没有人会一直只做那几件事/);
  assert.deepEqual(h.calls[0].tools[0].parameters.properties.tries.maxItems, 1);
  assert.deepEqual(tasks.map((t) => [t.kind, t.source]), [['try', TRY_SOURCE]]);
  assert.match(tasks[0].text, /想试试\] 你刚才想在电脑上：在电脑上用画图给自己画个新头像。因为看腻了现在这个。/);
  assert.match(tasks[0].text, /不花钱[\s\S]*不改任何账号[\s\S]*不发帖、不评论、不私信任何人，也不找他[\s\S]*要审批的等批准/);
  // while it runs, the errand cannot talk on QQ or write the ledger; other tools pass to their own gates
  tasks[0].onStart('e1');
  assert.equal((await h.gate('e1', 'qq_send')).kind, 'deny');
  assert.equal((await h.gate('e1', 'mcp__dot-qq__send_group_msg')).kind, 'deny');
  assert.equal((await h.gate('e1', `${VM_TOOL_PREFIX}browser_click`)).via, 'next');
  assert.equal((await h.gate('s1', 'qq_send')).via, 'next', 'her conversation is not a try');
  const t0 = Date.now();
  tasks[0].onDone({ status: 'done', queuedAt: t0, startedAt: t0, doneAt: t0 + 60000, busyWith: '', report: '做了：画了一只戴耳机的猫\n结果：存成 avatar.png\n找他：不用', cost: { in: 12000, cached: 3000, out: 800 } });
  assert.equal((await h.gate('e1', 'qq_send')).via, 'next', 'released when done');
  // he says something about it in her conversation: her tool notes it
  const fb = await h.tool().execute({ action: 'feedback', about: '头像', text: '猫挺可爱，换上吧' });
  assert.equal(fb.ok, true);
  // and she reflects in the next round
  h.act('s1', 'again', 'ok');
  const id = JSON.parse(readFileSync(join(h.home, 'interlude', 'doings.json'), 'utf8'))[0].id;
  await h.cmd().handler({ rawInput: 'now' });
  const payload = JSON.parse(h.calls[1].messages[0].content[0].text);
  assert.equal(payload.returned[0].tokens, 15800);
  const mine = payload.yourDoings.recent.find((x) => x.id === id);
  assert.equal(mine.tokens, 15800);
  assert.deepEqual(mine.feedback, ['他：猫挺可爱，换上吧']);
  assert.match(h.calls[1].system, /yourDoings 是她自己的账/);
  assert.match(h.calls[1].system, /tries：\[\]（宿主关闭了/, 'daily cap reached: tries off');
  assert.equal(tasks.length, 1);
  h.stop();
});

test('reflect and /interlude feedback: her afterthought and his word land on the doing; /interlude doings lists them', async () => {
  const reply = (o) => (o.messages[0].content[0].text.includes('"yourDoings"') && JSON.parse(o.messages[0].content[0].text).yourDoings.recent.length
    ? GOOD.replace('"contact":null', `"contact":null,"reflect":[{"id":"${JSON.parse(o.messages[0].content[0].text).yourDoings.recent[0].id}","text":"花了不少，下次直接用手机"}]`)
    : GOOD.replace('"contact":null', '"contact":null,"browserIntents":[{"mode":"search","query":"广州 降温","purpose":"看天气"}]'));
  const web = { search: async () => ({ content: '这周广州降温到 12 度，周四有雨，出门记得带伞，早晚温差大，注意添衣。'.repeat(8), sources: [{ title: '广州天气', url: 'https://x', snippet: '降温' }] }) };
  const h = harness({ reply, web });
  h.act('s1', 'hi', 'hello');
  await h.cmd().handler({ rawInput: 'now' });
  let r = await h.cmd().handler({ rawInput: 'feedback 查天气挺贴心' });
  assert.match(r.text, /noted on #\S+: 看天气/);
  h.act('s1', 'again', 'ok');
  await h.cmd().handler({ rawInput: 'now' });
  r = await h.cmd().handler({ rawInput: 'doings' });
  assert.match(r.text, /look 看天气 → done：广州天气 ｜他：查天气挺贴心 ｜我：花了不少，下次直接用手机/);
  assert.match((await h.cmd().handler({ rawInput: 'feedback #nope 嗯' })).text, /no such doing #nope/);
  h.stop();
});

test('tries and plays: a task dot merges into one already waiting is not counted twice and leaves no stuck doing; no willingness = not wanted', async () => {
  const reply = GOOD.replace('"contact":null', '"contact":null,"tries":[{"what":"试试记账 App","on":"either","willingness":0.9}],"playIntents":[{"app":"小黑盒","action":"like","target":"耳机测评","willingness":0.9}]');
  const h = harness({ reply, vm: {} });
  const tasks = [];
  h.ctx.get = ((get) => (n) => (n === 'dshDot' ? { task: (t) => { const same = tasks.some((x) => x.key === t.key); if (!same) tasks.push(t); return same ? 'refreshed' : 'queued'; }, isErrand: (id) => id === 'e1', session: () => 's1' } : n === 'dshPhone' ? { isReady: true, apps: async () => ['com.max.xiaoheihe'] } : get(n)))(h.ctx.get);
  for (const m of ['a', 'b']) { h.act('s1', m, 'ok'); await h.cmd().handler({ rawInput: 'now' }); }
  assert.deepEqual(tasks.map((t) => t.kind).sort(), ['play', 'try']);
  const list = JSON.parse(readFileSync(join(h.home, 'interlude', 'doings.json'), 'utf8'));
  assert.deepEqual(list.map((d) => d.kind).sort(), ['play', 'try'], 'one doing each');
  assert.match((await h.cmd().handler({ rawInput: '' })).text, /today 1, posts 0\/1\) · tries: on \(today 1\/3\)/);
  // the ledger tool: in her conversation with him only
  assert.equal((await h.gate('e1', 'doings')).kind, 'deny');
  assert.equal((await h.gate('qq-friend', 'doings')).kind, 'deny');
  assert.equal((await h.gate('s1', 'doings')).via, 'next');
  assert.match((await h.cmd().handler({ rawInput: 'feedback #abc' })).text, /what should she hear/);
  h.stop();
  assert.equal(parseReply('{"script":"x","tries":[{"what":"y"}]}').tries[0].willingness, 0);
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

test('growth: the weekly review reads her week (never writes memory), keeps her portrait, and the portrait follows the Canon in her prompt and in the round', async () => {
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
  h.act('s1', 'hi', 'hello');
  await h.cmd().handler({ rawInput: 'now' });
  assert.match(h.calls.at(-1).system, /迷上了画画/, 'the round sees her portrait too');
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
