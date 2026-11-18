import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tooShort, canonToCard, parseBlacklist, phrasePattern, stripStage, checkReply, migrateCanon, readCard, readChecks, checksText } from '../src/persona/card.js';

const CANON = {
  storyDefaults: { characterName: '林夏（小夏）', characterProfile: '22岁的女大学生。', perspective: '第一人称（我）。', relationship: '网上认识两年多的老熟人。', world: '现代日常。', supportingCast: '亲姐林秋。', location: '台北的出租屋。', replyRules: '只输出发出去的消息文本本身。\n一条一行。', style: '叙事文风不进卡' },
  examples: '刚醒\n嗓子好干',
  blacklist: ['公文与说教套话：「首先」「其次」「综上所述」', '端水与句式八股：「不是……而是……」「与其说……不如说」', '油腻AI口癖：绝对禁止说任何带「我认」的短句（「这条我认」）', '客服：「我理解你的感受/焦虑」'],
};

test('canonToCard: the canon\'s sentences as they are, under our headings; no blacklist, no narrator style', () => {
  const card = canonToCard(CANON);
  assert.match(card, /^# 你是 林夏（小夏）\n/);
  for (const s of ['22岁的女大学生。', '第一人称（我）。', '网上认识两年多的老熟人。', '亲姐林秋。', '现代日常。', '台北的出租屋。', '只输出发出去的消息文本本身。\n一条一行。', '刚醒\n嗓子好干']) assert.ok(card.includes(s), s);
  assert.ok(!card.includes('首先') && !card.includes('我认') && !card.includes('叙事文风不进卡'));
  assert.deepEqual([...card.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['你是谁', '和他的关系', '身边的人和地方', '怎么说话', '说话的样子']);
  assert.equal(canonToCard(null), '');
  assert.equal(canonToCard({ storyDefaults: {} }), '');
});

test('parseBlacklist: quoted phrases of a canon line, one phrase a line of a checks file; …… spans a short stretch', () => {
  const ps = parseBlacklist(CANON.blacklist);
  assert.deepEqual(ps.map((p) => p.phrase), ['首先', '其次', '综上所述', '不是……而是……', '与其说……不如说', '我认', '这条我认', '我理解你的感受']);
  const re = phrasePattern('不是……而是……');
  assert.ok(re.test('这不是偷懒而是战略休息'));
  assert.ok(!re.test('不是吧。\n而是什么'));
  assert.deepEqual(parseBlacklist('# 注释\n首先\n\n不是……而是……\n').map((p) => p.phrase), ['首先', '不是……而是……']);
  assert.deepEqual(parseBlacklist(''), []);
  assert.ok(tooShort('我认') && tooShort('……呢') && tooShort('～') && !tooShort('我认了') && !tooShort('记得……哦'));
});

test('stripStage: a bracketed action at either end goes; a bracket inside a sentence, and code, stay', () => {
  assert.equal(stripStage('（低头，把后颈递过去）这里最好摸'), '这里最好摸');
  assert.equal(stripStage('好啦 (笑)'), '好啦');
  assert.equal(stripStage('*叹气* 行吧'), '行吧');
  assert.equal(stripStage('（静静观察着群聊）'), '');
  assert.equal(stripStage('我那个号（旧的那个）登不上了'), '我那个号（旧的那个）登不上了');
  assert.equal(stripStage('await sem.acquire() (限制并发)'), 'await sem.acquire() (限制并发)');
  assert.equal(stripStage('print(x)'), 'print(x)');
  assert.equal(stripStage('看这个 (v2)'), '看这个 (v2)');
});

test('checkReply: lines kept, stage directions counted, blacklisted phrases named', () => {
  const ps = parseBlacklist(CANON.blacklist);
  const r = checkReply('（挠头）\n首先你别急\n\n这不是bug而是特性 (摊手)', ps);
  assert.deepEqual(r.lines, ['首先你别急', '这不是bug而是特性']);
  assert.equal(r.stripped, 2);
  assert.deepEqual(r.hits, ['首先', '不是……而是……']);
  const clean = checkReply('刚醒\n嗓子好干', ps);
  assert.deepEqual(clean, { text: '刚醒\n嗓子好干', lines: ['刚醒', '嗓子好干'], stripped: 0, hits: [] });
  assert.deepEqual(checkReply('（笑）好', ps, { strip: false }).lines, ['（笑）好']);
});

test('migrateCanon: writes the card and the checks once; never over what is there', () => {
  const home = mkdtempSync(join(tmpdir(), 'persona-'));
  assert.deepEqual(migrateCanon(home, null), { card: false, checks: false });
  assert.deepEqual(migrateCanon(home, CANON), { card: true, checks: true });
  assert.equal(readCard(home), canonToCard(CANON).trim());
  // 首先 / 其次 / 我认: too short to check, written commented out
  assert.deepEqual(readChecks(home).map((p) => p.phrase), ['综上所述', '不是……而是……', '与其说……不如说', '这条我认', '我理解你的感受']);
  assert.match(readFileSync(join(home, 'persona.checks.txt'), 'utf8'), /\n# 首先\n# 其次\n# 我认\n$/);
  assert.ok(readFileSync(join(home, 'persona.checks.txt'), 'utf8').startsWith('#'));
  writeFileSync(join(home, 'persona.md'), '# 我自己写的\n');
  assert.deepEqual(migrateCanon(home, CANON), { card: false, checks: false });
  assert.equal(readCard(home), '# 我自己写的');
  const bare = mkdtempSync(join(tmpdir(), 'persona-'));
  assert.deepEqual(migrateCanon(bare, { storyDefaults: { characterName: 'dot' } }), { card: true, checks: false });
  assert.ok(!existsSync(join(bare, 'persona.checks.txt')));
  assert.equal(checksText({}), '');
  assert.equal(readCard(mkdtempSync(join(tmpdir(), 'persona-'))), '');
});
