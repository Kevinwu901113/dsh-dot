import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bankOp, emptyMemory, touchPerson, updatePerson, approvePending, observeFragment, ageFragments, renderStanding, renderPerson, rejectReason, jaccard, search,
  resolvePerson, setOwner, syncFriends, proposeMerge, approveMerge, normalizeMemory, findPerson, dayMark,
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
  // Automatic recall has its own tests (recall.test.js); here it must not install anything.
  writeFileSync(join(process.env.DSH_HOME, 'dsh-memory.json'), JSON.stringify({ recall: { backend: 'off' } }));
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
    inject(deps, fn) { fn({ systemPrompt: { context: (c) => contexts.push(c) }, tools: { register: (t) => { tools[t.name] = t; return () => {}; } }, effect: (f) => f(), on: (...a) => ctx.on(...a) }); },
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
  h.emit('s1', 'tool/call', { callId: 'c1', name: 'qq_send', arguments: JSON.stringify({ to: 'owner', text: '搬去哪<sep/>要帮忙吗' }) });
  h.emit('s1', 'tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'sent 2 message(s)' }] }, meta: { sent: 2, said: ['搬去哪', '要帮忙吗'], imagesSent: 0 } });
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
    { type: 'tool/call', time: 2, data: { callId: 'c1', name: 'qq_send', arguments: JSON.stringify({ to: 'owner', text: '搬哪' }) } },
    { type: 'tool/result', time: 3, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'sent 1 message(s)' }] } } },
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

test('daily diary: `/dot memory diary` consolidates with a diary; the entry is her own words, headed by the day; herLife is the self bank', async () => {
  const reply = JSON.stringify({ self: [{ action: 'add', content: '每天晚上刷一会儿小黑盒，看角色卡帖' }], diary: '今天没什么事。晚上在小黑盒看了几个角色卡帖，有一个写记忆的挺细，记下了。他没来。', handoff: null });
  const h = harness({ llmReply: reply });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, dailyAt: '23:30' });
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'assistant/message', msg('在'));
  h.emit('s1', 'turn/end', {});
  await wait(20);
  const r = await h.services.dotMemory.command('memory diary');
  assert.match(r, /"diary":true/);
  assert.match(h.calls[0].messages[0].content[0].text, /这次要写 diary：今天是 \d{4}-\d{2}-\d{2} 周./);
  const diary = readFileSync(join(h.home, 'memory', 'diary.md'), 'utf8');
  assert.match(diary, /^## \d{4}-\d{2}-\d{2} 周.\n今天没什么事。/);
  assert.deepEqual(h.services.dotMemory.herLife(), ['每天晚上刷一会儿小黑盒，看角色卡帖']);
  assert.ok(!h.services.dotMemory.forInterlude().some((x) => x.startsWith('她自己')), 'self notes travel as herLife, not among memories');
  const again = await h.services.dotMemory.command('memory diary');
  assert.match(again, /not run|consolidated/, 'a second diary the same day is not an error');
  const status = await h.services.dotMemory.command('memory');
  assert.match(status, /diary \d{4}-\d{2}-\d{2} \(daily at 23:30\)/);
});

test('coexist auto: another memory service present → owner/self banks neither consolidated nor in the prompt; people and fragments kept', async () => {
  const reply = JSON.stringify({ owner: [{ action: 'add', content: '他下周六搬家' }], self: [{ action: 'add', content: '我喜欢猫' }], fragments: [{ text: '他问她要不要帮忙搬家', kind: 'plan', tag: 2 }] });
  const h = harness({ llmReply: reply });
  h.services.hermesMemory = {};
  apply(h.ctx, { home: h.home, handoffTokens: 100000, minTokensBetweenHandoffs: 1000, consolidateEveryLines: 1000 });
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '下周六我搬家' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'assistant/message', msg('搬去哪'));
  h.tokens = 150000;
  h.emit('s1', 'turn/end', {});
  await wait(50);
  assert.match(h.calls[0].messages[0].content[0].text, /由别的记忆插件负责/);
  const md = readFileSync(join(h.home, 'memory', 'memory.md'), 'utf8');
  assert.doesNotMatch(md, /他下周六搬家|我喜欢猫/);
  const ctxText = h.contexts[0].text({ agent: { session: { id: 's2', header: { cwd: h.home } } } });
  assert.match(ctxText, /最近的事[\s\S]*帮忙搬家/);
  assert.doesNotMatch(ctxText, /关于他|你自己记下的/);
  // full forces the banks back on even with the other service there
  const m = emptyMemory(); m.owner.push('他住光谷');
  assert.match(renderStanding(m), /关于他/);
  assert.doesNotMatch(renderStanding(m, { banks: false }), /关于他/);
});

test('coexist full: banks on even next to another memory service', async () => {
  const h = harness({ llmReply: JSON.stringify({ owner: [{ action: 'add', content: '他下周六搬家' }] }) });
  h.services.hermesMemory = {};
  apply(h.ctx, { home: h.home, coexist: 'full', handoffTokens: 100000, minTokensBetweenHandoffs: 1000, consolidateEveryLines: 1000 });
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '下周六我搬家' }] }, { surfaceOp: 'append' });
  h.tokens = 150000;
  h.emit('s1', 'turn/end', {});
  await wait(50);
  assert.match(h.contexts[0].text({ agent: { session: { id: 's2', header: { cwd: h.home } } } }), /关于他\n- 他下周六搬家/);
});

test('dates: MM-DD within the current year, YYYY-MM-DD from another (transcript lines and standing fragments)', () => {
  const now = new Date(2026, 4, 20, 12, 0).getTime();
  const thisYear = new Date(2026, 4, 8, 9, 5).getTime(), lastYear = new Date(2025, 4, 8, 9, 5).getTime();
  assert.equal(dayMark(thisYear, now), '05-08');
  assert.equal(dayMark(lastYear, now), '2025-05-08');
  assert.equal(transcriptLine({ at: thisYear, who: 'owner', text: '在吗' }, { now }), '[05-08 09:05] 他：在吗');
  assert.equal(transcriptLine({ at: lastYear, who: 'owner', text: '在吗' }, { now }), '[2025-05-08 09:05] 他：在吗');
  // as a .map callback the index must not be taken for `now`
  assert.deepEqual([{ at: Date.now(), who: 'owner', text: 'x' }].map(transcriptLine)[0].match(/^\[(\d\d-\d\d) /)?.length, 2);
  const m = emptyMemory();
  observeFragment(m, { text: '05-08 他去体检', tag: 2, kind: 'event', gen: 1, now: lastYear });
  observeFragment(m, { text: '05-08 他换了工作', tag: 1, kind: 'event', gen: 1, now: thisYear });
  const s = renderStanding(m, { now });
  assert.match(s, /- \[2025-05-08\] 05-08 他去体检/);
  assert.match(s, /- 05-08 他换了工作/);
  assert.equal(s, renderStanding(m, { now: now + 86400000 }), 'byte-stable within the year');
});

test('stamps: wake messages are stamped, the transcript is not stamped twice; lastSaidAt is the last line before a moment', async () => {
  const h = harness();
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000 });
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'user/message', { source: { kind: 'user', rpcId: 'qq-dot-1' }, content: [{ type: 'text', text: '[11-04 04:51] 在吗\n睡了没' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'phone-notification' }, content: [{ type: 'text', text: '[2025-11-04 04:52 手机通知] 小黑盒 · 阿满：回复了你\n（不想理就只回 DOT_SILENT。）' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'errand-note' }, content: [{ type: 'text', text: '[11-04 04:53 刚才拿起手机看了一眼] 没什么\n（这是你自己刚做过的事…）' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '[不是时间] 原样' }] }, { surfaceOp: 'append' });
  await wait(10);
  const lines = readFileSync(join(h.home, 'memory', 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.who, l.text]), [['owner', '在吗\n睡了没'], ['phone', '[手机通知] 小黑盒 · 阿满：回复了你'], ['note', '[刚才拿起手机看了一眼] 没什么'], ['owner', '[不是时间] 原样']]);
  assert.doesNotMatch(transcriptLine(lines[0]), /\].*\[11-04/, 'one time per line');
  const mem = h.services.dotMemory;
  assert.equal(mem.lastSaidAt(lines[1].at + 1), lines[0].at, 'phone and notes do not count, his words do');
  assert.equal(mem.lastSaidAt(lines[0].at), 0, 'only lines before the moment');
  const { transcriptFromEvents } = await import('../src/memory/memory.js');
  assert.deepEqual(transcriptFromEvents([{ type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '[11-04 04:51] 我下周搬家' }] } }], 's1').map((l) => l.text), ['我下周搬家']);
});

test('pictures in what woke her: memory records the words for them only, never the image blocks', async () => {
  const img = { type: 'image', attachment: { attachmentId: 'sha256:1', mediaType: 'image/gif', bytes: 6, width: 1, height: 1 } };
  const content = [{ type: 'text', text: '[11-04 10:00] 你看[表情包 sticker:aa11bb22cc]' }, img, { type: 'text', text: '\n[图片 https://x.qq.com/a]' }, img, { type: 'text', text: '哈哈' }];
  const h = harness();
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000 });
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'user/message', { source: { kind: 'user', rpcId: 'qq-dot-1' }, content }, { surfaceOp: 'append' });
  h.emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'phone-notification' }, content: [{ type: 'text', text: '[11-04 10:01 手机通知] QQ · 路人（30003）：[图片 https://x.qq.com/b]' }, img, { type: 'text', text: '\n（不想理就只回 DOT_SILENT。）' }] }, { surfaceOp: 'append' });
  await wait(10);
  const lines = readFileSync(join(h.home, 'memory', 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.who, l.text]), [['owner', '你看[表情包 sticker:aa11bb22cc]\n[图片 https://x.qq.com/a]哈哈'], ['phone', '[手机通知] QQ · 路人（30003）：[图片 https://x.qq.com/b]']]);
  assert.ok(lines.every((l) => typeof l.text === 'string' && !/sha256|attachment/.test(JSON.stringify(l))), 'no image block, no attachment id');
  const { transcriptFromEvents } = await import('../src/memory/memory.js');
  assert.deepEqual(transcriptFromEvents([{ type: 'user/message', time: 1, data: { source: { kind: 'user' }, content } }], 's1').map((l) => l.text), ['你看[表情包 sticker:aa11bb22cc]\n[图片 https://x.qq.com/a]哈哈']);
  for (const d of h.effects) if (typeof d === 'function') d();
});

test('his words steered into a running turn are recorded without the line dot adds', async () => {
  const { ownerSaid, transcriptFromEvents } = await import('../src/memory/memory.js');
  const { ownerWords } = await import('../src/dot/core.js');
  const { unstamp } = await import('../src/clock.js');
  const busy = unstamp(ownerWords([{ text: '先别弄了' }, { text: '（括号也是他打的）' }], Date.now(), { whileBusy: true }));
  assert.equal(ownerSaid(busy), '先别弄了\n（括号也是他打的）');
  assert.equal(ownerSaid('就这一句'), '就这一句');
  const ev = { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: ownerWords([{ text: '在吗' }], Date.now(), { whileBusy: true }) }] } };
  assert.equal(transcriptFromEvents([ev], 's')[0].text, '在吗');
});

test('qq_send in the transcript is what went out: a denied send nothing, an interrupted one its sent bubbles, a failed image only the text; at the call\'s time', async () => {
  const { qqSentText, transcriptFromEvents } = await import('../src/memory/memory.js');
  const args = { to: 'owner', text: '那家店我去过\n还挺好吃的\n下次带你去', images: ['face:14'] };
  const result = (meta, text = `sent ${meta?.sent ?? 0} message(s)`, isError = false) => ({ message: { toolCallId: 'c', isError, content: [{ type: 'text', text }] }, ...(meta ? { meta } : {}) });
  const denied = result(null, '他刚又发了消息，这条没发出去。', true);
  const cut = result({ sent: 1, said: ['那家店我去过'], imagesSent: 0, interrupted: true });
  const imageFailed = result({ sent: 3, said: ['那家店我去过', '还挺好吃的', '下次带你去'], imagesSent: 0 });
  assert.equal(qqSentText(args, denied), '');
  assert.equal(qqSentText(args, cut), '那家店我去过');
  assert.equal(qqSentText(args, imageFailed), '那家店我去过 / 还挺好吃的 / 下次带你去');
  // images as the refs that went out — sendable as they read (qq's markerOf takes them back)
  assert.equal(qqSentText(args, result({ sent: 4, said: ['a', 'b', 'c'], imagesSent: 1, images: ['face:14'] })), 'a / b / c [图 face:14]');
  assert.equal(qqSentText({ to: 'owner', images: ['sticker:9384f5360b', 'phone:screen', 'https://example.com/a.png'] }, result({ sent: 3, said: [], imagesSent: 3, images: ['sticker:9384f5360b', 'phone:screen', 'https://example.com/a.png'] })), '[表情包 sticker:9384f5360b] [图 phone:screen] [图 https://example.com/a.png]');
  assert.equal(qqSentText({ to: 'owner', images: ['phone:latest', 'https://example.com/bad.png'] }, result({ sent: 2, said: ['看'], imagesSent: 1, images: ['phone:latest'] })), '看 [图 phone:latest]', 'a refused image is not recorded');
  // 0.17.0 meta (a count, no refs): the first that many of the call's images
  assert.equal(qqSentText(args, result({ sent: 4, said: ['a', 'b', 'c'], imagesSent: 1 })), 'a / b / c [图 face:14]');
  // no meta (an older qq_send): the first `sent` lines
  assert.equal(qqSentText(args, result(null, 'sent 2 message(s)\n发了 2 条，他插了话…')), '那家店我去过 / 还挺好吃的');
  assert.equal(qqSentText(args, result(null, 'sent 4 message(s)')), '那家店我去过 / 还挺好吃的 / 下次带你去 [图 face:14]');
  // backfill from the session log
  const ev = (type, time, data) => ({ type, time, data });
  const call = (id, time) => ev('tool/call', time, { callId: id, name: 'qq_send', arguments: JSON.stringify(args) });
  const res = (id, time, r) => ev('tool/result', time, { ...r, message: { ...r.message, toolCallId: id } });
  const said = transcriptFromEvents([call('a', 1), res('a', 2, denied), call('b', 3), ev('user/message', 5, { source: { kind: 'user' }, content: [{ type: 'text', text: '等下' }] }), res('b', 6, cut), call('c', 7), res('c', 8, imageFailed)], 's');
  assert.deepEqual(said.map((l) => [l.at, l.who, l.text]), [[3, 'her', '那家店我去过'], [5, 'owner', '等下'], [7, 'her', '那家店我去过 / 还挺好吃的 / 下次带你去']]);
  // live: recorded at the result, placed at the call's time; the handoff tail and recall read the same lines
  const h = harness();
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000 });
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'tool/call', { callId: 'a', name: 'qq_send', arguments: JSON.stringify(args) });
  h.emit('s1', 'tool/result', denied.message ? { ...denied, message: { ...denied.message, toolCallId: 'a' } } : denied);
  h.emit('s1', 'tool/call', { callId: 'b', name: 'qq_send', arguments: JSON.stringify(args) });
  await wait(5);
  h.emit('s1', 'user/message', { source: { kind: 'user', rpcId: 'qq-dot-1' }, content: [{ type: 'text', text: '等下' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'tool/result', { ...cut, message: { ...cut.message, toolCallId: 'b' } });
  h.emit('s1', 'tool/call', { callId: 'c', name: 'qq_send', arguments: JSON.stringify(args) });
  h.emit('s1', 'tool/result', { ...imageFailed, message: { ...imageFailed.message, toolCallId: 'c' } });
  h.emit('s1', 'turn/end', {});
  await wait(10);
  const lines = readFileSync(join(h.home, 'memory', 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.who === 'her').map((l) => l.text), ['那家店我去过', '那家店我去过 / 还挺好吃的 / 下次带你去']);
  assert.ok(!lines.some((l) => l.text.includes('[图')), 'the face never went out');
  assert.deepEqual(lines.sort((a, b) => a.at - b.at).map((l) => [l.who, l.text]), [['her', '那家店我去过'], ['owner', '等下'], ['her', '那家店我去过 / 还挺好吃的 / 下次带你去']], 'in time order: the cut send came before his interruption');
  const found = await h.tools.recall.execute({ query: '好吃' });
  assert.match(found.found, /我：那家店我去过 \/ 还挺好吃的 \/ 下次带你去/);
  for (const d of h.effects) if (typeof d === 'function') d();
});
