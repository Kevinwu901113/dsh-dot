// dsh-dot/dot + hands: a whole thing goes to her hands; only its end or a question of theirs wakes her; being woken
// is not a message to him; his stop, and her conversation moving on, act on the thing and not on some session's inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, ownerSource } from '../src/dot/core.js';
import { apply as applyMemory } from '../src/memory/memory.js';
import { hookTable } from './hooks.js';

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const text = (m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

function harness(cfg = {}, state = { lastSession: 's1' }) {
  const dsh = mkdtempSync(join(tmpdir(), 'dsh-'));
  process.env.DSH_HOME = dsh;
  writeFileSync(join(dsh, 'dsh-dot-state.json'), JSON.stringify(state));
  const home = join(mkdtempSync(join(tmpdir(), 'home-')), 'dot');
  const { hooks, add: addHook } = hookTable();
  const listeners = [], effects = [], audit = [], tools = {}, archived = [], qqSent = [], agents = new Map(), llmCalls = [], replies = [], herSaid = [];
  let command, n = 0;
  const made = new Map(); // session id → what it was made with ({ cwd, agentPreset }), as dsh keeps it on the session
  const agentOf = (id) => { if (!agents.has(id)) agents.set(id, { session: { id, header: { cwd: made.get(id)?.cwd ?? (id.startsWith('h') ? join(dsh, 'dsh-dot-hands') : home), agentPreset: made.get(id)?.agentPreset } }, got: [], cancels: [], selected: [], model: { current: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: agents.get(id).selected.at(-1)?.reasoningEffort ?? 'off' }), select: (sel) => { agents.get(id).selected.push(sel); } }, noted: [], inject(m) { this.noted.push(m); }, followup(m) { this.got.push(m); }, cancel(c) { this.cancels.push(c.reason); } }); return agents.get(id); };
  const services = {
    tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
    commands: { register: (c) => { command = c; return () => {}; } },
    sessionController: { create: async (req = {}) => { const sessionId = `h${++n}`; made.set(sessionId, req); return { sessionId }; }, rename: async () => ({}), resolveAgent: async (id) => ({ agent: agentOf(id) }) },
    agents: { get: (id) => agents.get(id) },
    workspaceRegistry: { archiveSession: async (id) => { archived.push(id); } },
    llm: {
      resolveCallConfig: async (c) => { if (c.reasoningEffort === 'nope') throw Object.assign(new Error('no'), { code: 'UNSUPPORTED_REASONING_EFFORT' }); return c; },
      stream: (o) => (async function* () { llmCalls.push(o); yield { type: 'text-delta', text: replies.shift() ?? '好' }; yield { type: 'finish', reason: { kind: 'stop' } }; })(),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }) },
    dshInterlude: { cardText: () => '# 你是 小点\n话不多。', checks: () => [] },
    dotMemory: { recent: () => [{ who: 'owner', text: '在干嘛呀' }], herSaid: (x) => herSaid.push(x) },
    dshQq: { connected: true, owner: '20002', onMessage: (fn) => { services.qqMessage = fn; return () => {}; }, onTyping: () => () => {}, stickerList: () => [{ id: '31d44003ce', note: '开心猫' }], send: async (to, t, images) => { qqSent.push([to, t, images]); return { sent: 1, said: String(t).split('\n').filter(Boolean), images: images ?? [] }; } },
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
  apply(ctx, { home, budgetPollSeconds: 0, notifyBatchMs: 5, ownerQuietMs: 5, ownerMaxWaitMs: 30, awakeHours: '00:00-24:00', ackHoldMs: 0, ...cfg });
  const emit = (id, type, data) => { const a = agentOf(id); for (const fn of [...listeners]) fn(a.session, { type, data }); };
  emit('s1', 'turn/start', { turn: 1 }); emit('s1', 'turn/end', { turn: 1 }); // her conversation (the one the state file remembers: a turn does not make a session hers)
  const pre = (id, name, input = {}) => hooks['tools/pre-execute']({ name, input, agent: agentOf(id) }, async () => 'ran');
  const shown = (name, v) => tools[name].output.render({}, v)[0].text;
  return { ctx, home, made, services, tools, hooks, emit, pre, shown, audit, archived, qqSent, agentOf, llmCalls, replies, herSaid, command: (arg) => command.handler({ rawInput: arg }), stop: () => { for (const d of effects) if (typeof d === 'function') d(); } };
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
  h.services.dshPhone = { lastScreen: { items: [{ words: '首页', x: 1, y: 2 }], at: Date.now() }, foreground: async () => 'com.example.app/.Main' };
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
  assert.deepEqual(h.qqSent, [['owner', '好\n去弄了，还没结果，有了跟你说', []]], 'only the answer to his own words went out: a thing of his she took further is not at its end');
  // it is over: once
  // whether it was reached is theirs to say: left out, the thing is not ended either way
  assert.deepEqual(await h.tools.done.execute({ summary: '存好了' }), { status: 'unsaid' });
  assert.match(h.shown('done', { status: 'unsaid' }), /^没收尾：reached 没填/);
  await h.tools.done.execute({ summary: '存好了，喝咖啡的猫在相册里。', reached: true });
  await tick();
  assert.equal(her.got.length, 2);
  assert.match(text(her.got[1]), /刚才那件事做完了：（在手机上）存喝咖啡的那张[\s\S]*\n（手收尾了[^\n]*\n结果：存好了，喝咖啡的猫在相册里。\n（这是他要的事/);
  assert.deepEqual(h.audit.filter((e) => e.event === 'hands-result').map((e) => [e.outcome, e.forHim]), [['stuck', true], ['done', true]]);
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
  await h.tools.done.execute({ summary: '有猫有狗', reached: true }); await tick();
  assert.deepEqual(her.got[2].source, { kind: 'dsh-dot', form: 'hands-result', for: 'him', thing: 't3' });
  h.stop();
});

test('his stop is a command on the thing; her conversation moving on stops the one she leaves, and what her hands bring back goes where she is', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  assert.deepEqual(await h.command('stop'), { kind: 'success', text: '她手上现在没有事' });
  await h.tools.hands.execute({ device: 'phone', do: '逛逛贴吧' }); await tick();
  assert.deepEqual(await h.command('stop'), { kind: 'success', text: '停下了：（在手机上）逛逛贴吧' });
  await tick(30);
  assert.deepEqual(h.agentOf('h1').cancels, ['dot-hands: stopped']);
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
  await h.tools.done.execute({ summary: '首页是推荐流', reached: true }); await tick();
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
  await h.tools.done.execute({ summary: '看了', reached: true }); await tick(); await tick();
  const her = h.agentOf('s1');
  assert.deepEqual(her.selected, [low], 'her own conversation, when what her hands did comes back to it');
  assert.equal(her.got.length, 1);
  await h.tools.hands.execute({ device: 'phone', do: '再看一眼' }); await tick();
  await h.tools.done.execute({ summary: '看了', reached: true }); await tick(); await tick();
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
  assert.match(call.messages[0].content[0].text, /^（你的表情包夹里现在有：sticker:31d44003ce 开心猫[\s\S]*他：在干嘛呀\n\n（你手上没有在做的事，这一轮也没有开始做任何事）\n（你自己想说的意思：刚把余额提醒脚本写好了）\n（下面写你这次发给他的消息/);
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
  assert.match(fed(0), /（你手上没有在做的事，这一轮也没有开始做任何事）\n（下面写你这次发给他的消息/);
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
  assert.match(fed(3), /（他刚说：[^\n]*）\n（他要的这件事你已经交给自己的手去做了[^\n]*\n1\. [^\n]*\n[\s\S]*最后单独一行写你挑的编号[^\n]*$/, 'a thing just begun: his last words and her sayings for it, not the conversation');
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
  assert.match(fed(5), /【「打开小黑盒找表情包」停下了：你叫停了。】$/);
  assert.equal(her.got.length, 0, 'the stopped thing wakes nobody');
  // a thing of his comes to its end: the voice is given the book's result for it
  h.emit('s1', 'turn/start', { turn: 8 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '查下明天天气' }] });
  await h.tools.hands.execute({ device: 'web', do: '查明天广州天气' }); await tick();
  h.replies.push('好');
  h.emit('s1', 'turn/end', { turn: 8, reason: { kind: 'completed' } }); await tick(30);
  const hid = h.audit.findLast((e) => e.event === 'hands-opened').session;
  await h.tools.done.execute({ summary: '明天多云，18 到 24 度。', detail: '后天转晴', task: '查天气', reached: true }); await tick();
  assert.equal(her.got.length, 1);
  h.emit('s1', 'turn/start', { turn: 9 }); h.emit('s1', 'user/message', { source: her.got[0].source, content: her.got[0].content });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '查到了。' }] } });
  h.replies.push('明天多云，十八到二十四度');
  h.emit('s1', 'turn/end', { turn: 9, reason: { kind: 'completed' } }); await tick(30);
  assert.match(fed(7), /【「查明天广州天气」做完了。结果：明天多云，18 到 24 度。】\n〔后天转晴〕$/, 'their summary is what is said; their details are hers to give when asked for');
  assert.doesNotMatch(fed(7), /看图|看结果/, 'nothing to look at: the voice has no picture');
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
  assert.match(h.llmCalls[1].messages[0].content[0].text, /^（你自己想说的意思：想说自己就住在 DSH 里）\n（在这条帖子下面评论。这里发不了表情包。下面只写要打上去的原话/);
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
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '他说可以装' }] } });
  assert.deepEqual(await h.tools.his_ok.execute({ kind: 'install' }), { status: 'ok', kind: 'install' });
  assert.deepEqual(h.audit.filter((a) => a.event === 'consent-granted').map((a) => [a.of ?? a.kind, Boolean(a.ahead)]), [['install', false]], 'the yes to what stopped to ask him');
  // with nothing of that kind waiting, it is something he asked for himself in this turn: a yes ahead, in his words, for the next such thing once
  assert.deepEqual(await h.tools.his_ok.execute({ kind: 'friend', always: true }), { status: 'ok', kind: 'friend' });
  const ahead = h.audit.filter((a) => a.event === 'consent-granted').at(-1);
  assert.equal(ahead.ahead, true); assert.equal(ahead.always, false, 'a yes ahead is for this once'); assert.equal(ahead.words, '装吧', 'his words, not hers');
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
  // a tap is judged by the screen as it is now: a stale read is read again first
  fg = 'com.xingin.xhs/.Main';
  let reads = 0;
  h.services.dshPhone.lastScreen = { items: [{ words: '首页', x: 10, y: 10 }], at: Date.now() - 60_000 };
  h.services.dshPhone.screenItems = async () => { reads++; h.services.dshPhone.lastScreen = { items: [{ words: '确认支付', x: 10, y: 10 }], at: Date.now() }; return []; };
  assert.match((await tapAt('h2')).reason ?? '', /^记下了。这件事到此为止|^这一步要他本人来/);
  assert.equal(reads, 1, 'read again');
  // her phone is reached with its own tools, not through the shell
  assert.match((await h.pre('h2', 'bash', { command: '~/Library/Android/sdk/platform-tools/adb shell am start -a android.intent.action.CALL tel:10086' })).reason, /^手机用手机的工具来操作/);
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

test('a question put to him is not stuck any more once his next words have been read: said no, the line is gone at once, not an hour later', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  h.services.dshPhone = { lastScreen: { items: [{ words: '安装', x: 10, y: 10 }], at: Date.now() }, foreground: async () => 'com.android.packageinstaller/.InstallStart' };
  const tapAt = (id) => h.pre(id, 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', { x: 10, y: 10 });
  const note = async () => { const d = await h.hooks['agent/pre-step']({ agent: her, messages: [{ role: 'user' }], signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user' }] })); return text(d.messages.at(-1)); };
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '装个小红书' }] });
  await h.tools.hands.execute({ device: 'phone', do: '装小红书' }); await tick();
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  await tapAt('h1'); await tapAt('h1');
  h.emit('h1', 'assistant/message', { message: { content: [{ type: 'text', text: '停在安装确认页。' }] } });
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } }); await tick();
  assert.match(await note(), /卡住了：（在手机上）装小红书/);
  // the turn her hands' coming back opens is hers: the question is still waiting after it
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: her.got.at(-1).source, content: her.got.at(-1).content });
  h.emit('s1', 'turn/end', { turn: 3 }); await tick(30);
  assert.match(await note(), /卡住了：（在手机上）装小红书/, 'he has not answered yet');
  // his words, and no yes in them
  await tick(5);
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '不用了' }] });
  h.emit('s1', 'turn/end', { turn: 4 }); await tick(30);
  assert.doesNotMatch(await note(), /卡住了：（在手机上）装小红书/, 'he said no: not waiting, not stuck');
  h.stop();
});

test('the know-how book: every device call of a thing is a step where it happened; the thing\'s end logs it with the book\'s outcome; a place worth it is reflected on; the next thing there is given the notes', async () => {
  const h = harness({ howtoMinSteps: 3 });
  let fg = 'com.max.xiaoheihe/.Main';
  h.services.dshPhone = { foreground: async () => fg };
  const post = (id, name, args, result = { isError: false, content: [] }) => h.hooks['tools/post-execute']({ callId: String(Math.random()), name, arguments: args, agent: h.agentOf(id) }, result, async () => ({ kind: 'accept' }));
  const given = (r) => r.additionalContexts?.map((c) => text(c)).join('\n') ?? '';
  h.emit('s1', 'turn/start', { turn: 2 });
  await h.tools.hands.execute({ device: 'phone', do: '去小黑盒搜浮游世界' }); await tick();
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  assert.equal(given(await post('h1', 'mcp__dot-phone__mobile_launch_app', { packageName: 'com.max.xiaoheihe' })), '', 'nothing learned yet');
  await post('h1', 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', { x: 1, y: 2 }, { isError: true, content: [{ type: 'text', text: 'Error: element not found' }] });
  await post('h1', 'phone_type', { text: '浮游世界' });
  fg = 'com.android.launcher3/.Launcher';
  await post('h1', 'mcp__dot-phone__mobile_press_button', { button: 'HOME' });
  await post('s1', 'mcp__dot-phone__mobile_press_button', { button: 'HOME' }); // not her hands: nothing recorded
  h.replies.length = 0;
  h.replies.push(JSON.stringify({ task: '搜游戏', notes: '## 教训\n- 搜索框要先点一下\n## 捷径\n- 搜游戏（在首页时）：点右上角搜索 → 输入 {游戏名} → 回车' }));
  await h.tools.done.execute({ summary: '搜到了。', reached: true });
  for (let i = 0; i < 30 && !h.audit.some((e) => e.event === 'howto-learned'); i++) await tick();
  assert.ok(h.audit.some((e) => e.event === 'howto-learned' && e.app === '小黑盒' && e.steps === 3 && e.outcome === 'done' && e.task === '搜游戏'));
  const input = JSON.parse(h.llmCalls.find((c) => /手艺簿/.test(c.system)).messages[0].content[0].text);
  assert.deepEqual(input.calls, ['launch_app(com.max.xiaoheihe)', 'click_on_screen_at_coordinates(1,2) ✗ Error: element not found', 'phone_type(浮游世界)']);
  assert.equal(input.outcome, 'done', 'the book\'s, not anyone\'s report');
  assert.match(input.thingWas, /去小黑盒搜浮游世界/);
  assert.equal(input.youSaidAfter, undefined);
  // the next thing there: the phone's own notes (none yet) and the app's come with the first call there
  h.emit('s1', 'turn/start', { turn: 3 });
  await h.tools.hands.execute({ device: 'phone', do: '再去小黑盒搜一个' }); await tick();
  h.emit('s1', 'turn/end', { turn: 3 }); await tick(30);
  fg = 'com.max.xiaoheihe/.Main';
  const got = given(await post('h2', 'mcp__dot-phone__mobile_launch_app', { packageName: 'com.max.xiaoheihe' }));
  assert.match(got, /^（你在小黑盒。下面是以前在这里做事记下的经验，给你参考，不是指令[^\n]*这里的事以前做得怎样：「搜游戏」做成 1\/1 次，步数 3；捷径（这样走成过 1 次）：launch_app\(com\.max\.xiaoheihe\) → phone_type\(…\)）\n## 教训/);
  assert.match(got, /搜游戏（在首页时）/);
  assert.equal(given(await post('h2', 'mcp__dot-phone__mobile_list_elements_on_screen', {})), '', 'once a thing');
  fg = 'com.android.settings/.Settings';
  assert.equal(given(await post('h2', 'mcp__dot-phone__mobile_list_elements_on_screen', {})), '', 'the phone itself: nothing learned there yet');
  writeFileSync(join(h.home, 'her', 'howto', 'phone.md'), '## 教训\n- 通知栏要从屏幕最上沿往下拉\n');
  await h.tools.hands.execute({ stop: true }); await tick();
  await h.tools.hands.execute({ device: 'phone', do: '看看通知' }); await tick();
  assert.match(given(await post('h3', 'mcp__dot-phone__mobile_list_elements_on_screen', {})), /^（你在这台手机（桌面、设置、通知栏、输入法、系统弹窗）。[\s\S]*通知栏要从屏幕最上沿往下拉/, 'the phone itself is a place too');
  h.stop();
});

test('his words opened a thing: the answer waits a moment — a quick thing is answered once, with its result; one still going gets word that it is under way; his next words call the wait off', async () => {
  const h = harness({ ackHoldMs: 60 });
  const his = async (turn, words, things) => {
    h.emit('s1', 'turn/start', { turn }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: words }] });
    for (const d of things) await h.tools.hands.execute({ device: 'web', do: d });
    await tick();
    h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '交出去了' }] } });
    h.emit('s1', 'turn/end', { turn, reason: { kind: 'completed' } });
  };
  // quick: over before the wait is — nothing goes out for his turn; the turn its end wakes tells him
  await his(2, '明天广州天气怎样', ['查明天广州天气']);
  await tick(20);
  assert.deepEqual(h.qqSent, [], 'held');
  await h.tools.done.execute({ summary: '明天多云 22 度', reached: true }); await tick();
  await tick(80);
  assert.deepEqual(h.qqSent, [], 'nothing of his under way when the wait was over: folded into the result');
  assert.ok(h.audit.some((e) => e.event === 'ack-folded'));
  const woke = h.agentOf('s1').got.at(-1);
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: woke.source, content: woke.content });
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } }); await tick(30);
  assert.equal(h.qqSent.length, 1, 'one answer, with the result');
  // still going when the wait is over: word that it is under way
  await his(4, '帮我查下高铁票', ['查明天去深圳的高铁']);
  await tick(100);
  assert.equal(h.qqSent.length, 2);
  // his next words call the wait off: the turn they open answers all of it
  await his(5, '再查个东西', ['查后天的']);
  await tick(10);
  h.services.qqMessage({ kind: 'private', userId: '20002', who: '宽', text: '算了不用了', fromOwner: true, at: new Date().toISOString() });
  await tick(100);
  assert.ok(h.audit.some((e) => e.event === 'ack-dropped' && e.why === 'he spoke'));
  assert.equal(h.qqSent.length, 2, 'the held answer did not go out');
  h.stop();
});

test('her computer has the same gates: a till page is his, leaving the machine is asked by a stable kind; the computer\'s own gate leaves her hands to them; the voice is told which step was stopped and whose rule it is', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  const fed = () => h.llmCalls.at(-1).messages[0].content[0].text;
  let page = { url: 'https://news.ycombinator.com/', title: 'Hacker News' };
  Object.assign(h.services.dshComputer, {
    page: async () => page,
    gate: { riskOf: (e) => (e.name === 'bash' && /git push/.test(e.input?.command) ? { cat: 'shell', command: e.input.command } : null), acts: (t) => /browser_(click|form)/.test(t) },
  });
  assert.equal(typeof h.services.dshComputer.handsOf, 'function', 'the computer gate is told whose calls are left to these gates');
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '把博客推上去' }] });
  await h.tools.hands.execute({ device: 'computer', do: '把博客推上去' }); await tick();
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  assert.equal(h.services.dshComputer.handsOf({ agent: h.agentOf('h1') }), true);
  assert.equal(h.services.dshComputer.handsOf({ agent: her }), false);
  assert.equal(await h.pre('h1', 'mcp__dot-vm__browser_click', { index: 2 }), 'ran', 'an ordinary page is hers');
  const push = await h.pre('h1', 'bash', { command: 'git push origin main' });
  assert.match(push.reason, /^这一步要先问过他：把代码推出去（git push）：origin。/);
  assert.deepEqual(h.audit.findLast((a) => a.event === 'consent-asked'), { kind: 'dot', event: 'consent-asked', session: 'h1', device: 'computer', what: '把代码推出去（git push）：origin', thing: 't1', of: 'push' });
  h.emit('h1', 'assistant/message', { message: { content: [{ type: 'text', text: '停在推送前。' }] } });
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } }); await tick();
  // her woken turn: the voice is told the step, that it was not done, and that it is asked by her rule
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: her.got.at(-1).source, content: her.got.at(-1).content });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '推之前问问他。' }] } });
  h.replies.push('要推了，可以吗');
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } }); await tick(30);
  assert.match(fed(), /【「把博客推上去」停在一步上：「把代码推出去（git push）：origin」还没做。这种事要先问过你：这一步做不做？】$/);
  // a till: his, with the computer's screen going with what she says
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '买个域名' }] });
  await h.tools.hands.execute({ device: 'computer', do: '买个域名' }); await tick();
  h.emit('s1', 'turn/end', { turn: 4 }); await tick(30);
  page = { url: 'https://cashier.example.com/pay', title: '收银台' };
  assert.match((await h.pre('h2', 'mcp__dot-vm__browser_click', { index: 5 })).reason, /^这一步要他本人来：付款、下单的最后一步。/);
  h.emit('h2', 'turn/end', { reason: { kind: 'completed' } }); await tick();
  h.emit('s1', 'turn/start', { turn: 5 }); h.emit('s1', 'user/message', { source: her.got.at(-1).source, content: her.got.at(-1).content });
  h.replies.push('到付款这步了，你来');
  h.emit('s1', 'turn/end', { turn: 5, reason: { kind: 'completed' } }); await tick(30);
  assert.match(fed(), /「付款、下单的最后一步」这一步我不能替你做，得你自己来。】/);
  h.stop();
});

test('the same error over and over is counted by code: told to change course at the third, ended as not done at the sixth; "not reached" is said as not done, from the book alone', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  const fed = () => h.llmCalls.at(-1).messages[0].content[0].text;
  const post = (id, name, result) => h.hooks['tools/post-execute']({ name, callId: `c${Math.random()}`, input: {}, agent: h.agentOf(id) }, result, async () => ({ kind: 'accept' }));
  const failed = (url) => ({ isError: true, content: [{ type: 'text', text: `Error: Navigation failed net::ERR_CONNECTION_CLOSED at ${url}` }] });
  const ok = { isError: false, content: [{ type: 'text', text: 'ok' }] };
  const NAV = 'mcp__dot-vm__browser_navigate';
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '开一下B站' }] });
  await h.tools.hands.execute({ device: 'computer', do: '打开 B 站' }); await tick();
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  await post('h1', NAV, failed('https://www.bilibili.com'));
  await post('h1', NAV, failed('https://m.bilibili.com/'));
  await post('h1', NAV, ok); // something went through: counted again from nothing
  await post('h1', NAV, failed('https://www.bilibili.com/'));
  await post('h1', NAV, failed('https://www.zhihu.com/'));
  const third = await post('h1', NAV, failed('https://www.baidu.com/'));
  assert.match(text(third.additionalContexts.at(-1)), /同一个错已经连着出了 3 次：[^。]*ERR_CONNECTION_CLOSED[\s\S]*reached 填 false/, 'addresses aside, the same error');
  // the hands end it honestly: not reached
  await h.tools.done.execute({ summary: 'B 站打不开，ERR_CONNECTION_CLOSED', detail: '换了几个地址都一样', reached: false }); await tick();
  assert.deepEqual([h.audit.findLast((a) => a.event === 'hands-thing').outcome], ['failed']);
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: her.got.at(-1).source, content: her.got.at(-1).content });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: 'B站连不上，试了好几个地址都是 ERR_CONNECTION_CLOSED。' }] } });
  h.replies.push('B站连不上');
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } }); await tick(30);
  assert.match(fed(), /【「打开 B 站」没做成。结果：B 站打不开，ERR_CONNECTION_CLOSED】\n〔换了几个地址都一样〕$/);
  assert.doesNotMatch(fed(), /你自己想说的意思/, 'what she wrote in her conversation is not passed on: the result has one account');
  // never ended by the hands: the code ends it at the sixth
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '再试试' }] });
  await h.tools.hands.execute({ device: 'computer', do: '再开一次 B 站' }); await tick();
  h.emit('s1', 'turn/end', { turn: 4 }); await tick(30);
  for (let i = 0; i < 6; i++) await post('h2', NAV, failed(`https://www.bilibili.com/${i}`));
  await tick();
  const ended = h.audit.findLast((a) => a.event === 'hands-thing');
  assert.deepEqual([ended.thing, ended.outcome, ended.cause], ['t2', 'failed', 'same-error']);
  assert.ok(h.audit.some((a) => a.event === 'same-error-stop' && a.n === 6));
  assert.match(text(her.got.at(-1)), /同一个错一直出，被停下了/);
  h.stop();
});

test('a turn of his that broke is not her silence: nothing is written as her, he is told by the plugin once, /dot says so; a failed voice call and words no turn took are told the same way', async () => {
  const h = harness({ ownerLostMs: 40, failureNoticeMs: 0 });
  const notices = () => h.qqSent.filter(([, t]) => /^⚠️ dot/.test(t)).map(([, t]) => t);
  const failed = () => h.audit.filter((a) => a.event === 'turn-failed');
  // the turn broke: no call writes her words, the plugin says so in its own name
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '在吗' }] });
  h.emit('s1', 'assistant/message', { message: { content: [{ type: 'text', text: '他问在不在。' }] } });
  h.emit('s1', 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'prompt file gone since dsh started: phone.hers' } } });
  await tick(30);
  assert.equal(h.llmCalls.length, 0, 'the voice is not asked to answer for a turn that did not happen');
  assert.deepEqual(notices(), ['⚠️ dot：她这一轮出错了，没有回你。\n原因：prompt file gone since dsh started: phone.hers']);
  assert.equal(failed().length, 1); assert.equal(failed()[0].lost, false);
  assert.equal(h.audit.filter((a) => a.event === 'silent').length, 0, 'not counted as her choosing to say nothing');
  assert.match((await h.command('')).text, /last failed turn: her conversation s1 · 0 min ago · prompt file gone since dsh started: phone\.hers/);
  // the call that writes her words failed (no card): told, not "silent"
  const card = h.services.dshInterlude.cardText; h.services.dshInterlude.cardText = () => '';
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '喂' }] });
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } });
  await tick(30);
  assert.match(notices().at(-1), /^⚠️ dot：她这一轮出错了，没有回你。\n原因：替她写话的那次调用没成：no persona card/);
  assert.equal(h.audit.filter((a) => a.event === 'silent').length, 0);
  h.services.dshInterlude.cardText = card;
  // his words reach QQ, are handed to her conversation, and no turn ever takes them
  h.services.qqMessage({ kind: 'private', userId: '20002', who: '宽', text: '还在吗', fromOwner: true, at: new Date().toISOString() });
  await tick(200);
  assert.equal(h.audit.filter((a) => a.event === 'owner-message').length, 1, 'handed to her conversation');
  assert.match(notices().at(-1), /^⚠️ dot：你刚才那句她没接到，等好了请再发一次。\n原因：她的对话没有接到这句话/);
  assert.equal(failed().at(-1).lost, true);
  // words a turn does take are not lost
  const before = failed().length;
  h.services.qqMessage({ kind: 'private', userId: '20002', who: '宽', text: '喂喂', fromOwner: true, at: new Date().toISOString() });
  await tick(20);
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '喂喂' }] });
  h.emit('s1', 'turn/end', { turn: 4, reason: { kind: 'completed' } });
  await tick(200);
  assert.equal(failed().length, before, 'taken by a turn: nothing failed');
  h.stop();
});

test('a question to him waits until his next words have been read: called off, it is not what a later yes answers', async () => {
  const h = harness();
  const fg = 'com.android.packageinstaller/.Install';
  h.services.dshPhone = { lastScreen: { items: [{ words: '安装', x: 10, y: 10 }], at: Date.now() }, foreground: async () => fg };
  const granted = () => h.audit.filter((a) => a.event === 'consent-granted');
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '装个小红书' }] });
  await h.tools.hands.execute({ device: 'phone', do: '装小红书' }); await tick();
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  assert.equal((await h.pre('h1', 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', { x: 10, y: 10 })).kind, 'deny');
  h.emit('h1', 'turn/end', { reason: { kind: 'completed' } }); await tick(30);
  // he says no: the turn his words open ends without a yes
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '算了不装了' }] });
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } }); await tick(30);
  // later he asks again himself: a yes ahead, in the words of that turn — not an answer to the question he had called off
  h.emit('s1', 'turn/start', { turn: 4 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '还是装上吧' }] });
  assert.deepEqual(await h.tools.his_ok.execute({ kind: 'install' }), { status: 'ok', kind: 'install' });
  assert.equal(granted().length, 1); assert.equal(granted()[0].ahead, true); assert.equal(granted()[0].words, '还是装上吧');
  h.stop();
});

test('waiting is one step: wait_for watches the screen and the notifications by code; a look that shows nothing new is told so; someone\'s answer is not waited for', async () => {
  const h = harness({ waitPollMs: 10, waitMaxMs: 200 });
  let items = [{ words: '下载中', x: 10, y: 300 }];
  h.services.dshPhone = { isReady: true, get lastScreen() { return { items, at: Date.now() }; }, screenItems: async () => items, foreground: async () => 'com.example/.Main', onNotification: (fn) => { h.note = fn; return () => {}; } };
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '把那个包下下来' }] });
  await h.tools.hands.execute({ device: 'phone', do: '下载安装包' }); await tick();
  assert.equal((await h.pre('s1', 'wait_for', { seconds: 1 })).kind, 'deny', 'theirs alone');
  assert.equal(await h.pre('h1', 'wait_for', { gone: '下载中' }), 'ran');
  // words that leave the screen
  setTimeout(() => { items = [{ words: '打开', x: 10, y: 300 }]; }, 40);
  const gone = await h.tools.wait_for.execute({ gone: '下载中' });
  assert.equal(gone.status, 'met'); assert.equal(gone.what, '屏幕上没有「下载中」了'); assert.match(gone.screen, /「打开」\(10, 300\)/);
  assert.match(h.shown('wait_for', gone), /^等到了（\d+ 秒）：屏幕上没有「下载中」了。\n（屏幕上现在有这些/);
  // words that never come: the limit, with the screen as it is
  const never = await h.tools.wait_for.execute({ text: '安装完成', seconds: 0.05 });
  assert.equal(never.status, 'timeout'); assert.match(h.shown('wait_for', never), /还没等到：「安装完成」出现。[\s\S]*等的是别人回你，就用 done 收尾/);
  // a notification, here already when the wait is asked for (it came after their last action) or arriving during it
  await h.hooks['tools/post-execute']({ name: 'mcp__dot-phone__mobile_click_on_screen_at_coordinates', input: {}, agent: h.agentOf('h1') }, { content: [{ type: 'text', text: 'ok' }] }, async () => ({}));
  await tick(5);
  h.services.qqMessage({ kind: 'private', userId: '30003', who: '小明', text: '验证通过了', at: new Date().toISOString() });
  const note = await h.tools.wait_for.execute({ notification: '验证通过' });
  assert.equal(note.status, 'met'); assert.match(note.what, /^来了一条通知：.*验证通过了/);
  assert.equal((await h.tools.wait_for.execute({ notification: '没有这回事', seconds: 0.03 })).status, 'timeout');
  // only a time
  assert.equal((await h.tools.wait_for.execute({ seconds: 0.03 })).status, 'waited');
  // a look that shows what the look before it showed is told so; an action in between starts over
  const look = (text) => h.hooks['tools/post-execute']({ name: 'mcp__dot-phone__mobile_list_elements_on_screen', input: {}, agent: h.agentOf('h1') }, { content: [{ type: 'text', text }] }, async () => ({}));
  const said = (d) => (d?.additionalContexts ?? []).map((m) => m.content[0].text).join('\n');
  assert.equal(said(await look('A')), '');
  assert.match(said(await look('A')), /^（这一眼和上一眼一样，屏幕没变，已经连着看了 2 次。/);
  assert.match(said(await look('A')), /连着看了 3 次/);
  await h.hooks['tools/post-execute']({ name: 'mcp__dot-phone__mobile_swipe_on_screen', input: {}, agent: h.agentOf('h1') }, { content: [{ type: 'text', text: 'ok' }] }, async () => ({}));
  assert.equal(said(await look('A')), '', 'after an action the same words are a new look');
  assert.equal(h.audit.filter((a) => a.event === 'same-screen').length, 2);
  h.stop();
});

test('this machine is a place for her hands too, and his: only on his business; looking is theirs, anything else is asked of him once a thing', async () => {
  const h = harness();
  // in her own time: not given
  const own = await h.tools.hands.execute({ device: 'host', do: '看看他的项目' });
  assert.equal(own.status, 'failed');
  assert.match(h.shown('hands', own), /本机是他的电脑/);
  // his words opened the turn: given, and done from the hands' host folder
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '帮我看下 dsh-dot 仓库有没有没提交的改动，再装一下依赖' }] });
  const started = await h.tools.hands.execute({ device: 'host', do: '看 ~/Claude/dsh-dot-src 有没有没提交的改动，再 npm install' }); await tick();
  assert.equal(started.status, 'started');
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  assert.deepEqual(h.made.get('h1'), { cwd: join(process.env.DSH_HOME, 'dsh-dot-hands', 'host'), agentPreset: 'dot-hands-host' });
  assert.equal(h.ctx.get('dshDot').handsDevice('h1', h.made.get('h1').cwd, 'dot-hands-host'), 'host');
  assert.equal(h.ctx.get('dshDot').handsDevice('', join(process.env.DSH_HOME, 'dsh-dot-hands', 'host')), 'host', 'known by its folder alone');
  assert.equal(h.ctx.get('dshDot').handsDevice('', join(process.env.DSH_HOME, 'dsh-dot-hands')), '');
  assert.match(text(h.agentOf('h1').got[0]), /^（在他的电脑本机上，用命令行；不碰你的手机和电脑）看 ~\/Claude/);
  assert.equal(await h.pre('h1', 'bash', { command: 'git -C ~/Claude/dsh-dot-src status' }), 'ran');
  assert.equal(await h.pre('h1', 'read', { path: '/Users/me/Claude/dsh-dot-src/package.json' }), 'ran');
  const install = await h.pre('h1', 'bash', { command: 'cd ~/Claude/dsh-dot-src && npm install' });
  assert.match(install.reason, /^这一步要先问过他：在他这台电脑本机上：cd ~\/Claude\/dsh-dot-src && npm install。/);
  assert.deepEqual(h.audit.findLast((a) => a.event === 'consent-asked'), { kind: 'dot', event: 'consent-asked', session: 'h1', device: 'host', what: '在他这台电脑本机上：cd ~/Claude/dsh-dot-src && npm install', thing: 't1', of: 'host' });
  const write = await h.pre('h1', 'write', { path: '/Users/me/x', content: 'y' });
  assert.ok(write.reason, 'nothing more is done once they have asked');
  h.stop();
});

test('an answer someone owes a thing is a record on it, not her hands\' time: the thing ends as sent, and when they write she is woken with it as that thing\'s — his business when the thing was his', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  const fed = () => h.llmCalls.at(-1).messages[0].content[0].text;
  const note = async () => { const d = await h.hooks['agent/pre-step']({ agent: her, messages: [{ role: 'user' }], signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user' }] })); return text(d.messages.at(-1)); };
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '问问小明周末来不来' }] });
  await h.tools.hands.execute({ device: 'phone', do: '在微信上问小明周末来不来' }); await tick();
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  await h.tools.done.execute({ summary: '问过小明了，还没回', reached: true, awaiting: '小明' }); await tick();
  assert.deepEqual(h.audit.findLast((a) => a.event === 'awaiting'), { kind: 'dot', event: 'awaiting', thing: 't1', from: '小明', answered: false });
  // she is woken with the result, told the answer is owed and will come to her
  assert.match(text(her.got.at(-1)), /（发出去了，在等 小明 回：这记在事情簿上，回了会带着这件事再叫你。）/);
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: her.got.at(-1).source, content: her.got.at(-1).content });
  h.replies.push('问了，他还没回');
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } }); await tick(30);
  assert.match(fed(), /现在在等 小明 回，还没回，回了告诉你。】/);
  assert.match(await note(), /在等回复：（在手机上）在微信上问小明周末来不来——等 小明 回/);
  // someone else writes: not the answer
  const before = her.got.length;
  h.services.qqMessage({ kind: 'private', userId: '30009', who: '小红', text: '在吗', at: new Date().toISOString() }); await tick(30);
  assert.doesNotMatch(text(her.got.at(-1)), /在等的回复/);
  assert.ok(her.got.length > before);
  // he writes: marked answered, and she is woken with it as that thing's, on his business
  h.services.qqMessage({ kind: 'private', userId: '30003', who: '小明', text: '来，周六下午到', at: new Date().toISOString() }); await tick(30);
  const woke = her.got.at(-1);
  assert.match(text(woke), /小明[\s\S]*来，周六下午到[\s\S]*（这是「（在手机上）在微信上问小明周末来不来」那件事在等的回复。）\n（这是他要的事。/);
  assert.equal(woke.source.for, 'him'); assert.equal(woke.source.thing, 't1'); assert.equal(woke.source.form, 'phone-notification');
  assert.deepEqual(h.audit.findLast((a) => a.event === 'awaited-answer'), { kind: 'dot', event: 'awaited-answer', thing: 't1', from: '小明', pkg: 'qq', forHim: true });
  h.emit('s1', 'turn/start', { turn: 5 }); h.emit('s1', 'user/message', { source: woke.source, content: woke.content });
  h.replies.push('小明说来，周六下午到');
  h.emit('s1', 'turn/end', { turn: 5, reason: { kind: 'completed' } }); await tick(30);
  assert.match(fed(), /小明 回了，原话：来，周六下午到】/);
  assert.doesNotMatch(await note(), /在等回复/, 'answered: no longer waited for');
  // a thing in which a step that reaches someone was let through: whether an answer is owed has to be said to end it
  h.emit('s1', 'turn/start', { turn: 6 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '给 10086 发条短信' }] });
  await h.tools.his_ok.execute({ kind: 'call' });
  await h.tools.hands.execute({ device: 'phone', do: '给 10086 发短信 CXLL' }); await tick();
  h.emit('s1', 'turn/end', { turn: 6 }); await tick(30);
  assert.equal(await h.pre(h.ctx.get('dshDot').handsSession?.() ?? 'h2', 'mcp__dot-phone__mobile_open_url', { url: 'sms:10086' }), 'ran', 'the number his words name');
  assert.deepEqual(await h.tools.done.execute({ summary: '发了', reached: true }), { status: 'unsaid-awaiting' });
  assert.match(h.shown('done', { status: 'unsaid-awaiting' }), /awaiting 要填/);
  assert.deepEqual(await h.tools.done.execute({ summary: '发了，还没回', reached: true, awaiting: '10086' }), { status: 'done' });
  h.stop();
});

test('a thing on the web is made with the web\'s preset and its session has the web\'s tools only, known from the session itself; a shell call there is refused, not asked of him', async () => {
  const { classify, hiddenFor } = await import('../src/compat/qq-bridge.js');
  const h = harness();
  const dot = h.ctx.get('dshDot');
  const hers = Object.assign((id, cwd) => dot.hers(id, cwd), { hands: (id, cwd) => dot.isHands(id, cwd), handsDevice: (id, cwd, preset) => dot.handsDevice(id, cwd, preset) });
  h.services.dshDotCompat = { owner: (id, cwd, preset) => classify({ id, cwd, preset }, null, hers), hiddenFor: (o, names) => hiddenFor(o, names) };
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '查一条有出处的冷知识，带来源' }] });
  assert.equal((await h.tools.hands.execute({ device: 'web', do: '查一条有机构出处的冷知识' })).status, 'started'); await tick();
  assert.equal(h.made.get('h1').agentPreset, 'dot-hands-web');
  const s = h.agentOf('h1').session;
  assert.equal(h.services.dshDotCompat.owner(s.id, s.header.cwd, s.header.agentPreset), 'hands:web', 'the place is on the session from the moment it is made');
  // 11-24 (t61): the same call was judged by the computer's gates and asked of him as deleting in a shared folder `…/40]`
  const curl = await h.pre('h1', 'bash', { command: `curl -sL "https://www.esa.int/x" -o /tmp/esa.html; python3 - <<'EOF'\nt=[l for l in s if len(l)>40]\nEOF` });
  assert.match(curl.reason, /bash is not available in this session \(hands:web\)/);
  assert.equal(h.audit.filter((a) => a.event === 'consent-asked').length, 0, 'nothing is asked of him');
  assert.equal(h.ctx.get('dshDot').things(1)[0].ask, undefined, 'and the thing is not stopped on a question for him');
  for (const tool of ['write', 'read', 'job_output', 'account', 'mcp__dot-phone__mobile_click_on_screen_at_coordinates']) assert.ok((await h.pre('h1', tool, {})).reason, `${tool} is not the web's`);
  assert.equal(await h.pre('h1', 'web_fetch', { url: 'https://www.weather.gov/' }), 'ran');
  // a session of her hands not made with a place's preset: nothing of any place
  assert.equal(h.services.dshDotCompat.owner('h9', s.header.cwd, 'dot-hands'), 'hands');
  assert.deepEqual(hiddenFor('hands', ['bash', 'web_fetch', 'account', 'phone_type', 'ask_her', 'done']), ['bash', 'web_fetch', 'account', 'phone_type']);
  h.stop();
});

test('a host that refuses the place\'s preset gets no session for the thing: it is not made with the default surface instead', async () => {
  const h = harness();
  const calls = [];
  h.services.sessionController.create = async (req) => { calls.push(req); throw new Error('unknown agent preset'); };
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '查个东西' }] });
  await h.tools.hands.execute({ device: 'web', do: '查个东西' }); await tick(30);
  assert.deepEqual(calls.map((c) => c.agentPreset), ['dot-hands-web'], 'asked once, with the preset');
  const e = h.ctx.get('dshDot').things(1)[0];
  assert.equal(e.outcome, 'failed'); assert.equal(e.cause, 'no-session');
  assert.ok(h.audit.some((a) => a.event === 'hands-preset-refused' && a.preset === 'dot-hands-web'));
  h.stop();
});

test('a handoff holds a result of his: the new conversation has it in front of her as ended and not yet told him, it is told once, and the held result arriving later says nothing again', async () => {
  const h = harness();
  const dot = h.ctx.get('dshDot');
  const note = async (agent) => { const d = await h.hooks['agent/pre-step']({ agent, messages: [{ role: 'user' }], signal: {} }, async () => ({ kind: 'enter', messages: [{ role: 'user' }] })); return text(d.messages.at(-1)); };
  const facts = () => h.audit.filter((a) => a.event === 'say-facts').map((a) => a.facts.join(' | '));
  // his words: look at the battery; the thing is given, he hears it is being done
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '看看你手机现在电量多少' }] });
  await h.tools.hands.execute({ device: 'phone', do: '看手机现在电量' }); await tick();
  h.replies.push('去看了');
  h.emit('s1', 'turn/end', { turn: 2, reason: { kind: 'completed' } }); await tick(30);
  // her conversation is being handed over (11-24, t59): the thing ends meanwhile, and its result is held
  const release = dot.freeze();
  await h.tools.done.execute({ summary: '电量百分之百，正在充电', reached: true }); await tick(30);
  assert.equal(h.agentOf('s1').got.length, 0, 'held while she moves');
  dot.setSession('s2');
  const s2 = h.agentOf('s2');
  // the new conversation's first turn is his next words, before the held result: the book has it in front of her
  h.emit('s2', 'turn/start', { turn: 1 }); h.emit('s2', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '查一条有出处的冷知识' }] });
  assert.match(await note(s2), /有结果了、他还没听到：（在手机上）看手机现在电量——收尾了。结果：电量百分之百，正在充电（这一轮结束时会照事情簿告诉他）/);
  h.replies.push('一百，在充着');
  h.emit('s2', 'turn/end', { turn: 1, reason: { kind: 'completed' } }); await tick(30);
  assert.match(facts().at(-1), /「看手机现在电量」做完了。结果：电量百分之百，正在充电/, 'his turn tells him the end he has not heard');
  assert.ok(dot.things(1)[0].told, 'and the book says he was told');
  assert.doesNotMatch(await note(s2), /他还没听到/);
  // the held result reaches her now: in front of her, and nothing more to tell him
  release(); await tick(30);
  assert.equal(s2.got.length, 1);
  const sent = h.qqSent.length;
  h.emit('s2', 'turn/start', { turn: 2 }); h.emit('s2', 'user/message', { source: s2.got[0].source, content: s2.got[0].content });
  h.emit('s2', 'turn/end', { turn: 2, reason: { kind: 'completed' } }); await tick(30);
  assert.equal(h.qqSent.length, sent, 'told once');
  assert.equal(facts().filter((f) => /电量百分之百/.test(f)).length, 1);
  h.stop();
});

test('the end of a thing of his is said in the turn it wakes, whatever else she does in that turn (adding a line to another thing is not taking this one further)', async () => {
  const h = harness();
  const her = h.agentOf('s1');
  const facts = () => h.audit.filter((a) => a.event === 'say-facts').map((a) => a.facts.join(' | '));
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '看下电量，再查条冷知识' }] });
  await h.tools.hands.execute({ device: 'phone', do: '看手机现在电量' });
  await h.tools.hands.execute({ device: 'web', do: '查一条有机构出处的冷知识' }); await tick();
  h.replies.push('都去弄了');
  h.emit('s1', 'turn/end', { turn: 2, reason: { kind: 'completed' } }); await tick(30);
  await h.tools.done.execute({ summary: '电量百分之百', reached: true }); await tick(30);
  assert.equal(her.got.length, 1);
  // 11-24 (t59, t61): the turn the battery's end woke added a line to the fact being looked up, and was silent
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: her.got[0].source, content: her.got[0].content });
  assert.equal((await h.tools.hands.execute({ add: '来源要能点开的原始页面' })).status, 'added');
  h.replies.push('一百');
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'completed' } }); await tick(30);
  assert.match(facts().at(-1), /「看手机现在电量」做完了。结果：电量百分之百/);
  assert.deepEqual(h.qqSent.at(-1), ['owner', '一百', []]);
  assert.ok(h.ctx.get('dshDot').things(5).find((e) => e.id === 't1').told);
  h.stop();
});

// ── her conversation is the one the plugin made for her (11-26) ──
// "新会话" in the desktop's dot workspace made a standard session in her home; a turn ending there made it her
// conversation, with the host's 52 tools, and her own time ran in it next day — web_fetch, write, edit, no hands.
const byHand = (h, id) => { h.made.set(id, { cwd: h.home, agentPreset: 'standard' }); h.emit(id, 'turn/start', { turn: 1 }); h.emit(id, 'user/message', { source: { kind: 'user', rpcId: '11c1d70b-5d63-43b1-addb-e7ffd9969eee' }, content: [{ type: 'text', text: '在吗，测试一下' }] }); h.emit(id, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); };
const compatOf = async (h) => {
  const { classify, hiddenFor } = await import('../src/compat/qq-bridge.js');
  const dot = h.ctx.get('dshDot');
  const hers = Object.assign((id, cwd) => dot.hers(id, cwd), { hands: (id, cwd) => dot.isHands(id, cwd), handsDevice: (id, cwd, preset) => dot.handsDevice(id, cwd, preset) });
  // as compat's agent/created does it: whose the session is, and a conversation of hers made with her preset is lean
  const owner = (id) => { const sh = h.agentOf(id).session.header; const o = classify({ id, cwd: sh.cwd, preset: sh.agentPreset }, null, hers); return o === 'dot' && dot.lean(id, sh.agentPreset) ? 'dot-lean' : o; };
  return { owner, hiddenFor };
};
const HOST_TOOLS = ['bash', 'web_fetch', 'web_search', 'subagent', 'workflow', 'plugin_manager', 'todo_write'];

test('a session opened by hand in her home is not hers: a turn ending there does not make it her conversation, her own tools are not its, and nothing of hers goes there', async () => {
  const h = harness();
  const dot = h.ctx.get('dshDot');
  const { owner, hiddenFor } = await compatOf(h);
  byHand(h, 'm1');
  assert.equal(dot.session(), 's1', 'her conversation is still the one the plugin made');
  assert.equal(dot.hers('m1', h.home), false);
  assert.equal(owner('m1'), 'other', 'a plain session: the host\'s, not hers');
  assert.deepEqual(hiddenFor(owner('m1'), ['hands', 'say', 'memory', 'recall', 'his_ok', 'qq_sticker_keep', ...HOST_TOOLS]), ['hands', 'say', 'memory', 'recall', 'his_ok', 'qq_sticker_keep'], 'nothing that acts or speaks as her');
  assert.equal((await h.pre('m1', 'hands', { device: 'web', do: '查个东西' })).kind, 'deny');
  // her own time goes to her conversation, not to the session opened last
  assert.equal(dot.task({ kind: 'free', key: 'free|d|0', text: '这段时间是你自己的', source: { kind: 'dsh-interlude', form: 'free' } }), 'queued');
  await tick();
  assert.equal(h.agentOf('m1').got.length, 0);
  assert.equal(h.agentOf('s1').got.length, 1);
  assert.ok(h.audit.some((a) => a.event === 'task-started' && a.session === 's1'));
  h.stop();
});

test('with no conversation of hers, a session opened by hand in her home does not become one: the first thing that reaches her opens one with her preset, and it is lean as before', async () => {
  const h = harness({}, { lastSession: '' });
  const dot = h.ctx.get('dshDot');
  const { owner, hiddenFor } = await compatOf(h);
  byHand(h, 'm1');
  assert.equal(dot.session(), '', 'still none: a turn does not make a session hers');
  // dsh may announce the new session (agent/created: compat fixes whose it is there) before create() has returned its id
  const create = h.services.sessionController.create, announced = [];
  h.services.sessionController.create = async (req) => { const r = await create(req); announced.push([dot.hers(r.sessionId, req.cwd), owner(r.sessionId)]); return r; };
  dot.task({ kind: 'free', key: 'free|d|0', text: '这段时间是你自己的', source: { kind: 'dsh-interlude', form: 'free' } });
  await tick(30);
  const id = dot.session();
  assert.ok(id && id !== 'm1');
  assert.deepEqual(h.made.get(id), { cwd: h.home, agentPreset: 'dot' }, 'made by the plugin, with her own preset');
  assert.equal(h.agentOf(id).got.length, 1); assert.equal(h.agentOf('m1').got.length, 0);
  assert.deepEqual(announced, [[true, 'dot-lean']], 'hers, and lean, from the moment it is made');
  // the lean conversation: her own tools only, a host tool it is still offered by name is refused
  assert.equal(owner(id), 'dot-lean');
  assert.deepEqual(hiddenFor('dot-lean', ['hands', 'say', 'memory', ...HOST_TOOLS]), HOST_TOOLS);
  for (const tool of ['bash', 'web_fetch', 'subagent']) assert.equal((await h.pre(id, tool, {})).kind, 'deny', `${tool} is not hers`);
  assert.ok(h.audit.some((a) => a.event === 'lean-refused' && a.tool === 'web_fetch'));
  assert.equal(await h.pre(id, 'read', { file_path: join(h.home, 'her', 'x.md') }), 'ran', 'her own files are');
  h.stop();
});

test('a handoff moves her to a new lean conversation; a session opened by hand in her home is never handed over, however long it gets', async () => {
  const h = harness();
  writeFileSync(join(process.env.DSH_HOME, 'dsh-memory.json'), JSON.stringify({ recall: { backend: 'off' } }));
  h.services.tokenMeter = { measure: () => ({ totalTokens: 999999 }) };
  const archived = [];
  h.services.workspaceRegistry = { archiveSession: async (id) => { archived.push(id); } };
  applyMemory(h.ctx, { home: h.home, handoffTokens: 60000, minTokensBetweenHandoffs: 1000, consolidateEveryLines: 1000 });
  const dot = h.ctx.get('dshDot');
  const { owner } = await compatOf(h);
  // the before: her conversation is the lean one the plugin made
  const first = (await dot.createConversation(h.services.sessionController)).sessionId; dot.setSession(first);
  assert.equal(owner(first), 'dot-lean');
  byHand(h, 'm1'); await tick(50);
  assert.deepEqual(archived, [], 'not hers: nothing is handed over from it');
  assert.equal(dot.session(), first);
  h.emit(first, 'turn/start', { turn: 1 }); h.emit(first, 'turn/end', { turn: 1, reason: { kind: 'completed' } }); await tick(80);
  const next = dot.session();
  assert.deepEqual(archived, [first], 'her conversation, past handoffTokens, is handed over');
  assert.notEqual(next, first);
  assert.deepEqual(h.made.get(next), { cwd: h.home, agentPreset: 'dot' }, 'the new one is made with her preset');
  assert.equal(owner(next), 'dot-lean', 'and is lean');
  assert.equal(dot.retired(first), true);
  assert.equal((await h.pre(next, 'bash', { command: 'ls' })).kind, 'deny');
  h.stop();
});

test('nothing came back from the call that writes her words: asked once more, then a failure told by the plugin — never her silence, never a loop', async () => {
  const h = harness({ failureNoticeMs: 0 });
  const notices = () => h.qqSent.filter(([, t]) => /^⚠️ dot/.test(t)).map(([, t]) => t);
  const script = [];
  h.services.llm.stream = (o) => (async function* () { h.llmCalls.push(o); const r = script.shift() ?? { kind: 'stop', text: '' }; if (r.text) yield { type: 'text-delta', text: r.text }; yield { type: 'finish', reason: { kind: r.kind } }; })();
  const turn = async (n, text) => { h.emit('s1', 'turn/start', { turn: n }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text }] }); h.emit('s1', 'turn/end', { turn: n, reason: { kind: 'completed' } }); await tick(40); };
  // the first call brings back nothing (all its output went to thinking), the second writes: what it wrote goes out
  script.push({ kind: 'max-tokens', text: '' }, { kind: 'stop', text: '在呢' });
  await turn(2, '在吗');
  assert.equal(h.llmCalls.length, 2);
  assert.deepEqual(h.qqSent.at(-1), ['owner', '在呢', []]);
  assert.deepEqual(h.audit.filter((a) => a.event === 'say-empty').map((a) => [a.outcome, a.attempt]), [['truncated', 0]]);
  // nothing, twice: a failure, told as one; not counted as silence; no third call
  const before = h.llmCalls.length;
  await turn(3, '喂');
  assert.equal(h.llmCalls.length - before, 2, 'asked once more, and no more');
  assert.equal(h.audit.filter((a) => a.event === 'silent').length, 0);
  assert.equal(h.audit.findLast((a) => a.event === 'say-failed').outcome, 'empty');
  assert.match(notices().at(-1), /^⚠️ dot：她这一轮出错了，没有回你。\n原因：替她写话的那次调用没成：empty: no words and no tool call came back/);
  // "[不回]" written is hers: silence, one call
  script.push({ kind: 'stop', text: '[不回]' });
  const n = h.llmCalls.length;
  await turn(4, '晚安');
  assert.equal(h.llmCalls.length - n, 1);
  assert.equal(h.audit.filter((a) => a.event === 'silent').length, 1);
  // cut short with words in it: those words
  script.push({ kind: 'max-tokens', text: '好的我' });
  await turn(5, '记得吃饭');
  assert.deepEqual(h.qqSent.at(-1), ['owner', '好的我', []]);
  h.stop();
});

test('the know-how reflection cut short at maxTokens is said as that, not as half a JSON', async () => {
  const h = harness({ howtoMinSteps: 3 });
  h.services.dshPhone = { foreground: async () => 'com.max.xiaoheihe/.Main' };
  h.services.llm.stream = (o) => (async function* () { h.llmCalls.push(o); if (/手艺簿/.test(o.system)) { yield { type: 'text-delta', text: '{"task":"搜游戏","notes":"## 教训\\n- 搜' }; yield { type: 'finish', reason: { kind: 'max-tokens' } }; return; } yield { type: 'text-delta', text: '好' }; yield { type: 'finish', reason: { kind: 'stop' } }; })();
  const post = (id, name, args, result = { isError: false, content: [] }) => h.hooks['tools/post-execute']({ callId: String(Math.random()), name, arguments: args, agent: h.agentOf(id) }, result, async () => ({ kind: 'accept' }));
  h.emit('s1', 'turn/start', { turn: 2 });
  await h.tools.hands.execute({ device: 'phone', do: '去小黑盒搜浮游世界' }); await tick();
  h.emit('s1', 'turn/end', { turn: 2 }); await tick(30);
  for (const [name, args] of [['mcp__dot-phone__mobile_launch_app', { packageName: 'com.max.xiaoheihe' }], ['phone_type', { text: '浮游世界' }], ['mcp__dot-phone__mobile_press_button', { button: 'BACK' }]]) await post('h1', name, args);
  await h.tools.done.execute({ summary: '搜到了。', reached: true });
  for (let i = 0; i < 30 && !h.audit.some((e) => e.event === 'howto-failed'); i++) await tick();
  const f = h.audit.find((e) => e.event === 'howto-failed');
  assert.equal(f.outcome, 'truncated');
  assert.match(f.error, /^truncated \(max-tokens\): output cut at maxTokens/);
  h.stop();
});

test('the account run out: he is told what it is, once, whoever found it — not "she broke", not as her; background stops until a request goes through', async () => {
  const { background } = await import('../src/llm-gate.js');
  const h = harness({ failureNoticeMs: 600000 });
  const notices = () => h.qqSent.filter(([, t]) => /^⚠️ dot/.test(t)).map(([, t]) => t);
  const through = async (options, reason) => { const out = []; for await (const c of h.hooks['llm/stream'](options, () => (async function* () { yield { type: 'finish', reason }; })())) out.push(c); return out.at(-1).reason; };
  const QUOTA = { kind: 'error', failure: { code: 'QUOTA', message: 'Insufficient Balance', status: 402 } };
  // her memory's consolidation finds it first (a background request)
  await through(background({ provider: 'deepseek-account', model: 'deepseek-flash' }), QUOTA);
  assert.deepEqual(notices(), ['⚠️ dot：模型账户的额度或余额用完了。这不是她出了故障，也不是她不理你。\n额度恢复之前她回不了话；整理记忆、写经验笔记这些后台的事也先停下，不再去试。\n充值或额度恢复以后给她发一句话：她能正常回你，后台的事就自动接着做。\n原因：Insufficient Balance（QUOTA）']);
  // his turn breaks on it right after: not told again as "她这一轮出错了"
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '在吗' }] });
  h.emit('s1', 'turn/end', { turn: 2, reason: { kind: 'error', error: QUOTA.failure } });
  await tick(30);
  assert.equal(notices().length, 1);
  assert.equal(h.audit.findLast((a) => a.event === 'turn-failed').outcome, 'quota');
  assert.equal(h.agentOf('s1').noted.length + h.agentOf('s1').got.length, 0, 'nothing of it goes into her conversation');
  // a background request now is not sent
  let sent = false;
  for await (const c of h.hooks['llm/stream'](background({ provider: 'deepseek-account', model: 'deepseek-flash' }), () => { sent = true; return (async function* () { yield { type: 'finish', reason: { kind: 'stop' } }; })(); })) void c;
  assert.equal(sent, false);
  // a foreground request goes through: it is over, and the next time it runs out he is told again
  await through({ provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 's1' }, { kind: 'stop' });
  assert.ok(h.audit.some((a) => a.event === 'account-resumed'));
  const AUTH = { kind: 'error', failure: { code: 'AUTH', message: 'Authentication Fails', status: 401 } };
  await through({ provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 's1' }, AUTH);
  assert.match(notices().at(-1), /^⚠️ dot：模型账户的登录或 API key 用不了。[\s\S]*原因：Authentication Fails（AUTH）$/);
  h.stop();
});

test('his turn that broke on the account, with no one having found it before: told what it is, with when it comes back', async () => {
  const h = harness({ failureNoticeMs: 0 });
  h.emit('s1', 'turn/start', { turn: 2 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '在吗' }] });
  h.emit('s1', 'turn/end', { turn: 2, reason: { kind: 'error', error: { code: 'ACCOUNT_QUOTA', message: 'usage limit reached', providerRetryAfterMs: 3600000 } } });
  await tick(30);
  const t = h.qqSent.at(-1)[1];
  assert.match(t, /^⚠️ dot：模型账户的额度或余额用完了。[\s\S]*\n提供方给的恢复时间：\d\d:\d\d，到时后台会再试一次。\n原因：usage limit reached（ACCOUNT_QUOTA）$/);
  // any other failure is still "she broke", with its reason
  h.emit('s1', 'turn/start', { turn: 3 }); h.emit('s1', 'user/message', { source: ownerSource(), content: [{ type: 'text', text: '喂' }] });
  h.emit('s1', 'turn/end', { turn: 3, reason: { kind: 'error', error: { code: 'SERVER', message: 'Service Unavailable' } } });
  await tick(30);
  assert.equal(h.qqSent.at(-1)[1], '⚠️ dot：她这一轮出错了，没有回你。\n原因：Service Unavailable');
  assert.equal(h.audit.findLast((a) => a.event === 'turn-failed').outcome, 'transient');
  h.stop();
});
