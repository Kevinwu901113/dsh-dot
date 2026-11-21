// dsh-dot/dot + hands: a whole thing goes to her hands; only its end or a question of theirs wakes her; being woken
// is not a message to him; his stop, and her conversation moving on, act on the thing and not on some session's inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, ownerSource } from '../src/dot/core.js';
import { hookTable } from './hooks.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const text = (m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

function harness(cfg = {}) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  writeFileSync(join(dsh, 'dsh-dot-state.json'), '{}');
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const { hooks, add: addHook } = hookTable();
  const listeners = [], effects = [], audit = [], tools = {}, archived = [], qqSent = [], agents = new Map(), llmCalls = [], replies = [], herSaid = [];
  let command, n = 0;
  const agentOf = (id) => { if (!agents.has(id)) agents.set(id, { session: { id, header: { cwd: id.startsWith('h') ? join(dsh, 'dsh-dot-hands') : home } }, got: [], cancels: [], selected: [], model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: agents.get(id).selected.at(-1)?.reasoningEffort ?? 'off' }), select: (sel) => { agents.get(id).selected.push(sel); } }, noted: [], inject(m) { this.noted.push(m); }, followup(m) { this.got.push(m); }, cancel(c) { this.cancels.push(c.reason); } }); return agents.get(id); };
  const services = {
    tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
    commands: { register: (c) => { command = c; return () => {}; } },
    sessionController: { create: async () => ({ sessionId: `h${++n}` }), rename: async () => ({}), resolveAgent: async (id) => ({ agent: agentOf(id) }) },
    agents: { get: (id) => agents.get(id) },
    workspaceRegistry: { archiveSession: async (id) => { archived.push(id); } },
    llm: {
      resolveCallConfig: async (c) => { if (c.reasoningEffort === 'nope') throw Object.assign(new Error('no'), { code: 'UNSUPPORTED_REASONING_EFFORT' }); return c; },
      stream: (o) => (async function* () { llmCalls.push(o); yield { type: 'text-delta', text: replies.shift() ?? '好' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }) },
    dshInterlude: { cardText: () => '# 你是 小点\n话不多。', checks: () => [] },
    dotMemory: { recent: () => [{ who: 'owner', text: '在干嘛呀' }], herSaid: (x) => herSaid.push(x) },
    dshQq: { connected: true, owner: '20002', onMessage: () => () => {}, onTyping: () => () => {}, stickerList: () => [{ id: '31d44003ce', note: '开心猫' }], send: async (to, t, images) => { qqSent.push([to, t, images]); return { sent: 1, said: String(t).split('\n').filter(Boolean), images: images ?? [] }; } },
    dshComputer: { audit: (e) => audit.push(e), status: () => ({ state: 'ready' }), onStatus: () => () => {} },
  };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    on: (name, fn, opts) => { if (name === 'session/event') listeners.push(fn); else addHook(name, fn, opts); },
    effect(fn) { effects.push(fn()); },
    systemPrompt: { context() {}, section() { return () => {}; }, getSectionOrder: () => 0 },
    inject(deps, fn) { if (deps.every((d) => this.get(d))) fn({ ...this, ...Object.fromEntries(deps.map((d) => [d, this.get(d)])) }); },
    get: (name) => (name === 'systemPrompt' ? ctx.systemPrompt : services[name]),
    provide: (name, v) => { services[name] = v; },
  };
  apply(ctx, { home, budgetPollSeconds: 0, notifyBatchMs: 5, ownerQuietMs: 5, ownerMaxWaitMs: 30, awakeHours: '00:00-24:00', ...cfg });
  const emit = (id, type, data) => { const a = agentOf(id); for (const fn of [...listeners]) fn(a.session, { type, data }); };
  emit('s1', 'turn/start', { turn: 1 }); emit('s1', 'turn/end', { turn: 1 }); // her conversation
  const pre = (id, name, input = {}) => hooks['tools/pre-execute']({ name, input, agent: agentOf(id) }, async () => 'ran');
  const shown = (name, v) => tools[name].output.render({}, v)[0].text;
  return { ctx, services, tools, hooks, emit, pre, shown, audit, archived, qqSent, agentOf, llmCalls, replies, herSaid, command: (arg) => command.handler({ rawInput: arg }), stop: () => { for (const d of effects) if (typeof d === 'function') d(); } };
}

test('a thing of his goes to her hands whole; she is woken when they ask and when it is over — and being woken says nothing to him', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  // his words open a turn; she gives her hands the whole thing
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '去找点猫的表情包存下来' }] });
  const started = await h.tools.hands.execute({ device: 'phone', do: '去 emojiset 挑几张猫的贴图存下来，挑之前把候选列给我' });
  assert.equal(started.status, 'started');
  await tick();
  const hands = h.agentOf('h1');
  assert.equal(text(hands.got[0]), '（在手机上）去 emojiset 挑几张猫的贴图存下来，挑之前把候选列给我');
  assert.doesNotMatch(h.shown('hands', started), /stop|秒/);
  h.emit('s1', 'turn/end', { turn: 2 });
  assert.equal(her.got.length, 0, 'nothing of theirs reaches her in between');
  // asking her is the hands' own: not hers to call, and once asked their stretch is over
  assert.equal((await h.pre('s1', 'ask_her', { question: 'x' })).kind, 'deny');
  assert.equal(await h.pre('h1', 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', { x: 1, y: 2 }), 'ran');
  assert.deepEqual(await h.tools.ask_her.execute({ question: '这页有三张：竖大拇指的猫、喝咖啡的猫、发呆的猫。存哪几张？' }), { status: 'asked' });
  assert.match((await h.pre('h1', 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', { x: 1, y: 2 })).reason, /^问她了。这一段到此为止/);
  assert.equal(await h.pre('h1', 'ask_her', { question: '再补一句' }), 'ran');
  h.emit('h1', 'assistant/message', { message: { content: [{ type: 'text', text: '停在猫的贴图页第一页。' }] } });
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } });
  await tick();
  assert.equal(her.got.length, 1);
  assert.deepEqual(her.got[0].source, { kind: 'dsh-dot', form: 'hands-result', for: 'him' }, 'whose business it is — not "this turn goes to him"');
  assert.match(text(her.got[0]), /做到一半，有个地方要你拿主意：（在手机上）去 emojiset[^\n]*\n问你的是：这页有三张[^\n]*\n停在猫的贴图页第一页。\n（在 hands 的 do 里回答[^\n]*\n（这是他要的事。要告诉他什么，写下来就行/);
  // the turn that wakes: what she writes beside a tool call is not sent to him; her answer goes back to the same hands
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: her.got[0].source, content: her.got[0].content });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '手机有点卡，我再等等' }, { type: 'tool-call', name: 'hands' }] } });
  const answered = await h.tools.hands.execute({ device: 'phone', do: '喝咖啡的那张' });
  assert.equal(answered.status, 'answered');
  await tick();
  assert.equal(text(hands.got[1]), '喝咖啡的那张', 'her words as they are, to the hands that asked');
  h.emit('s1', 'turn/end', { turn: 3 });
  await tick(30);
  assert.deepEqual(h.qqSent, [], 'being woken by her hands is not a message to him');
  // it is over: once
  h.emit('h1', 'assistant/message', { message: { content: [{ type: 'text', text: '存好了，喝咖啡的猫在相册里。' }] } });
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } });
  await tick();
  assert.equal(her.got.length, 2);
  assert.match(text(her.got[1]), /刚才那件事做完了：（在手机上）去 emojiset[^\n]*\n（做到这儿停下了[^\n]*\n结果：存好了，喝咖啡的猫在相册里。\n（这是他要的事/);
  assert.deepEqual(h.archived, ['h1']);
  assert.deepEqual(h.audit.filter((e) => e.event === 'hands-result').map((e) => [e.status, e.forHim, e.rounds]), [['asking', true, 1], ['done', true, 2]]);
  // a thing she starts from the turn her hands came back to on his business is his too
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: her.got[1].source, content: her.got[1].content });
  await h.tools.hands.execute({ device: 'web', do: '查一下这个站还有什么分类' }); await tick();
  assert.equal(h.audit.findLast((e) => e.event === 'hands-opened').session, 'h2', 'new hands: they have seen nothing of the last thing');
  h.emit('s1', 'turn/end', { turn: 4 });
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } }); await tick();
  assert.deepEqual(her.got[2].source, { kind: 'dsh-dot', form: 'hands-result', for: 'him' });
  h.stop();
});

test('his stop is a command on the thing; her conversation moving on stops the one she leaves, and what her hands bring back goes where she is', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  assert.deepEqual(await h.command('stop'), { kind: 'success', text: '她手上现在没有事' });
  await h.tools.hands.execute({ device: 'phone', do: '逛逛贴吧' }); await tick();
  assert.deepEqual(await h.command('stop'), { kind: 'success', text: '停下了：（在手机上）逛逛贴吧' });
  await tick();
  assert.deepEqual(h.agentOf('h1').cancels, ['dot-hands: 他叫停了']);
  assert.equal(her.got.length, 0, 'a thing stopped on his word does not wake her');
  assert.match(text(her.noted[0]), /（他叫停的：[^\n]*到此为止，不要接着做）/, 'she finds a line about it, the next time she is up');
  // her own stop: she knows, nothing comes back; and a thing given while one is under way waits its turn
  await h.tools.hands.execute({ device: 'phone', do: '甲' }); await tick();
  const queued = await h.tools.hands.execute({ device: 'web', do: '乙' });
  assert.equal(queued.status, 'queued');
  assert.match(h.shown('hands', queued), /^排上了，前面还有一件没完：（在手机上）甲。/);
  assert.deepEqual(await h.tools.hands.execute({ stop: true }), { status: 'stopped' });
  await tick();
  assert.deepEqual([her.got.length, her.noted.length], [0, 1]);
  assert.equal(h.shown('hands', { status: 'stopped' }), '停下了，手上没有事了。');
  // handed over while her hands are on something: the old conversation is cancelled (its inbox with it), the result waits for the new one
  await h.tools.hands.execute({ device: 'phone', do: '看看小黑盒首页' }); await tick();
  const release = h.services.dshDot.freeze();
  const hid = h.audit.findLast((e) => e.event === 'hands-opened').session;
  h.emit(hid, 'assistant/message', { message: { content: [{ type: 'text', text: '首页是推荐流' }] } });
  h.emit(hid, 'turn/end', { reason: { kind: 'completed' } }); await tick();
  assert.equal(her.got.length, 0, 'not delivered into the conversation she is leaving');
  h.services.dshDot.setSession('s2');
  assert.deepEqual(her.cancels, ['dot: her conversation moved on']);
  release(); await tick();
  assert.equal(her.got.length, 0);
  assert.match(text(h.agentOf('s2').got[0]), /刚才那件事做完了：（在手机上）看看小黑盒首页/);
  h.stop();
});

test('her hands and she think at their own effort: the session\'s own selection, set before anything is sent into it', async () => {
  const h = harness();
  assert.equal(h.hooks['agent/request'], undefined, 'never through the request waterfall: the host fails the turn');
  const low = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' };
  await h.tools.hands.execute({ device: 'phone', do: '看一眼' }); await tick();
  const hands = h.agentOf('h1');
  assert.deepEqual(hands.selected, [low]);
  assert.equal(hands.got.length, 1, 'and then the thing is sent');
  h.emit('h1', 'assistant/message', { message: { content: [{ type: 'text', text: '看了' }] } });
  h.emit('h1', 'turn/end', { reason: { kind: 'done' } }); await tick(); await tick();
  const her = h.agentOf('s1');
  assert.deepEqual(her.selected, [low], 'her own conversation, when what her hands did comes back to it');
  assert.equal(her.got.length, 1);
  await h.tools.hands.execute({ device: 'phone', do: '再看一眼' }); await tick();
  h.emit('h2', 'turn/end', { reason: { kind: 'done' } }); await tick(); await tick();
  assert.deepEqual(her.selected, [low], 'already so: nothing is done');
  assert.ok(h.audit.some((a) => a.event === 'effort-set' && a.session === 's1' && a.was === 'off' && a.effort === 'low'));
  h.stop();
  const none = harness({ handsEffort: 'nope', herEffort: false });
  await none.tools.hands.execute({ device: 'phone', do: '看一眼' }); await tick();
  assert.deepEqual(none.agentOf('h1').selected, [], 'an effort the model does not offer is not set');
  assert.equal(none.agentOf('h1').got.length, 1);
  const off = harness({ handsEffort: false, herEffort: false });
  await off.tools.hands.execute({ device: 'phone', do: '看一眼' }); await tick();
  assert.deepEqual(off.agentOf('h1').selected, []);
  none.stop(); off.stop();
});

test('what she writes in her conversation goes to no one; what she says is written by a call that is only her card, and leaves by one way', async () => {
  const h = harness();
  // his words over QQ open a turn; she thinks aloud, and says something
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '在干嘛呀' }] });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '他问我在干嘛，我刚写完脚本，告诉他。' }] } });
  h.replies.push('在整你交代的那个余额的事\n[表情包 sticker:31d44003ce]');
  assert.equal(await h.pre('s1', 'say', { about: '刚把余额提醒脚本写好了' }), 'ran');
  const r = await h.tools.say.execute({ about: '刚把余额提醒脚本写好了' });
  assert.deepEqual([r.status, r.said], ['said', ['在整你交代的那个余额的事']]);
  assert.deepEqual(h.qqSent, [['owner', '在整你交代的那个余额的事', ['sticker:31d44003ce']]]);
  const call = h.llmCalls[0];
  assert.equal(call.system, '# 你是 小点\n话不多。', 'the system prompt is her card and nothing else');
  assert.ok(!('tools' in call) && call.reasoningEffort === 'off' && !('sessionId' in call), 'no tools, no thinking, nobody\'s session');
  assert.match(call.messages[0].content[0].text, /^（你的表情包夹里现在有：sticker:31d44003ce 开心猫[\s\S]*他：在干嘛呀\n\n（你手上的事：现在没有在做的事）\n（你这会儿知道的事：刚把余额提醒脚本写好了）\n（下面写你这次发给他的消息/);
  assert.match(h.shown('say', r), /^说出去了：\n在整你交代的那个余额的事\n\[sticker:31d44003ce\]$/);
  h.emit('s1', 'turn/end', { turn: 2 });
  await tick(30);
  assert.equal(h.qqSent.length, 1, 'her thinking was not sent');
  // the backend's own send, or qq_send by name, is not a second way out
  assert.match((await h.pre('s1', 'qq_send', { to: 'owner', text: '在的' })).reason, /^话不从这里直接发：用 say/);
  // what is in her hands is told by the code, and her choosing not to answer is an answer
  await h.tools.hands.execute({ device: 'phone', do: '去小黑盒找表情包' }); await tick();
  h.replies.push('[不回]');
  assert.deepEqual(await h.tools.say.execute({}), { status: 'silent' });
  assert.match(h.llmCalls[1].messages[0].content[0].text, /（你手上的事：正在做：（在手机上）去小黑盒找表情包，还没做完）/);
  assert.equal(h.shown('say', { status: 'silent' }), '这次没回，什么也没发。');
  assert.equal(h.qqSent.length, 1);
  h.stop();
});

test('a turn he is in that ends: what she wrote last is what she means to tell him, and say writes the words — nothing she wrote leaves as written', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '睡了吗' }] });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '醒着呢\n\n这么晚还没睡呀' }] } });
  h.replies.push('醒着呢');
  h.emit('s1', 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  await tick(30);
  assert.deepEqual(h.qqSent, [['owner', '醒着呢', []]], 'the words are the call\'s, not hers');
  assert.match(h.llmCalls[0].messages[0].content[0].text, /（你心里想回他的意思：醒着呢 \/ 这么晚还没睡呀。意思照这个[^\n]*\n（下面写你这次发给他的消息/);
  assert.equal(h.llmCalls[0].system, '# 你是 小点\n话不多。');
  assert.deepEqual(her.noted.map(text), ['说出去了：\n醒着呢'], 'what really went out is told back to her, without waking her');
  assert.ok(!h.audit.some((a) => a.event === 'silent'));
  // she wrote nothing: nothing goes out, and that is her not answering
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '晚安' }] });
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } });
  await tick(30);
  assert.equal(h.qqSent.length, 1);
  assert.ok(h.audit.some((a) => a.event === 'silent'));
  // a turn he is not in (her hands came back with something of her own, her own time): what she writes goes nowhere
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'hands-result' }, content: [{ type: 'text', text: '刚才那件事做完了' }] });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '存好了，先放着。' }] } });
  h.emit('s1', 'turn/end', { turn: 4, reason: { kind: 'completed' } });
  await tick(30);
  assert.equal(h.qqSent.length, 1);
  assert.equal(h.llmCalls.length, 1);
  // what her hands did for him: the same as a turn of his
  h.emit('s1', 'turn/start', { turn: 5 }); h.emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'hands-result', for: 'him' }, content: [{ type: 'text', text: '刚才那件事做完了' }] });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '第一张存好了，是水豚' }] } });
  h.replies.push('你看看这个\n[表情包 sticker:31d44003ce]');
  h.emit('s1', 'turn/end', { turn: 5, reason: { kind: 'completed' } });
  await tick(30);
  assert.deepEqual(h.qqSent[1], ['owner', '你看看这个', ['sticker:31d44003ce']]);
  assert.match(h.llmCalls[1].messages[0].content[0].text, /他这会儿没说话，是你有事要告诉他/);
  h.stop();
});

test('where he is talking to her is where her words show; words her hands type for others are written the same way', async () => {
  const h = harness();
  // at her window (the desktop): the tool's own output is what he reads, nothing goes to his QQ
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: { kind: 'user', rpcId: 'desk-1' }, content: [{ type: 'text', text: '在吗' }] });
  h.replies.push('在的');
  const r = await h.tools.say.execute({});
  assert.deepEqual([r.status, r.said], ['said', ['在的']]);
  assert.deepEqual(h.qqSent, []);
  assert.deepEqual(h.herSaid.map((x) => x.text), ['在的'], 'on her record all the same');
  h.emit('s1', 'turn/end', { turn: 2 });
  // a comment: she says what she means, the card writes it, her hands are given the words to type
  h.replies.push('住这儿的人路过');
  const started = await h.tools.hands.execute({ device: 'phone', do: '在这条帖子下面评论', say: '想说自己就住在 DSH 里' }); await tick();
  assert.equal(started.status, 'started');
  assert.equal(h.agentOf('h1').got[0].content[0].text, '（在手机上）在这条帖子下面评论\n要打的字（原样打，一个字不改）：\n住这儿的人路过');
  assert.match(h.llmCalls[1].messages[0].content[0].text, /^（你这会儿知道的事：想说自己就住在 DSH 里）\n（在这条帖子下面评论。这里发不了表情包。下面只写要打上去的原话/);
  assert.equal(await h.pre('h1', 'phone_type', { text: '住这儿的人路过' }), 'ran', 'the words are hers to type from');
  assert.equal((await h.pre('h1', 'phone_type', { text: '哈哈确实，我也这么觉得' })).kind, 'deny', 'their own are not');
  // she would rather not say it: nothing is handed over
  h.services.dshDot && h.tools.hands.execute({ stop: true });
  h.replies.push('[不回]');
  assert.equal((await h.tools.hands.execute({ device: 'phone', do: '回他一句', say: 'x' })).status, 'failed');
  h.stop();
});
