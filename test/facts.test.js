import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFacts, daysOf, fuse, nearInTime, parseFacts, parsePick } from '../src/memory/facts.js';

const DAY = 86400000;
const at = (s) => new Date(s).getTime();

test('facts: the write call\'s lines are read as time｜fact｜situations; other lines are dropped', () => {
  const stamps = new Map([['06-22 19:40', 111]]);
  const got = parseFacts('06-22 19:40｜老周对花生过敏｜要和老周一起吃饭点菜；想给老周带零食\n- [06-22 19:40] | 老周 07-01 来吃饭 | 明天老周来;买菜;订位;多的一个\n好的，以下是事实条：\n06-23 08:00｜短｜x\n06-23 08:00｜没有情境的一行', stamps, 999);
  assert.deepEqual(got, [
    { at: 111, text: '老周对花生过敏', when: ['要和老周一起吃饭点菜', '想给老周带零食'] },
    { at: 111, text: '老周 07-01 来吃饭', when: ['明天老周来', '买菜', '订位'] },
  ]);
  assert.equal(parseFacts('07-01 10:00｜他把豆浆包子戒了｜问他早饭吃什么', stamps, 999)[0].at, 999, 'a time the batch does not hold falls back to its last line');
});

test('facts: the days a sentence speaks of come from when.js, relative to when it was said', () => {
  const said = at('2026-06-22T19:40:00');
  assert.deepEqual(daysOf('老周下周三过来吃饭', said).map((d) => new Date(d).toISOString().slice(0, 10)), [new Date(2026, 6, 1).toISOString().slice(0, 10)]);
  assert.deepEqual(daysOf('老周对花生过敏', said), []);
});

test('facts: near in time is three days back to fourteen ahead, the nearest first; fuse is by rank', () => {
  const now = at('2026-07-01T12:00:00');
  const facts = [{ days: [now + 10 * DAY] }, { days: [] }, { days: [now + DAY, now + 40 * DAY] }, { days: [now - 2 * DAY] }, { days: [now - 5 * DAY] }];
  assert.deepEqual(nearInTime(facts, now), [2, 3, 0]);
  assert.deepEqual(fuse([[1, 2, 3], [3, 1], [3]]).slice(0, 2), [3, 1]);
  assert.deepEqual(parsePick('想到：……\n编号：3, 1，3、9', 5), [3, 1]);
  assert.deepEqual(parsePick('编号：无', 5), []);
});

function make({ reply, cfg = {}, embed = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'facts-'));
  const calls = [];
  const lines = [];
  const recall = { indexId: () => 'test-emb', embed: async (texts, role, use) => (embed ? embed(texts, role, use) : null) };
  const complete = async (text, reason, o) => { calls.push({ text, reason, o }); return { raw: reply(text, reason) }; };
  const f = createFacts({ cfg: { facts: true, factsShown: 60, factsPicked: 6, ...cfg }, dir, recall, complete, lines: () => lines, logger: { warn: () => {}, info: () => {} } });
  return { f, calls, lines, dir, recall, complete };
}

test('facts: written from his lines of a batch, shown when his words reach them, picked by one foreground call', async () => {
  const t0 = at('2026-06-22T19:40:00');
  const h = make({ reply: (text, reason) => (reason === 'facts' ? '06-22 19:40｜别在别人面前提高姐房贷的事｜想劝高姐一起花钱；高姐在场聊到开销\n06-22 19:41｜汤团一听吹风机就钻床底｜要开吹风机' : '编号：1') });
  const batch = [{ at: t0, who: 'owner', text: '你可别在别人面前提高姐房贷的事' }, { at: t0 + 1000, who: 'her', text: '记住了' }, { at: t0 + 60000, who: 'owner', text: '汤团一听吹风机就钻床底' }];
  h.lines.push(...batch);
  assert.deepEqual(await h.f.write(batch), { ok: true, facts: 2 });
  assert.equal(h.calls[0].reason, 'facts');
  assert.match(h.calls[0].text, /\[06-22 19:40\] 你可别在别人面前提高姐房贷的事\n\[06-22 19:41\] 汤团/, 'his lines only, each with its time');
  assert.doesNotMatch(h.calls[0].text, /记住了/);
  const now = at('2026-07-10T12:00:00');
  await h.f.prepare('s1', '明天大家拼单点外卖，我想劝高姐一起', { now });
  assert.equal(h.calls[1].reason, 'facts-pick');
  assert.deepEqual(h.calls[1].o, { foreground: true }, 'the pick must not wait behind his own turn');
  assert.match(h.calls[1].text, /1\. \[06-22\] 别在别人面前提高姐房贷的事[\s\S]*他刚说】明天大家拼单点外卖/);
  assert.match(h.f.textFor('s1'), /^你记下的相关的事[^\n]*\n- \[06-22\] 别在别人面前提高姐房贷的事$/);
  assert.equal(h.f.pending('s1'), null);
  h.f.clear('s1');
  assert.equal(h.f.textFor('s1'), '');
  // a second instance reads what was written
  const again = createFacts({ cfg: { facts: true }, dir: h.dir, recall: h.recall, complete: h.complete, lines: () => h.lines, logger: { warn: () => {} } });
  assert.equal(again.size, 2);
});

test('facts: off, held (replayed history) and nothing stored make no call; a pick of nothing shows nothing', async () => {
  let h = make({ reply: () => '编号：无', cfg: { facts: false } });
  assert.deepEqual(await h.f.write([{ at: 1, who: 'owner', text: '别提那件事' }]), { skipped: 'off' });
  assert.equal(h.f.prepare('s', '在吗你好呀'), null);
  h = make({ reply: (t, reason) => (reason === 'facts' ? '01-01 08:00｜老周对花生过敏｜和老周吃饭' : '编号：无') });
  await h.f.prepare('s', '老周来吃饭');
  assert.equal(h.calls.length, 0, 'nothing stored: no call');
  await h.f.write([{ at: at('2026-01-01T08:00:00'), who: 'owner', text: '老周对花生过敏' }]);
  h.f.hold(true);
  assert.equal(h.f.prepare('s', '老周来吃饭'), null);
  await h.f.prepare('s', '老周来吃饭', { force: true });
  assert.equal(h.calls.at(-1).reason, 'facts-pick');
  assert.equal(h.f.textFor('s'), '');
});

test('facts: with an embedder, a situation that matches his words outranks a sentence that shares none of them', async () => {
  // toy vectors: one axis per topic
  const axis = (t) => (/(拼单|花钱|外卖)/.test(t) ? [1, 0, 0] : /吹风机/.test(t) ? [0, 1, 0] : [0, 0, 1]);
  const embed = async (texts) => texts.map((t) => Float32Array.from(axis(t)));
  const h = make({ reply: (t, reason) => (reason === 'facts' ? '03-01 08:00｜汤团一听吹风机就钻床底｜要开吹风机\n03-01 08:01｜高姐每月房贷四千二让他别往外说｜想劝高姐一起花钱' : '编号：1'), embed });
  await h.f.write([{ at: at('2026-03-01T08:00:00'), who: 'owner', text: 'x' }, { at: at('2026-03-01T08:01:00'), who: 'owner', text: 'y' }]);
  await h.f.sync();
  const top = await h.f.shortlist('大家拼单点外卖', at('2026-06-01T08:00:00'), 1);
  assert.equal(top[0].text, '高姐每月房贷四千二让他别往外说');
});
