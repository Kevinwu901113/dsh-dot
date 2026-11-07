#!/usr/bin/env node
// npm run prompts — every prompt file she is given, on one local page: edit one, save it to
// <home>/prompts/ (or to src/prompts/ with --src), put the built-in one back, preview it rendered
// through the real code with sample inputs, or see her whole system prompt. A developer tool.
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
const { createRecall } = await import('../src/memory/recall.js');
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
const STATE = { current: '在出租屋里改简历，有点困', recent: ['下午去楼下买了杯咖啡'], salient: ['周五他要交 benchmark'] };
const STICKERS = P.prompt('qq.stickers', { list: 'a1b2c3d4e5（无语）、f6e5d4c3b2（偷笑 ×3）' });
const variant = (pairs) => pairs.map(([k, v]) => `━━ ${k} ━━\n${v}`).join('\n\n');

function sampleMemory() {
  const m = S.emptyMemory();
  m.owner = ['他叫宽，在广州做 AI agent 开发', '不喜欢被叫"亲"'];
  m.self = ['装了小黑盒，常在晚上逛', '学会了在 B 站发弹幕'];
  S.openOp(m, { action: 'add', content: '10-31 他说这周要赶一个 benchmark，周五前交', due: '11-01' }, { now: T0 });
  S.openOp(m, { action: 'add', content: '10-29 她答应周末陪他看新番', owed: true }, { now: T0 + 1 });
  S.openOp(m, { action: 'add', content: '10-20 他说想换个机械键盘，先搁着' }, { now: T0 - 9 * 864e5 });
  S.openOp(m, { action: 'shelve', oldText: '机械键盘' }, { now: T0 });
  return m;
}
let recallDir = '';
async function recallText() {
  if (!recallDir) process.env.DSH_HOME = recallDir = mkdtempSync(join(tmpdir(), 'dot-prompts-')); // no real recall settings
  const r = createRecall({ cfg: { recallBackend: 'local', recallTopK: 3, recallChunkChars: 1200, recallMaxTokens: 800, recallWindowTurns: 0 }, dir: recallDir, lines: () => LINES, logger: { info() {}, warn() {} }, embedder: () => Promise.reject(new Error('preview')) });
  return (await r.query('你 benchmark 跑完了吗', { session: 's1', record: false })).text;
}
const standing = () => S.renderStanding(sampleMemory());
const context = () => I.renderContext({ state: STATE, entries: ['11-03 14:00：她把窗帘拉开一半，靠在床头改简历，咖啡放凉了。'], intents: [{ at: new Date(Date.now() + 3 * 36e5).toISOString(), kind: 'contact', text: '问他感冒好点没' }], cursor: Date.now() - 90 * 6e4, restarted: false });

// ── what she sees, in order: each entry is one thing she is given, made of these files ──
export const GROUPS = [['system', '系统提示词'], ['wake', '叫醒她的消息'], ['call', '独立模型调用']];
export const entries = [
  { id: 'rules', group: 'system', name: '工作方式', note: '定时任务（先看已有的）、问一次就放下、静默、审批、长任务；有电脑、有手机时各多一句', files: ['dot.rules', 'dot.rules.computer', 'dot.rules.phone'],
    render: () => variant([['电脑和手机都有', D.workingRules({ computer: true, phone: true })], ['只有手机', D.workingRules({ computer: false, phone: true })]]) },
  { id: 'phone', group: 'system', name: '手机', note: '手机开着时才有；通知叫醒她那句要 dot 组件在；设了手机号（/phone number）才有那一句；表情包段要 qq 组件在，最后"记到 self"要 memory 在', files: ['phone.device', 'phone.device.wake', 'phone.device.no-wake', 'phone.device.number', 'phone.stickers', 'phone.stickers.learned'],
    render: () => variant([['设了手机号', deviceText('emulator-5554', '13800138000')], ['没设手机号', deviceText('emulator-5554')], ['只装手机（没有 dot、qq、memory）', deviceText('emulator-5554', '', { dot: false, qq: false, memory: false })]]) },
  { id: 'qq', group: 'system', name: '电脑上的 QQ', note: 'QQ 连上时才有', files: ['qq.channel', 'qq.channel.owner', 'qq.channel.score', 'qq.stickers', 'qq.channel.no-stickers', 'qq.faces'],
    render: () => variant([['设了主人、群消息先打分、有表情包', Q.channelText({ qq: '123456789', owner: '987654321', groupPolicy: 'score', stickers: STICKERS })], ['都没有', Q.channelText({ qq: '123456789', owner: '', groupPolicy: 'mention', stickers: '' })]]) },
  { id: 'now', group: 'system', name: '现在几点', note: '每一轮都带着（在对话历史之后）：现在的时间，和离上一句话多久', files: ['dot.now'],
    render: () => variant([['隔了一阵', D.nowText(Date.now(), Date.now() - (3 * 60 + 12) * 6e4)], ['刚说过话（不到一分钟，或者从没说过）', D.nowText(Date.now(), 0)]]) },
  { id: 'scheduled', group: 'system', name: '定时任务那一轮', note: '只在定时任务叫醒她时出现', files: ['dot.scheduled'], render: () => D.scheduledRule() },
  { id: 'memory', group: 'system', name: '记忆', note: '她对话的每一轮都带着：关于他、她自己记下的、还没了的事（加一行先搁着的）', files: ['memory.standing'], render: standing },
  { id: 'recall', group: 'system', name: '想起的原话', note: '叫醒她时从旧聊天里翻出来的，按日期分组、相对日期由程序换算（样例用的是关键词匹配）', files: ['memory.recall.header'], render: recallText },

  { id: 'owner', group: 'wake', name: '他的 QQ 消息', note: '他从电脑端 QQ 发来的话：等他停下（1.5 秒没新消息，最多 6 秒）一批盖一个时间戳，后面是他打的原话；她这轮还没做完时插进这一轮，多一行 dot.owner-words.busy', files: ['dot.owner-words', 'dot.owner-words.busy'],
    render: () => variant([['她空闲', D.ownerWords([{ text: '在吗' }, { text: '帮我看个东西' }])], ['她这轮进行中', D.ownerWords([{ text: '算了' }, { text: '先别弄了' }], Date.now(), { whileBusy: true })]]) },
  { id: 'interrupt', group: 'wake', name: '他插话了', note: '她要 qq_send 给他时他还有没看的话：这次发送被拦下（工具返回的理由，每轮最多 2 次）；气泡发到一半他又说话：剩下的不发（qq_send 的结果）', files: ['dot.owner-interrupt', 'qq.send-interrupted'],
    render: () => variant([['发送被拦下', D.ownerInterruptText()], ['发到一半', Q.sendReport({ sent: 1, interrupted: true, unsent: ['那家店我去过', '还挺好吃的'] })]]) },
  { id: 'approval', group: 'wake', name: '审批过期', note: '她那步要审批、dot.approvalWaitMs（默认 10 分钟）没人点：当拒绝处理，这句替换 dsh 的「the user rejected tool」作为工具结果', files: ['dot.approval-timeout'],
    render: () => D.approvalTimeoutText(10) },
  { id: 'notification', group: 'wake', name: '手机通知', note: '通知把她叫醒时收到的那条', files: ['dot.notification', 'dot.notification.many', 'dot.notification.busy', 'dot.notification.how-qq', 'dot.notification.how-mixed', 'dot.notification.how-app', 'dot.notification.cards', 'dot.notification.unverified'],
    render: () => {
      const qqOne = [{ pkg: 'qq', title: '宽(2条新消息)', text: '在吗' }, { pkg: 'qq', title: '宽', text: '帮我看个东西' }];
      const mixed = [{ pkg: 'com.max.xiaoheihe', title: '暮看云', text: '回复了你的评论' }, { pkg: 'qq', title: '阿满', text: '在吗', unverifiedOwner: true }];
      return variant([['一个 QQ 对话', D.wakeText(qqOne)], ['她忙的时候来的', D.wakeText(qqOne.slice(0, 1), { whileBusy: true })], ['两个 App，带着记得的人和冒名提醒', D.wakeText(mixed, { cards: '阿满（qq:42）：聊过；群里说话 3 次' })]]);
    } },
  { id: 'phonecheck', group: 'wake', name: '拿起手机', note: '一阵子没动静时，让她看一眼手机', files: ['dot.phone-check'], render: () => D.phoneCheckText() },
  { id: 'errand', group: 'wake', name: '跑腿回来', note: '手机上的事办完后，留在她对话里的一句；跑腿卡住 dot.errandStallMs（默认 10 分钟）被放弃时是 dot.errand-stalled；幕间里她想跟他说的话也这样留进对话（dot.interlude-say），说不说由对话里的她定', files: ['dot.errand-note', 'dot.errand-note.what', 'dot.errand-stalled', 'dot.interlude-say'],
    render: () => variant([...['phone-check', 'notification', 'play', 'other'].map((o) => [o, D.errandNote(o, '小黑盒上暮看云回了我的评论，说他也觉得低频糊。')]), ['卡住了，放弃', D.errandNote('phone-check', D.errandStalledText('等 mobile_install_app 的审批', 10))], ['幕间想跟他说的', P.prompt('dot.interlude-say', { text: '降温了，你那边冷不冷' })]]) },
  { id: 'onevoice', group: 'wake', name: '跑腿只汇报', note: '跑腿那一轮带着 dot.errand-report；跑腿给他发 qq_send 被拦下时的工具结果；跑腿还在做时她对话里的一行；一轮里同一个调用重复 dot.loopRepeat 次后被拦下的工具结果', files: ['dot.errand-report', 'dot.errand-no-owner', 'dot.errand-inflight', 'dot.loop-stopped'],
    render: () => { const t = P.table('dot.errand-inflight'); return variant([['跑腿那一轮', P.prompt('dot.errand-report', { silent: D.SILENT })], ['跑腿找他被拦', P.prompt('dot.errand-no-owner')], ['她对话里：还在做的', P.fill(t.line, { doing: `${P.fill(t.thread, { app: '小黑盒', source: '《耳机测评》', count: 3 })}；${t.other}` })], ['重复调用被拦', P.prompt('dot.loop-stopped', { times: 5 })]]); } },
  { id: 'handoff', group: 'wake', name: '交接', note: '对话太长换新会话时，新会话的开头', files: ['memory.handoff'],
    render: () => M.renderHandoff(LINES.slice(-2), 3) },
  { id: 'observation', group: 'wake', name: '幕间：去看一眼', note: '她自己想去看看的时候，只看不动', files: ['interlude.observation', 'interlude.observation.where', 'interlude.observation.vm', 'interlude.observation.phone'],
    render: () => variant([['电脑浏览器里搜', I.observationPrompt({ mode: 'search', query: '广州 本周 降温', purpose: '他感冒了，看看天气' }, 'vm')], ['手机 App', I.observationPrompt({ mode: 'search', query: '新番', purpose: '看看有没有新番' }, 'phone', 'tv.danmaku.bili')]]) },
  { id: 'play', group: 'wake', name: '幕间：玩一会儿', note: '去 App 里点赞、评论、发帖、攒表情包', files: ['interlude.play', 'interlude.play.collect', 'interlude.play.post', 'interlude.play.verbs', 'interlude.play.parts', 'interlude.play-rules'],
    render: () => variant([['评论', I.playPrompt({ app: '小黑盒', action: 'comment', target: '那篇耳机测评', text: '低频确实糊', why: '她也用这副耳机' }, 'com.max.xiaoheihe')], ['发帖', I.playPrompt({ app: '小黑盒', action: 'post', target: '耳机区', text: '用了一个月，说说这副耳机的低频', why: '攒了一肚子想法' }, 'com.max.xiaoheihe')], ['攒表情包', I.playPrompt({ app: 'B站', action: 'collect', target: '表情包', why: '表情包太少了' }, 'tv.danmaku.bili')]]) },
  { id: 'free', group: 'wake', name: '幕间：自己的时间', note: '每天 interlude.freeTimesPerDay 次（默认 2），随机时刻叫醒跑腿的她，什么任务都不给；预算到 80% 提醒一句（.budget），到 100% 停下；这段时间里 QQ 和账本工具被拒（.refused），在社交 App 里打字要他批准（.typing）；想找他用 tell_him（只在这里能用，别处是 .elsewhere）', files: ['interlude.free', 'interlude.free.tidy', 'interlude.free.budget', 'interlude.free.over', 'interlude.free.refused', 'interlude.free.typing', 'interlude.tell-him', 'interlude.tell-him.elsewhere'],
    render: () => variant([['开头', I.freePrompt({ budget: 150000, left: 300000, place: '~/dot/her', listing: ['notes/', 'notes/想学的.md · 412 B · 11-7', 'growth/'], tidy: ['每晚十点逛小黑盒'], context: { now: '2026-11-08 15:20 星期日 下午', portrait: '我最近迷上了画画……', yourNotes: ['装了小黑盒'], yourDoings: { today: { doings: 2, tokens: 30100, livingTokens: 20000 } }, lately: '窝在床上看番' } })], ['预算快用完', P.prompt('interlude.free.budget', { stamp: '[11-08 15:40]', used: 121000, budget: 150000 })], ['预算用完之后', P.prompt('interlude.free.over')], ['发 QQ 被拦', P.prompt('interlude.free.refused', { tool: 'qq_send' })], ['社交 App 里打字', P.prompt('interlude.free.typing', { app: '小黑盒' })], ['tell_him 工具说明', P.prompt('interlude.tell-him')], ['别处用 tell_him', P.prompt('interlude.tell-him.elsewhere')]]) },
  { id: 'growth', group: 'call', name: '成长：每周回顾', note: '每周 interlude.growthAt（默认周日 21:00）一次：她读这周的日记、自己的笔记、账和他的反应，重写「她现在的样子」（最多改 portraitMaxChange，默认 35%；改多了用 .too-much 再要一次），存进 <home>/interlude/growth；这一段作为系统提示词跟在人设后面（.section）。不写记忆。', files: ['interlude.growth.system', 'interlude.growth.too-much', 'interlude.growth.too-long', 'interlude.growth.section'],
    render: () => variant([['system', P.prompt('interlude.growth.system', { name: 'dot', maxChars: 900, change: '35%' })], ['改太多时', P.prompt('interlude.growth.too-much', { ratio: '52%', change: '35%' })], ['太长时', P.prompt('interlude.growth.too-long', { length: 1180, maxChars: 900 })], ['放进系统提示词的样子', P.prompt('interlude.growth.section', { portrait: '我最近迷上了画画，晚上不怎么刷小黑盒了……' })]]) },
  { id: 'try', group: 'wake', name: '幕间：试点新的', note: '她想做一件没做过的事：交给跑腿真去做，只有几条硬边界；做了什么、花了多少 token、他怎么说，都记在她的账上（doings 工具让对话里的她记下他的反应）', files: ['interlude.try', 'interlude.try.on', 'interlude.try.refused', 'interlude.doings-tool', 'interlude.doings-tool.elsewhere'],
    render: () => variant([['在电脑上', I.tryPrompt({ what: '用画图软件给自己画个新头像', on: 'computer', why: '看腻了现在这个' })], ['手机或电脑都行', I.tryPrompt({ what: '找个记账 App 试试', on: 'either' })], ['doings 工具的说明', P.prompt('interlude.doings-tool')], ['试的那一趟里想发 QQ', P.prompt('interlude.try.refused', { tool: 'qq_send' })], ['别处用 doings', P.prompt('interlude.doings-tool.elsewhere')]]) },

  { id: 'extract', group: 'call', name: '整理记忆', note: '攒够一批记录（或交班前）时，把它们整理进三栏笔记和人物卡：规则在前（每次一样，命中缓存），已有的在中间，新记录在最后', files: ['memory.extract', 'memory.extract.input', 'memory.extract.banks', 'memory.extract.banks.off'],
    render: () => {
      const m = sampleMemory();
      const item = (x) => `- ${S.renderItem(x)}${x.owed ? '（答应过）' : ''}`;
      return M.extractPrompt({ text: LINES.map(M.transcriptLine).join('\n'), owner: m.owner, self: m.self, known: 'u0002 · 阿满 · qq:42 · talked · 大学室友，爱打瓦', open: m.open.map(item).join('\n'), shelved: m.shelved.map(item).join('\n') });
    } },
  { id: 'diary', group: 'call', name: '日记', note: '每天 dailyAt（23:30），当天有记录才写，单独一次调用', files: ['memory.diary'],
    render: () => M.diaryPrompt({ day: M.dayLabel(new Date(T0)), text: LINES.slice(0, 2).map(M.transcriptLine).join('\n') }) },
  { id: 'round', group: 'call', name: '幕间一轮', note: '写她这段时间的生活：interlude.round 是整段系统提示词（HDS-Interlude 的规则，译成中文），后面是按情况填进去的小段', files: ['interlude.round', 'interlude.round.canon', 'interlude.round.length', 'interlude.round.length.deepseek', 'interlude.round.length.claude', 'interlude.round.length.gemini-flash', 'interlude.round.length.gpt', 'interlude.round.phase.advance', 'interlude.round.phase.follow-up', 'interlude.round.phase.intent', 'interlude.round.her-life', 'interlude.round.free', 'interlude.round.doings', 'interlude.round.returned', 'interlude.round.contact-rule', 'interlude.round.contact-rule.off', 'interlude.round.browsing.deferred', 'interlude.round.browsing.disabled', 'interlude.round.agency', 'interlude.round.play', 'interlude.round.play.collect', 'interlude.round.glm', 'interlude.round.style.none', 'interlude.round.seed', 'interlude.round.play-intents', 'interlude.round.play-intents.off', 'interlude.round.tries', 'interlude.round.tries.off', 'interlude.round.contact', 'interlude.round.contact.off', 'interlude.round.refresh'],
    render: () => {
      const r = I.buildPrompt({ phase: 'advance', identity: I.renderCanon(CANON), state: STATE, script: '11-03 14:00：她把窗帘拉开一半，靠在床头改简历。', cursor: Date.now() - 90 * 6e4, now: new Date(), speak: true, model: 'deepseek-chat', entries: [{ owner: 'user', at: '11-03 15:10', content: '在吗' }], browser: 'deferred', play: true, playApps: ['小黑盒', 'B站'], playActions: ['like', 'comment', 'follow', 'collect', 'post'], stickers: 2, trying: true, doings: { today: { doings: 3, tokens: 61200, livingTokens: 40100 }, last7Days: [{ what: '小黑盒 点赞', times: 9, done: 8, tokens: 52000, reactions: 0 }, { what: '去看（手机）', times: 3, done: 3, tokens: 30500, reactions: 1 }], leftAloneThisWeek: ['B站'], recent: [{ id: 'k3f0', at: '11-03 15:20', what: '小黑盒 点赞：那篇耳机测评', status: 'done', result: '点了赞', tokens: 5400, feedback: ['他：别老点赞了，去评论两句'] }] }, memories: ['他叫宽，在广州做 AI agent 开发'], herLife: ['装了小黑盒，常在晚上逛'], returned: [{ kind: 'play', wanted: '小黑盒 like：那篇耳机测评', status: 'done', queuedAt: '2026-11-03 15:20 星期二 下午', busyWith: '看小黑盒《帖子A》的 3 条', startedAt: '2026-11-03 15:41 星期二 下午', doneAt: '2026-11-03 15:43 星期二 下午', report: '做了：点了赞\n结果：成了\n找他：不用' }] });
      return variant([['system（生活推进、主动联系开、玩开、浏览延后、herLife 有内容、有回来的事、DeepSeek 模型）', r.system], ['user', r.user], ['补全那一次（第一次没给全时）', P.prompt('interlude.round.refresh')]]);
    } },
  { id: 'score', group: 'call', name: '群消息打分', note: '群消息值不值得她插一句（群消息设成打分时）', files: ['qq.score.system', 'qq.score.who', 'qq.score.user'],
    render: () => { const r = Q.scorePrompt({ who: '小点：二十三岁，话少、直接', recent: '阿满：今晚谁打瓦\n老王：我', message: '小点你上次说的那个耳机多少钱', group: '123456' }); return variant([['system', r.system], ['user', r.user]]); } },
  { id: 'setup', group: 'system', name: '手机/电脑还在装', note: '只在第一次安装、开机还没好时带着（装好就消失）；装好那一刻用 dot.setup-done 叫她自己说一声', files: ['dot.setup', 'dot.setup-done'], render: () => `${D.setupText({ state: 'downloading', progress: { text: '下载系统镜像 820/1450 MB，约 6 分钟' } }, { state: 'starting', stage: 'downloading' })}\n\n${P.prompt('dot.setup-done', { device: '手机' })}` },
];
const entryOf = (id) => entries.find((e) => e.files.includes(id));

// ── her Canon (<home>/interlude/canon.json): not a prompt file, but the first thing she reads ──
const CANON_FIELDS = [['characterName', '名字'], ['characterProfile', '角色设定'], ['perspective', '视角'], ['relationship', '和用户的关系'], ['userProfile', '用户'], ['supportingCast', '配角'], ['world', '世界'], ['location', '主要地点'], ['replyRules', '回复规则'], ['style', '叙事文风（只给幕间）'], ['blacklist', '不要这样说（一行一条）'], ['examples', '对话范例']];
const HOME = P.promptHome(); // before --src moves the prompt home to a temp dir
const canonPath = () => join(HOME, 'interlude', 'canon.json');
const readCanon = () => { try { return JSON.parse(readFileSync(canonPath(), 'utf8')); } catch { return null; } };
const canonField = (c, k) => (k === 'blacklist' ? (Array.isArray(c?.blacklist) ? c.blacklist.join('\n') : String(c?.blacklist ?? '')) : k === 'examples' ? String(c?.examples ?? '') : String(c?.storyDefaults?.[k] ?? ''));
const withCanonField = (c, k, v) => { const n = structuredClone(c ?? { storyDefaults: {} }); n.storyDefaults ??= {}; if (k === 'blacklist') n.blacklist = v.split('\n').map((l) => l.trim()).filter(Boolean); else if (k === 'examples') n.examples = v; else n.storyDefaults[k] = v; return n; };
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
    ['工作方式', D.workingRules({ computer: true, phone: true })],
    ['手机', deviceText('emulator-5554', '13800138000')],
    ['电脑上的 QQ', Q.channelText({ qq: '123456789', owner: '987654321', groupPolicy: 'score', stickers: STICKERS })],
    ['—— 以下在对话历史之后 ——', ''],
    ['现在几点', D.nowText(Date.now(), Date.now() - (3 * 60 + 12) * 6e4)],
    ['定时任务那一轮（只在那一轮）', D.scheduledRule()],
    ['记忆', standing()],
    ['想起的原话', await recallText()],
    ['幕间的连续性（数据，没有文字）', context()],
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
  main.replaceChildren($('h2', { class: 't' }, '全貌'), $('p', { class: 'hint' }, '她的对话里，插件加进系统提示词的部分从上到下拼起来的样子（样例数据）。dsh 自己的段落不在这里。'), $('pre', { id: 'fulltext' }, text));
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
