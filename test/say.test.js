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
  assert.match(text, /^（你的表情包夹里现在有：sticker:31d44003ce 开心猫。要发就单独一行写 \[表情包 sticker:编号\]。QQ 小表情单独一行写 \[face:编号\]：14 微笑[^\n]*）\n\n（你和他在 QQ 上刚才的对话，最后一句是他刚发的）\n他：开机\n你：醒啦 \/ 我在呢\n他：在干嘛呀\n\n（你手上没有在做的事，这一轮也没有开始做任何事）\n（你自己想说的意思：刚把余额提醒脚本写好了）\n（下面写你这次发给他的消息。说多少、怎么说，你自己看场合[^\n]*不想回就只写 \[不回\]。）$/);
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

test('how much she says is hers: no count cuts it; lines she fences are one message, as written', async () => {
  const { parseSaid, tidy, WITHIN, unfold } = await import('../src/dot/say.js');
  const chat = tidy(parseSaid('一\n二\n三\n四\n五\n六（小声）'));
  assert.deepEqual(chat.lines, ['一', '二', '三', '四', '五', '六'], 'six lines of chat are six bubbles; a stage direction is not said');
  const report = tidy(parseSaid('查好了\n```\n分支  dev\n提交  269dc67 (HEAD)\n      37b8176\n\n      1fe8c5e\n```\n就这些'));
  assert.equal(report.lines.length, 3);
  assert.equal(unfold(report.lines[1]), '分支  dev\n提交  269dc67 (HEAD)\n      37b8176\n\n      1fe8c5e', 'the block keeps its lines, its spacing and its brackets');
  assert.ok(report.lines[1].includes(WITHIN) && !report.lines[1].includes('\n'));
  assert.deepEqual(tidy(parseSaid('```text\na\nb')).lines.map(unfold), ['a\nb'], 'a fence left open: what follows is the block');
});

test('a report from the book is said from its sentences, not from the conversation; a figure nobody gave it is written once more, then the sentences go as they are', async () => {
  const { reportInput, unfounded, createSay } = await import('../src/dot/say.js');
  const input = reportInput({ his: '把最近三条提交列给我', must: ['「看提交」做完了。结果：当前分支 dev'], may: ['460d2c7 The voice\n2d26055 Whether'], stickers: [] });
  assert.match(input, /（他刚说：把最近三条提交列给我）\n（把下面【】里的话[^\n]*\n（〔〕里是这件事的细节[^\n]*\n【「看提交」做完了。结果：当前分支 dev】\n〔460d2c7 The voice\n2d26055 Whether〕$/);
  assert.doesNotMatch(input, /刚才的对话/, 'the conversation is not given');
  assert.match(reportInput({ must: ['x'], unprompted: true }), /^（他这会儿没说话，是你有事要告诉他。）/);
  assert.deepEqual(unfounded(['等了 2 分钟，16:50 发的', '分支 dev，460d2c7'], '460d2c7 分支 dev'), ['2', '16:50']);
  assert.deepEqual(unfounded(['好了，在 dev 上'], '当前分支 dev'), []);
  const mk = (replies) => { const sent = [], audits = []; const say = createSay({ card: () => '# 卡', call: async () => replies.shift() ?? '好', recent: () => [{ who: 'owner', text: '以前的话' }], stickers: () => [], check: (t) => ({ lines: String(t).split('\n').filter(Boolean), hits: [] }), send: async (o) => { sent.push(o.text); return { said: o.text.split('\n') }; }, audit: (e, d) => audits.push([e, d]) }); return { say, sent, audits }; };
  const plan = { his: '发了吗', must: ['「发短信」这件事我去做了，现在还在做，还没有结果，有结果了告诉你。'] };
  const ok = mk(['去弄了\n有结果跟你说']);
  await ok.say.speak({ plan });
  assert.deepEqual(ok.sent, ['去弄了\n有结果跟你说']);
  const twice = mk(['发了，16:50 发的', '发了，等了 3 分钟没回']);
  await twice.say.speak({ plan });
  assert.deepEqual(twice.sent, ['「发短信」这件事我去做了，现在还在做，还没有结果，有结果了告诉你。'], 'what cannot be held to the book is not sent: the book\'s own sentence is');
  assert.deepEqual(twice.audits.filter(([e]) => e === 'say-unfounded' || e === 'say-plain').map(([e]) => e), ['say-unfounded', 'say-unfounded', 'say-plain']);
  // of a thing still being done: a reply that says it is over is written once more, then the sentence goes as it is
  const { saysOver } = await import('../src/dot/say.js');
  assert.equal(saysOver(['发了，还在等回音']), true); assert.equal(saysOver(['好，我去发', '有结果了跟你说']), false);
  const over = mk(['发啦\n还没回', '去发了\n有结果跟你说']);
  await over.say.speak({ plan: { ...plan, underway: true } });
  assert.deepEqual(over.sent, ['去发了\n有结果跟你说']);
  const done = mk(['发完了，没回']);
  await done.say.speak({ plan: { his: '发了吗', must: ['「发短信」做完了。结果：发出去了，没回'] } });
  assert.deepEqual(done.sent, ['发完了，没回'], 'of a thing that is over, saying so is the report');
  const once = mk(['发了，16:50 发的', '去弄了']);
  await once.say.speak({ plan });
  assert.deepEqual(once.sent, ['去弄了']);
});
