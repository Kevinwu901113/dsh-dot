import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bankOp, bankUsage, emptyMemory, touchPerson, setImpression, openOp, expireOpen, openView, renderStanding, DEFAULT_LIMITS, renderPerson, rejectReason, jaccard, search,
  resolvePerson, setOwner, syncFriends, proposeMerge, approveMerge, normalizeMemory, findPerson, cleanDue, touchShare, TOUCH_MIN, dueSaid,
} from '../src/memory/store.js';
import { apply, applyExtraction, parseLooseJson, renderHandoff, transcriptLine, takeChunk, extractPrompt, dailyPrompt, dayLabel } from '../src/memory/memory.js';
import { dayMark } from '../src/clock.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('banks: Hermes add / replace / remove under a character budget; an add or a longer replace past it is refused, one that does not grow the bank applies', () => {
  let r = bankOp([], { action: 'add', content: '他在广州上班，做后端' }, 40);
  assert.ok(r.ok); let bank = r.entries;
  assert.equal(bankOp(bank, { action: 'add', content: '他在广州上班，做后端' }, 40).note, 'already there');
  const big = bankOp(bank, { action: 'add', content: '一'.repeat(40) }, 40);
  assert.equal(big.ok, false); assert.equal(big.full, true);
  assert.match(big.error, /^over the limit \(52\/40 chars\): replace an entry that matters less now/);
  assert.equal(bankUsage(bank, 40), '11/40 chars');
  assert.equal(bankOp(bank, { action: 'replace', oldText: '广州', content: `他在广州上班，做后端，${'二'.repeat(30)}` }, 40).full, true, 'a replace that grows past the limit');
  assert.ok(bankOp(bank, { action: 'replace', oldText: '广州', content: `他在广州上班，做后端，${'二'.repeat(10)}` }, 40).ok, 'a replace that grows within it');
  // a bank already over (an earlier build): a replace that does not grow it and a remove apply, an add does not
  const over = ['三'.repeat(30), '四'.repeat(30)];
  assert.equal(bankOp(over, { action: 'add', content: '他喜欢猫和狗' }, 40).full, true);
  assert.deepEqual(bankOp(over, { action: 'replace', oldText: '三三', content: '他喜欢猫和狗' }, 40).entries, ['他喜欢猫和狗', '四'.repeat(30)]);
  assert.deepEqual(bankOp(over, { action: 'replace', oldText: '三三', content: '五'.repeat(30) }, 40).entries, ['五'.repeat(30), '四'.repeat(30)], 'same size: still over, applies');
  assert.equal(bankOp(over, { action: 'replace', oldText: '三三', content: '五'.repeat(31) }, 40).full, true);
  assert.deepEqual(bankOp(over, { action: 'remove', oldText: '三三' }, 40).entries, ['四'.repeat(30)]);
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

test('还没了的事: a consolidation replace keeps a dated item\'s due unless the record says the new day; an item without one gets it as before', () => {
  const T = new Date(2026, 1, 10, 20, 0).getTime(); // 02-10
  const later = T + 3 * 86400000; // 02-13
  const fresh = () => { const m = emptyMemory(); openOp(m, { action: 'add', content: '02-10 他说下个月十五号前交房租', due: '02-15' }, { now: T }); openOp(m, { action: 'add', content: '他想换个键盘' }, { now: T }); return m; };
  // not said in this record: the due stays, the replacing text's stale mark goes (its words stay)
  let m = fresh();
  let r = applyExtraction(m, { open: [{ action: 'replace', oldText: '房租', content: '02-10 他说下个月十五号（=03-15）前交房租，今天又提了一句（到 02-15）', due: '03-15' }] }, { now: later, segment: '[02-13 21:00] 他：房租的事别忘了' });
  assert.equal(r.open, 1, 'the replace still applies');
  assert.equal(m.open[0].due, '2026-02-15');
  assert.equal(m.open[0].text, '02-10 他说下个月十五号前交房租，今天又提了一句（到 02-15）');
  assert.equal(m.open[0].saidAt, later);
  // a due cleared by a replace (no date in the record) is kept too
  m = fresh(); applyExtraction(m, { open: [{ action: 'replace', oldText: '房租', content: '他要交房租', due: '' }] }, { now: later, segment: '[02-13 21:00] 他：房租' });
  assert.equal(m.open[0].due, '2026-02-15');
  // the line stamp is not the day said: a replace re-dated to the consolidation's own day stays put
  m = fresh(); applyExtraction(m, { open: [{ action: 'replace', oldText: '房租', content: '今天（=02-13）交房租', due: '02-13' }] }, { now: later, segment: '[02-13 21:00] 他：房租' });
  assert.equal(m.open[0].due, '2026-02-15');
  // said in this record (annotated, or written out): the new day goes in, the text as written
  for (const said of ['[02-13 21:00] 他：房租改到下个月五号（=03-05）交了', '[02-13 21:00] 他：房租房东说3月5号再交', '[02-13 21:00] 他：房东说三月五号交']) {
    m = fresh(); applyExtraction(m, { open: [{ action: 'replace', oldText: '房租', content: '02-13 他说房租改到下个月五号（=03-05）交', due: '03-05' }] }, { now: later, segment: said });
    assert.equal(m.open[0].due, '2026-03-05', said);
    assert.equal(m.open[0].text, '02-13 他说房租改到下个月五号（=03-05）交');
  }
  // an item without a due gets one on a replace, as before
  m = fresh(); applyExtraction(m, { open: [{ action: 'replace', oldText: '键盘', content: '他周六（=02-14）去买键盘', due: '02-14' }] }, { now: later, segment: '[02-13 21:00] 他：键盘' });
  assert.equal(m.open[1].due, '2026-02-14');
  // her own tool in a conversation (no record): the replace sets the due as given
  m = fresh(); openOp(m, { action: 'replace', oldText: '房租', content: '他三月五号交房租', due: '03-05' }, { now: later });
  assert.equal(m.open[0].due, '2026-03-05');
  assert.equal(dueSaid('2026-03-25', '[03-25 08:00] 他：三月廿五见'), true);
  assert.equal(dueSaid('2026-03-15', '[03-15 08:00] 他：13月15'), false);
});

test('还没了的事: add / replace / done; owed is ignored, shelve / restore are gone; storage is never cut', () => {
  const m = emptyMemory();
  const T = new Date(2026, 5, 22, 20, 0).getTime();
  assert.ok(openOp(m, { action: 'add', content: '06-22 她答应老贺下周三（=07-01）前寄画册', due: '07-01', owed: true }, { now: T + 1 }).ok);
  assert.ok(openOp(m, { action: 'add', content: '06-20 他说想换个机械键盘' }, { now: T + 2 }).ok);
  assert.equal(openOp(m, { action: 'add', content: '06-20 他说想换个机械键盘' }, { now: T + 3 }).note, 'already there');
  assert.equal(m.open[1].saidAt, T + 3, 'said again: touched');
  assert.match(openOp(m, { action: 'add', content: '记住密码 abc' }).error, /secret/);
  assert.equal(m.open[0].due, '2026-07-01');
  assert.equal('owed' in m.open[0], false);
  for (let i = 0; i < 30; i++) openOp(m, { action: 'add', content: `第 ${i} 件很长很长很长很长很长很长的事情要做` }, { now: T + 10 + i });
  assert.equal(m.open.length, 32, 'all kept, whatever the display budget');
  assert.ok(openOp(m, { action: 'replace', oldText: '键盘', content: '06-24 他说周六（=06-27）去买键盘', due: '06-27', owed: true }, { now: T + 50 }).ok);
  assert.equal(m.open[1].saidAt, T + 50);
  assert.equal('owed' in m.open[1], false);
  for (const action of ['shelve', 'restore']) {
    const r = openOp(m, { action, oldText: '键盘' });
    assert.ok(r.ok && /no longer exist/.test(r.note), `${action}: a note, nothing moved`);
  }
  assert.equal(m.open.length, 32);
  assert.ok(openOp(m, { action: 'done', oldText: '老贺' }).ok);
  assert.match(openOp(m, { action: 'done', oldText: '不存在' }).error, /no item/);
  assert.equal(cleanDue('2026-7-1'), '2026-07-01'); assert.equal(cleanDue('月底'), ''); assert.equal(cleanDue('02-30'), '');
  assert.equal(cleanDue('01-06', new Date(2026, 11, 20).getTime()), '2027-01-06', 'a January date said in December is next year');
  assert.ok(jaccard('参考文献还没弄', '还差参考文献') > 0);
  assert.equal(search([{ text: '他下周六搬家' }, { text: '猫叫团子' }], '搬家')[0].text, '他下周六搬家');
});

test('还没了的事 expire by code: a dated item a few days after its day, one without a date after days untouched', () => {
  const day = (d, h = 12) => new Date(2026, 5, d, h, 0).getTime();
  const m = emptyMemory();
  openOp(m, { action: 'add', content: '06-01 她答应老贺 06-10 寄画册', due: '06-10' }, { now: day(1) });
  openOp(m, { action: 'add', content: '06-01 他说想换个机械键盘' }, { now: day(1) });
  openOp(m, { action: 'add', content: '06-01 他说想去看海' }, { now: day(1) });
  openOp(m, { action: 'add', content: '06-01 他说想去看海' }, { now: day(10) }); // brought up again on 06-10
  assert.equal(expireOpen(m, { now: day(13, 23) }), 0, 'three days past its day: still kept');
  assert.equal(expireOpen(m, { now: day(14, 0) + 1 }), 1, 'the fourth: gone');
  assert.equal(expireOpen(m, { now: day(15) }), 0, 'fourteen days untouched: still kept');
  assert.equal(expireOpen(m, { now: day(16) }), 1);
  assert.deepEqual(m.open.map((x) => x.text), ['06-01 他说想去看海'], 'touched on 06-10: it lives longer');
  assert.equal(expireOpen(m, { now: day(25) }), 1);
  // the windows are settings
  openOp(m, { action: 'add', content: '06-01 他说想学吉他', due: '06-02' }, { now: day(1) });
  assert.equal(expireOpen(m, { now: day(3), keepAfterDue: 0 }), 1);
  // the consolidation lets run-out items go after its own operations
  openOp(m, { action: 'add', content: '06-01 他说想学吉他' }, { now: day(1) });
  const r = applyExtraction(m, { open: [{ action: 'add', content: '06-20 他说周末去看房', due: null, owed: true }, { action: 'shelve', oldText: '吉他' }] }, { now: day(20), keepIdle: 7 });
  assert.equal(r.expired, 1);
  assert.equal(r.errors.length, 0, 'shelve from an old prompt: ignored, no error');
  assert.deepEqual(m.open.map((x) => x.text), ['06-20 他说周末去看房']);
  assert.equal('owed' in m.open[0], false);
});

test('今天到期的: only what is due today and has not come up today, above the rest; overdue ones sit first in the list; at most five, outside the budget', () => {
  const T = new Date(2026, 5, 22, 20, 0).getTime();
  const m = emptyMemory();
  for (let i = 0; i < 12; i++) openOp(m, { action: 'add', content: `第 ${i} 件很长很长很长很长很长很长很长很长的事情要做` }, { now: T + i });
  openOp(m, { action: 'add', content: '06-20 她答应老贺 06-22 寄画册', due: '06-22' }, { now: T - 2 * 864e5 }); // the oldest: would not fit the list
  openOp(m, { action: 'add', content: '06-18 他说 06-20 交报告', due: '06-20' }, { now: T - 4 * 864e5 });
  openOp(m, { action: 'add', content: '06-10 他说 06-18 体检', due: '06-18' }, { now: T - 12 * 864e5 }); // four days past: gone
  openOp(m, { action: 'add', content: '06-21 他说 06-25 搬家', due: '06-25' }, { now: T - 864e5 });
  const limits = { ...DEFAULT_LIMITS, open: 120 };
  const s = renderStanding(m, { now: T, limits });
  assert.match(s, /## 今天到期的[^\n]*\n- 06-20 她答应老贺 06-22 寄画册（到 06-22）\n## 还没了的事[^\n]*\n- 06-18 他说 06-20 交报告（到 06-20）\n- 06-21 他说 06-25 搬家（到 06-25）\n- 第 11 件/);
  assert.doesNotMatch(s, /体检/);
  assert.equal(s, renderStanding(m, { now: T + 3600000, limits }), 'byte-stable within the day');
  // brought up on its day (a replace, said again): back in the list
  openOp(m, { action: 'replace', oldText: '老贺', content: '06-20 她答应老贺 06-22 寄画册，今天说了在打包', due: '06-22' }, { now: T });
  const after = renderStanding(m, { now: T + 1, limits });
  assert.doesNotMatch(after, /## 今天到期的/);
  assert.match(after, /## 还没了的事[^\n]*\n- 06-18 他说 06-20 交报告[^\n]*\n- 06-20 她答应老贺[^\n]*（到 06-22）\n- 06-21 他说 06-25 搬家/);
  // touched before the day does not count; the next day it is no longer in the section
  openOp(m, { action: 'add', content: '06-21 他说 06-23 去银行', due: '06-23' }, { now: T });
  openOp(m, { action: 'replace', oldText: '银行', content: '06-21 他说 06-23 上午去银行', due: '06-23' }, { now: T });
  assert.match(renderStanding(m, { now: T + 864e5, limits }), /## 今天到期的[^\n]*\n- 06-21 他说 06-23 上午去银行（到 06-23）\n## /);
  assert.doesNotMatch(renderStanding(m, { now: T + 2 * 864e5, limits }), /## 今天到期的/);
  // at most five; the rest go to the list
  const n = emptyMemory();
  for (let d = 0; d < 6; d++) openOp(n, { action: 'add', content: `${['给老贺寄画册', '给罗姐交报告', '去店里取眼镜', '还钱给知遥', '去牙科洗牙', '修厨房水龙头'][d]}`, due: '06-24' }, { now: T + d });
  openOp(n, { action: 'add', content: '去银行办卡', due: '06-23' }, { now: T });
  const v = openView(n, { now: new Date(2026, 5, 24, 9).getTime() });
  assert.deepEqual(v.today.map((x) => x.text), ['给老贺寄画册', '给罗姐交报告', '去店里取眼镜', '还钱给知遥', '去牙科洗牙']);
  assert.deepEqual(v.list.map((x) => x.text), ['去银行办卡', '修厨房水龙头'], 'yesterday\'s and the sixth are in the list');
});

test('还没了的事 due the same day: a reworded add counts as already there (Jaccard 0.55); different errands that day, or the same words another day, do not', () => {
  const T = new Date(2026, 9, 8, 21, 0).getTime();
  const m = emptyMemory();
  openOp(m, { action: 'add', content: '10-08 他打算明天（=10-09）上午先把甲方剩下的意见理一理，能改的先改。', due: '10-09' }, { now: T });
  const r = openOp(m, { action: 'add', content: '10-08 他打算明天（=10-09）把甲方剩下的意见理一理，能改的先改。', due: '10-09' }, { now: T + 5 });
  assert.equal(r.note, 'already there');
  assert.equal(m.open[0].saidAt, T + 5);
  openOp(m, { action: 'add', content: '10-08 他打算明天（=10-09）顺路买猫粮。', due: '10-09' }, { now: T });
  openOp(m, { action: 'add', content: '10-08 他打算明天（=10-09）早起排节点。', due: '10-09' }, { now: T });
  assert.equal(m.open.length, 3, 'two errands sharing the 明天 template (0.52) stay two');
  openOp(m, { action: 'add', content: '10-08 他打算明天（=10-10）上午先把甲方剩下的意见理一理。', due: '10-10' }, { now: T });
  assert.equal(m.open.length, 4, 'another day: the strict rule');
});

test('还没了的事 shown: dated first by the nearest day, then the newest; the budget limits what is shown, never what is kept', () => {
  const T = new Date(2026, 5, 1, 20, 0).getTime();
  const m = emptyMemory();
  openOp(m, { action: 'add', content: '06-01 他说想去看海' }, { now: T });
  openOp(m, { action: 'add', content: '06-01 他说 06-20 搬家', due: '06-20' }, { now: T + 1 });
  openOp(m, { action: 'add', content: '06-01 他说想学吉他' }, { now: T + 2 });
  openOp(m, { action: 'add', content: '06-01 他说 06-09 体检', due: '06-09' }, { now: T + 3 });
  const all = openView(m, { now: T }).list.map((x) => x.text);
  assert.deepEqual(all, ['06-01 他说 06-09 体检', '06-01 他说 06-20 搬家', '06-01 他说想学吉他', '06-01 他说想去看海']);
  const few = openView(m, { now: T, limits: { ...DEFAULT_LIMITS, open: 40 } }).list.map((x) => x.text);
  assert.deepEqual(few, ['06-01 他说 06-09 体检', '06-01 他说 06-20 搬家']);
  assert.equal(m.open.length, 4, 'stored all the same');
  assert.doesNotMatch(renderStanding(m, { now: T, limits: { ...DEFAULT_LIMITS, open: 40 } }), /吉他|看海/);
  assert.equal(search(m.open, '吉他')[0].text, '06-01 他说想学吉他', 'what is not shown is still found');
});

test('the consolidation sees 还没了的事 as she is shown them (today first, then the list within the budget), not every stored one; a done that matches nothing fails softly', async () => {
  const h = harness({ llmReply: JSON.stringify({ open: [{ action: 'done', oldText: '没有这一条' }, { action: 'replace', oldText: '也没有', content: '随便写点什么东西' }] }) });
  const { mkdirSync } = await import('node:fs');
  const dir = join(h.home, 'memory'); mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const due = (d) => { const t = new Date(now + d * 864e5); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const open = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `o${String(i + 1).padStart(4, '0')}`, text: `第 ${i} 件很长很长很长很长很长的事情要做`, at: now - (30 - i) * 60000, due: '' })),
    { id: 'o0031', text: '他说今天交报告', at: now - 5 * 864e5, due: due(0) },
    { id: 'o0032', text: '他说过几天搬家', at: now - 5 * 864e5, due: due(5) },
  ];
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({ ...emptyMemory(), open, oseq: 32 }));
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, limits: { open: 100 } });
  h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '在吗' }] }, { surfaceOp: 'append' });
  const r = await h.services.dotMemory.consolidate({ reason: 'manual' });
  assert.ok(r.ok);
  assert.equal(r.report.errors.length, 2, 'unmatched done / replace: errors in the report, nothing thrown');
  const ask = h.calls[0].messages[0].content[0].text;
  const part = ask.split('=== 已有：还没了的事 ===\n')[1].split('\n=== ')[0].split('\n');
  assert.equal(part[0], '- 他说今天交报告（到 ' + dayMark(new Date(`${due(0)}T00:00:00`).getTime()) + '）', 'due today first');
  assert.match(part[1], /^- 他说过几天搬家/, 'then the dated ones');
  assert.match(part[2], /^- 第 29 件/, 'then the newest');
  assert.ok(part.length < 8, 'within the budget');
  assert.doesNotMatch(ask, /第 0 件/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).open.length, 32, 'all still stored');
});

test('0.23 memory.json: the shelf is folded into 还没了的事 (and runs out like the rest), owed is dropped; the tool notes shelve / restore are gone', async () => {
  const now = Date.now();
  const legacy = { version: 2, gen: 4, owner: [], self: [], people: {}, merges: [], oseq: 3,
    open: [{ id: 'o0001', text: '她答应陪他看新番', at: now - 864e5, due: '', owed: true }],
    shelved: [{ id: 'o0002', text: '他说想换个机械键盘', at: now - 2 * 864e5, due: '', owed: false, shelvedAt: now }, { id: 'o0003', text: '很久以前的一件事', at: now - 60 * 864e5, due: '', owed: true, shelvedAt: now - 30 * 864e5 }] };
  const m = normalizeMemory(legacy);
  assert.equal('shelved' in m, false);
  assert.deepEqual(m.open.map((x) => x.id), ['o0001', 'o0002', 'o0003']);
  assert.ok(m.open.every((x) => !('owed' in x) && !('shelvedAt' in x)));
  const h = harness();
  const { mkdirSync } = await import('node:fs');
  const dir = join(h.home, 'memory'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.json'), JSON.stringify(legacy));
  apply(h.ctx, { home: h.home });
  const saved = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'));
  assert.deepEqual(saved.open.map((x) => x.id), ['o0001', 'o0002'], 'the long-untouched one ran out on load');
  assert.equal('shelved' in saved, false);
  assert.doesNotMatch(readFileSync(join(dir, 'memory.md'), 'utf8'), /搁着的（|答应过/);
  assert.equal('shelved' in h.services.dotMemory.status(), false);
  assert.doesNotMatch(await h.services.dotMemory.command('memory'), /shelved/);
  const tool = h.tools.memory;
  assert.deepEqual(tool.parameters.properties.action.enum, ['add', 'replace', 'remove', 'done']);
  assert.equal('owed' in tool.parameters.properties, false);
  for (const action of ['shelve', 'restore']) {
    const r = await tool.execute({ target: 'open', action, oldText: '键盘' });
    assert.ok(r.ok && /没有了/.test(r.note));
  }
  const r = await tool.execute({ target: 'open', action: 'add', content: '06-22 她答应老贺寄画册', owed: true });
  assert.ok(r.ok);
  const added = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).open.at(-1);
  assert.equal(added.text, '06-22 她答应老贺寄画册'); assert.equal('owed' in added, false);
});

test('extraction: 还没了的事, people (new seen ones from apps); loose JSON', () => {
  const m = emptyMemory();
  const a = touchPerson(m, { handles: ['qq:42'], platform: 'qq', name: '阿满', tier: 'talked' });
  const out = parseLooseJson('好的：```json\n' + JSON.stringify({
    owner: [{ action: 'add', content: '他讨厌被叫全名' }],
    self: [{ action: 'add', content: '学会了在小黑盒里看攻略帖' }],
    open: [{ action: 'add', content: '10-25 他说晚上要加班到十点，让她别等', due: null, owed: false }, { action: 'done', oldText: '没有这条' }],
    people: [{ id: 'u0001', impression: '爱发猫图' }, { platform: 'xiaoheihe', name: '暮看云', tier: 'seen', impression: '写长帖的' }, { name: '不认识的人' }],
  }) + '\n```');
  const r = applyExtraction(m, out);
  assert.deepEqual([r.open, r.done, r.people], [1, 0, 2]);
  assert.match(r.errors[0], /open: no item/);
  assert.deepEqual([m.owner, m.self], [[], []], 'owner / self are the daily call\'s');
  assert.equal(m.open[0].due, '');
  assert.equal(a.impression, '爱发猫图');
  assert.equal(findPerson(m.people, 'xiaoheihe:name:暮看云').tier, 'seen');
  assert.equal(Object.keys(m.people).length, 2, 'a name with no platform and no card is not invented');
  assert.match(renderHandoff([{ at: 0, who: 'owner', text: '在吗' }, { at: 0, who: 'her', to: 'owner', text: '在' }], 2), /第 2 段[\s\S]*最后几句[\s\S]*他：在吗[\s\S]*我：在/);
  assert.match(transcriptLine({ at: 0, who: 'her', to: 'user:9', text: 'hi' }), /我（发给 user:9）：hi/);
  // the rules come first (the same prefix every call), the new records last
  const ask = extractPrompt({ text: '[06-22 20:00] 他：在吗', open: '- 06-20 他说想换键盘' });
  assert.ok(ask.startsWith('你在帮她整理记忆'));
  assert.ok(ask.indexOf('他说想换键盘') < ask.indexOf('=== 这段时间的记录 ==='));
  assert.ok(ask.trimEnd().endsWith('他：在吗'));
});

test('consolidation: a done counts only when the record it read mentions the item; otherwise it stays and goes by itself', () => {
  const m = emptyMemory();
  const now = new Date(2026, 8, 7, 13, 0).getTime();
  for (const content of ['09-05 他给汤团下单了猫饮水机，快递（=09-07）到驿站，她说先让机器空转两天', '09-06 他答应霜霜周三（=09-09）一起去吃老幺面馆的热米皮'])
    applyExtraction(m, { open: [{ action: 'add', content, due: null }] }, { now });
  const segment = '[09-07 12:40] 他：霜霜说周三有事，老幺面馆那顿米皮改下周了\n[09-07 12:41] 我：行，那就下周';
  const r = applyExtraction(m, { open: [{ action: 'done', oldText: '猫饮水机' }, { action: 'done', oldText: '热米皮' }] }, { now, segment });
  assert.equal(r.done, 1);
  assert.match(r.errors[0], /^open: done skipped, the record read does not mention it: 09-05 他给汤团下单了猫饮水机/);
  assert.deepEqual(m.open.map((x) => x.text.slice(0, 5)), ['09-05'], 'the one never mentioned is kept');
  // dates, numbers and common words do not count as mentioning it
  assert.ok(touchShare('09-05 他给汤团下单了猫饮水机', '今天 09-05，他下单了') < TOUCH_MIN);
  assert.ok(touchShare('09-05 他给汤团下单了猫饮水机', '饮水机到了，汤团闻了闻') >= TOUCH_MIN);
  // without a segment (her own memory tool, mid-conversation) a done is taken as given
  assert.equal(openOp(m, { action: 'done', oldText: '猫饮水机' }).ok, true);
  assert.equal(m.open.length, 0);
});

test('consolidation: no owner / self — the prompt carries no bank (schema, rules or entries); owner / self in a reply are ignored without error', () => {
  const m = emptyMemory();
  m.owner = ['他住光谷，养了一只猫'];
  m.self = ['每天晚上逛小黑盒'];
  const r = applyExtraction(m, {
    owner: [{ action: 'remove', oldText: '光谷' }, { action: 'add', content: '他不吃香菜，一点都不行' }],
    self: [{ action: 'replace', oldText: '小黑盒', content: '每天晚上逛小黑盒和 B 站' }],
  });
  assert.deepEqual(r.errors, []);
  assert.deepEqual([m.owner, m.self], [['他住光谷，养了一只猫'], ['每天晚上逛小黑盒']]);
  assert.equal('owner' in r || 'self' in r, false);
  const ask = extractPrompt({ text: '[06-22 20:00] 他：在吗', known: 'u0002 · 阿满 · qq:42 · talked', open: '- 06-20 他说想换键盘' });
  assert.doesNotMatch(ask, /"owner"|"self"|- owner：|- self：|已有：关于他|她自己记下的|别的记忆插件/);
  assert.match(ask, /每天晚上另有一次整理，这里不用写。\n/);
  assert.match(ask, /\n\n=== 已认识的人 ===\nu0002[^\n]*\n=== 已有：还没了的事 ===\n- 06-20 他说想换键盘\n\n=== 这段时间的记录 ===/, 'the people (more stable) before 还没了的事 (changes nearly every call)');
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
  const calls = [], warns = [];
  const ctx = {
    logger: () => ({ info() {}, warn: (m) => warns.push(m), error() {} }),
    on: (name, fn) => { if (name === 'session/event') listeners.push(fn); },
    effect(fn) { effects.push(fn()); },
    get: (n) => services[n],
    provide(n, v) { services[n] = v; },
    inject(deps, fn) { fn({ systemPrompt: { context: (c) => contexts.push(c) }, tools: { register: (t) => { tools[t.name] = t; return () => {}; } }, effect: (f) => f(), on: (...a) => ctx.on(...a) }); },
    llm: { stream: (opts) => { calls.push(opts); return (async function* () { yield { type: 'text-delta', text: reply(opts) }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'deepseek-v4-flash' }) },
  };
  const emit = (id, type, data, extra = {}) => listeners.forEach((fn) => fn({ id, header: { cwd: home } }, { type, data, ...extra }));
  return { ctx, home, services, contexts, tools, injected, archived, audit, calls, warns, emit, effects, recallEmbedder: charEmbedder, get session() { return session; }, set tokens(n) { tokens = n; }, get frozen() { return [frozen, released]; } };
}
const msg = (text) => ({ message: { content: [{ type: 'text', text }] } });
const say = (h, text) => { h.emit('s1', 'turn/start', {}); h.emit('s1', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' }); h.emit('s1', 'assistant/message', msg('嗯')); h.emit('s1', 'turn/end', {}); };

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
  const reply = JSON.stringify({ open: [{ action: 'add', content: '他问她搬家那天能不能帮忙，还没定时间', owed: false }] });
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
  assert.match(ctxText, /还没了的事[^\n]*\n- 他问她搬家那天/);
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
  const h = harness({ llmReply: JSON.stringify({ open: [{ action: 'add', content: '他说下周搬家，还没说搬哪' }] }) });
  h.services.sessionQuery = { readSession: async () => ({ events }) };
  apply(h.ctx, { home: h.home });
  const r = await h.services.dotMemory.consolidate({ reason: 'manual' });
  assert.ok(r.ok);
  assert.match(h.calls[0].messages[0].content[0].text, /他：我下周搬家[\s\S]*我：搬哪/);
  assert.equal(h.services.dotMemory.status().open, 1);
});

test('passwords and keys never enter memory; phone numbers and verification codes do', () => {
  for (const t of ['手机 QQ 号 1234567890 / 密码 Example99', 'api key 是 sk-xxx', 'GitHub token ghp_xxx']) assert.equal(rejectReason(t), 'secret', t);
  for (const t of ['他的手机号 13800000000', '他给了验证码 4321，登录成功了', '他的小黑盒玩家号 21873448']) assert.equal(rejectReason(t), '', t);
  // His work is about agents: talk of tokens, context windows and prompts is ordinary — not a secret, not plumbing.
  for (const t of ['他在做 dsh 插件，担心长上下文和 token 消耗', '他说提示词要少写找补的话', '他的记忆模块交班阈值定在 15 万 token']) assert.equal(rejectReason(t), '', t);
  for (const t of ['他的 access token 是 abc', 'bot token 换了', '密钥在 .env 里是 xyz', 'ghp_abcdefgh12345']) assert.equal(rejectReason(t), 'secret', t);
  assert.equal(rejectReason('这轮我调用了 phone 工具看了一眼'), 'meta');
  const m = emptyMemory();
  const r = applyExtraction(m, { open: [{ action: 'add', content: 'QQ 密码是 abc123，等他说登录成功没' }, { action: 'add', content: '他给了验证码 4321，等他说登录成功没' }] });
  assert.equal(m.open.length, 1);
  assert.match(bankOp(['他的 QQ 是 12345'], { action: 'replace', oldText: 'QQ', content: '他的 QQ 密码是 abc123' }, 100).error, /secret/, 'nor in a replace');
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
  const h = harness({ llmReply: JSON.stringify({ diary: '今天没什么事。晚上在小黑盒看了几个角色卡帖，有一个写记忆的挺细，记下了。他没来。' }) });
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
  assert.match(h.calls[0].messages[0].content[0].text, /^这是她每天一次的收拾[\s\S]*=== 今天的记录（\d{4}-\d{2}-\d{2} 周.）===\n[^\n]*他：在吗/);
  assert.equal(h.services.dotMemory.status().sinceCursor, 2, 'the diary is not a consolidation');
  const diary = readFileSync(join(h.home, 'memory', 'diary.md'), 'utf8');
  assert.match(diary, /^## \d{4}-\d{2}-\d{2} 周.\n今天没什么事。/);
  h.services.dotMemory.consolidate = undefined;
  const m = emptyMemory(); m.self.push('每天晚上刷一会儿小黑盒');
  const status = await h.services.dotMemory.command('memory');
  assert.match(status, /diary \d{4}-\d{2}-\d{2} \(daily at 23:30\)/);
  assert.deepEqual(h.services.dotMemory.forInterlude(), [], 'the interlude gets what she knows about him; nothing yet');
});

test('coexist auto: another memory service present → owner/self notes not in the prompt; people and 还没了的事 kept', async () => {
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
  const h = harness({ llmReply: JSON.stringify({ diary: '他说下周六搬家，我问他搬去哪。', owner: [{ action: 'add', content: '他下周六搬家，搬去光谷' }] }) });
  h.services.hermesMemory = {};
  apply(h.ctx, { home: h.home, coexist: 'full', consolidateEveryLines: 1000 });
  say(h, '下周六我搬家');
  await wait(20);
  await h.services.dotMemory.diary();
  assert.match(h.calls[0].messages[0].content[0].text, /=== 关于他（现在 0 字/);
  assert.match(h.contexts[0].text({ agent: { session: { id: 's1', header: { cwd: h.home } } } }), /关于他\n- 他下周六搬家，搬去光谷/);
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
  // 05-08 2026 is a Friday: 明天 05-09, 下周三 05-13; what she said today is dated too, what she said yesterday is not
  assert.equal(transcriptLine({ at: thisYear, who: 'owner', text: '明天去，下周三回，她说后天也行，昨天她说下周五' }, { now }), '[05-08 09:05] 他：明天（=05-09）去，下周三（=05-13）回，她说后天（=05-10）也行，昨天（=05-07）她说下周五');
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

test('persona lives only in the Canon: the daily call keeps persona and 「照着某某学」 out of self', () => {
  const text = dailyPrompt({ day: '2026-11-03 周二', text: '我：照着星野那版学', banks: { owner: [], self: ['拼出来的人设：蓝发'] } });
  assert.match(text, /她自己那一栏记她学会了什么、习惯、看法（人设、说话风格、「照着某某学」不算）/);
  assert.match(text, /- 拼出来的人设：蓝发/, 'existing entries are shown as they are, not migrated');
});

test('0.19 memory migrates: open fragments become 还没了的事 (all of them), pinned ones join the owner bank, the rest archived', async () => {
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
  assert.equal(m.open.length, 62, 'none cut, none shelved');
  assert.equal('shelved' in m, false);
  const { report, archive } = m.migration;
  assert.equal(report.open.length, 62);
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
  assert.match(readFileSync(join(dir, 'memory-migration.md'), 'utf8'), /62 件进了第三栏/);
  assert.ok(h.audit.some((e) => e.event === 'migrated'));
});

test('review fixes: an unreadable or unmigratable memory.json is copied aside, never overwritten', async () => {
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

// ── the daily call: the diary and the banks ──
const fill = async (h, bank, lines) => { for (const content of lines) assert.ok((await h.tools.memory.execute({ target: bank, action: 'add', content })).ok); };
const OWNER = ['他叫宽，在广州做 agent 开发', '快递后天到，记得提醒他', '他不喜欢被叫全名', '他喜欢猫'];
const readJsonl = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('her memory tool: a full bank refuses an add and tells her to replace an entry that matters less; a replace still goes in', async () => {
  const h = harness();
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, limits: { owner: 30 } });
  await fill(h, 'owner', OWNER.slice(0, 1));
  const r = await h.tools.memory.execute({ target: 'owner', action: 'add', content: OWNER[1] });
  assert.equal(r.ok, true);
  assert.equal(r.usage, '30/30 chars');
  const o = await h.tools.memory.execute({ target: 'owner', action: 'add', content: OWNER[2] });
  assert.equal(o.ok, false);
  assert.equal(o.error, '这一栏满了（30/30 字），没记上：要记这条，用 replace 换掉一条现在不那么要紧的（过去了的一次性的事，或同一件事的旧说法）。');
  assert.equal(o.entries.length, 2);
  const x = await h.tools.memory.execute({ target: 'owner', action: 'replace', oldText: '快递', content: OWNER[2] });
  assert.equal(x.ok, true); assert.equal(x.usage, '27/30 chars');
  assert.match(h.tools.memory.description, /满了加不进去：要记新的，先用 replace 换掉一条现在不那么要紧的。/);
  assert.doesNotMatch(h.tools.memory.description, /整理|照样记下/);
  const ctxText = h.contexts[0].text({ agent: { session: { id: 's1', header: { cwd: h.home } } } });
  assert.match(ctxText, /关于他\n- 他叫宽[^\n]*\n- 他不喜欢被叫全名\n/);
  assert.match(readFileSync(join(h.home, 'memory', 'memory.md'), 'utf8'), /## 关于你（27\/30 chars）/);
  assert.match(await h.services.dotMemory.command('memory'), /owner 27\/30 chars ·/);
  assert.ok(!h.audit.some((e) => e.event === 'memory-tool' && 'over' in e));
  const p = await h.services.dotMemory.panel();
  assert.deepEqual([p.owner.chars, p.owner.limit], [27, 30]);
});

const banksOf = (h) => { const m = JSON.parse(readFileSync(join(h.home, 'memory', 'memory.json'), 'utf8')); return JSON.stringify([m.owner, m.self]); };

test('daily run, nothing lasting: both banks shown, no ops in the reply → byte-identical, the diary written; nothing that day → no call', async () => {
  for (const reply of [{}, { owner: [], self: [] }]) {
    const h = harness({ llmReply: JSON.stringify({ diary: '今天他问了一句在吗，我说在。别的没什么。', ...reply }) });
    apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, limits: { owner: 1000 } });
    await fill(h, 'owner', OWNER);
    assert.match(await h.services.dotMemory.command('memory diary'), /not run: nothing happened today/);
    assert.equal(h.calls.length, 0);
    say(h, '在吗');
    await wait(20);
    const before = banksOf(h);
    const out = await h.services.dotMemory.command('memory diary');
    assert.equal(h.calls.length, 1);
    const lines = readJsonl(join(h.home, 'memory', 'transcript.jsonl'));
    const ask = h.calls[0].messages[0].content[0].text;
    assert.ok(ask.startsWith('这是她每天一次的收拾'));
    assert.match(ask, /多数日子今天没有要一直记着的新东西，两栏都是 \[\]/);
    assert.doesNotMatch(ask, /一字不改|一整栏|"rewrite"/);
    assert.ok(ask.endsWith(`=== 关于他（现在 44 字，上限 1000）===\n${OWNER.map((e) => `- ${e}`).join('\n')}\n=== 她自己记下的（现在 0 字，上限 2200）===\n（空）\n=== 今天的记录（${dayLabel(new Date())}）===\n${lines.map((l) => transcriptLine(l)).join('\n')}`), ask.slice(-600));
    assert.equal(banksOf(h), before, 'banks byte-identical');
    assert.match(readFileSync(join(h.home, 'memory', 'diary.md'), 'utf8'), /\n今天他问了一句在吗，我说在。别的没什么。\n/);
    assert.doesNotMatch(out, /owner:|self:/);
  }
});

test('daily run: the reply carries ops — adds and replaces applied in order; one that does not apply is skipped with a warning, the rest go in', async () => {
  const h = harness({ llmReply: JSON.stringify({ diary: '他说他搬去武昌了，想养猫。', owner: [
    { action: 'replace', oldText: '喜欢猫', content: '他喜欢猫，最近还想养一只' },
    { action: 'replace', oldText: '北京', content: '他在北京' }, // matches nothing
    { action: 'add', content: '他搬去了武昌，离公司近' },
    { action: 'add', content: '他不喜欢被叫全名' }, // already there
    '他叫宽，在广州做 agent 开发', // a bare line (the old full-bank shape): not an op
    { action: 'remove', oldText: '快递' }, // not the daily call's
  ] }) });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, limits: { owner: 70 } });
  await fill(h, 'owner', OWNER);
  await fill(h, 'self', ['每天晚上逛小黑盒']);
  say(h, '我搬去武昌了');
  await wait(20);
  const self = JSON.stringify(JSON.parse(readFileSync(join(h.home, 'memory', 'memory.json'), 'utf8')).self);
  const r = await h.services.dotMemory.diary();
  assert.deepEqual(h.services.dotMemory.forInterlude(), ['他叫宽，在广州做 agent 开发', '快递后天到，记得提醒他', '他不喜欢被叫全名', '他喜欢猫，最近还想养一只', '他搬去了武昌，离公司近'].map((e) => `关于他：${e}`));
  assert.equal(JSON.stringify(JSON.parse(readFileSync(join(h.home, 'memory', 'memory.json'), 'utf8')).self), self, 'self untouched');
  assert.equal(r.banks.owner, '+1 added, 1 replaced, 3 skipped → 64/70 chars');
  assert.equal(r.banks.self, undefined);
  assert.equal(h.warns.filter((w) => /daily: owner op skipped/.test(w)).length, 3);
  assert.ok(h.warns.some((w) => /op skipped \(no entry contains "北京"\)/.test(w)));
  assert.ok(h.audit.some((e) => e.event === 'daily-op-skipped' && e.bank === 'owner' && e.errors.length === 3));
  // the next day it has 6 characters of room: its header says it is full and asks for a replace
  say(h, '在吗');
  await wait(20);
  await h.services.dotMemory.diary();
  const next = h.calls[1].messages[0].content[0].text;
  assert.match(next, /=== 关于他（现在 64 字，上限 70，满了）：这一栏满了，要记新的，就用 replace 换掉[^\n]*===\n- 他叫宽/);
  assert.match(next, /=== 她自己记下的（现在 9 字，上限 2200）===\n/);
  assert.doesNotMatch(next, /重写|"rewrite"/);
});

test('daily run, a full bank: an add that does not fit is skipped with a warning and an audit event; a replace in the same reply still goes in', async () => {
  const h = harness({ llmReply: JSON.stringify({ diary: '他说他换了工作。', owner: [
    { action: 'add', content: '他换到了深圳的一家公司' },
    { action: 'replace', oldText: '快递', content: '他在深圳上班' },
  ], self: [{ action: 'add', content: '我学会了看天气预报' }] }) });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, limits: { owner: 44 } });
  await fill(h, 'owner', OWNER);
  say(h, '我换工作了');
  await wait(20);
  const r = await h.services.dotMemory.diary();
  assert.match(h.calls[0].messages[0].content[0].text, /=== 关于他（现在 44 字，上限 44，满了）：/);
  assert.equal(r.banks.owner, '+0 added, 1 replaced, 1 skipped → 39/44 chars');
  assert.equal(r.banks.self, '+1 added, 0 replaced → 10/2200 chars', 'the other bank as usual');
  assert.ok(h.warns.some((w) => /daily: owner op skipped \(over the limit \(56\/44 chars\)/.test(w)));
  assert.ok(h.audit.some((e) => e.event === 'daily-op-skipped' && e.bank === 'owner' && e.errors.length === 1 && /^over the limit/.test(e.errors[0])));
  assert.deepEqual(h.services.dotMemory.forInterlude(), ['他叫宽，在广州做 agent 开发', '他在深圳上班', '他不喜欢被叫全名', '他喜欢猫'].map((e) => `关于他：${e}`));
});

test('daily run: a reply that is not JSON leaves the banks as they are and writes no diary; the day is done', async () => {
  const h = harness({ llmReply: '今天他来问了一句在吗，就这些。' });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, limits: { owner: 44 } });
  await fill(h, 'owner', OWNER);
  say(h, '在吗');
  await wait(20);
  const r = await h.services.dotMemory.diary();
  assert.deepEqual(r.banks, {});
  assert.equal(r.diary, '', 'no JSON, no diary to take from it');
  assert.equal(h.services.dotMemory.forInterlude().length, 4);
  assert.match(await h.services.dotMemory.command('memory'), /diary \d{4}-\d{2}-\d{2}/);
});

test('daily run, a day longer than inputChars: one call per part, oldest first, each seeing the banks as the last left them; nothing skipped; the diary from the last', async () => {
  let n = 0;
  const h = harness({ llmReply: () => { n++; return JSON.stringify({ diary: `第 ${n} 段的日记，他说了不少话。`, owner: [{ action: 'add', content: `他第 ${n} 段里说了一件长久的事` }] }); } });
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, inputChars: 200 });
  for (let i = 0; i < 8; i++) say(h, `第 ${i} 句话，${'他说了很多很多的话'.repeat(2)}`);
  await wait(20);
  const r = await h.services.dotMemory.diary();
  const lines = readJsonl(join(h.home, 'memory', 'transcript.jsonl'));
  assert.ok(h.calls.length >= 3, `${h.calls.length} calls`);
  const parts = h.calls.map((c) => c.messages[0].content[0].text.split(/=== 今天的记录（[^\n]*）===\n/)[1]);
  for (const p of parts) assert.ok(p.length <= 200, 'each part within inputChars');
  assert.equal(parts.join('\n'), lines.map((l) => transcriptLine(l)).join('\n'), 'every line read once, in order');
  for (let k = 1; k < h.calls.length; k++) assert.match(h.calls[k].messages[0].content[0].text, new RegExp(`- 他第 ${k} 段里说了一件长久的事\n=== 她自己记下的`), 'the banks as the call before left them');
  assert.equal(h.services.dotMemory.forInterlude().length, h.calls.length);
  assert.equal(r.diary, `第 ${h.calls.length} 段的日记，他说了不少话。`);
  assert.equal((readFileSync(join(h.home, 'memory', 'diary.md'), 'utf8').match(/^## /gm) ?? []).length, 1, 'one diary for the day');
  assert.match(r.banks.owner, new RegExp(`^(\\+1 added, 0 replaced → \\d+/1375 chars; ){${h.calls.length - 1}}\\+1 added`));
});

test('daily run, people-only (another memory plugin owns the banks): diary only — no banks shown, owner / self in the reply ignored', async () => {
  const h = harness({ llmReply: JSON.stringify({ diary: '他说下周六搬家。', owner: [{ action: 'add', content: '他下周六搬家' }], self: [{ action: 'add', content: '我喜欢猫' }] }) });
  h.services.hermesMemory = {};
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000 });
  say(h, '下周六我搬家');
  await wait(20);
  const r = await h.services.dotMemory.diary();
  const ask = h.calls[0].messages[0].content[0].text;
  assert.match(ask, /\n=== 关于他 \/ 她自己记下的：由别的记忆插件负责，这次只写 diary，owner 和 self 都给 \[\] ===\n=== 今天的记录（[^\n]*）===\n[^\n]*他：下周六/);
  assert.doesNotMatch(ask, /（现在 \d+ 字/);
  assert.equal(r.diary, '他说下周六搬家。');
  assert.deepEqual(r.banks, {});
  assert.deepEqual([h.services.dotMemory.forInterlude(), h.services.dotMemory.herLife()], [[], []]);
});

test('daily run: a bank over its limit and nothing that day → no call, nothing dropped; a tidy.jsonl and an override of the old rewrite prompt left from before change nothing', async () => {
  const h = harness({ llmReply: () => JSON.stringify({ diary: '今天他问了一句在吗。', rewrite: { owner: ['他叫宽'] } }) });
  const stale = `${JSON.stringify({ at: '0', bank: 'owner', before: [], after: [] })}\n`;
  mkdirSync(join(h.home, 'memory'), { recursive: true });
  mkdirSync(join(h.home, 'prompts'), { recursive: true });
  writeFileSync(join(h.home, 'memory', 'tidy.jsonl'), stale);
  writeFileSync(join(h.home, 'prompts', 'memory.daily.rewrite.txt'), '整栏重写到 {target} 字');
  writeFileSync(join(h.home, 'memory', 'memory.json'), JSON.stringify({ ...emptyMemory(), owner: OWNER }));
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, limits: { owner: 40 } });
  assert.deepEqual(await h.services.dotMemory.diary({ reason: 'daily' }), { skipped: 'nothing happened today' });
  assert.equal(h.calls.length, 0);
  say(h, '在吗');
  await wait(20);
  const r = await h.services.dotMemory.diary();
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(h.calls[0].messages[0].content[0].text, /整栏重写|\{target\}/);
  assert.equal(r.diary, '今天他问了一句在吗。');
  assert.deepEqual(h.services.dotMemory.forInterlude(), OWNER.map((e) => `关于他：${e}`), 'a "rewrite" in the reply is ignored');
  assert.equal(readFileSync(join(h.home, 'memory', 'tidy.jsonl'), 'utf8'), stale, 'the old undo trail is neither read nor written');
  assert.doesNotMatch(await h.services.dotMemory.command('memory'), /tidy/);
});

test('a home whose bank an earlier build left over its limit: shown in full, nothing dropped; adds refused until replaces and removes bring it under', async () => {
  const h = harness();
  const old = Array.from({ length: 6 }, (_, i) => `他第 ${i} 件一直为真的事，写得比较长一些`);
  mkdirSync(join(h.home, 'memory'), { recursive: true });
  writeFileSync(join(h.home, 'memory', 'memory.json'), JSON.stringify({ ...emptyMemory(), owner: old }));
  apply(h.ctx, { home: h.home, consolidateEveryLines: 1000, limits: { owner: 50 } });
  const at = { agent: { session: { id: 's1', header: { cwd: h.home } } } };
  assert.match(h.contexts[0].text(at), new RegExp(`关于他\n${old.map((e) => `- ${e}`).join('\n')}\n`), 'all of it in front of her');
  assert.doesNotMatch(h.warns.join('\n'), /limit/);
  assert.match(await h.services.dotMemory.command('memory'), /owner 126\/50 chars ·/);
  const add = await h.tools.memory.execute({ target: 'owner', action: 'add', content: '他喜欢猫' });
  assert.equal(add.ok, false); assert.match(add.error, /^这一栏满了（126\/50 字），没记上/);
  assert.equal((await h.tools.memory.execute({ target: 'owner', action: 'replace', oldText: '第 0 件', content: '他喜欢猫' })).ok, true, 'a shorter replace');
  for (const i of [1, 2, 3, 4]) assert.equal((await h.tools.memory.execute({ target: 'owner', action: 'remove', oldText: `第 ${i} 件` })).ok, true);
  assert.equal(h.services.dotMemory.forInterlude().length, 2);
  assert.equal((await h.tools.memory.execute({ target: 'owner', action: 'add', content: '他不喜欢被叫全名' })).ok, true, 'under the limit again: adds go in');
});
