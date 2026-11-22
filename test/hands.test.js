// dsh-dot/hands: a whole thing is given and not waited for; its end, or a question of theirs, is what reaches her.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHands } from '../src/dot/hands.js';
import { createLedger, headTail } from '../src/dot/ledger.js';

function harness(opts = {}) {
  const listeners = new Set(), sent = [], cancelled = [], kv = new Map(opts.kv ?? []), audits = [], done = [], asked = [], retired = [];
  let n = 0;
  const agents = new Map();
  const dir = join(mkdtempSync(join(tmpdir(), 'hands-')), 'hands');
  const store = { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) };
  const ledger = createLedger({ store });
  const hands = createHands({
    dir, ledger,
    create: async () => { const id = `h${++n}`; agents.set(id, { followup: (m) => sent.push([id, m]), cancel: (c) => cancelled.push([id, c.reason]) }); return id; },
    agentFor: async (id) => agents.get(id) ?? null,
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    message: (text) => text, textOf: (c) => c,
    store, done: () => 'MISSING',
    onDone: (r, j) => done.push([r, j]), onAsk: (r, j) => asked.push([r, j]), retire: (id) => retired.push(id),
    audit: (event, data) => audits.push({ event, ...data }), ...opts,
  });
  const emit = (id, type, data) => { for (const fn of [...listeners]) fn({ id }, { type, data }); };
  return { hands, ledger, sent, cancelled, emit, audits, kv, dir, done, asked, retired, listeners };
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('hands: a thing starts at once and is not waited for; nothing comes back until it is over — done by their own word, with a summary and details', async () => {
  const h = harness({ maxChars: 12 });
  assert.deepEqual(h.hands.start({ device: 'phone', task: '打开贴吧，说说首页有什么', forHim: true }), { status: 'started', id: 't1' });
  await tick();
  assert.deepEqual(h.sent, [['h1', '打开贴吧，说说首页有什么']]);
  assert.ok(h.hands.busy() && h.hands.isHands('h1') && h.hands.isHands('', join(h.dir, 'x')) && !h.hands.isHands('s1', '/home/her'));
  h.emit('h1', 'tool/call'); h.emit('h1', 'tool/call');
  h.emit('h1', 'tool/result', { message: { content: '显卡又涨价了，纯纯坐牢' } }); h.emit('h1', 'tool/result', { message: { content: [{ text: '猫把杯子推下去了' }] } });
  h.emit('h1', 'assistant/message', { message: { content: '我先看看' } });
  assert.deepEqual([h.hands.doing().task, h.hands.doing().state, h.hands.doing().said, h.hands.doing().steps], ['打开贴吧，说说首页有什么', 'running', '我先看看', 2]);
  // one pair of hands, one thing at a time: a second waits its turn
  const queued = h.hands.start({ device: 'phone', task: '再做一件' });
  assert.deepEqual([queued.status, queued.id, queued.doing.task], ['queued', 't2', '打开贴吧，说说首页有什么']);
  assert.deepEqual(h.ledger.unfinished().map((e) => [e.id, e.state, e.asker]), [['t1', 'running', 'him'], ['t2', 'queued', 'her']]);
  assert.equal(h.done.length, 0, 'nothing reaches her while it is under way');
  // done is their word, with their tool: it ends there, the run is stopped (nothing more to say)
  assert.equal(h.hands.finish({ summary: '首页三个帖子：显卡、猫、游戏', detail: '首页有三个帖子：第一个讲显卡，第二个讲猫' }), true);
  const [r, j] = h.done[0];
  assert.deepEqual([r.outcome, r.by, r.steps, r.rounds, r.summary, r.detail], ['done', 'code', 2, 1, '首页三个帖子：显卡、猫、游戏', headTail('首页有三个帖子：第一个讲显卡，第二个讲猫', 12)]);
  assert.match(r.shown, /纯纯坐牢[\s\S]*猫把杯子推下去了/, 'what the screen showed them, in full: what a line she keeps is checked against');
  assert.deepEqual(j, { id: 't1', session: 'h1', device: 'phone', task: '打开贴吧，说说首页有什么', forHim: true });
  await tick();
  assert.deepEqual(h.cancelled[0], ['h1', 'dot-hands: done']);
  assert.deepEqual(h.retired, ['h1'], 'the session is put away with the thing');
  const e = h.ledger.get('t1');
  assert.deepEqual([e.state, e.outcome, e.steps, e.summary, e.detail, e.session], ['ended', 'done', 2, r.summary, r.detail, 'h1'], 'on the book: facts, not a sentence for anyone');
  h.emit('h1', 'turn/end', { reason: { kind: 'aborted' } });
  assert.equal(h.done.length, 1, 'the cancelled run ending late is nothing');
  // the one that waited is done next, by hands of its own
  await tick();
  assert.deepEqual([h.hands.doing().task, h.hands.doing().id, h.sent.at(-1)[0]], ['再做一件', 't2', 'h2']);
  h.emit('h2', 'assistant/message', { message: { content: '做了', }, usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 3 } });
  assert.deepEqual(h.ledger.get('t2').tokens, { in: 10, cached: 90, out: 3 }, 'what it cost is on the book');
  // a run over without their tool is told once to finish properly; still nothing: nobody can tell what came of it
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } });
  await tick();
  assert.deepEqual(h.sent.at(-1), ['h2', 'MISSING'], 'told once, in the same run');
  assert.equal(h.done.length, 1);
  h.emit('h2', 'assistant/message', { message: { content: '做完了' } });
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } });
  assert.deepEqual([h.done.at(-1)[0].outcome, h.done.at(-1)[0].cause, h.done.at(-1)[0].detail, h.ledger.get('t2').outcome], ['failed', 'no-result', '做完了', 'failed']);
  assert.ok(!h.hands.busy() && h.hands.doing() === null && h.listeners.size === 0);
  assert.equal(h.hands.finish({ summary: 'x' }), false, 'nothing under way');
});

test('hands: each thing gets hands that have seen nothing else — what was stopped before is not theirs to pick up', async () => {
  const h = harness();
  h.hands.start({ device: 'phone', task: '点右上角的放大镜' }); await tick();
  assert.equal(h.hands.stop({ by: 'her' }), true);
  h.hands.start({ device: 'phone', task: '打开相册' }); await tick();
  assert.deepEqual(h.sent.map(([id]) => id), ['h1', 'h2']);
  // the stopped one's turn ends late: it is not the new thing's end
  h.emit('h1', 'turn/end', { reason: { kind: 'aborted' } });
  assert.ok(h.hands.busy() && h.done.length === 1 && h.done[0][0].outcome === 'stopped');
  assert.ok(h.hands.isHands('h1') && h.hands.isHands('h2'), 'the old one is still her hands');
  h.hands.finish({ summary: '相册开了' });
  assert.deepEqual(h.done.map(([r]) => r.outcome), ['stopped', 'done']);
  assert.deepEqual(h.ledger.recent(2).map((e) => [e.outcome, e.by]), [['done', 'code'], ['stopped', 'her']]);
});

test('hands: they need her — said with their tool, the thing ends there as stuck; what she adds to a thing under way is read between two steps', async () => {
  const h = harness();
  assert.equal(h.hands.ask('问什么'), false, 'nothing under way: nothing to ask about');
  h.hands.start({ device: 'phone', task: '去那个站挑几张猫的贴图存下来', forHim: true }); await tick();
  h.emit('h1', 'tool/call');
  h.emit('h1', 'assistant/message', { message: { content: '这页有三张猫的贴图，你想存哪几张？' } });
  h.hands.finish({ summary: '这页有三张猫的贴图', detail: '你想存哪几张？' });
  assert.equal(h.done[0][0].outcome, 'done', 'a question in the prose of a report is a report: nobody reads "needs her" out of words');
  h.hands.start({ device: 'phone', task: '去那个站挑几张猫的贴图存下来', forHim: true }); await tick();
  assert.equal(h.hands.ask('这页有三张：竖大拇指的猫、喝咖啡的猫、发呆的猫。存哪几张？'), true);
  assert.ok(h.hands.asked(), 'asked, the run not yet over');
  h.emit('h2', 'assistant/message', { message: { content: '停在猫的贴图页' } });
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } });
  const [q, job] = h.done[1];
  assert.deepEqual([q.outcome, q.question, q.detail, job.forHim], ['stuck', '这页有三张：竖大拇指的猫、喝咖啡的猫、发呆的猫。存哪几张？', '停在猫的贴图页', true]);
  assert.equal(h.hands.finish({ summary: 'x' }), false, 'once asked, not done');
  assert.ok(!h.hands.busy(), 'nothing waits half-open: her hands are free');
  const e = h.ledger.get(job.id);
  assert.deepEqual([e.state, e.outcome, e.question, e.detail], ['ended', 'stuck', q.question, '停在猫的贴图页']);
  // what she decides is a new thing, which knows which one it carries on
  const next = h.hands.start({ device: 'phone', task: '喝咖啡的那张，备注写「续命」', forHim: true, after: job.id }); await tick();
  assert.deepEqual([h.ledger.get(next.id).after, h.sent.at(-1)[0]], [job.id, 'h3']);
  // one more thing for the hands at work
  assert.equal(h.hands.has('再存一张发呆的'), false);
  assert.deepEqual(h.hands.add('再存一张发呆的'), { status: 'added', id: next.id });
  await tick();
  assert.deepEqual(h.sent.at(-1), ['h3', '再存一张发呆的'], 'into the run under way');
  assert.ok(h.hands.has('再存一张发呆的') && h.hands.has('续命'), 'what she added is hers to type from, like the task');
  assert.deepEqual(h.ledger.get(next.id).added, ['再存一张发呆的']);
  h.hands.finish({ summary: '存好了' });
  assert.deepEqual([h.done[2][0].outcome, h.done[2][0].summary], ['done', '存好了']);
  assert.deepEqual(h.hands.add('还有一张'), { status: 'idle' }, 'nothing under way: nothing to add to');
  const { handsStatus } = await import('../src/dot/core.js');
  assert.match(handsStatus(q), /卡在一个要你定的地方/);
});

test('hands: stopped (by whom), too long, ended by someone else, broke off; what a restart cut off is told once', async () => {
  const h = harness({ maxMs: 30 });
  h.hands.start({ task: '登录' });
  await tick();
  assert.deepEqual(h.ledger.unfinished().map((e) => e.task), ['登录'], 'on the book while it is under way');
  h.emit('h1', 'assistant/message', { message: { content: '停在验证码' } });
  assert.equal(h.hands.stop({ by: 'her' }), true);
  assert.deepEqual([h.done[0][0].outcome, h.done[0][0].by, h.done[0][0].cause, h.done[0][0].detail], ['stopped', 'her', 'stopped', '停在验证码']);
  await tick();
  assert.deepEqual(h.cancelled[0], ['h1', 'dot-hands: stopped']);
  assert.deepEqual(h.ledger.unfinished(), []);
  assert.equal(h.hands.stop(), false, 'nothing under way');
  // stop is for everything in her hands: what waited goes with what was under way; his /dot stop is a command
  h.hands.start({ task: '甲' }); h.hands.start({ task: '乙' }); await tick();
  assert.equal(h.hands.stop({ by: 'him', cause: 'command' }), true);
  assert.deepEqual(h.ledger.recent(2).map((e) => [e.task, e.outcome, e.by, e.cause]), [['乙', 'stopped', 'him', 'command'], ['甲', 'stopped', 'him', 'command']]);
  h.done.splice(1); await tick();
  h.hands.start({ task: '第二件' });
  await tick(60);
  assert.deepEqual([h.done[1][0].outcome, h.done[1][0].cause, h.ledger.recent(1)[0].outcome], ['timeout', 'timeout', 'timeout']);
  h.hands.start({ task: '第三件' });
  await tick(); h.emit(h.sent.at(-1)[0], 'turn/end', { reason: { kind: 'aborted' } });
  assert.deepEqual([h.done[2][0].outcome, h.done[2][0].cause], ['failed', 'interrupted'], 'not done, and not hers to answer');
  assert.equal(h.hands.start({ task: '' }).status, 'failed');
  // the run broke (the model call failed): not a thing done, and what it said on the way is not its result
  h.hands.start({ task: '第四件' }); await tick();
  const hid = h.sent.at(-1)[0];
  h.emit(hid, 'assistant/message', { message: { content: [{ type: 'text', text: '我先打开看看' }, { type: 'tool-call', name: 'x' }] } });
  h.emit(hid, 'turn/end', { reason: { kind: 'error', error: { message: 'Failed to parse the request body as JSON' } } });
  assert.deepEqual([h.done.at(-1)[0].outcome, h.done.at(-1)[0].cause, h.done.at(-1)[0].detail], ['failed', 'broke-off', undefined]);
  assert.match(h.done.at(-1)[0].error, /^Failed to parse/);
  assert.deepEqual(h.hands.interrupted(), []);
  // a restart in the middle: the next start of the plugin finds it, tells it once, and the old single session is still her hands
  const again = harness({ kv: [['handsThing', { device: 'phone', task: '存贴图', forHim: true, startedAt: 1 }], ['handsSession', 'old1'], ['handsPast', ['old0']]] });
  assert.ok(again.hands.isHands('old0') && again.hands.isHands('old1') && !again.hands.busy());
  assert.equal(again.kv.get('handsThing'), null);
  // a thing the book had as under way when the plugin starts was cut by the restart: ended as such, told once
  const kv = new Map(); const first = createLedger({ store: { get: (k) => kv.get(k), set: (k, v) => kv.set(k, v) } });
  first.begin(first.open({ asker: 'him', device: 'phone', task: '存贴图' }));
  const after = harness({ kv: [...kv] });
  assert.deepEqual(after.hands.interrupted().map((e) => [e.task, e.asker, e.outcome, e.cause]), [['存贴图', 'him', 'failed', 'restart']]);
  assert.deepEqual(after.hands.interrupted(), []);
});

test('hands: what they type is hers or was shown to them — never their own words', async () => {
  const { ownWords } = await import('../src/dot/core.js');
  const h = harness();
  assert.equal(h.hands.has('随便'), false, 'no round: nothing was given');
  h.hands.start({ device: 'phone', task: '在这条帖子下面评论「笑死 这也行」，然后搜 瓦罗兰特' });
  await tick();
  assert.ok(h.hands.has('笑死 这也行') && h.hands.has('笑死这也行') && h.hands.has('瓦罗兰特'), 'her words, whitespace aside');
  assert.equal(h.hands.has('哈哈确实，我也这么觉得'), false);
  h.emit('h1', 'tool/result', { message: { content: '登录名 15625040795 密码 Abc-123456' } });
  assert.ok(h.hands.has('15625040795') && h.hands.has('Abc-123456'), 'what a tool showed them (an account, the screen)');
  const has = h.hands.has;
  assert.deepEqual(ownWords('笑死 这也行', has), []);
  assert.deepEqual(ownWords('tieba.baidu.com', has), [], 'an address is not words');
  assert.deepEqual(ownWords('https://www.bilibili.com/v/popular', has), []);
  assert.deepEqual(ownWords('笑死 这也行\n哈哈确实', has), ['哈哈确实']);
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } });
});

test('hands: how a thing ended is worded for each reader from the facts — for her (with the screen), for the voice (facts only)', async () => {
  const { handsStatus, voiceHow } = await import('../src/dot/core.js');
  assert.match(handsStatus({ outcome: 'done' }), /^手收尾了——成没成看结果/);
  assert.match(handsStatus({ outcome: 'done' }, 'web'), /查没查到/);
  assert.match(handsStatus({ outcome: 'timeout' }), /太久了.*别当成什么都没做/);
  assert.match(handsStatus({ outcome: 'stopped', by: 'her' }), /被叫停了/);
  assert.match(handsStatus({ outcome: 'stopped', by: 'him' }), /^他叫停的.*到此为止/);
  assert.match(handsStatus({ outcome: 'failed', cause: 'no-session' }), /没能开始或中途断了：手那边的会话没能开起来/);
  assert.match(handsStatus({ outcome: 'failed', cause: 'broke-off', error: '400' }), /做到一半断了（400）/);
  assert.match(handsStatus({ outcome: 'done', notes: ['own-words', 'own-words', 'reply-check'] }), /^手收尾了.*；要打一段你没写的字.*；你写的那句话被退回了/);
  // the voice has no picture and nothing to do: facts in a few words
  assert.deepEqual(['done', 'timeout', 'failed'].map((o) => voiceHow({ outcome: o })), ['', '做太久停下了，可能只做了一部分。', '没做成。']);
  assert.equal(voiceHow({ outcome: 'stopped', by: 'him' }), '他叫停了。');
  assert.equal(voiceHow({ outcome: 'failed', cause: 'restart' }), '没做完，中途被重启打断了。');
  for (const o of ['done', 'timeout', 'stopped', 'failed']) assert.doesNotMatch(voiceHow({ outcome: o }), /图|看/, 'nothing to look at');
  const h = harness();
  h.hands.start({ device: 'phone', task: '回一句' }); await tick();
  h.hands.note('own-words'); h.hands.finish({ summary: '回了' });
  assert.deepEqual(h.done[0][0].notes, ['own-words']);
});


test('hands: a round for him is known as his (the request gate lets it go like her replies); looking something up is a kind of round', async () => {
  const h = harness();
  h.hands.start({ device: 'web', task: '（查资料，不碰手机和电脑）查一下明天的天气', forHim: true }); await tick();
  assert.deepEqual([h.hands.doing().device, h.hands.doing().forHim], ['web', true]);
  h.hands.finish({ summary: '明天多云' });
  h.hands.start({ device: 'phone', task: '看一眼手机' }); await tick();
  assert.equal(h.hands.doing().forHim, false, 'her own business stays behind his');
  h.hands.finish({ summary: '桌面' });
});

test('whom her answer goes to is said by the message that woke her, not read off an id', async () => {
  const { addressed } = await import('../src/dot/core.js');
  assert.equal(addressed({ kind: 'user', rpcId: 'qq-dot-abc' }), 'qq');
  assert.equal(addressed({ kind: 'user', rpcId: 'desk-1' }), 'desk');
  assert.equal(addressed({ kind: 'user' }), 'desk');
  assert.equal(addressed({ kind: 'dsh-dot', form: 'open-nudge', to: 'him' }), 'qq');
  assert.equal(addressed({ kind: 'dsh-dot', form: 'hands-result', for: 'him' }), '', 'her hands coming back on his business wake her; what he hears she says with qq_send');
  assert.equal(addressed({ kind: 'dsh-dot', form: 'hands-result' }), '', 'her own time: hers to speak of or not');
  assert.equal(addressed({ kind: 'dsh-dot', form: 'phone-notification' }), '');
  assert.equal(addressed({ kind: 'schedule' }), '');
});

test('hands: ending is not succeeding — "not reached" is a thing that failed, in their own words; the code can end one as failed (the same error over and over)', async () => {
  const h = harness();
  h.hands.start({ device: 'computer', task: '打开 B 站' }); await tick();
  assert.equal(h.hands.finish({ summary: 'B 站打不开，ERR_CONNECTION_CLOSED', detail: '标签页都关了', task: '开B站', reached: false }), true);
  const [r] = h.done.at(-1);
  assert.deepEqual([r.outcome, r.cause, r.summary, r.detail, r.name], ['failed', 'not-reached', 'B 站打不开，ERR_CONNECTION_CLOSED', '标签页都关了', '开B站']);
  await tick();
  assert.deepEqual(h.cancelled.at(-1), ['h1', 'dot-hands: failed'], 'their word ends the run');
  h.hands.start({ device: 'computer', task: '再开一次' }); await tick();
  h.emit('h2', 'assistant/message', { message: { content: '再试一次' } });
  assert.equal(h.hands.fail({ cause: 'same-error', error: 'net::ERR_CONNECTION_CLOSED' }), true);
  const [s] = h.done.at(-1);
  assert.deepEqual([s.outcome, s.cause, s.error, s.detail, h.ledger.get('t2').outcome], ['failed', 'same-error', 'net::ERR_CONNECTION_CLOSED', '再试一次', 'failed']);
  await tick();
  assert.deepEqual(h.cancelled.at(-1), ['h2', 'dot-hands: failed']);
  assert.equal(h.hands.fail({}), false, 'nothing under way');
});
