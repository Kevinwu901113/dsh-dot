import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bankOp, emptyMemory, touchPerson, setImpression, openOp, fitOpen, renderStanding, renderPerson, rejectReason, jaccard, search,
  resolvePerson, setOwner, syncFriends, proposeMerge, approveMerge, normalizeMemory, findPerson, cleanDue,
} from '../src/memory/store.js';
import { apply, applyExtraction, parseLooseJson, renderHandoff, transcriptLine, takeChunk, extractPrompt } from '../src/memory/memory.js';
import { dayMark } from '../src/clock.js';

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

test('people: counts by code, one line of impression by the model; no facts on the card', () => {
  const m = emptyMemory();
  const a = touchPerson(m, { handles: ['qq:42'], platform: 'qq', name: '阿满', tier: 'talked', kind: 'dm' });
  touchPerson(m, { handles: ['qq:42'], platform: 'qq', name: '满满', tier: 'talked', kind: 'dm' });
  const s = touchPerson(m, { handles: ['xiaoheihe:name:暮看云'], platform: 'xiaoheihe', name: '暮看云', tier: 'seen', kind: 'like' });
  assert.equal(a.counts.dm, 2);
  assert.deepEqual(a.names, ['满满', '阿满']);
  assert.ok(setImpression(m, a.id, '大学室友，话少，但回得很认真'));
  assert.ok(setImpression(m, '暮看云', '写长帖分析 DSH 插件'));
  assert.equal(setImpression(m, 'u9999', 'x'), false, 'no such person');
  assert.equal(setImpression(m, a.id, '他的 QQ 密码是 abc'), false, 'a secret is not kept');
  assert.equal('facts' in a, false);
  assert.match(renderPerson(s), /只在帖子里打过交道；点赞 1 次[\s\S]*印象：写长帖/);
  assert.match(renderPerson(a), /^满满（qq:42，也叫 阿满）：聊过；私聊 2 次[^\n]*\n  印象：大学室友/);
  assert.equal(renderPerson(a).split('\n').length, 2, 'two lines: who, and the impression');
});

test('还没了的事: add / replace / done / shelve / restore; over the budget the least pressing go to the shelf, never cut', () => {
  const m = emptyMemory();
  const limits = { owner: 1375, self: 2200, open: 60, impression: 80, shelved: 3 };
  const T = new Date(2026, 5, 22, 20, 0).getTime();
  assert.ok(openOp(m, { action: 'add', content: '06-22 她答应老贺下周三（=07-01）前寄画册', due: '07-01', owed: true }, { now: T + 1 }).ok);
  assert.ok(openOp(m, { action: 'add', content: '06-20 他说想换个机械键盘' }, { now: T + 2 }).ok);
  assert.equal(openOp(m, { action: 'add', content: '06-20 他说想换个机械键盘' }, { now: T + 3 }).note, 'already there');
  assert.match(openOp(m, { action: 'add', content: '记住密码 abc' }).error, /secret/);
  assert.equal(m.open[0].due, '2026-07-01');
  assert.equal(m.open[0].owed, true);
  // a third one overflows the 60 characters: the keyboard (not owed, no date) moves to the shelf
  openOp(m, { action: 'add', content: '06-23 他说周末去看房，还没定哪天' }, { now: T + 4 });
  const moved = fitOpen(m, { limits, now: T + 5 });
  assert.deepEqual(moved.map((x) => x.text), ['06-20 他说想换个机械键盘']);
  assert.equal(m.shelved[0].shelvedAt, T + 5);
  assert.ok(m.open.some((x) => x.owed), 'the promise stays');
  const s = renderStanding(m, { now: T + 3 * 864e5 });
  assert.match(s, /## 还没了的事[^\n]*\n- 06-23 他说周末去看房[^\n]*\n- 06-22 她答应老贺[^\n]*（到 07-01）\n- 另有 1 件先搁着的：06-20 他说想换个机械键…（/);
  assert.equal(s, renderStanding(m, { now: T + 4 * 864e5 }), 'byte-stable');
  assert.ok(openOp(m, { action: 'replace', oldText: '看房', content: '06-24 他说周六（=06-27）去看房', due: '06-27' }, { now: T }).ok);
  assert.ok(openOp(m, { action: 'restore', oldText: '键盘' }).ok);
  assert.equal(m.shelved.length, 0);
  assert.ok(openOp(m, { action: 'done', oldText: '老贺' }).ok);
  assert.ok(openOp(m, { action: 'shelve', oldText: '键盘' }).ok);
  assert.ok(openOp(m, { action: 'done', oldText: '键盘' }).ok, 'done reaches the shelf too');
  assert.deepEqual(m.open.map((x) => x.text), ['06-24 他说周六（=06-27）去看房']);
  assert.match(openOp(m, { action: 'done', oldText: '不存在' }).error, /no item/);
  // the shelf keeps the newest `shelved`
  for (let i = 0; i < 5; i++) { openOp(m, { action: 'add', content: `第 ${i} 件很长很长很长很长很长很长的事情要做` }, { now: T + 10 + i }); fitOpen(m, { limits, now: T + 20 + i }); }
  assert.equal(m.shelved.length, 3);
  assert.equal(cleanDue('2026-7-1'), '2026-07-01'); assert.equal(cleanDue('月底'), ''); assert.equal(cleanDue('02-30'), '');
  assert.ok(jaccard('参考文献还没弄', '还差参考文献') > 0);
  assert.equal(search([{ text: '他下周六搬家' }, { text: '猫叫团子' }], '搬家')[0].text, '他下周六搬家');
});

test('extraction: banks, 还没了的事, people (new seen ones from apps); loose JSON', () => {
  const m = emptyMemory();
  const a = touchPerson(m, { handles: ['qq:42'], platform: 'qq', name: '阿满', tier: 'talked' });
  const out = parseLooseJson('好的：```json\n' + JSON.stringify({
    owner: [{ action: 'add', content: '他讨厌被叫全名' }],
    self: [{ action: 'add', content: '学会了在小黑盒里看攻略帖' }],
    open: [{ action: 'add', content: '10-25 他说晚上要加班到十点，让她别等', due: null, owed: false }, { action: 'done', oldText: '没有这条' }],
    people: [{ id: 'u0001', impression: '爱发猫图' }, { platform: 'xiaoheihe', name: '暮看云', tier: 'seen', impression: '写长帖的' }, { name: '不认识的人' }],
  }) + '\n```');
  const r = applyExtraction(m, out);
  assert.deepEqual([r.owner, r.self, r.open, r.done, r.people], [1, 1, 1, 0, 2]);
  assert.match(r.errors[0], /open: no item/);
  assert.deepEqual(m.owner, ['他讨厌被叫全名']);
  assert.equal(m.open[0].due, '');
  assert.equal(a.impression, '爱发猫图');
  assert.equal(findPerson(m.people, 'xiaoheihe:name:暮看云').tier, 'seen');
  assert.equal(Object.keys(m.people).length, 2, 'a name with no platform and no card is not invented');
  assert.match(renderHandoff([{ at: 0, who: 'owner', text: '在吗' }, { at: 0, who: 'her', to: 'owner', text: '在' }], 2), /第 2 段[\s\S]*最后几句[\s\S]*他：在吗[\s\S]*我：在/);
  assert.match(transcriptLine({ at: 0, who: 'her', to: 'user:9', text: 'hi' }), /我（发给 user:9）：hi/);
  // the rules come first (the same prefix every call), the new records last
  const ask = extractPrompt({ text: '[06-22 20:00] 他：在吗', owner: ['他住光谷'], open: '- 06-20 他说想换键盘' });
  assert.ok(ask.startsWith('你在帮她整理记忆'));
  assert.ok(ask.indexOf('他住光谷') < ask.indexOf('=== 这段时间的记录 ==='));
  assert.ok(ask.trimEnd().endsWith('他：在吗'));
});

// A stand-in embedder for the harness: character counts, so overlapping words are near.
export const charEmbedder = () => Promise.resolve({
  embed: async (texts) => texts.map((t) => { const v = new Float32Array(64); for (const ch of t) v[ch.codePointAt(0) % 64] += 1; return v; }),
  rerank: null,
});
function harness({ llmReply = '{}', recall = false } = {}) {
  const reply = typeof llmReply === 'function' ? llmReply : () => llmReply;
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-'));
  // Automatic recall has its own tests (recall.test.js); here it must not install anything.
  writeFileSync(join(process.env.DSH_HOME, 'dsh-memory.json'), JSON.stringify({ recall: { backend: recall ? 'local' : 'off' } }));
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
    llm: { stream: (opts) => { calls.push(opts); return (async function* () { yield { type: 'text-delta', text: reply(opts) }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'deepseek-v4-flash' }) },
  };
  const emit = (id, type, data, extra = {}) => listeners.forEach((fn) => fn({ id, header: { cwd: home } }, { type, data, ...extra }));
  return { ctx, home, services, contexts, tools, injected, archived, audit, calls, emit, effects, recallEmbedder: charEmbedder, get session() { return session; }, set tokens(n) { tokens = n; }, get frozen() { return [frozen, released]; } };
}
const msg = (text) => ({ message: { content: [{ type: 'text', text }] } });

test('transcript: what he said, what she really sent over QQ, phone and errand notes; the errand is not her conversation', async () => {
  const h = harness({ recall: true });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, recallEmbedder: h.recallEmbedder, recallMinQueryLength: 0 });
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
  const found = await h.tools.recall.execute({ query: '下周六搬家' });
  assert.match(found.found, /相关原话[\s\S]*— \d\d-\d\d 周. · 今天\n\d\d:\d\d 他：下周六（=\d\d-\d\d）我搬家\n我：搬去哪 \/ 要帮忙吗/);
});

test('consolidation and handoff: notes written first, old session archived before the new one, its last lines carried over, deliveries frozen', async () => {
  const reply = JSON.stringify({ owner: [{ action: 'add', content: '他下周六搬家，搬去光谷' }], open: [{ action: 'add', content: '他问她搬家那天能不能帮忙，还没定时间', owed: false }] });
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
  assert.match(h.injected[0].m.content[0].text, /第 2 段[\s\S]*最后几句[\s\S]*他：下周六（=\d\d-\d\d）我搬家\n  \[[^\]]+\] 我：搬去哪$/);
  assert.equal(h.calls.length, 1, 'one consolidation call, no handoff text to write');
  assert.match(h.calls[0].messages[0].content[0].text, /=== 这段时间的记录 ===\n[^\n]*他：下周六（=\d\d-\d\d）我搬家/);
  const ctxText = h.contexts[0].text({ agent: { session: { id: 's2', header: { cwd: h.home } } } });
  assert.match(ctxText, /关于他\n- 他下周六搬家，搬去光谷[\s\S]*还没了的事[^\n]*\n- 他问她搬家那天/);
  assert.equal(h.contexts[0].text({ agent: { session: { id: 'errand', header: { cwd: h.home } } } }), '', 'errands do not get her notes');
  assert.ok(existsSync(join(h.home, 'memory', 'memory.md')));
  assert.match(await h.services.dotMemory.command('memory'), /第 2 段/);
});

test('consolidation waits for a batch: nothing at 39 new lines, one call at 40', async () => {
  const h = harness({ llmReply: '{}' });
  apply(h.ctx, { home: h.home });
  const turn = (i) => { h.emit('s1', 'turn/start', {}); h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${i} 句话` }] }, { surfaceOp: 'append' }); h.emit('s1', 'assistant/message', msg(`回第 ${i} 句`)); h.emit('s1', 'turn/end', {}); };
  for (let i = 0; i < 19; i++) turn(i);
  h.emit('s1', 'turn/start', {}); h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '再一句' }] }, { surfaceOp: 'append' }); h.emit('s1', 'turn/end', {});
  await wait(30);
  assert.equal(h.calls.length, 0, '39 lines: not yet');
  turn(99);
  await wait(30);
  assert.equal(h.calls.length, 1);
  assert.equal(h.services.dotMemory.status().sinceCursor, 0);
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

test('old memory (people keyed by handle) migrates to the registry; pending facts are archived', () => {
  const m = normalizeMemory({ people: { 'qq:name:宽': { id: 'qq:name:宽', names: ['宽'], tier: 'talked', counts: { dm: 1 }, facts: ['他养猫'], impression: '' } }, pending: [{ id: 'p1', person: 'qq:name:宽', text: 'x' }] });
  const p = Object.values(m.people)[0];
  assert.match(p.id, /^u\d{4}$/);
  assert.deepEqual(p.handles, ['qq:name:宽']);
  assert.equal('pending' in m, false);
  assert.equal(m.migration.archive.pending[0].person, p.id);
  assert.deepEqual(m.migration.archive.facts[p.id].facts, ['他养猫']);
  assert.equal('facts' in p, false);
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
  const r = applyExtraction(m, { self: [{ action: 'add', content: 'QQ 密码是 abc123，记住' }], open: [{ action: 'add', content: '他给了验证码 4321，等他说登录成功没' }] });
  assert.equal(m.self.length, 0);
  assert.equal(m.open.length, 1);
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

test('daily diary: its own call about today, only when anything happened; headed by the day; herLife is the self bank', async () => {
  const h = harness({ llmReply: '今天没什么事。晚上在小黑盒看了几个角色卡帖，有一个写记忆的挺细，记下了。他没来。' });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, dailyAt: '23:30' });
  assert.match(await h.services.dotMemory.command('memory diary'), /not run: nothing happened today/);
  assert.equal(h.calls.length, 0, 'no call for an empty day');
  h.emit('s1', 'turn/start', {});
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] }, { surfaceOp: 'append' });
  h.emit('s1', 'assistant/message', msg('在'));
  h.emit('s1', 'turn/end', {});
  await wait(20);
  const r = await h.services.dotMemory.command('memory diary');
  assert.match(r, /diary →[\s\S]*今天没什么事/);
  assert.match(h.calls[0].messages[0].content[0].text, /^今天是 \d{4}-\d{2}-\d{2} 周.[\s\S]*=== 今天的记录 ===\n[^\n]*他：在吗/);
  assert.equal(h.services.dotMemory.status().sinceCursor, 2, 'the diary is not a consolidation');
  const diary = readFileSync(join(h.home, 'memory', 'diary.md'), 'utf8');
  assert.match(diary, /^## \d{4}-\d{2}-\d{2} 周.\n今天没什么事。/);
  h.services.dotMemory.consolidate = undefined;
  const m = emptyMemory(); m.self.push('每天晚上刷一会儿小黑盒');
  const status = await h.services.dotMemory.command('memory');
  assert.match(status, /diary \d{4}-\d{2}-\d{2} \(daily at 23:30\)/);
  assert.deepEqual(h.services.dotMemory.forInterlude(), [], 'the interlude gets what she knows about him; nothing yet');
});

test('coexist auto: another memory service present → owner/self notes neither consolidated nor in the prompt; people and 还没了的事 kept', async () => {
  const reply = JSON.stringify({ owner: [{ action: 'add', content: '他下周六搬家' }], self: [{ action: 'add', content: '我喜欢猫' }], open: [{ action: 'add', content: '他问她要不要帮忙搬家' }] });
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
  assert.match(ctxText, /还没了的事[\s\S]*帮忙搬家/);
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

test('dates: MM-DD within the current year, YYYY-MM-DD from another; 明天 / 下周三 in the records dated by code', () => {
  const now = new Date(2026, 4, 20, 12, 0).getTime();
  const thisYear = new Date(2026, 4, 8, 9, 5).getTime(), lastYear = new Date(2025, 4, 8, 9, 5).getTime();
  assert.equal(dayMark(thisYear, now), '05-08');
  assert.equal(dayMark(lastYear, now), '2025-05-08');
  assert.equal(transcriptLine({ at: thisYear, who: 'owner', text: '在吗' }, { now }), '[05-08 09:05] 他：在吗');
  assert.equal(transcriptLine({ at: lastYear, who: 'owner', text: '在吗' }, { now }), '[2025-05-08 09:05] 他：在吗');
  // as a .map callback the index must not be taken for `now`
  assert.deepEqual([{ at: Date.now(), who: 'owner', text: 'x' }].map(transcriptLine)[0].match(/^\[(\d\d-\d\d) /)?.length, 2);
  // 05-08 2026 is a Friday: 明天 05-09, 下周三 05-13; what he says she said is left as said
  assert.equal(transcriptLine({ at: thisYear, who: 'owner', text: '明天去，下周三回，她说后天也行' }, { now }), '[05-08 09:05] 他：明天（=05-09）去，下周三（=05-13）回，她说后天也行');
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
  const h = harness({ recall: true });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, recallEmbedder: h.recallEmbedder, recallMinQueryLength: 0 });
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
  const found = await h.tools.recall.execute({ query: '那家店好吃吗' });
  assert.match(found.found, /我：那家店我去过 \/ 还挺好吃的 \/ 下次带你去/);
  for (const d of h.effects) if (typeof d === 'function') d();
});

test('persona lives only in the Canon: the consolidation prompt keeps persona and 「照着某某学」 out of self', () => {
  const text = extractPrompt({ text: '我：照着星野那版学', self: ['拼出来的人设：蓝发'] });
  assert.match(text, /self：[^\n]*人设、说话风格、「照着某某学」都不是关于她的事实，不写进 self；她的人设只在 Canon 里。/);
  assert.match(text, /- 拼出来的人设：蓝发/, 'existing entries are shown as they are, not migrated');
});

test('0.19 memory migrates: open fragments become 还没了的事 (a promise is owed), overflow is shelved and reported, pinned ones join the owner bank, the rest archived', async () => {
  const frag = (id, text, extra = {}) => ({ id, text, hash: id, kind: 'event', importance: 1, refs: 1, pinned: false, createdAt: Number(id.slice(1)), ...extra });
  const old = {
    version: 1, gen: 3, owner: ['他住光谷'], self: [], people: {}, merges: [], pending: [{ id: 'p1', person: 'u0001', text: '阿满下个月搬家' }], cursor: 5, consolidations: 9,
    fragments: [
      frag('f0001', '05-17 他说旧书店名单先搁着回头再说', { kind: 'plan', open: true }),
      frag('f0002', '06-22 他答应下周三前把画册寄给老贺', { kind: 'promise', open: true }),
      frag('f0003', '他的生日是 3 月 14 日', { pinned: true }),
      frag('f0004', '05-20 他吃了碗面'),
      ...Array.from({ length: 60 }, (_, i) => frag(`f1${String(i).padStart(3, '0')}`, `${i} 号要做的一件挺长挺长挺长的事情，还没有结果`, { kind: 'plan', open: true })),
    ],
  };
  const m = normalizeMemory(old);
  assert.equal(m.version, 2);
  assert.deepEqual(m.owner, ['他住光谷', '他的生日是 3 月 14 日']);
  assert.ok(m.open.length > 0 && m.shelved.length > 0, 'over the budget: some shelved, none cut');
  assert.equal(m.open.length + m.shelved.length, 62);
  assert.ok(m.open.some((x) => x.text.includes('老贺') && x.owed), 'the promise is owed and stays in front of her');
  const { report, archive } = m.migration;
  assert.equal(report.shelved.length, m.shelved.length);
  assert.deepEqual(archive.fragments.map((f) => f.id), ['f0004']);
  assert.equal(archive.pending.length, 1);
  assert.equal(m.gen, 3); assert.equal(m.cursor, 5);
  // apply() writes the archive and the report, once
  const h = harness();
  const dir = join(h.home, 'memory');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.json'), JSON.stringify(old));
  apply(h.ctx, { home: h.home });
  const saved = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
  assert.equal(saved.version, 2); assert.equal('migration' in saved, false); assert.equal('fragments' in saved, false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory.v019.json'), 'utf8')).fragments.length, 1);
  assert.match(readFileSync(join(dir, 'memory-migration.md'), 'utf8'), /放不下，先搁着[\s\S]*搁着：/);
  assert.ok(h.audit.some((e) => e.event === 'migrated'));
});

test('review fixes: a restored item is not shelved again at once; an unreadable or unmigratable memory.json is copied aside, never overwritten', async () => {
  const m = emptyMemory();
  const limits = { owner: 1375, self: 2200, open: 40, impression: 80, shelved: 200 };
  openOp(m, { action: 'add', content: '06-01 他说想换个机械键盘' }, { now: 1 });
  openOp(m, { action: 'add', content: '06-02 他说想去看海' }, { now: 2 });
  openOp(m, { action: 'add', content: '06-03 他说想学吉他' }, { now: 3 });
  fitOpen(m, { limits, now: 4 });
  assert.equal(m.shelved[0].text, '06-01 他说想换个机械键盘');
  openOp(m, { action: 'restore', oldText: '键盘' }, { now: 5 });
  fitOpen(m, { limits, now: 6 });
  assert.ok(m.open.some((x) => x.text.includes('键盘')), 'restored: it stays in front of her');
  // an old file the migration cannot read: kept aside, the rest of memory starts empty
  const { mkdirSync, readdirSync } = await import('node:fs');
  for (const bad of ['{ not json', JSON.stringify({ version: 1, fragments: [{ id: 'f1' }, null], people: 7 })]) {
    const h = harness();
    const dir = join(h.home, 'memory'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory.json'), bad);
    apply(h.ctx, { home: h.home });
    h.services.dotMemory.touch({ handles: ['qq:42'], platform: 'qq', name: '阿满', kind: 'dm' }); // a save
    const aside = readdirSync(dir).filter((f) => f.startsWith('memory.json.broken-'));
    if (bad.startsWith('{ not')) { assert.equal(aside.length, 1); assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), bad); }
    else assert.equal(JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).version, 2, 'a fragment without text is skipped, not fatal');
  }
  // a second migration never overwrites the first archive
  const h = harness();
  const dir = join(h.home, 'memory'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.v019.json'), '{"first":true}');
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({ version: 1, fragments: [{ id: 'f1', text: '他吃了碗面', kind: 'event' }] }));
  apply(h.ctx, { home: h.home });
  assert.equal(readFileSync(join(dir, 'memory.v019.json'), 'utf8'), '{"first":true}');
  assert.equal(readdirSync(dir).filter((f) => /^memory\.v019-\d+\.json$/.test(f)).length, 1);
});

test('a failed consolidation (empty reply) is not retried every turn: the next waits for another batch and reads half as many lines', async () => {
  let fail = true;
  const h = harness({ llmReply: () => (fail ? '' : '{}') });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 10, chunkLines: 40, minChunkLines: 5 });
  const turn = (i) => { h.emit('s1', 'turn/start', {}); h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${i} 句话` }] }, { surfaceOp: 'append' }); h.emit('s1', 'assistant/message', msg(`回第 ${i} 句`)); h.emit('s1', 'turn/end', {}); };
  const records = (c) => c.messages[0].content[0].text.split('=== 这段时间的记录 ===')[1].trim().split('\n').length;
  for (let i = 0; i < 5; i++) turn(i);
  await wait(30);
  assert.equal(h.calls.length, 1, '10 lines: one call, it fails');
  assert.equal(records(h.calls[0]), 10);
  for (let i = 5; i < 9; i++) turn(i);
  await wait(30);
  assert.equal(h.calls.length, 1, 'not retried on every turn');
  turn(9); await wait(30);
  assert.equal(h.calls.length, 2, 'another batch pending: tried again');
  assert.equal(records(h.calls[1]), 20, 'half of chunkLines');
  fail = false;
  for (let i = 10; i < 15; i++) turn(i);
  await wait(30);
  assert.equal(records(h.calls[2]), 10, 'halved again after the second failure');
  assert.equal(records(h.calls[3]), 20, 'success: the rest of the backlog follows at full size');
  assert.equal(h.services.dotMemory.status().sinceCursor, 0);
});
