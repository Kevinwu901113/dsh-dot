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
  assert.match((await h.pre('h1', 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', { x: 1, y: 2 })).reason, /^记下了。这件事到此为止/);
  assert.equal(await h.pre('h1', 'ask_her', { question: '再补一句' }), 'ran');
  h.emit('h1', 'assistant/message', { message: { content: [{ type: 'text', text: '停在猫的贴图页第一页。' }] } });
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } });
  await tick();
  assert.equal(her.got.length, 1);
  assert.deepEqual(her.got[0].source, { kind: 'dsh-dot', form: 'hands-result', for: 'him', thing: 't1' }, 'whose business it is, and which thing — not "this turn goes to him"');
  assert.match(text(her.got[0]), /刚才那件事卡住了，停在一个要你拿主意的地方：（在手机上）去 emojiset[^\n]*\n要你定的是：这页有三张[^\n]*\n停在猫的贴图页第一页。\n（这件事到这儿停了[^\n]*\n（这是他要的事。你能定的就定了再交出去/);
  assert.deepEqual(h.archived, ['h1'], 'the thing is over: nothing waits half-open');
  // the turn that wakes: she decides, and gives her hands the next part — it carries on from where the last one stopped, and he is told nothing yet
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: her.got[0].source, content: her.got[0].content });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '选喝咖啡的' }, { type: 'tool-call', name: 'hands' }] } });
  const next = await h.tools.hands.execute({ device: 'phone', do: '存喝咖啡的那张' });
  assert.equal(next.status, 'started');
  await tick();
  assert.match(text(h.agentOf('h2').got[0]), /^（在手机上）存喝咖啡的那张\n（接着刚才那件：（在手机上）去 emojiset[^\n]*\n问过：这页有三张[^\n]*。屏幕还停在那时的地方/);
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '交出去了' }] } });
  h.emit('s1', 'turn/end', { turn: 3 });
  await tick(30);
  assert.deepEqual(h.qqSent, [['owner', '好', []]], 'only the answer to his own words went out: a thing of his she took further is not at its end');
  // it is over: once
  h.emit('h2', 'assistant/message', { message: { content: [{ type: 'text', text: '存好了，喝咖啡的猫在相册里。' }] } });
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } });
  await tick();
  assert.equal(her.got.length, 2);
  assert.match(text(her.got[1]), /刚才那件事做完了：（在手机上）存喝咖啡的那张[\s\S]*\n（做到这儿停下了[^\n]*\n结果：存好了，喝咖啡的猫在相册里。\n（这是他要的事/);
  assert.deepEqual(h.audit.filter((e) => e.event === 'hands-result').map((e) => [e.status, e.forHim]), [['stuck', true], ['done', true]]);
  // one more thing for the hands at work goes into their run; with nothing under way there is nothing to add to
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: her.got[1].source, content: her.got[1].content });
  assert.match(h.shown('hands', await h.tools.hands.execute({ add: '再存一张' })), /^你现在没在做什么|没有可补的/);
  await h.tools.hands.execute({ device: 'web', do: '查一下这个站还有什么分类' }); await tick();
  assert.equal(h.audit.findLast((e) => e.event === 'hands-opened').session, 'h3', 'new hands: they have seen nothing of the last thing');
  assert.deepEqual(await h.tools.hands.execute({ add: '顺便看看有没有狗的' }), { status: 'added', id: 't3' });
  await tick();
  assert.equal(text(h.agentOf('h3').got[1]), '顺便看看有没有狗的');
  assert.equal(h.shown('hands', { status: 'added' }), '补上了，它下一步之前就会看到。');
  h.emit('s1', 'turn/end', { turn: 4 });
  h.emit('h3', 'assistant/message', { message: { content: [{ type: 'text', text: '有猫有狗' }] } });
  h.emit('h3', 'turn/end', { reason: { kind: 'completed' } }); await tick();
  assert.deepEqual(her.got[2].source, { kind: 'dsh-dot', form: 'hands-result', for: 'him', thing: 't3' });
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
  assert.match(call.messages[0].content[0].text, /^（你的表情包夹里现在有：sticker:31d44003ce 开心猫[\s\S]*他：在干嘛呀\n\n（你手上没有在做的事，这一轮也没有开始做任何事）\n（你这会儿知道的：刚把余额提醒脚本写好了）\n（下面写你这次发给他的消息/);
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
  assert.match(h.llmCalls[1].messages[0].content[0].text, /（手上正在做一件事[^：]*：（在手机上）去小黑盒找表情包。还没做完，没有结果）/);
  assert.equal(h.shown('say', { status: 'silent' }), '这次没回，什么也没发。');
  assert.equal(h.qqSent.length, 1);
  h.stop();
});

test('a turn he is in that ends is answered by the voice, from the book and her note — what she wrote is not a draft, and a promise is only true if the book has it', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  const fed = (i) => h.llmCalls[i].messages[0].content[0].text;
  // plain talk: nothing in her hands; her note is one more thing she knows
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '睡了吗' }] });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '他问睡了没，还醒着。' }] } });
  h.replies.push('醒着呢');
  h.emit('s1', 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  await tick(30);
  assert.deepEqual(h.qqSent, [['owner', '醒着呢', []]]);
  assert.match(fed(0), /（你手上没有在做的事，这一轮也没有开始做任何事）\n（你这会儿知道的：他问睡了没，还醒着。）\n（下面写你这次发给他的消息/);
  assert.equal(h.llmCalls[0].system, '# 你是 小点\n话不多。');
  assert.equal(her.noted.length, 0, 'nothing is put into her conversation for it');
  // she says she will go and do it, and gives her hands nothing: the voice is told nothing was begun
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '吃饭去了' }] });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '（趁这会儿去翻 LPL）' }] } });
  h.replies.push('去吧');
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } });
  await tick(30);
  assert.match(fed(1), /这一轮也没有开始做任何事）\n（下面写/, 'a note in brackets is a thought of hers, not something she knows for him');
  // she wrote nothing at all: he spoke, so the voice still answers (or chooses not to)
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '晚安' }] });
  h.replies.push('[不回]');
  h.emit('s1', 'turn/end', { turn: 4, reason: { kind: 'completed' } });
  await tick(30);
  assert.equal(h.qqSent.length, 2);
  assert.ok(h.audit.some((a) => a.event === 'silent'));
  // she gives her hands a thing: the voice is told it was just begun, by its first clause only
  h.emit('s1', 'turn/start', { turn: 5 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '去小黑盒找五个表情包' }] });
  await h.tools.hands.execute({ device: 'phone', do: '打开小黑盒找表情包。从不同帖子各存一张，共五张，存完告诉我来源。' }); await tick();
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '交出去了。' }] } });
  h.replies.push('好');
  h.emit('s1', 'turn/end', { turn: 5, reason: { kind: 'completed' } });
  await tick(30);
  assert.match(fed(3), /（这一轮刚开始做一件事：（在手机上）打开小黑盒找表情包。才开始，还没有任何结果）\n（你这会儿知道的：交出去了。）/);
  assert.doesNotMatch(fed(3), /从不同帖子/, 'the task itself is not read out to the voice');
  // asked how it is going: the book says it is under way and has no result
  h.emit('s1', 'turn/start', { turn: 6 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '在干嘛呀' }] });
  h.replies.push('在找呢');
  h.emit('s1', 'turn/end', { turn: 6, reason: { kind: 'completed' } });
  await tick(30);
  assert.match(fed(4), /（手上正在做一件事[^：]*：（在手机上）打开小黑盒找表情包。还没做完，没有结果）/);
  // what she is told the next time she is up: the words that went out, once
  const note = await h.hooks['agent/pre-step']({ agent: her, messages: [{ role: 'user' }], signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user' }] }));
  assert.match(text(note.messages.at(-1)), /说出去了：\n在找呢/);
  // he says stop: the voice is told what was stopped and that nothing came of it
  h.emit('s1', 'turn/start', { turn: 7 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '停' }] });
  await h.tools.hands.execute({ stop: true }); await tick();
  h.replies.push('收到！');
  h.emit('s1', 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  await tick(30);
  assert.match(fed(5), /（这一轮刚停下一件事：（在手机上）打开小黑盒找表情包。停下前没有做出结果）/);
  assert.equal(her.got.length, 0, 'the stopped thing wakes nobody');
  // a thing of his comes to its end: the voice is given the book's result for it
  h.emit('s1', 'turn/start', { turn: 8 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '查下明天天气' }] });
  await h.tools.hands.execute({ device: 'web', do: '查明天广州天气' }); await tick();
  h.replies.push('好');
  h.emit('s1', 'turn/end', { turn: 8, reason: { kind: 'completed' } }); await tick(30);
  const hid = h.audit.findLast((e) => e.event === 'hands-opened').session;
  h.emit(hid, 'assistant/message', { message: { content: [{ type: 'text', text: '明天多云，18 到 24 度。' }] } });
  h.emit(hid, 'turn/end', { reason: { kind: 'completed' } }); await tick();
  assert.equal(her.got.length, 1);
  h.emit('s1', 'turn/start', { turn: 9 }); h.emit('s1', 'user/message', { source: her.got[0].source, content: her.got[0].content });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '查到了。' }] } });
  h.replies.push('明天多云，十八到二十四度');
  h.emit('s1', 'turn/end', { turn: 9, reason: { kind: 'completed' } }); await tick(30);
  assert.match(fed(7), /（他要的事到头了：（查资料，不碰手机和电脑）查明天广州天气。[^\n]*结果：明天多云，18 到 24 度。）/);
  assert.match(fed(7), /他这会儿没说话，是你有事要告诉他/);
  assert.equal(h.qqSent.at(-1)[1], '明天多云，十八到二十四度');
  // a turn he is not in (her own thing came back): what she writes goes nowhere, and nothing is said
  const before = h.llmCalls.length;
  h.emit('s1', 'turn/start', { turn: 10 }); h.emit('s1', 'user/message', { source: { kind: 'dsh-dot', form: 'hands-result' }, content: [{ type: 'text', text: '刚才那件事做完了' }] });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '存好了，先放着。' }] } });
  h.emit('s1', 'turn/end', { turn: 10, reason: { kind: 'completed' } });
  await tick(30);
  assert.equal(h.llmCalls.length, before);
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
  assert.match(h.llmCalls[1].messages[0].content[0].text, /^（你这会儿知道的：想说自己就住在 DSH 里）\n（在这条帖子下面评论。这里发不了表情包。下面只写要打上去的原话/);
  assert.equal(await h.pre('h1', 'phone_type', { text: '住这儿的人路过' }), 'ran', 'the words are hers to type from');
  assert.equal((await h.pre('h1', 'phone_type', { text: '哈哈确实，我也这么觉得' })).kind, 'deny', 'their own are not');
  // she would rather not say it: nothing is handed over
  h.services.dshDot && h.tools.hands.execute({ stop: true });
  h.replies.push('[不回]');
  assert.equal((await h.tools.hands.execute({ device: 'phone', do: '回他一句', say: 'x' })).status, 'failed');
  h.stop();
});

test('what she decides by: the book, a line a thing — what is under way, what he stopped (not to be taken up again), what is stuck', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  const note = async () => { const d = await h.hooks['agent/pre-step']({ agent: her, messages: [{ role: 'user' }], signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user' }] })); return text(d.messages.at(-1)); };
  assert.doesNotMatch(await note(), /在做：|排着：|叫停的/);
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '去贴吧看看' }] });
  await h.tools.hands.execute({ device: 'phone', do: '打开贴吧看首页。挑几条好玩的。' }); await tick();
  await h.tools.hands.execute({ device: 'web', do: '查明天天气' });
  const n1 = await note();
  assert.match(n1, /在做：（在手机上）打开贴吧看首页（[^）]*开始的）。还没完，别再开一件一样的/);
  assert.match(n1, /排着：（查资料[^）]*）查明天天气。/);
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  // his "stop": she stops it in his turn — the book has it as his stop, and says not to take it up again
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '停' }] });
  await h.tools.hands.execute({ stop: true }); await tick();
  h.emit('s1', 'turn/end', { turn: 3 }); await tick(30);
  const n2 = await note();
  assert.match(n2, /他叫停的：（在手机上）打开贴吧看首页。他没再提，就别再做，也别换个法子接着做。/);
  assert.match(n2, /他叫停的：（查资料[^）]*）查明天天气。/);
  assert.doesNotMatch(n2, /在做：/);
  h.stop();
});

test('what needs him: code reads the screen; an ask ends the thing for him, his yes in his own words lets it through once; his own steps are his; nothing waits on a button', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  let fg = 'com.android.packageinstaller/.InstallStart';
  h.services.dshPhone = { lastScreen: { items: [{ words: '安装', x: 10, y: 10 }], at: Date.now() }, foreground: async () => fg };
  const tapAt = (id) => h.pre(id, 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', { x: 10, y: 10 });
  const note = async () => { const d = await h.hooks['agent/pre-step']({ agent: her, messages: [{ role: 'user' }], signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user' }] })); return text(d.messages.at(-1)); };
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '装个小红书' }] });
  await h.tools.hands.execute({ device: 'phone', do: '装小红书' }); await tick();
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  // an "ask" step: refused at once, the thing ends as a question for him
  const r = await tapAt('h1');
  assert.equal(r.kind, 'deny');
  assert.match(r.reason, /^这一步要先问过他：装一个 App。已经记下了/);
  assert.match((await tapAt('h1')).reason, /^记下了。这件事到此为止/);
  h.emit('h1', 'assistant/message', { message: { content: [{ type: 'text', text: '停在安装确认页。' }] } });
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } }); await tick();
  const back = text(her.got.at(-1));
  assert.match(back, /停在一个要他来的地方：（在手机上）装小红书\n要他点头：装一个 App\n停在安装确认页。\n（这件事到这儿停了/);
  assert.doesNotMatch(back, /你能定的就定了/, 'not hers to decide');
  assert.match(await note(), /卡住了：（在手机上）装小红书。要定的是：要他点头：装一个 App/);
  // his yes is his: not in a turn of hers, and only in words of his
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: her.got.at(-1).source, content: her.got.at(-1).content });
  assert.deepEqual(await h.tools.his_ok.execute({ kind: 'install' }), { status: 'refused', kind: 'install' });
  assert.equal(h.shown('his_ok', { status: 'refused' }), '没记：要他自己刚说的话里同意了才能记。');
  h.emit('s1', 'turn/end', { turn: 3 }); await tick(30);
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '装吧' }] });
  assert.deepEqual(await h.tools.his_ok.execute({ kind: 'install' }), { status: 'ok', kind: 'install' });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '好' }, { type: 'tool-call', name: 'hands' }] } });
  await h.tools.hands.execute({ device: 'phone', do: '接着装', after: true }); await tick();
  assert.match(text(h.agentOf('h2').got[0]), /^（在手机上）接着装\n（接着刚才那件：（在手机上）装小红书\n问过：要他点头：装一个 App。屏幕还停在那时的地方/);
  assert.equal(await tapAt('h2'), 'ran', 'his yes covers this thing');
  assert.doesNotMatch(await note(), /卡住了：（在手机上）装小红书/, 'a stuck thing taken up again is not stuck');
  // his own step: a payment's last tap is not hers, yes or no
  fg = 'com.xingin.xhs/.Pay';
  h.services.dshPhone.lastScreen = { items: [{ words: '确认支付', x: 10, y: 10 }], at: Date.now() };
  const pay = await tapAt('h2');
  assert.match(pay.reason, /^这一步要他本人来：付款、下单的最后一步。/);
  h.emit('s1', 'turn/end', { turn: 4 }); await tick(30);
  h.emit('h2', 'assistant/message', { message: { content: [{ type: 'text', text: '停在付款页。' }] } });
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } }); await tick();
  assert.match(text(her.got.at(-1)), /要他本人来：付款、下单的最后一步[\s\S]*要他本人来的（验证码、扫码、人脸、付款）：告诉他/);
  // money is not done at all
  fg = 'com.eg.android.AlipayGphone/.Main';
  assert.match((await tapAt('h2')).reason, /^这一步不做：在 com\.eg\.android\.AlipayGphone 里操作/);
  // a step the host gates in her own conversation is refused at once (no button), and she reads to ask him first
  const answer = await h.hooks['approval/request']({ agent: her, toolName: 'bash', callId: 'c9', reason: 'rm -rf ~/old' }, async () => { throw new Error('no button'); });
  assert.equal(answer, 'rejected');
  const post = await h.hooks['tools/post-execute']({ callId: 'c9', name: 'bash', agent: her }, { isError: true, content: [{ type: 'text', text: 'Error: the user rejected tool "bash"' }] }, async () => ({ kind: 'accept' }));
  assert.match(post.feedback[0].text, /^这一步要先问过他：电脑上：rm -rf ~\/old。先问他；他同意了用 his_ok 记下，再做。/);
  assert.match(await note(), /等他点头：电脑上：rm -rf ~\/old/);
  assert.equal(await h.hooks['approval/request']({ agent: { session: { id: 'x', header: { cwd: '/elsewhere' } } }, toolName: 'bash' }, async () => 'approved'), 'approved', 'not hers: passed on');
  h.stop();
});
