import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, parseReply, renderContext, readScript, buildPrompt, inHours, describeNow } from '../src/core.js';

function fakeStream(text) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const part of text.match(/[\s\S]{1,7}/g) ?? []) yield { type: 'text-delta', index: 0, text: part };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

const CANON = { characterName: 'dot', characterProfile: '用户的常驻助手，话少，不打句号。' };

function harness({ reply, canon = CANON, config = {}, targets = [{ targetId: 'me' }] } = {}) {
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  mkdirSync(home, { recursive: true });
  const calls = [], sent = [], listeners = [], prompts = [], sections = [], assemblers = [], effects = [];
  let cmd;
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); if (name === 'system-prompt/assemble') assemblers.push(fn); return () => {}; },
    effect(fn) { effects.push(fn()); },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (n) => ({
      systemPrompt: { context: (c) => prompts.push(c), section: (c) => { sections.push(c); return () => {}; }, getSectionOrder: () => 0 },
      commands: { register: (c) => { cmd = c; return () => {}; } },
      dshIm: { listBots: async () => [{ botId: 'b1' }], listTargets: async () => targets, send: async (b, t, text) => { sent.push({ b, t, text }); return { sent: true }; } },
      dshComputer: { audit() {} },
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
  return { home, calls, sent, emit, emitAs, act, ctxText, canonText, assemble, tick: () => ticks.forEach((f) => f()), cmd: () => cmd, stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}

const soon = new Date(Date.now() + 3600000).toISOString();
const GOOD = `\`\`\`json
{"script":"他让我看了两次提交，第二次没变化，我按静默规则没出声。之后我把 dsh-computer 那个锁的问题记在了便签上。","state":{"mood":"平静","now":"整理便签","next":"晚点看看锁的修复有没有合进去","threads":["盯 dsh-dot 的提交"]},"overlay":[],"intents":[{"at":"${soon}","kind":"reminder","text":"看看锁的修复合进去没有","willingness":0.7}],"contact":null}
\`\`\``;

test('parseReply normalises intents, overlay, contact; rejects past intents and garbage', () => {
  const p = parseReply(GOOD);
  assert.equal(p.state.now, '整理便签');
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
  assert.equal(renderContext({ state: null, overlay: '', entries: [], intents: [], cursor: 0 }), '');
  const t = renderContext({ state: { mood: 'ok', now: 'x', next: 'y', threads: ['a'] }, overlay: '- 2026-10-1 喜欢上早起', entries: ['e1'], intents: [{ at: soon, text: '提醒他' }], cursor: Date.now() - 90 * 60000, restarted: true });
  assert.match(t, /上次幕间：2 小时前；期间 dsh 重启过/);
  assert.match(t, /已形成的变化：- 2026-10-1 喜欢上早起/);
  assert.match(t, /近期的打算：提醒他/);
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
  assert.match(h.calls[0].system, /Canon[\s\S]*# 你是 dot[\s\S]*不打句号/);
  assert.match(h.canonText(), /^# 你是 dot/, 'the Canon is a prompt section for home sessions');
  assert.equal(h.canonText('x', '/elsewhere'), '', 'and absent elsewhere');
  assert.match(h.calls[0].system, /对话后续/);
  assert.match(h.calls[0].system, /"contact": null/);
  const user = h.calls[0].messages[0].content[0].text;
  assert.match(user, /定时任务\][\s\S]*DOT_SILENT/);
  const script = readFileSync(join(h.home, 'interlude', 'script.md'), 'utf8');
  assert.match(script, /^## .* · follow-up\n他让我看了两次提交/m);
  const state = JSON.parse(readFileSync(join(h.home, 'interlude', 'state.json'), 'utf8'));
  assert.equal(state.threads[0], '盯 dsh-dot 的提交');
  const intents = JSON.parse(readFileSync(join(h.home, 'interlude', 'intents.json'), 'utf8'));
  assert.equal(intents.length, 1);
  assert.equal(readFileSync(join(h.home, 'interlude', 'pending.jsonl'), 'utf8'), '');
  const text = h.ctxText();
  assert.match(text, /状态：平静/);
  assert.match(text, /刚才在做：整理便签/);
  assert.match(text, /近期的打算：看看锁的修复合进去没有/);
  assert.equal(h.ctxText('elsewhere', '/tmp/x'), '');
  const r2 = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r2.text, /not run: nothing happened/);
  h.stop();
});

test('advance round runs without any conversation and says so to the model', async () => {
  const h = harness({ reply: GOOD.replace('"overlay":[]', '"overlay":["开始习惯在下午整理便签"]') });
  const r = await h.cmd().handler({ rawInput: 'advance' });
  assert.match(r.text, /ran:/);
  assert.match(h.calls[0].system, /生活推进[\s\S]*不要编造用户说了什么/);
  assert.match(h.calls[0].messages[0].content[0].text, /这段时间没有对话/);
  assert.match(readFileSync(join(h.home, 'interlude', 'overlay.md'), 'utf8'), /开始习惯在下午整理便签/);
  h.stop();
});

test('a due intent is resolved by an intent round and removed', async () => {
  const past = new Date(Date.now() - 60000).toISOString();
  const seeded = harness({ reply: GOOD });
  writeFileSync(join(seeded.home, 'interlude', 'intents.json'), JSON.stringify([{ id: 'i1', at: past, kind: 'reminder', text: '提醒他喝水', willingness: 0.8 }]));
  seeded.stop();
  const h = harness({ reply: GOOD.replace(/"intents":\[[^\]]*\]/, '"intents":[]'), config: { home: seeded.home } });
  h.tick();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].system, /到期的意图[\s\S]*提醒他喝水/);
  assert.deepEqual(JSON.parse(readFileSync(join(seeded.home, 'interlude', 'intents.json'), 'utf8')), []);
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
  assert.match(h.calls[0].system, /对话后续/);
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
  assert.match(buildPrompt({ phase: 'intent', identity: '', state: null, overlay: '', script: '', digest: '', cursor: now - 3600000, now, intent: { text: '提醒他喝水', kind: 'reminder', at: new Date(now).toISOString() }, speak: true }).system, /到期的意图[\s\S]*提醒他喝水[\s\S]*"contact": \{/);
  assert.match(buildPrompt({ phase: 'advance', identity: '', state: null, overlay: '', script: '', digest: '', cursor: 0, now, speak: false }).system, /到 .* 为止的这段时间/);
});

test('renderCanon and fetchPreset: HDSI storyDefaults become the Canon; share codes resolve via the hub API', async () => {
  const { renderCanon, fetchPreset } = await import('../src/core.js');
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
  const seed = JSON.stringify({ script: '[10-21 23:40] 她把练习册翻过去一页，台灯还亮着\n[10-22 07:50] 闹钟响了三遍才起来，早饭是楼下的包子\n[10-22 12:10] 希绘发来奶茶店的链接，她回了个问号', state: { mood: '困', now: '吃午饭', next: '下午去文具店', threads: ['奶茶店'] }, overlay: [], intents: [], contact: null });
  const h = harness({ reply: seed });
  const r = await h.cmd().handler({ rawInput: 'seed' });
  assert.match(r.text, /ran:/);
  assert.match(h.calls[0].system, /「开场」/);
  const script = readFileSync(join(h.home, 'interlude', 'script.md'), 'utf8');
  assert.equal((script.match(/^## /gm) || []).length, 3);
  assert.match(script, /10-21 23:40 .* seed\n她把练习册翻过去一页/);
  assert.match(script, /10-22 12:10 .* seed\n希绘发来奶茶店的链接/);
  const r2 = await h.cmd().handler({ rawInput: 'seed' });
  assert.match(r2.text, /already has entries/);
  assert.match(h.ctxText(), /奶茶店/);
  h.stop();
});
