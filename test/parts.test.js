// dsh-dot/persona/parts: her card in parts, and who reads which.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardFor, cutCard } from '../src/persona/parts.js';

const CARD = '# 你是 小点\n\n## 你是谁\n住在屏幕里。\n\n## 和他的关系\n他造了你。\n\n## 怎么说话\n1. 一句短的。\n\n## 说话的样子\n他：喂\n你：嗯呐？';

test('parts: the card is cut by its headings; who she is goes to both, how she talks to the voice alone', () => {
  assert.deepEqual(Object.keys(cutCard(CARD)), ['who.md', 'voice.md', 'examples.md']);
  assert.deepEqual(cutCard('没有标题的一张卡'), { 'who.md': '没有标题的一张卡' });
  const home = mkdtempSync(join(tmpdir(), 'parts-'));
  writeFileSync(join(home, 'persona.md'), CARD);
  const decide = cardFor(home, 'decide', CARD), say = cardFor(home, 'say', CARD);
  assert.equal(decide, '# 你是 小点\n\n## 你是谁\n住在屏幕里。\n\n## 和他的关系\n他造了你。');
  assert.match(say, /^# 你是 小点[\s\S]*## 怎么说话\n1\. 一句短的。\n\n## 说话的样子\n他：喂\n你：嗯呐？$/);
  assert.ok(existsSync(join(home, 'persona', 'who.md')) && existsSync(join(home, 'persona', 'examples.md')));
  // who reads what is one word in the list; a part he adds is a file and a line
  const list = join(home, 'persona', 'parts.json');
  const parts = JSON.parse(readFileSync(list, 'utf8'));
  parts.find((p) => p.file === 'examples.md').for = ['decide', 'say'];
  parts.push({ file: 'likes.md', for: ['decide'] });
  writeFileSync(list, JSON.stringify(parts)); writeFileSync(join(home, 'persona', 'likes.md'), '## 喜欢\n水豚');
  const later = new Date(Date.now() + 5000); utimesSync(list, later, later);
  assert.match(cardFor(home, 'decide', CARD), /说话的样子[\s\S]*## 喜欢\n水豚$/);
  assert.doesNotMatch(cardFor(home, 'say', CARD), /水豚/);
  // a part edited in its own file is what is read
  writeFileSync(join(home, 'persona', 'voice.md'), '## 怎么说话\n只说一个字。'); utimesSync(list, later, later);
  assert.match(cardFor(home, 'say', CARD), /只说一个字。/);
  // the whole card written again (a new canon, an edit of persona.md): cut again, his choices of who reads what kept
  const NEW = CARD.replace('住在屏幕里。', '住在网线里。');
  writeFileSync(join(home, 'persona.md'), NEW); const newer = new Date(Date.now() + 10000); utimesSync(join(home, 'persona.md'), newer, newer);
  assert.match(cardFor(home, 'decide', NEW), /住在网线里。[\s\S]*说话的样子[\s\S]*水豚/);
  // no card at all: nothing (the caller renders the canon as before)
  assert.equal(cardFor(mkdtempSync(join(tmpdir(), 'parts-')), 'say', ''), '');
});
