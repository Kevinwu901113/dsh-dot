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

function harness({ reply, identity = '我是 dot，用户的常驻助手。', config = {}, targets = [{ targetId: 'me' }] } = {}) {
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'AGENTS.md'), identity);
  const calls = [], sent = [], listeners = [], prompts = [], effects = [];
  let cmd;
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); },
    effect(fn) { effects.push(fn()); },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (n) => ({
      systemPrompt: { context: (c) => prompts.push(c) },
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
  try { apply(ctx, { home, idleMinutes: 0, activeHours: '00:00-24:00', ...config }); } finally { globalThis.setInterval = realSetInterval; }
  const emit = (sid, type, data, extra = {}) => listeners.forEach((fn) => fn({ id: sid, header: { cwd: home } }, { type, data, ...extra }));
  const act = (sid, user, assistant, origin = 'user') => {
    emit(sid, 'turn/start', { turn: 1 });
    emit(sid, 'user/message', { content: [{ type: 'text', text: user }], source: { kind: origin } }, { surfaceOp: 'append' });
    emit(sid, 'assistant/message', { message: { content: [{ type: 'text', text: assistant }] } });
    emit(sid, 'turn/end', { turn: 1 });
  };
  const ctxText = (sid = 's1', cwd = home) => prompts.find((p) => p.name === 'interlude').text({ agent: { session: { id: sid, header: { cwd } } } });
  return { home, calls, sent, emit, act, ctxText, tick: () => ticks.forEach((f) => f()), cmd: () => cmd, stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
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
  assert.match(h.calls[0].system, /Canon[\s\S]*我是 dot/);
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
  const withContact = GOOD.replace('"contact":null', '"contact":{"text":"那个锁的问题我记下了，回头跟你说。","willingness":0.9,"reason":"刚整理完便签"}');
  const quiet = harness({ reply: withContact });
  quiet.act('s1', 'hi', 'hello');
  await quiet.cmd().handler({ rawInput: 'now' });
  assert.equal(quiet.sent.length, 0);
  quiet.stop();

  const loud = harness({ reply: withContact, config: { speak: true, maxContactsPerDay: 1 } });
  loud.act('s1', 'hi', 'hello');
  const r = await loud.cmd().handler({ rawInput: 'now' });
  assert.deepEqual(loud.sent.map((s) => s.text), ['那个锁的问题我记下了，回头跟你说。']);
  assert.match(r.text, /\(sent\)/);
  loud.act('s1', 'again', 'ok');
  const r2 = await loud.cmd().handler({ rawInput: 'now' });
  assert.match(r2.text, /\(held\)/, 'daily cap');
  assert.equal(loud.sent.length, 1);
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
