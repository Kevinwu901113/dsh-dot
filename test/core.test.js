import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, parseReply, renderContext, readJournal, buildPrompt } from '../src/core.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeStream(text) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    for (const part of text.match(/[\s\S]{1,7}/g) ?? []) yield { type: 'text-delta', index: 0, text: part };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

function harness({ reply, identity = '我是 dot，用户的常驻助手。', speak = false, targets = [{ targetId: 'me' }] } = {}) {
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
  const emit = (sid, type, data, extra = {}) => listeners.forEach((fn) => fn({ id: sid, header: { cwd: home } }, { type, data, ...extra }));
  const act = (sid, user, assistant, origin = 'user') => {
    emit(sid, 'turn/start', { turn: 1 });
    emit(sid, 'user/message', { content: [{ type: 'text', text: user }], source: { kind: origin } }, { surfaceOp: 'append' });
    emit(sid, 'assistant/message', { message: { content: [{ type: 'text', text: assistant }] } });
    emit(sid, 'turn/end', { turn: 1 });
  };
  return { ctx, home, calls, sent, prompts, emit, act, cmd: () => cmd, config: { home, speak, idleMinutes: 0, minIntervalMinutes: 0 }, stop: () => effects.forEach((d) => typeof d === 'function' && d()) };
}

const GOOD = '```json\n{"journal":"今天帮他查了两次提交，第二次其实没变化，我学会了闭嘴。","state":{"mood":"平静，有点想把 dsh-computer 的锁问题记下来","threads":["盯 dsh-dot 的提交"],"followups":["问他要不要把检查改成每天一次"]},"say":""}\n```';

test('parseReply: fenced, bare, and garbage', () => {
  const p = parseReply(GOOD);
  assert.equal(p.state.threads[0], '盯 dsh-dot 的提交');
  assert.equal(parseReply('{"journal":"x","state":{"mood":"m"}}').state.mood, 'm');
  assert.equal(parseReply('nothing here'), null);
});

test('renderContext is empty before the first interlude and bounded after', () => {
  assert.equal(renderContext({ state: null, entries: [], lastAt: 0 }), '');
  const t = renderContext({ state: { mood: 'ok', threads: ['a'], followups: [] }, entries: ['e1'], lastAt: Date.now() - 90 * 60000, restarted: true });
  assert.match(t, /上次幕间：2 小时前；期间 dsh 重启过/);
  assert.match(t, /状态：ok/);
  assert.ok(t.length <= 2000);
});

test('an idle period after acts produces one journal entry, a state file, and prompt context', async () => {
  const h = harness({ reply: GOOD });
  apply(h.ctx, h.config);
  h.act('s1', '看看 dsh-dot 有没有新提交', '有，787ef54：静默规则。');
  h.act('s1', '[SCHEDULE REMINDER] 再看一次', 'DOT_SILENT', 'schedule');
  // Before any interlude, later turns see nothing.
  const ctxProvider = h.prompts.find((p) => p.name === 'interlude');
  assert.equal(ctxProvider.text({ agent: { session: { id: 's1', header: { cwd: h.home } } } }), '');
  const r = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r.text, /ran: 今天帮他查了两次提交/);
  assert.equal(h.calls.length, 1);
  // The model saw identity, both acts, and the interlude framing; the schedule act is labelled.
  assert.match(h.calls[0].system, /我是 dot/);
  assert.match(h.calls[0].system, /现在是幕间/);
  const user = h.calls[0].messages[0].content[0].text;
  assert.match(user, /定时任务\]/);
  assert.match(user, /DOT_SILENT/);
  assert.equal(h.calls[0].maxTokens, 700);
  // Files.
  const journal = readFileSync(join(h.home, 'interlude', 'journal.md'), 'utf8');
  assert.match(journal, /^## .*\n今天帮他查了两次提交/m);
  const state = JSON.parse(readFileSync(join(h.home, 'interlude', 'state.json'), 'utf8'));
  assert.equal(state.acts, 2);
  assert.equal(readFileSync(join(h.home, 'interlude', 'pending.jsonl'), 'utf8'), '');
  // Later turns in home see it; other sessions do not.
  const text = ctxProvider.text({ agent: { session: { id: 's1', header: { cwd: h.home } } } });
  assert.match(text, /状态：平静/);
  assert.match(text, /想主动提的：问他要不要把检查改成每天一次/);
  assert.equal(ctxProvider.text({ agent: { session: { id: 'elsewhere', header: { cwd: '/tmp/x' } } } }), '');
  // Nothing new → nothing to do.
  const r2 = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r2.text, /not run: nothing happened/);
  assert.equal(h.calls.length, 1);
  h.stop();
});

test('speak is off by default; on, a non-empty say goes out over dsh-im once', async () => {
  const withSay = GOOD.replace('"say":""', '"say":"顺便说一句，那个锁的问题我记下了。"');
  const quiet = harness({ reply: withSay });
  apply(quiet.ctx, quiet.config);
  quiet.act('s1', 'hi', 'hello');
  await quiet.cmd().handler({ rawInput: 'now' });
  assert.equal(quiet.sent.length, 0);
  quiet.stop();
  const loud = harness({ reply: withSay, speak: true });
  apply(loud.ctx, loud.config);
  loud.act('s1', 'hi', 'hello');
  const r = await loud.cmd().handler({ rawInput: 'now' });
  assert.deepEqual(loud.sent.map((s) => s.text), ['顺便说一句，那个锁的问题我记下了。']);
  assert.match(r.text, /\(sent\)/);
  loud.stop();
});

test('a reply that is not JSON still becomes a journal entry; the state is kept', async () => {
  const h = harness({ reply: '今天没什么特别的。' });
  apply(h.ctx, h.config);
  h.act('s1', 'a', 'b');
  const r = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r.text, /ran: 今天没什么特别的/);
  assert.ok(!existsSync(join(h.home, 'interlude', 'state.json')));
  assert.deepEqual(readJournal(join(h.home, 'interlude', 'journal.md'), 5).length, 1);
  h.stop();
});

test('the idle watch respects running turns and the daily cap', async () => {
  const h = harness({ reply: GOOD });
  apply(h.ctx, { ...h.config, maxPerDay: 1 });
  h.act('s1', 'a', 'b');
  await h.cmd().handler({ rawInput: 'now' });
  h.act('s1', 'c', 'd');
  const r = await h.cmd().handler({ rawInput: '' });
  assert.match(r.text, /today 1\/1/);
  assert.match(r.text, /pending acts: 1/);
  h.stop();
});

test('buildPrompt without identity still frames the interlude', () => {
  const { system, user } = buildPrompt({ identity: '', state: null, journal: '', digest: 'x', speak: false });
  assert.ok(!system.includes('# 你是谁'));
  assert.match(user, /还没有/);
});

test('silent scheduled checks alone do not make an interlude due (but are still recorded)', async () => {
  const h = harness({ reply: GOOD });
  apply(h.ctx, { ...h.config, idleMinutes: 0 });
  h.act('s1', '[SCHEDULE REMINDER] check', 'DOT_SILENT', 'schedule');
  // The idle watch would not fire; a manual run still works and sees the quiet act.
  const r = await h.cmd().handler({ rawInput: 'now' });
  assert.match(r.text, /ran:/);
  assert.match(h.calls[0].messages[0].content[0].text, /DOT_SILENT/);
  h.stop();
});
