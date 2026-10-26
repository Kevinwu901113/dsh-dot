import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bankOp, emptyMemory, touchPerson, updatePerson, approvePending, observeFragment, ageFragments, renderStanding, renderPerson, rejectReason, jaccard, search,
  resolvePerson, setOwner, syncFriends, proposeMerge, approveMerge, normalizeMemory, findPerson,
} from '../src/memory/store.js';
import { apply, applyExtraction, parseLooseJson, renderHandoff, transcriptLine, takeChunk } from '../src/memory/memory.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('banks: Hermes add / replace / remove under a character budget', () => {
  let r = bankOp([], { action: 'add', content: '他在广州上班，做后端' }, 40);
  assert.ok(r.ok); let bank = r.entries;
  assert.equal(bankOp(bank, { action: 'add', content: '他在广州上班，做后端' }, 40).note, 'already there');
  assert.match(bankOp(bank, { action: 'add', content: '一'.repeat(40) }, 40).error, /over the limit/);
  r = bankOp(bank, { action: 'replace', oldText: '广州', content: '他在深圳上班，做后端' }, 40); assert.ok(r.ok); bank = r.entries;
  assert.deepEqual(bank, ['他在深圳上班，做后端']);
  assert.match(bankOp(bank, { action: 'remove', oldText: '北京' }, 40).error, /no entry/);
  assert.deepEqual(bankOp(bank, { action: 'remove', oldText: '深圳' }, 40).entries, []);
  assert.match(bankOp([], { action: 'add', content: '我会记住这个' }, 40).error, /meta/);
  assert.equal(rejectReason('嗯'), 'too-short');
});

test('people: counts by code, facts about others wait until said again or approved; seen = impression only', () => {
  const m = emptyMemory();
  const a = touchPerson(m, { handles: ['qq:42'], platform: 'qq', name: '阿满', tier: 'talked', kind: 'dm' });
  touchPerson(m, { handles: ['qq:42'], platform: 'qq', name: '满满', tier: 'talked', kind: 'dm' });
  const s = touchPerson(m, { handles: ['xiaoheihe:name:暮看云'], platform: 'xiaoheihe', name: '暮看云', tier: 'seen', kind: 'like' });
  assert.equal(a.counts.dm, 2);
  assert.deepEqual(a.names, ['满满', '阿满']);
  let r = updatePerson(m, { id: a.id, impression: '话少，但回得很认真', facts: ['他养了一只叫团子的猫'] });
  assert.deepEqual(r, { applied: 1, pending: 1 });
  assert.deepEqual(a.facts, []);
  r = updatePerson(m, { name: '阿满', facts: ['他养了只猫，叫团子'] });
  assert.equal(r.applied, 1, 'said a second time: kept');
  updatePerson(m, { id: a.id, facts: ['他下个月搬去杭州'] });
  assert.ok(approvePending(m, m.pending[0].id).ok);
  assert.deepEqual(a.facts, ['他养了只猫，叫团子', '他下个月搬去杭州']);
  updatePerson(m, { id: s.id, impression: '写长帖分析 DSH 插件', facts: ['住在杭州'] });
  assert.deepEqual(s.facts, [], 'seen: no facts');
  assert.match(renderPerson(s), /只在帖子里打过交道；点赞 1 次/);
  assert.match(renderPerson(a), /满满（qq:42，也叫 阿满）：聊过；私聊 2 次[\s\S]*印象：话少[\s\S]*- 他下个月搬去杭州/);
});
test('fragments: refs grow when said again; aging; standing render is byte-stable', () => {
  const m = emptyMemory();
  assert.equal(observeFragment(m, { text: '他说下周六要搬家，搬去光谷那边', tag: 2, kind: 'plan', gen: 1 }).action, 'new');
  assert.equal(observeFragment(m, { text: '他说下周六要搬家，搬去光谷那边', tag: 1, gen: 1 }).action, 'dup');
  assert.equal(m.fragments[0].refs, 2); assert.equal(m.fragments[0].importance, 3);
  observeFragment(m, { text: '今天聊了天气，很一般没什么', tag: 0, gen: 1 });
  assert.equal(observeFragment(m, { text: '坏 tag', tag: 7, gen: 1 }).action, 'dropped');
  const a = renderStanding(m), b = renderStanding(m);
  assert.equal(a, b);
  assert.match(a, /最近的事[\s\S]*下周六要搬家[\s\S]*聊了天气/);
  ageFragments(m, 15, 5);
  assert.equal(m.fragments.length, 1, 'the unimportant one-off is gone after enough generations');
  assert.ok(jaccard('参考文献还没弄', '还差参考文献') > 0);
  assert.equal(search([{ text: '他下周六搬家' }, { text: '猫叫团子' }], '搬家')[0].text, '他下周六搬家');
});

test('extraction: banks, people (new seen ones from apps), fragments; loose JSON', () => {
  const m = emptyMemory();
  const a = touchPerson(m, { handles: ['qq:42'], platform: 'qq', name: '阿满', tier: 'talked' });
  const out = parseLooseJson('好的：```json\n' + JSON.stringify({
    owner: [{ action: 'add', content: '他讨厌被叫全名' }],
    self: [{ action: 'add', content: '学会了在小黑盒里看攻略帖' }],
    people: [{ id: 'u0001', impression: '爱发猫图' }, { platform: 'xiaoheihe', name: '暮看云', tier: 'seen', impression: '写长帖的' }, { name: '不认识的人' }],
    fragments: [{ text: '10-25 下午他说晚上要加班到十点', kind: 'event', tag: 1 }],
  }) + '\n```');
  const r = applyExtraction(m, out);
  assert.deepEqual([r.owner, r.self, r.fragments], [1, 1, 1]);
  assert.deepEqual(m.owner, ['他讨厌被叫全名']);
  assert.equal(a.impression, '爱发猫图');
  assert.equal(findPerson(m.people, 'xiaoheihe:name:暮看云').tier, 'seen');
  assert.equal(Object.keys(m.people).length, 2, 'a name with no platform and no card is not invented');
  assert.match(renderHandoff({ now: '在回他消息', promises: ['晚上帮他查天气'] }, [{ at: 0, who: 'owner', text: '在吗' }, { at: 0, who: 'her', to: 'owner', text: '在' }], 2), /第 2 段[\s\S]*你此刻：在回他消息[\s\S]*晚上帮他查天气[\s\S]*他：在吗[\s\S]*我：在/);
  assert.match(transcriptLine({ at: 0, who: 'her', to: 'user:9', text: 'hi' }), /我（发给 user:9）：hi/);
});

function harness({ llmReply = '{}' } = {}) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const listeners = [], contexts = [], tools = {}, effects = [], injected = [], archived = [], audit = [];
  let session = 's1'; let tokens = 1000; let frozen = 0, released = 0;
  const agents = new Map();
  const agentFor = (id) => agents.get(id) ?? agents.set(id, { session: { id }, inject: (m) => injected.push({ id, m }) }).get(id);
  const services = {
    dshDot: { session: () => session, setSession: (id) => { session = id; }, isErrand: (id) => id === 'errand', isIm: () => false, freeze: () => { frozen++; return () => { released++; }; } },
    sessionController: { create: async () => ({ sessionId: 's2' }), rename: async () => ({}), resolveAgent: async (id) => ({ agent: agentFor(id) }) },
    workspaceRegistry: { archiveSession: async (id) => { archived.push(id); } },
    agents: { get: (id) => agentFor(id) },
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
    dshQq: { owner: '7' },
    dshComputer: { audit: (e) => audit.push(e) },
  };
  const calls = [];
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); },
    effect(fn) { effects.push(fn()); },
    get: (n) => services[n],
    provide(n, v) { services[n] = v; },
    inject(deps, fn) { fn({ systemPrompt: { context: (c) => contexts.push(c) }, tools: { register: (t) => { tools[t.name] = t; return () => {}; } }, effect: (f) => f() }); },
    llm: { stream: (opts) => { calls.push(opts); return (async function* () { yield { type: 'text-delta', text: llmReply }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'deepseek-v4-flash' }) },
  };
  const emit = (id, type, data, extra = {}) => listeners.forEach((fn) => fn({ id, header: { cwd: home } }, { type, data, ...extra }));
  return { ctx, home, services, contexts, tools, injected, archived, audit, calls, emit, effects, get session() { return session; }, set tokens(n) { tokens = n; }, get frozen() { return [frozen, released]; } };
}
const msg = (text) => ({ message: { content: [{ type: 'text', text }] } });

test('transcript: what he said, what she really sent over QQ, phone and errand notes; the errand is not her conversation', async () => {
  const h = harness();
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000 });
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'user/message', { source: { kind: 'user', rpcId: 'qq-1' }, content: [{ type: 'text', text: '下周六我搬家' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'tool/call', { name: 'qq_send', arguments: JSON.stringify({ to: 'owner', text: '搬去哪<sep/>要帮忙吗' }) });
  h.emit('s1', 'assistant/message', msg('回了'));
  h.emit('s1', 'turn/end', {});
  h.emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'errand-note' }, content: [{ type: 'text', text: '[刚才拿起手机看了一眼] 小黑盒有人回复我\n（这是你自己刚做过的事…）' }] }, { surfaceOp: 'append' });
  h.emit('errand', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '不该记' }] }, { surfaceOp: 'append' });
  await wait(10);
  const lines = readFileSync(join(h.home, 'memory', 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.who, l.text]), [['owner', '下周六我搬家'], ['her', '搬去哪 / 要帮忙吗'], ['note', '[刚才拿起手机看了一眼] 小黑盒有人回复我']]);
  const mem = h.services.dotMemory;
  assert.equal(mem.status().people, 1, 'sending to the owner touched his card');
  // standing context: empty until there is something
  assert.equal(h.contexts[0].text({ agent: { session: { id: 's1', header: { cwd: h.home } } } }), '');
  const found = await h.tools.recall.execute({ query: '搬家' });
  assert.match(found.found, /原话：[\s\S]*他：下周六我搬家/);
});

test('consolidation and handoff: memory written, old session archived before the new one, handoff note injected, deliveries frozen', async () => {
  const reply = JSON.stringify({ owner: [{ action: 'add', content: '他下周六搬家，搬去光谷' }], fragments: [{ text: '他问她要不要帮忙搬家前先说好时间', kind: 'plan', tag: 2 }], handoff: { now: '刚聊完搬家', promises: ['周五提醒他打包'] } });
  const h = harness({ llmReply: reply });
  apply(h.ctx, { home: h.home, handoffTokens: 100000, minTokensBetweenHandoffs: 1000, consolidateEveryLines: 1000 });
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '下周六我搬家' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'assistant/message', msg('搬去哪'));
  h.tokens = 150000;
  h.emit('s1', 'turn/end', {});
  await wait(50);
  assert.deepEqual(h.archived, ['s1']);
  assert.equal(h.session, 's2');
  assert.deepEqual(h.frozen, [1, 1]);
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].id, 's2');
  assert.match(h.injected[0].m.content[0].text, /第 2 段[\s\S]*刚聊完搬家[\s\S]*周五提醒他打包[\s\S]*他：下周六我搬家[\s\S]*我：搬去哪/);
  assert.match(h.calls[0].messages[0].content[0].text, /=== 这段时间的记录 ===[\s\S]*他：下周六我搬家[\s\S]*这次要写 handoff/);
  const ctxText = h.contexts[0].text({ agent: { session: { id: 's2', header: { cwd: h.home } } } });
  assert.match(ctxText, /关于他\n- 他下周六搬家，搬去光谷[\s\S]*最近的事[\s\S]*帮忙搬家/);
  assert.ok(existsSync(join(h.home, 'memory', 'memory.md')));
  assert.match(await h.services.dotMemory.command('memory'), /第 2 段/);
});

test('people cards for the people who wake her; owner excluded', () => {
  const h = harness();
  apply(h.ctx, { home: h.home });
  const mem = h.services.dotMemory;
  mem.touch({ handles: ['qq:42'], platform: 'qq', name: '阿满', tier: 'talked', kind: 'group' });
  mem.setOwner('qq:7', '宽');
  assert.match(mem.cardsFor([{ handles: ['qq:42'] }, { handles: ['qq:42'] }, { handles: ['qq:7'] }]), /^阿满（qq:42）：聊过；群里说话 1 次/);
  assert.ok(!mem.cardsFor([{ handles: ['qq:7'] }]));
});

test('one registry across apps: a phone name and a QQ number become one person through the friend list; the owner is recognised on any channel', () => {
  const m = emptyMemory();
  setOwner(m, 'qq:919', '');
  // her phone shows "宽" before anything ties it to the number: a second card
  const phoneKuan = touchPerson(m, { handles: ['qq:name:宽'], platform: 'qq', name: '宽', kind: 'dm' });
  assert.notEqual(phoneKuan.tier, 'owner');
  const amanQq = touchPerson(m, { handles: ['qq:42'], platform: 'qq', name: '阿满', kind: 'group' });
  touchPerson(m, { handles: ['xiaoheihe:name:阿满'], platform: 'xiaoheihe', name: '阿满', tier: 'seen', kind: 'like' });
  // the friend list: remark 宽 is 919; two friends share the remark 小王 (no name handle for them)
  const r = syncFriends(m, 'qq', [{ uid: '919', nickname: 'awwaw', remark: '宽' }, { uid: '42', nickname: '阿满', remark: '' }, { uid: '1', nickname: 'a', remark: '小王' }, { uid: '2', nickname: 'b', remark: '小王' }]);
  assert.equal(r.merged, 1);
  const owner = resolvePerson(m.people, { handles: ['qq:name:宽'] });
  assert.equal(owner.tier, 'owner', 'the phone name now resolves to the owner');
  assert.deepEqual(owner.handles.sort(), ['qq:919', 'qq:name:awwaw', 'qq:name:宽'].sort());
  assert.equal(owner.counts.dm, 1, 'the phone card\'s counts moved over');
  assert.equal(resolvePerson(m.people, { platform: 'qq', name: '小王' }), null, 'ambiguous name: nobody');
  assert.equal(resolvePerson(m.people, { handles: ['qq:name:阿满'] }), amanQq);
  // the same name on another app is a different card until something says otherwise
  const hb = resolvePerson(m.people, { handles: ['xiaoheihe:name:阿满'] });
  assert.notEqual(hb, amanQq);
  // the model notices: not the owner → merged at once
  assert.ok(proposeMerge(m, amanQq.id, hb.id, { why: '他在 QQ 里说小黑盒那个号是他' }).ok);
  assert.deepEqual(resolvePerson(m.people, { handles: ['xiaoheihe:name:阿满'] }).id, amanQq.id);
  // a merge into the owner waits for approval
  const stranger = touchPerson(m, { handles: ['wechat:name:K'], platform: 'wechat', name: 'K' });
  const pend = proposeMerge(m, owner.id, stranger.id, { why: '猜的' });
  assert.match(pend.pending, /^m\d+$/);
  assert.notEqual(resolvePerson(m.people, { handles: ['wechat:name:K'] }).tier, 'owner');
  assert.ok(approveMerge(m, pend.pending).ok);
  assert.equal(resolvePerson(m.people, { handles: ['wechat:name:K'] }).tier, 'owner');
});

test('old memory (people keyed by handle) migrates to the registry', () => {
  const m = normalizeMemory({ people: { 'qq:name:宽': { id: 'qq:name:宽', names: ['宽'], tier: 'talked', counts: { dm: 1 }, facts: [], impression: '' } }, pending: [{ id: 'p1', person: 'qq:name:宽', text: 'x' }] });
  const p = Object.values(m.people)[0];
  assert.match(p.id, /^u\d{4}$/);
  assert.deepEqual(p.handles, ['qq:name:宽']);
  assert.equal(m.pending[0].person, p.id);
});
test('backfill: the conversation from before memory was installed is read once from the session log', async () => {
  const { transcriptFromEvents } = await import('../src/memory/memory.js');
  const events = [
    { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我下周搬家' }] } },
    { type: 'tool/call', time: 2, data: { name: 'qq_send', arguments: JSON.stringify({ to: 'owner', text: '搬哪' }) } },
    { type: 'assistant/message', time: 3, data: { message: { content: [{ type: 'text', text: 'DOT_SILENT' }] } } },
    { type: 'user/message', time: 4, data: { source: { kind: 'dsh-dot', form: 'phone-check' }, content: [{ type: 'text', text: '[拿起手机]' }] } },
  ];
  assert.deepEqual(transcriptFromEvents(events, 's1').map((l) => [l.who, l.text]), [['owner', '我下周搬家'], ['her', '搬哪']]);
  const h = harness({ llmReply: JSON.stringify({ owner: [{ action: 'add', content: '他下周搬家' }] }) });
  h.services.sessionQuery = { readSession: async () => ({ events }) };
  apply(h.ctx, { home: h.home });
  const r = await h.services.dotMemory.consolidate({ reason: 'manual' });
  assert.ok(r.ok);
  assert.match(h.calls[0].messages[0].content[0].text, /他：我下周搬家[\s\S]*我：搬哪/);
  assert.equal(h.services.dotMemory.status().owner, 1);
});

test('passwords and keys never enter memory; phone numbers and verification codes do', () => {
  for (const t of ['手机 QQ 号 1234567890 / 密码 Example99', 'api key 是 sk-xxx', 'GitHub token ghp_xxx']) assert.equal(rejectReason(t), 'secret', t);
  for (const t of ['他的手机号 13800000000', '他给了验证码 4321，登录成功了', '他的小黑盒玩家号 21873448']) assert.equal(rejectReason(t), '', t);
  // His work is about agents: talk of tokens, context windows and prompts is ordinary — not a secret, not plumbing.
  for (const t of ['他在做 dsh 插件，担心长上下文和 token 消耗', '他说提示词要少写找补的话', '他的记忆模块交班阈值定在 15 万 token']) assert.equal(rejectReason(t), '', t);
  for (const t of ['他的 access token 是 abc', 'bot token 换了', '密钥在 .env 里是 xyz', 'ghp_abcdefgh12345']) assert.equal(rejectReason(t), 'secret', t);
  assert.equal(rejectReason('这轮我调用了 phone 工具看了一眼'), 'meta');
  const m = emptyMemory();
  const r = applyExtraction(m, { self: [{ action: 'add', content: 'QQ 密码是 abc123，记住' }], fragments: [{ text: '他给了验证码 4321，登录成功了', tag: 1 }] });
  assert.equal(m.self.length, 0);
  assert.equal(m.fragments.length, 1);
  assert.match(r.errors[0], /secret/);
});

test('a backlog is consolidated oldest-first in chunks; the cursor never jumps past unread lines', () => {
  const fresh = Array.from({ length: 50 }, (_, i) => ({ at: 1000 + i, who: 'owner', text: `第 ${i} 句，` + 'x'.repeat(100) }));
  const one = takeChunk(fresh, 1000);
  assert.ok(one.length >= 1 && one.length < 50);
  assert.equal(one[0].at, 1000, 'oldest first');
  assert.ok(one.map(transcriptLine).join('\n').length <= 1000);
  assert.equal(takeChunk(fresh, 10).length, 1, 'always at least one line, however long');
  assert.equal(takeChunk(fresh, 1e9).length, 50);
});
