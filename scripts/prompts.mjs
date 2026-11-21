#!/usr/bin/env node
// npm run prompts — every prompt file she is given, on one local page: edit one, save it to
// <home>/prompts/ (or to src/prompts/ with --src), put the built-in one back, preview it rendered
// through the real code with sample inputs, or see her whole system prompt. A developer tool.
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// dsh's own packages are peer dependencies: present where the plugin runs, usually absent in a bare
// source checkout. The prompts never need them, so a missing one is replaced by a stub.
{
  const { register } = await import('node:module');
  const stubs = {
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = (m) => m;',
    '@deepseek-ai/dsh-subprocess': 'export class SubprocessExecutableNotFoundError extends Error {}',
    '@deepseek-ai/dsh-subprocess-local': 'export class LocalSubprocessRuntime {}',
    '@deepseek-ai/dsh-mcp-client': '',
  };
  const missing = Object.fromEntries(Object.entries(stubs).filter(([n]) => { try { import.meta.resolve(n); return false; } catch { return true; } }));
  if (Object.keys(missing).length) {
    const hook = `export const resolve = (s, c, next) => (STUBS[s] ? { url: 'data:text/javascript,' + encodeURIComponent(STUBS[s]), shortCircuit: true } : next(s, c));`;
    register(`data:text/javascript,${encodeURIComponent(`const STUBS=${JSON.stringify(missing)};${hook}`)}`);
  }
}
const P = await import('../src/prompts.js');
const D = await import('../src/dot/core.js');
const I = await import('../src/interlude/core.js');
const M = await import('../src/memory/memory.js');
const S = await import('../src/memory/store.js');
const Q = await import('../src/qq/qq.js');
const { deviceText } = await import('../src/phone/phone.js');
const { createRecall, renderSeen } = await import('../src/memory/recall.js');
// Pinned now: the recall sample below points DSH_HOME (and so the settings file) at a temp dir.
P.configure({ home: P.promptHome() });

// ── samples ──
const CANON = { storyDefaults: { characterName: '小点', characterProfile: '二十三岁，刚毕业，在广州租房住。\n话少，直接，有自己的看法；熟了以后会吐槽。', perspective: '第三人称限知，贴着她。', relationship: '他是她大学时认识的朋友，现在每天都会聊几句。', userProfile: '宽，做 AI agent 开发，常熬夜。', world: '现实中国，2026 年。', location: '广州天河的一间合租房。', replyRules: '一句话一行；不用敬语。' }, blacklist: ['作为一个 AI', '我理解你的感受'], examples: '他：在吗\n她：在 怎么了' };
const T0 = Date.parse('2026-10-28T21:00:00+08:00');
const LINES = [
  { at: T0, session: 'old', who: 'owner', text: '周五前要把 benchmark 跑完' },
  { at: T0 + 6e4, session: 'old', who: 'her', text: '那你今晚别熬太晚' },
  { at: T0 + 864e5, session: 'old', who: 'owner', text: '我感冒了，嗓子疼' },
  { at: T0 + 864e5 + 6e4, session: 'old', who: 'her', text: '多喝水 别硬撑 benchmark 晚一天也行' },
];
const STICKERS = P.prompt('qq.stickers', { list: 'a1b2c3d4e5（无语）、f6e5d4c3b2（偷笑 ×3）' });
const variant = (pairs) => pairs.map(([k, v]) => `━━ ${k} ━━\n${v}`).join('\n\n');

function sampleMemory() {
  const m = S.emptyMemory();
  m.owner = ['他叫宽，在广州做 AI agent 开发', '不喜欢被叫"亲"'];
  m.self = ['装了小黑盒，常在晚上逛', '学会了在 B 站发弹幕'];
  S.openOp(m, { action: 'add', content: '10-31 他说这周要赶一个 benchmark，周五前交', due: '11-01' }, { now: T0 });
  S.openOp(m, { action: 'add', content: '10-29 她答应周末陪他看新番' }, { now: T0 + 1 });
  S.openOp(m, { action: 'add', content: '10-20 他说想换个机械键盘，先搁着' }, { now: T0 - 9 * 864e5 });
  return m;
}
let recallDir = '';
async function recallText() {
  if (!recallDir) process.env.DSH_HOME = recallDir = mkdtempSync(join(tmpdir(), 'dot-prompts-')); // no real recall settings
  const r = createRecall({ cfg: { recallBackend: 'local', recallTopK: 3, recallChunkChars: 1200, recallMaxTokens: 800, recallWindowTurns: 0 }, dir: recallDir, lines: () => LINES, logger: { info() {}, warn() {} }, embedder: () => Promise.reject(new Error('preview')) });
  return (await r.query('你 benchmark 跑完了吗', { session: 's1', record: false })).text;
}
const standing = () => S.renderStanding(sampleMemory(), { now: T0 + 3.5 * 864e5 }); // the day the benchmark is due: it shows under 今天到期的

// ── what she sees, in order: each entry is one thing she is given, made of these files ──
export const GROUPS = [['system', '系统提示词'], ['wake', '叫醒她的消息'], ['call', '独立模型调用']];
export const entries = [
  { id: 'rules', group: 'system', name: '工作方式', note: '她和他之间的几件事：定时任务（先看已有的）、问一次就放下、静默、审批。动手的说明不在这里（在手那边）', files: ['dot.rules'],
    render: () => D.workingRules() },
  { id: 'phone', group: 'system', name: '手机', note: '手机开着时才有；通知叫醒她那句要 dot 组件在；设了手机号（/phone number）才有那一句；表情包段要 qq 组件在', files: ['phone.device', 'phone.hers', 'phone.device.wake', 'phone.device.no-wake', 'phone.device.number', 'phone.stickers', 'dot.computer.hers'],
    render: () => variant([['她的对话里（工具在手那边）', deviceText('dot', '13800138000', { tools: false })], ['她对话里电脑那一行', P.prompt('dot.computer.hers')], ['手的会话里', deviceText('dot', '13800138000', { dot: false, qq: false, memory: false, hands: true })], ['设了手机号', deviceText('dot', '13800138000')], ['没设手机号', deviceText('dot')], ['只装手机（没有 dot、qq、memory）', deviceText('dot', '', { dot: false, qq: false, memory: false })]]) },
  { id: 'howto', group: 'system', name: '手艺簿（手到一个地方时给）', note: '她的手做一件事时，每一步按地方（某个 App、手机本身、电脑）记下；一件事结束，按地方各记一行（步数、错、这件事的结果、用时、花费，<home>/her/howto/_log.jsonl）。一件事里第一次到某个地方（手机上第一次操作时先给手机本身的），那里以前记下的经验和各件事做得怎样跟着工具结果给手（.given；还没有经验时 .no-notes）。整理经验的那次调用在「独立模型调用」里', files: ['dot.howto.given'],
    render: () => P.prompt('dot.howto.given', { app: '小黑盒', recent: '「搜游戏」做成 3/4 次，步数 23→14→9；11-08 12 步、没做成', notes: '## 教训\n- 详情页点图片会跳到旁边的商品，要点标题\n## 捷径\n- 搜游戏（在首页时）：点右上角搜索 → 输入 {游戏名} → 回车 → 点第一个结果（可一次做完）' }) },

  { id: 'qq', group: 'system', name: '电脑上的 QQ', note: 'QQ 连上时才有', files: ['qq.channel', 'qq.channel.owner', 'qq.channel.score', 'qq.stickers', 'qq.channel.no-stickers', 'qq.faces'],
    render: () => variant([['设了主人、群消息先打分、有表情包', Q.channelText({ qq: '123456789', owner: '987654321', groupPolicy: 'score', stickers: STICKERS })], ['都没有', Q.channelText({ qq: '123456789', owner: '', groupPolicy: 'mention', stickers: '' })]]) },
  { id: 'now', group: 'system', name: '现在几点', note: '每一轮都带着（在对话历史之后）：现在的时间，和离上一句话多久', files: ['dot.now'],
    render: () => variant([['隔了一阵', D.nowText(Date.now(), Date.now() - (3 * 60 + 12) * 6e4)], ['刚说过话（不到一分钟，或者从没说过）', D.nowText(Date.now(), 0)]]) },
  { id: 'woke', group: 'system', name: '刚醒', note: '她睡着（过了平时的点、安静满 dot.sleepAfterQuietMinutes）以后醒来的第一轮带一次：睡了多久。只给事实，怎么反应是人设的事', files: ['dot.woke', 'dot.woke.morning'],
    render: () => variant([['半夜被叫醒', P.prompt('dot.woke', { slept: '40 分钟', left: '6 小时 20 分钟' })], ['早上到点醒', P.prompt('dot.woke.morning', { slept: '8 小时 15 分钟' })]]) },
  { id: 'scheduled', group: 'system', name: '定时任务那一轮', note: '只在定时任务叫醒她时出现', files: ['dot.scheduled'], render: () => D.scheduledRule() },
  { id: 'memory', group: 'system', name: '记忆', note: '她对话的每一轮都带着：关于他、她自己记下的、今天到期的（到期当天、当天还没提过的）、还没了的事（有日子的在前，放不下的不显示）', files: ['memory.standing'], render: standing },
  { id: 'recall', group: 'system', name: '想起的原话', note: '叫醒她时从旧聊天里翻出来的，按日期分组、相对日期由程序换算（样例用的是关键词匹配）', files: ['memory.recall.header', 'memory.recall.seen'], render: async () => `${await recallText()}\n\n${renderSeen([{ text: '[2026-11-18 15:02] [我看到的]（小黑盒）：这把纯纯坐牢' }])}` },
  { id: 'seen', group: 'wake', name: '记下看到的一句话', note: '她自己逛的时候用 keep_line 记别人的原话（工具说明）；不是自己逛的时候、太长、带链接、当天记满、记过了、屏幕文字里找不到这句时被拒绝的理由（工具结果）', files: ['memory.seen.tool', 'memory.seen'],
    render: () => variant([['工具说明', P.prompt('memory.seen.tool', { max: 80 })], ...['elsewhere', 'long', 'not-words', 'full', 'again', 'not-shown'].map((c) => [c, M.seenRefusalText(c, { max: 80, perDay: 30 })])]) },
  { id: 'voice', group: 'system', name: '说话提醒（最后一段）', note: '放在她对话每一轮的最后（记忆、原话之后），模型回话前最后读到的就是它；人设里填了「说话提醒」就用那个，空着用这个（{name} 是她的名字）。只在和他的对话里，跑腿不带。interlude.voice = false 关掉', files: ['interlude.voice'],
    render: () => P.prompt('interlude.voice', { name: '小点' }) },

  { id: 'owner', group: 'wake', name: '他的 QQ 消息', note: '他从电脑端 QQ 发来的话：等他停下（1.5 秒没新消息，最多 6 秒）一批盖一个时间戳，报成「他：…」，后面是他打的原话（记进原话库时去掉「他：」）；她这轮还没做完时插进这一轮，多一行 dot.owner-words.busy；她上一条有没发出去的话（他先说了话），附在后面给她看一次 dot.owner-words.unsent', files: ['dot.owner-words', 'dot.owner-words.busy', 'dot.owner-words.unsent'],
    render: () => variant([['她空闲', D.ownerWords([{ text: '在吗' }, { text: '帮我看个东西' }])], ['她这轮进行中', D.ownerWords([{ text: '算了' }, { text: '先别弄了' }], Date.now(), { whileBusy: true })], ['她有话没发出去', D.ownerWords([{ text: '你中午吃什么' }], Date.now(), { unsent: ['回放的事我自己想办法', '你醒了再聊也行'] })]]) },
  { id: 'interrupt', group: 'wake', name: '他插话了', note: '她要 qq_send 给他时他还有没看的话：这次发送被拦下（工具返回的理由，每轮最多 2 次）；气泡发到一半他又说话：剩下的不发（qq_send 的结果）', files: ['dot.owner-interrupt', 'qq.send-interrupted'],
    render: () => variant([['发送被拦下', D.ownerInterruptText()], ['发到一半', Q.sendReport({ sent: 1, interrupted: true, unsent: ['那家店我去过', '还挺好吃的'] })]]) },
  { id: 'reply-check', group: 'wake', name: '这句话被代码拦下', note: '她用 qq_send 发给他的话里有 <home>/persona.checks.txt 列的说法，或者括号写的动作：这次发送被退回一次（工具返回的理由，每轮最多 1 次，第二稿照发）。她直接写的回复不退回，只去掉括号动作', files: ['dot.reply-check', 'dot.reply-check.phrases', 'dot.reply-check.stage'],
    render: () => variant([['有列出的说法', D.replyCheckText({ hits: ['不是……而是……', '综上所述'] })], ['有括号动作', D.replyCheckText()]]) },
  { id: 'gates', group: 'wake', name: '要他点头 / 他本人来', note: '敏感的一步由代码按类分四档：钱、理财、支付类 App 不做（.forbid）；验证码、扫码、人脸、付款要他本人来（.him，手停下，事情簿里记一条等他）；装 App、加好友、注册、删东西、打电话这类要先问过他（.ask；她自己的会话里被 dsh 拦下时 .asked.her）。她在对话里问他，他同意了她用 his_ok 记下（.ok-tool；只在他的话那一轮能记，.ok.refused），一次只管那一件事，他明说以后都行才长期。等他的事每轮列在「现在」下面（dot.things.asking）', files: ['dot.gates.forbid', 'dot.gates.him', 'dot.gates.him.q', 'dot.gates.ask', 'dot.gates.ask.q', 'dot.gates.asked.her', 'dot.gates.spend.q', 'dot.gates.ok-tool', 'dot.gates.ok', 'dot.gates.ok.refused', 'dot.things.asking', 'dot.hands.ask.him', 'dot.gates.shell'],
    render: () => variant([['从命令行碰手机', P.prompt('dot.gates.shell')], ['钱的事', P.prompt('dot.gates.forbid', { what: '打开支付宝' })], ['要他本人来', P.prompt('dot.gates.him', { what: '验证码' })], ['先问过他', P.prompt('dot.gates.ask', { what: '装 App' })], ['她这边被拦下', P.prompt('dot.gates.asked.her', { what: '在电脑上删文件' })], ['his_ok 工具说明', P.prompt('dot.gates.ok-tool')], ['记下了', P.prompt('dot.gates.ok', { what: '装 App' })], ['没记', P.prompt('dot.gates.ok.refused')], ['事情簿那行', P.prompt('dot.things.asking', { what: P.prompt('dot.gates.ask.q', { what: '装 App' }) })], ['花得多了', P.prompt('dot.gates.spend.q', { tokens: 620 })], ['手回来：要他来', P.prompt('dot.hands.ask.him', { stamp: '11-21 14:05', task: '（在手机上）登录小红书', question: P.prompt('dot.gates.him.q', { what: '验证码' }), text: '停在输入验证码那页，验证码发到他手机上了。' })]]) },
  { id: 'pushes', group: 'system', name: 'App 自己的推送', note: '不是人发来的通知（没有认得出的发信人，App 也没标成消息或来电）不叫醒她：留最近 dot.pushesKept 条（默认 12），下一次不管什么叫醒她时，在那一轮「现在」旁边给一次', files: ['dot.pushes'],
    render: () => D.pushesText([{ key: 'a', pkg: 'com.max.xiaoheihe', title: '签到提醒', text: '今日未签到' }, { key: 'b', pkg: 'com.ss.android.ugc.aweme', title: '你关注的人开播了', text: '快来看看' }]) },
  { id: 'notification', group: 'wake', name: '手机通知', note: '有人发来的通知（她 QQ 上的人、聊天 App 里的对话、App 标成消息或来电的）把她叫醒时收到的那条', files: ['dot.notification', 'dot.notification.many', 'dot.notification.busy', 'dot.notification.how-qq', 'dot.notification.how-mixed', 'dot.notification.how-app', 'dot.notification.cards', 'dot.notification.unverified'],
    render: () => {
      const qqOne = [{ pkg: 'qq', title: '宽(2条新消息)', text: '在吗' }, { pkg: 'qq', title: '宽', text: '帮我看个东西' }];
      const mixed = [{ pkg: 'com.max.xiaoheihe', title: '暮看云', text: '回复了你的评论' }, { pkg: 'qq', title: '阿满', text: '在吗', unverifiedOwner: true }];
      return variant([['一个 QQ 对话', D.wakeText(qqOne)], ['她忙的时候来的', D.wakeText(qqOne.slice(0, 1), { whileBusy: true })], ['两个 App，带着记得的人和冒名提醒', D.wakeText(mixed, { cards: '阿满（qq:42）：聊过；群里说话 3 次' })]]);
    } },
  { id: 'reach', group: 'system', name: '主动找他：发生了什么', note: '她在不是他开的那一轮里给他发了消息，算一次主动。「现在」那行下面多一行今天的数（几次、他回了几次、上一次什么时候）；一条过了 dot.reachUnansweredMs（默认 2 小时）他没回，在她对话里留一句。只给事实，没有次数上限：什么时候找他是她自己从这些里学的', files: ['dot.reach', 'dot.reach.waiting', 'dot.reach.unanswered'],
    render: () => variant([['现在那行下面', D.reachText([{ at: Date.now() - 7200000, answeredAt: Date.now() - 7000000 }, { at: Date.now() - 600000 }])], ['没回', P.prompt('dot.reach.unanswered', { time: '14:20', hours: 2 })]]) },
  { id: 'loop', group: 'wake', name: '重复调用', note: '一轮里同一个调用重复 dot.loopRepeat 次后被拦下的工具结果；她正在聊天时，自己的事记下的「在忙什么」', files: ['dot.loop-stopped', 'dot.busy.chat'],
    render: () => variant([['重复调用被拦', P.prompt('dot.loop-stopped', { times: 5 })], ['在忙什么', P.prompt('dot.busy.chat')]]) },
  { id: 'handoff', group: 'wake', name: '交接', note: '对话太长换新会话时，新会话的开头', files: ['memory.handoff'],
    render: () => M.renderHandoff(LINES.slice(-2), 3) },
  { id: 'free', group: 'wake', name: '自己的时间', note: '每天 interlude.freeTimesPerDay 次（默认 2），随机时刻在她的对话里开始，什么任务都不给；预算到 80% 提醒一句（.budget），到 100% 停下；这段时间里 QQ 和账本工具被拒（.refused），在社交 App 里打字要他批准（.typing）；这段时间里说的话不自动发给他，想找他就自己发', files: ['interlude.free', 'interlude.free.budget', 'interlude.free.over', 'interlude.free.typing'],
    render: () => variant([['开头', I.freePrompt({ budget: 150000, left: 300000, place: '~/dot/her', listing: ['notes/', 'notes/想学的.md · 412 B · 11-7', 'growth/'], context: { now: '2026-11-08 15:20 星期日 下午', portrait: '我最近迷上了画画……', yourNotes: ['装了小黑盒'], yourDoings: { today: { doings: 2, tokens: 30100, livingTokens: 20000 } } } })], ['预算快用完', P.prompt('interlude.free.budget', { stamp: '[11-08 15:40]', used: 121000, budget: 150000 })], ['预算用完之后', P.prompt('interlude.free.over')], ['社交 App 里打字', P.prompt('interlude.free.typing', { app: '小黑盒' })]]) },
  { id: 'hands', group: 'system', name: '她的手', note: '她的手机和电脑由另一个会话（手）操作——没有人设、记忆、QQ，只有设备工具和账号。她在对话里用 hands 工具交出一整件事，手从头做到尾，中间不叫她；做完了、或者卡在要她拿主意的地方（手用 ask_her 记下问题，这件事就此结束，.ask），才带着结果和屏幕回到她的对话；她定了再交一件，从停下的地方接上（.after）。正在做的事可以补一句（.added）；手上有事时再交的排队（.queued）。每件事在事情簿里有一条。他要的事到头了由「说」告诉他（.result.his）。对话里不再直接碰设备工具（.instead）', files: ['dot.hands.system', 'dot.hands-tool', 'dot.hands.instead', 'dot.hands.screen', 'dot.hands.screen.computer', 'dot.hands.started', 'dot.hands.queued', 'dot.hands.stopped', 'dot.hands.idle', 'dot.hands.result', 'dot.hands.result.his', 'dot.hands.own-words', 'dot.hands.reply-check', 'dot.hands.status.done', 'dot.hands.status.timeout', 'dot.hands.status.stopped', 'dot.hands.status.failed', 'dot.hands.status.own-words', 'dot.hands.status.reply-check', 'dot.hands.status.done.web', 'dot.hands.status.stopped.his', 'dot.hands.status.stuck', 'dot.things.running', 'dot.things.queued', 'dot.things.stopped.his', 'dot.things.stuck', 'dot.hands.added', 'dot.hands.add.idle', 'dot.hands.after', 'dot.hands.ask', 'dot.hands.ask.his', 'dot.hands.ask-tool', 'dot.hands.asked', 'dot.hands.where.phone', 'dot.hands.where.computer', 'dot.hands.where.web', 'dot.lean.not-hers'],
    render: () => variant([['手的系统提示词', P.prompt('dot.hands.system')], ['hands 工具说明', P.prompt('dot.hands-tool')], ['手问她的工具', P.prompt('dot.hands.ask-tool')], ['手来问她', P.prompt('dot.hands.ask', { stamp: '11-20 18:05', task: '（在手机上）去 emojiset 挑几张猫的贴图存下来', question: '这页有三张：竖大拇指的猫、喝咖啡的猫、发呆的猫。存哪几张？', text: '' })], ['回来时的状态', ['done', 'timeout', 'stopped', 'stopped.his', 'stuck', 'own-words', 'reply-check'].map((k) => P.prompt(`dot.hands.status.${k}`).trim()).concat(P.prompt('dot.hands.status.failed', { why: 'no hands session' }).trim()).join('\n')], ['别处', P.prompt('dot.hands.instead')], ['不在她手里的工具', P.prompt('dot.lean.not-hers', { tool: 'bash' })], ['手自己写的字', P.prompt('dot.hands.own-words', { text: '哈哈确实' })], ['她的字被退回', P.prompt('dot.hands.reply-check', { why: '里面有「综上所述」' })]]) },
  { id: 'say', group: 'call', name: '她说的话（只有人设的那次调用）', note: '她在对话里写的字不发给任何人。他在跟她说话的那一轮、他要的事到头的那一轮，结束后一定走这次调用；别的时候、对别人、要发图，她用 say 工具（.say-tool）。话由另一次模型调用写——系统提示词只有她的人设卡，没有工具、没有工作规则。它拿到的就是下面这一条消息：她的表情包（.stickers）、最近的对话原文、账上的事实（由代码从事情簿取，.fact.*，一件事一行，不带任务原文）、她这一轮最后记下的备注（.about）、最后一句（.end*）。写出来的就是发出去的：文字、单独一行的表情包或小表情标记，或者 [不回]。要手打给别人看的话（评论、回帖）走同一条路（.end.where），写好后作为"要打的字"交给手（dot.hands.words）',
    files: ['dot.say-tool', 'dot.say.note', 'dot.say.instead', 'dot.say.said', 'dot.say.interrupted', 'dot.say.silent', 'dot.say.stickers', 'dot.say.stickers.none', 'dot.say.faces', 'dot.say.dialogue', 'dot.say.dialogue.unprompted', 'dot.say.fact', 'dot.say.fact.none', 'dot.say.fact.opened', 'dot.say.fact.queued', 'dot.say.fact.running', 'dot.say.fact.waiting', 'dot.say.fact.stopped', 'dot.say.fact.ended', 'dot.say.fact.stuck', 'dot.say.about', 'dot.say.end', 'dot.say.end.unprompted', 'dot.say.end.where', 'dot.hands.words'],
    render: async () => { const { sayInput } = await import('../src/dot/say.js'); return variant([['say 工具说明', P.prompt('dot.say-tool')], ['每次到达时跟着的一句', P.prompt('dot.say.note')], ['回他（这一条消息就是那次调用的全部输入）', sayInput({ dialogue: [{ who: 'owner', text: '在干嘛呀' }], stickers: [{ id: '31d44003ce', note: '开心猫' }], facts: [P.prompt('dot.say.fact.none').trim()], about: '刚把余额提醒脚本写好了' })], ['她先开口', sayInput({ dialogue: [{ who: 'owner', text: '你去找点表情包' }, { who: 'her', text: '好' }], stickers: [], facts: [P.prompt('dot.say.fact.ended', { what: '（在手机上）去小黑盒找表情包', how: '做到这儿停下了', result: '结果：存了一张水豚' }).trim()], about: '第一张存好了', unprompted: true })], ['要手打出去的话', sayInput({ about: '想说自己就住在 DSH 里', where: '小黑盒一条帖子的评论框，所有人都看得到' })], ['说出去之后她看到的', P.prompt('dot.say.said', { said: '在整你交代的那个余额的事' })], ['没发完', P.prompt('dot.say.interrupted', { said: '好', unsent: '我去翻翻' })], ['没回', P.prompt('dot.say.silent')], ['别的发送工具', P.prompt('dot.say.instead')], ['交给手的字', P.prompt('dot.hands.words', { words: '住这儿的人路过' })]]); } },
  { id: 'howto-reflect', group: 'call', name: '整理手艺簿', note: '一件事结束后，某个地方出过错、这件事没做成或太久、或步数明显比平常多（≥ dot.howtoMinSteps，默认 12）：一次小调用读这件事在那里的操作（只有操作和报错，不带屏幕上的文字）、记账里的结果、现有的笔记和以前各次，重写笔记（≤ dot.howtoMaxChars，默认 800 字）：教训、捷径（只从做成的那次写），并给这件事起个短名，好把同一件事的几次排在一起看是不是越做越快、越省', files: ['dot.howto.reflect', 'dot.howto.review'],
    render: () => variant([['整理', P.prompt('dot.howto.reflect', { maxChars: 800 })], ['翻旧笔记', P.prompt('dot.howto.review', { maxChars: 800 })]]) },
  { id: 'extract', group: 'call', name: '整理记忆', note: '攒够一批记录（或交班前）时，把它们整理进还没了的事和人物卡（关于他 / 她自己不在这里写，归每天那一次）：从最少变的到最常变的排，好命中前缀缓存——规则、认识的人、还没了的事、新记录', files: ['memory.extract', 'memory.extract.input'],
    render: () => {
      const m = sampleMemory();
      return M.extractPrompt({ text: LINES.map(M.transcriptLine).join('\n'), known: 'u0002 · 阿满 · qq:42 · talked · 大学室友，爱打瓦', open: m.open.map((x) => `- ${S.renderItem(x)}`).join('\n') });
    } },
  { id: 'facts', group: 'call', name: '事实条', note: '整理一批记录时另有一次调用，把他说的话里以后用得上的事各写成一行（时间｜一句话｜该想起它的情境）；他叫醒她时，代码按日子、和他的话相近、和情境相近排出前 60 条，再一次调用挑出用得上的，最多 6 条列进她的提示词（memory.facts.header 是那几行的标题）', files: ['memory.facts.write', 'memory.facts.pick', 'memory.facts.header'],
    render: () => variant([['写（整理时）', P.prompt('memory.facts.write', { records: '[06-22 19:40] 老周下周三（=07-01）过来吃饭，他花生过敏你记着点' })], ['挑（他叫醒她时）', P.prompt('memory.facts.pick', { facts: '1. [06-22] 老周对花生过敏\n2. [06-22] 老周 07-01 过来吃饭', recent: '他：晚上吃啥\n你：看你想吃啥', now: '06-30 18:02', said: '明天老周来，我想做个宫保鸡丁' })], ['她看到的', `${P.prompt('memory.facts.header')}\n- [06-22] 老周对花生过敏`]]) },
  { id: 'daily', group: 'call', name: '日记和笔记', note: '每天她睡下后（dot.awakeHours 的结束时刻），当天有记录时一次调用：写日记，并且是关于他 / 她自己两栏唯一的整理者——当天值得一直记着的，只给加、换的改动（多数日子没有），代码照着改；栏超了上限也只是超着，不删不重写。固定的说明在前，两栏在中间，日子和当天记录在最后。当天记录超过 inputChars 就分几次读，日记取最后一次的', files: ['memory.daily', 'memory.daily.bank'],
    render: () => {
      const m = sampleMemory();
      const text = LINES.slice(0, 2).map(M.transcriptLine).join('\n');
      return variant([['日记和笔记', M.dailyPrompt({ day: M.dayLabel(new Date(T0)), text, banks: { owner: m.owner, self: m.self } })],
        ['和别的记忆插件共存（people-only）：只写日记', M.dailyPrompt({ day: M.dayLabel(new Date(T0)), text, banks: null })]]);
    } },
  { id: 'score', group: 'call', name: '群消息打分', note: '群消息值不值得她插一句（群消息设成打分时）', files: ['qq.score.system', 'qq.score.who', 'qq.score.user'],
    render: () => { const r = Q.scorePrompt({ who: '小点：二十三岁，话少、直接', recent: '阿满：今晚谁打瓦\n老王：我', message: '小点你上次说的那个耳机多少钱', group: '123456' }); return variant([['system', r.system], ['user', r.user]]); } },
  { id: 'setup', group: 'system', name: '手机/电脑还在装', note: '只在第一次安装、开机还没好时带着（装好就消失）；装好那一刻用 dot.setup-done 叫她自己说一声', files: ['dot.setup', 'dot.setup-done'], render: () => `${D.setupText({ state: 'downloading', progress: { text: '下载系统镜像 820/1450 MB，约 6 分钟' } }, { state: 'starting', stage: 'downloading' })}\n\n${P.prompt('dot.setup-done', { device: '手机' })}` },
];
const entryOf = (id) => entries.find((e) => e.files.includes(id));

// ── her Canon (<home>/interlude/canon.json): not a prompt file, but the first thing she reads ──
const CANON_FIELDS = [['characterName', '名字'], ['characterProfile', '角色设定'], ['perspective', '视角'], ['relationship', '和用户的关系'], ['userProfile', '用户'], ['supportingCast', '配角'], ['world', '世界'], ['location', '主要地点'], ['replyRules', '回复规则'], ['style', '叙事文风（只给幕间）'], ['blacklist', '不要这样说（一行一条）'], ['examples', '对话范例'], ['voice', '说话提醒（放在每轮最后；空着就用内置的 interlude.voice）']];
const HOME = P.promptHome(); // before --src moves the prompt home to a temp dir
const canonPath = () => join(HOME, 'interlude', 'canon.json');
const readCanon = () => { try { return JSON.parse(readFileSync(canonPath(), 'utf8')); } catch { return null; } };
const canonField = (c, k) => (k === 'blacklist' ? (Array.isArray(c?.blacklist) ? c.blacklist.join('\n') : String(c?.blacklist ?? '')) : k === 'examples' ? String(c?.examples ?? '') : k === 'voice' ? String(c?.voice ?? '') : String(c?.storyDefaults?.[k] ?? ''));
const withCanonField = (c, k, v) => { const n = structuredClone(c ?? { storyDefaults: {} }); n.storyDefaults ??= {}; if (k === 'blacklist') n.blacklist = v.split('\n').map((l) => l.trim()).filter(Boolean); else if (k === 'examples') n.examples = v; else if (k === 'voice') n.voice = v; else n.storyDefaults[k] = v; return n; };
const isCanon = (id) => id?.startsWith('canon.') && CANON_FIELDS.some(([k]) => id === `canon.${k}`);
entries.unshift({ id: 'canon', group: 'system', name: '人设（Canon）', note: '她是谁、怎么说话。存在 ' + canonPath() + '，改了她下一轮就用；每天第一次保存前自动备份一份', files: CANON_FIELDS.map(([k]) => `canon.${k}`),
  render: () => I.renderCanon(readCanon() ?? CANON, { withStyle: true }) });
const canonLabel = (id) => CANON_FIELDS.find(([k]) => id === `canon.${k}`)?.[1] ?? id;

export async function renderEntry(e) {
  try { return String(await e.render()); } catch (err) { return `（没拼出来：${err.stack}）`; }
}
/** Her conversation's system prompt from top to bottom (dsh's own sections left out). */
export async function full() {
  const parts = [
    ['人设（Canon）', I.renderCanon(readCanon() ?? CANON)],
    ['工作方式', D.workingRules()],
    ['手机、电脑', [deviceText('dot', '', { tools: false }), P.prompt('dot.computer.hers')].join('\n')],
    ['电脑上的 QQ', Q.channelText({ qq: '123456789', owner: '987654321', groupPolicy: 'score', stickers: STICKERS })],
    ['—— 以下在对话历史之后 ——', ''],
    ['现在几点', D.nowText(Date.now(), Date.now() - (3 * 60 + 12) * 6e4)],
    ['定时任务那一轮（只在那一轮）', D.scheduledRule()],
    ['记忆', standing()],
    ['想起的原话', await recallText()],
    ['说话提醒（最后一段）', String((readCanon() ?? CANON)?.voice ?? '').trim() || P.prompt('interlude.voice', { name: (readCanon() ?? CANON)?.storyDefaults?.characterName ?? '她' })],
  ];
  return parts.map(([k, v]) => (v ? `━━━━ ${k} ━━━━\n${v}` : `━━━━ ${k} ━━━━`)).join('\n\n');
}

const placeholders = (t) => [...new Set([...t.matchAll(/\{([A-Za-z]\w*)\}/g)].map((m) => m[1]))];
const isTable = (t) => t.split('\n').every((l) => /^[\w-]+=/.test(l));
function fileInfo(id, src) {
  if (isCanon(id)) { const c = readCanon(); return { id, title: `人设 · ${canonLabel(id)}`, text: canonField(c, id.slice(6)), path: canonPath() + (c ? '' : '（还没有：/interlude preset <分享码>，或从 examples/ 复制一份）'), placeholders: [], table: false, canon: true }; }
  P.raw(id); // unknown id → throws
  const builtin = readFileSync(P.builtinPath(id), 'utf8').replace(/\n$/, '');
  const over = P.list().find((x) => x.id === id)?.override;
  return { id, text: src ? builtin : P.raw(id), overridden: !src && Boolean(over), path: src || !over ? P.builtinPath(id) : over, placeholders: placeholders(builtin), table: isTable(builtin) };
}
function save(id, text, src) {
  if (isCanon(id)) {
    const path = canonPath(), c = readCanon();
    const bak = `${path}.bak-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    if (c && !existsSync(bak)) copyFileSync(path, bak);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(withCanonField(c, id.slice(6), String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '')), null, 2)}\n`);
    return { text: `已保存：${path}` };
  }
  P.raw(id); // unknown id → throws
  const body = `${String(text).replace(/\r\n/g, '\n').replace(/\n*$/, '')}\n`;
  const path = src ? P.builtinPath(id) : P.overridePath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, src ? body : P.stamp(id, body));
  const lost = placeholders(readFileSync(P.builtinPath(id), 'utf8')).filter((k) => !body.includes(`{${k}}`));
  return { text: `已保存：${path}`, warn: lost.length ? `注意：${lost.map((k) => `{${k}}`).join(' ')} 不见了，那里的内容就不会再出现` : '' };
}
function reset(id) {
  P.raw(id);
  const path = P.overridePath(id);
  rmSync(path, { force: true });
  return { text: '已恢复内置版本' };
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dot 提示词</title><style>
:root{--bg:#f7f6f3;--fg:#1f1d1a;--mute:#77716a;--line:#e4e0da;--card:#fff;--acc:#3d5a80;--acc-fg:#fff;--warn:#a1520c;--soft:#efece6;--ok:#2f6b4f}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--fg:#e9e6e1;--mute:#9b958c;--line:#2c2a26;--card:#1c1b18;--acc:#8fb0d9;--acc-fg:#10161e;--warn:#e0a35c;--soft:#23211e;--ok:#7cc4a0}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;display:grid;grid-template-rows:auto 1fr;height:100vh}
header{padding:14px 22px;border-bottom:1px solid var(--line);display:flex;gap:24px;align-items:flex-start}header h1{font-size:16px;margin:0;white-space:nowrap}header p{margin:0;color:var(--mute);font-size:13px}
.wrap{display:grid;grid-template-columns:320px 1fr;min-height:0}
nav{border-right:1px solid var(--line);overflow:auto;padding:10px 10px 40px}main{overflow:auto;padding:20px 28px 40px;display:flex;flex-direction:column;min-height:0}
nav h2{font-size:12px;letter-spacing:.08em;color:var(--mute);margin:18px 8px 6px;font-weight:600}nav h3{font-size:13px;margin:10px 8px 2px;font-weight:600}
nav h3 small{display:block;font-weight:400;color:var(--mute);font-size:12px}
nav a{display:flex;justify-content:space-between;gap:8px;padding:3px 8px 3px 16px;border-radius:6px;cursor:pointer;color:inherit;text-decoration:none;font:12.5px/1.6 ui-monospace,Menlo,Consolas,monospace}
nav a:hover{background:var(--soft)}nav a.on{background:var(--acc);color:var(--acc-fg)}nav a.on .tag{color:inherit;border-color:currentColor}
.tag{font:11px/1.6 system-ui,sans-serif;color:var(--mute);border:1px solid var(--line);border-radius:4px;padding:0 5px;white-space:nowrap}.tag.over{color:var(--warn);border-color:var(--warn)}
#full{display:block;margin:4px 0 0;padding:6px 8px;font:600 13px/1.6 system-ui,sans-serif}
h2.t{margin:0;font:600 16px/1.4 ui-monospace,Menlo,Consolas,monospace}.mute{color:var(--mute)}.path{font-size:12px;color:var(--mute);word-break:break-all;margin:2px 0 10px}
.hint{font-size:12.5px;color:var(--mute);margin:0 0 8px}.hint code{background:var(--soft);padding:0 4px;border-radius:3px}
textarea{flex:1;min-height:260px;width:100%;resize:vertical;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;font:13px/1.7 ui-monospace,Menlo,Consolas,monospace}
textarea:focus{outline:2px solid var(--acc);outline-offset:-1px}
.bar{display:flex;gap:8px;align-items:center;margin:10px 0}.bar .dirty{color:var(--warn);font-size:12.5px}
button{background:var(--acc);color:var(--acc-fg);border:0;border-radius:6px;padding:6px 16px;cursor:pointer;font:inherit}button.ghost{background:none;color:var(--fg);border:1px solid var(--line)}button:disabled{opacity:.4;cursor:default}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font:13px/1.65 ui-monospace,Menlo,Consolas,monospace;margin:6px 0 0}
h4{margin:18px 0 0;font-size:13px}#msg{position:fixed;right:16px;bottom:16px;max-width:520px;white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;display:none;box-shadow:0 4px 18px rgba(0,0,0,.08)}#msg.bad{color:var(--warn)}
@media (max-width:760px){.wrap{grid-template-columns:1fr}nav{max-height:40vh;border-right:0;border-bottom:1px solid var(--line)}header{flex-direction:column;gap:6px}}
</style></head><body><header><h1>dot 的提示词</h1><div id="help"></div></header><div class="wrap"><nav id="nav"></nav><main id="main"><p class="mute">从左边选一个文件。</p></main></div><div id="msg"></div><script>
const $ = (t, a = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a)) k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v); for (const c of kids.flat()) c != null && e.append(c); return e; };
const api = (p, body) => fetch(p, body ? { method: 'POST', headers: { 'content-type': 'application/json', 'x-prompts': '1' }, body: JSON.stringify(body) } : {}).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; });
const say = (t, bad) => { const m = document.getElementById('msg'); m.textContent = t; m.className = bad ? 'bad' : ''; m.style.display = 'block'; clearTimeout(say.t); say.t = setTimeout(() => { m.style.display = 'none'; }, bad ? 9000 : 3500); };
let cur = '', saved = '', state = null;
const dirty = () => cur && document.getElementById('ta') && document.getElementById('ta').value !== saved;
window.addEventListener('beforeunload', (e) => { if (dirty()) e.preventDefault(); });
async function nav() {
  state = await api('/api/list');
  document.getElementById('help').replaceChildren(
    $('p', {}, state.src ? '这里是她收到的每一段话。改完点「保存」会直接写进仓库的 src/prompts/。' : '这里是她收到的每一段话。改完点「保存」，会存一份到 ' + state.dir + '，她下一轮就用新的；仓库里的原文不动。'),
    $('p', {}, '「恢复内置」删掉你改过的那份；「预览」用样例数据拼出她实际看到的样子；「全貌」是她对话里完整的系统提示词。'));
  const n = document.getElementById('nav');
  n.replaceChildren($('a', { id: 'full', onclick: () => go(full) }, '全貌：她的系统提示词'));
  for (const g of state.groups) {
    n.append($('h2', {}, g.title));
    for (const e of g.entries) {
      n.append($('h3', {}, e.name, $('small', {}, e.note)));
      for (const f of e.files) n.append($('a', { 'data-id': f.id, onclick: () => go(() => show(f.id)) }, $('span', {}, f.label ?? f.id), f.tag === '' ? null : $('span', { class: 'tag' + (f.overridden ? ' over' : '') }, f.overridden ? '已改过' : '内置')));
    }
  }
  mark();
}
const mark = () => document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.dataset.id ? a.dataset.id === cur : !cur && a.id === 'full' && document.getElementById('fulltext')));
function go(f) { if (dirty() && !confirm('改动还没保存，确定离开吗？')) return; f(); }
async function full() {
  cur = ''; const main = document.getElementById('main');
  main.replaceChildren($('p', { class: 'mute' }, '正在拼…'));
  const { text } = await api('/api/full');
  main.replaceChildren($('h2', { class: 't' }, '全貌'), $('p', { class: 'hint' }, '她的对话里，插件加进系统提示词的部分从上到下拼起来的样子（样例数据）。dsh 自己的段落不在这里；手机和电脑的说明书不在每轮里，第一次用时才给（见「说明书」）。'), $('pre', { id: 'fulltext' }, text));
  mark();
}
async function show(id) {
  const f = await api('/api/file?id=' + encodeURIComponent(id));
  cur = id; saved = f.text; mark();
  const ta = $('textarea', { id: 'ta', spellcheck: 'false' }); ta.value = f.text;
  const flag = $('span', { class: 'dirty' });
  ta.addEventListener('input', () => { flag.textContent = dirty() ? '有改动，还没保存' : ''; });
  const out = $('div');
  const hints = [];
  if (f.table) hints.push($('p', { class: 'hint' }, '这个文件一行一项：等号左边是代号，别改；右边是她看到的文字。'));
  if (f.placeholders.length) hints.push($('p', { class: 'hint' }, '花括号里的 ', ...f.placeholders.flatMap((k, i) => [i ? ' ' : '', $('code', {}, '{' + k + '}')]), ' 会换成实际内容，别删。某一行如果只有一个 {…}，而它刚好是空的，这一行会整行省掉。'));
  const preview = async () => { out.replaceChildren($('p', { class: 'mute' }, '正在拼…')); const r = await api('/api/preview', { id, text: ta.value }).catch((e) => ({ text: e.message })); out.replaceChildren($('h4', {}, dirty() ? '预览（按你还没保存的改动）' : '预览'), $('pre', {}, r.text || '（空）')); };
  document.getElementById('main').replaceChildren(
    $('h2', { class: 't' }, f.title ?? id + '.txt'), $('div', { class: 'path' }, (f.canon ? '' : f.overridden ? '你改过的版本：' : state.src ? '仓库里的文件：' : '内置版本：') + f.path),
    ...hints, ta,
    $('div', { class: 'bar' },
      $('button', { onclick: async () => { try { const r = await api('/api/save', { id, text: ta.value }); saved = ta.value; flag.textContent = ''; say(r.warn ? r.text + '\\n' + r.warn : r.text, Boolean(r.warn)); await nav(); } catch (e) { say(e.message, true); } } }, '保存'),
      state.src || f.canon ? null : $('button', { class: 'ghost', ...(f.overridden ? {} : { disabled: '' }), onclick: async () => { if (!confirm('删掉你改过的版本，换回内置的？')) return; try { say((await api('/api/reset', { id })).text); await nav(); await show(id); } catch (e) { say(e.message, true); } } }, '恢复内置'),
      $('button', { class: 'ghost', onclick: preview }, '预览'), flag),
    out);
}
nav();
</script></body></html>`;

export function serve(port = Number(process.env.PORT) || 7870, { src = process.argv.includes('--src') } = {}) {
  const okHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (src) P.configure({ home: mkdtempSync(join(tmpdir(), 'dot-prompts-src-')) }); // previews show the files in src/, not her overrides
  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    // Loopback only, and writes need a header a cross-site page cannot send without a preflight.
    if (!okHost.has(req.headers.host)) return send(403, { error: 'host' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/list') {
        const over = new Map(P.list().map((x) => [x.id, x.override]));
        return send(200, { src, dir: P.overrideDir(), groups: GROUPS.map(([g, title]) => ({ title, entries: entries.filter((e) => e.group === g).map((e) => ({ name: e.name, note: e.note, files: e.files.map((id) => (isCanon(id) ? { id, label: canonLabel(id), tag: '' } : { id, overridden: !src && Boolean(over.get(id)) })) })) })) });
      }
      if (req.method === 'GET' && url.pathname === '/api/file') return send(200, fileInfo(url.searchParams.get('id'), src));
      if (req.method === 'GET' && url.pathname === '/api/full') return send(200, { text: await full() });
      if (req.method === 'POST' && req.headers['x-prompts'] === '1') {
        let body = '';
        for await (const c of req) body += c;
        const { id, text } = JSON.parse(body || '{}');
        if (url.pathname === '/api/save') return send(200, save(id, text, src));
        if (url.pathname === '/api/reset' && !src) return send(200, reset(id));
        if (url.pathname === '/api/preview' && isCanon(id)) return send(200, { text: I.renderCanon(withCanonField(readCanon() ?? CANON, id.slice(6), text ?? ''), { withStyle: true }) });
        if (url.pathname === '/api/preview') { const e = entryOf(id); if (!e) throw new Error('这个文件不在清单里'); return send(200, { text: await P.withDraft(id, text ?? P.raw(id), () => renderEntry(e)) }); }
      }
      send(404, { error: 'not found' });
    } catch (err) { send(400, { error: err.message }); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`dot 提示词: http://127.0.0.1:${port}/${src ? '（--src：保存写进 src/prompts/）' : ''}`));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serve();
  process.on('disconnect', () => process.exit()); // started by /dot prompts: go when dsh goes
}
