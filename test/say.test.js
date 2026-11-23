// dsh-dot/say: what she says is written by a call that is only her card, and leaves by one way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSay, parseSaid, sayInput } from '../src/dot/say.js';

test('say: what the call wrote is what goes out — lines, stickers she has, faces, or nothing', () => {
  const has = (id) => id === '31d44003ce';
  assert.deepEqual(parseSaid('醒啦\n\n我在呢'), { lines: ['醒啦', '我在呢'], images: [], silent: false });
  assert.deepEqual(parseSaid('[不回]'), { lines: [], images: [], silent: true });
  assert.deepEqual(parseSaid('好\n[不回]').lines, ['好'], 'beside a line it is nothing');
  assert.deepEqual(parseSaid('你看看这个\n[表情包 sticker:31d44003ce 开心猫]', { has }), { lines: ['你看看这个'], images: ['sticker:31d44003ce'], silent: false });
  assert.deepEqual(parseSaid('[表情包 sticker:deadbeef00]', { has }), { lines: [], images: [], silent: false }, 'a sticker she does not have is not sent');
  assert.deepEqual(parseSaid('停了 [表情包 sticker:31d44003ce]\n[face:178]', { has }), { lines: ['停了'], images: ['sticker:31d44003ce', 'face:178'], silent: false }, 'a marker inside a line is taken out of it');
  assert.deepEqual(parseSaid('[表情包 [sticker:31d44003cece 开心猫]\n都停啦', { has }).lines, ['都停啦'], 'a marker gone wrong is not said');
  assert.deepEqual(parseSaid('住这儿的人路过\n[表情包 sticker:31d44003ce]\n[face:14]', { has, pictures: false }), { lines: ['住这儿的人路过'], images: [], silent: false }, 'a place that takes words only');
});

test('say: the one message the call is given — her stickers first, the conversation as it went, what is in her hands, what she knows', () => {
  const text = sayInput({ dialogue: [{ who: 'owner', text: '开机' }, { who: 'her', text: '醒啦\n我在呢' }, { who: 'owner', text: '在干嘛呀' }], stickers: [{ id: '31d44003ce', note: '开心猫' }], facts: ['你手上没有在做的事，这一轮也没有开始做任何事'], about: '刚把余额提醒脚本写好了' });
  assert.match(text, /^（你的表情包夹里现在有：sticker:31d44003ce 开心猫。要发就单独一行写 \[表情包 sticker:编号\]。QQ 小表情单独一行写 \[face:编号\]：14 微笑[^\n]*）\n\n（你和他在 QQ 上刚才的对话，最后一句是他刚发的）\n他：开机\n你：醒啦 \/ 我在呢\n他：在干嘛呀\n\n（你手上没有在做的事，这一轮也没有开始做任何事）\n（你自己想说的意思：刚把余额提醒脚本写好了）\n（下面写你这次发给他的消息，一行一条，平时一句就够[^\n]*不想回就只写 \[不回\]。）$/);
  assert.match(sayInput({ stickers: [], facts: ['x'] }), /^（你的表情包夹现在是空的。/);
  assert.doesNotMatch(sayInput({ dialogue: [{ who: 'owner', text: '好' }], stickers: [], facts: ['x'] }), /你自己想说的意思/, 'nothing to tell: no such line');
  assert.match(sayInput({ dialogue: [{ who: 'owner', text: '好' }], stickers: [], facts: ['x'], unprompted: true }), /（你和他在 QQ 上最近的对话）[\s\S]*（他这会儿没说话，是你有事要告诉他。/);
  const typed = sayInput({ about: '想说自己就住在 DSH 里', where: '小黑盒一条帖子的评论框，所有人都看得到' });
  assert.equal(typed, '（你自己想说的意思：想说自己就住在 DSH 里）\n（小黑盒一条帖子的评论框，所有人都看得到。这里发不了表情包。下面只写要打上去的原话；不想写就只写 [不回]。）');
});

function harness({ replies = [], unread = () => false, checks = /综上所述/ } = {}) {
  const calls = [], sent = [], audits = [];
  const say = createSay({
    card: () => '# 你是 小点\n话不多。',
    call: async (o) => { calls.push(o); return replies.shift() ?? ''; },
    recent: () => [{ who: 'owner', text: '在吗' }],
    stickers: () => [{ id: '31d44003ce', note: '开心猫' }],
    check: (text) => ({ lines: String(text).split('\n').map((l) => l.replace(/（[^）]*）/g, '').trim()).filter(Boolean), hits: checks.test(text) ? ['综上所述'] : [] }),
    unread, send: async (m) => { sent.push(m); return { said: m.text.split('\n').filter(Boolean), images: m.images }; },
    audit: (event, data) => audits.push({ event, ...data }),
  });
  return { say, calls, sent, audits };
}

test('say: the call is her card and nothing else; what it writes is sent, checked once on the way', async () => {
  const h = harness({ replies: ['在的\n[表情包 sticker:31d44003ce]'] });
  const r = await h.say.speak({ about: '', facts: ['你手上没有在做的事，这一轮也没有开始做任何事'] });
  assert.deepEqual(h.calls.map((c) => c.system), ['# 你是 小点\n话不多。'], 'the system prompt is the card, whole and alone');
  assert.match(h.calls[0].text, /他：在吗\n\n（你手上没有在做的事，这一轮也没有开始做任何事）/);
  assert.deepEqual(h.sent, [{ to: 'owner', text: '在的', images: ['sticker:31d44003ce'] }]);
  assert.deepEqual(r, { status: 'said', said: ['在的'], images: ['sticker:31d44003ce'] });
  // a line the check catches is written once more; the second goes as it is, with what the check takes out taken out
  const again = harness({ replies: ['综上所述，在的', '（探头）综上所述 在'] });
  await again.say.speak();
  assert.equal(again.calls.length, 2);
  assert.deepEqual(again.sent[0].text, '综上所述 在');
  assert.ok(again.audits.some((e) => e.event === 'say-rewritten'));
  // pictures her thinking asked for go with it, also with no words
  const pic = harness({ replies: ['[不回]'] });
  assert.equal((await pic.say.speak({ images: ['phone:screen'] })).status, 'said');
  assert.deepEqual(pic.sent, [{ to: 'owner', text: '', images: ['phone:screen'] }]);
});

test('say: silence is hers to choose; his unread words come first — before it is written, and once more after', async () => {
  const quiet = harness({ replies: ['[不回]'] });
  assert.deepEqual(await quiet.say.speak(), { status: 'silent' });
  assert.equal(quiet.sent.length, 0);
  const held = harness({ replies: ['好'], unread: () => true });
  assert.deepEqual(await held.say.speak(), { status: 'held' });
  assert.equal(held.calls.length, 0, 'nothing is written while he has said something she has not read');
  let spoke = false;
  const late = harness({ replies: ['好'], unread: () => spoke });
  late.calls.push = function (o) { spoke = true; return Array.prototype.push.call(this, o); }; // he speaks while it is being written
  assert.deepEqual(await late.say.speak(), { status: 'held' });
  assert.equal(late.sent.length, 0, 'what was written for the moment before is not sent');
  assert.equal((await harness({ replies: ['好'], unread: () => true }).say.speak({ to: 'group:1' })).status, 'held');
  // a failure is said as one, not as silence
  const broken = createSay({ card: () => '', call: async () => '好', recent: () => [], stickers: () => [], check: (t) => ({ lines: [t], hits: [] }), send: async () => ({}) });
  assert.deepEqual(await broken.speak(), { status: 'failed', why: 'no persona card' });
});

test('say: words for her hands to type are written the same way — the card, no pictures, nothing of the chat with him', async () => {
  const h = harness({ replies: ['住这儿的人路过\n[表情包 sticker:31d44003ce]'] });
  assert.equal(await h.say.compose({ about: '想说自己就住在 DSH 里', where: '小黑盒一条帖子的评论框' }), '住这儿的人路过');
  assert.doesNotMatch(h.calls[0].text, /表情包夹|他：在吗|你手上/);
  assert.equal(h.sent.length, 0, 'composed, not sent: her hands type it');
  assert.equal(await harness({ replies: ['[不回]'] }).say.compose({ about: 'x' }), '');
});
