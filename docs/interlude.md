# dsh-dot/interlude · 幕间（原 dsh-interlude）

> Since dsh-dot v0.4 the interlude is a component of [dsh-dot](../README.md), not a separate plugin: install `dsh-dot-life`. Everything below still applies; the component name is `dsh-dot-life/interlude`, its files stay under `~/dot/interlude/`, the command is still `/interlude`.

**English** | [中文](#中文说明)

An independent implementation, for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), of the *interlude* idea from [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude) (Hyperrealistic Dialogue System, a Koishi plugin by MOMOR1A); none of its code or prompt text is used. **On stage** is any dsh conversation in your agent's home directory; dsh runs it, dsh-im carries it. **Between acts**, this plugin gives the character one bounded model call per round, in which it writes the life that happened since the last *story cursor*, keeps a small continuity snapshot, stores intents for later, and decides whether it has a real reason to reach out. The next conversation opens with that continuity in view.

Three kinds of rounds:

| Round | When |
|---|---|
| `follow-up` | a conversation has gone quiet (`idleMinutes`) |
| `advance` | independent life progression on an interval, even with no conversation (`advanceEveryMinutes`, inside `activeHours`) |
| `intent` | a stored intent came due (a reminder, a promised reply, a contact check); settles it, plants no new one |

Files, all plain text under `~/dot/interlude/`: `canon.json` (who the character is — HDSI `storyDefaults`, imported from the HDSI preset hub with `/interlude preset <share code>` or set in config; no `AGENTS.md` needed), `script.md` (the life script, append-only), `state.json` (continuity: current / recent / salient), `intents.json`, `calls.jsonl` (audit). The Canon is injected as a system-prompt section for sessions in the home directory.

```bash
dsh plugin --profile desktop add dsh-dot-life
```

No memory database, no retrieval, no tools inside the round; metered by dsh-budget like any other call. Works on its own; built to sit beside [dsh-dot](https://github.com/Kevinwu901113/dsh-dot).

---

<a id="中文说明"></a>

## 中文说明

### 一、来源

这是 [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude)（Hyperrealistic Dialogue System，MOMOR1A 的 Koishi 插件）里"幕间"这一层想法在 dsh 上的独立实现（不含它的代码和提示词文字）。它把角色的连续性做成了一个生活在时间里的故事：对话只是故事里被看见的那部分，对话之外角色也在过自己的日子，有情绪漂移、有打算、有在合适时机主动找人的意愿。

dsh 这边不需要重做一个对话系统——对话由 dsh 自己跑，IM 由 dsh-im 接，定时结果由 dsh-dot 推。缺的只是幕间。所以这个插件只做 HDSI 里"对话之外"的部分，并且做得小。

### 二、它做什么

0. **Canon（人设）由插件管理，不用 AGENTS.md**：`/interlude preset <分享码>` 从 HDSI 官方预设站 [typ0.space](https://typ0.space) 拉一份 `storyDefaults`（角色设定、视角、关系、配角、世界、文风、回复规则）存到 `~/dot/interlude/canon.json`，立即作为系统提示的一段注入 `~/dot` 里的每个会话（紧跟 dsh 的 persona 之后，静态，不破坏提示前缀缓存）。也可以在 `cordis.patch.yml` 的 `canon` 配置里直接写。`/interlude canon` 查看当前人设。HDSI 社区分享的任何人设因此都能直接用在 dsh 上。
1. **看着幕前**：记录 `~/dot` 里每一轮对话的梗概（谁发起的、用户说了什么、它最后答了什么、有没有审批）。定时任务触发的轮次也算。
2. **幕间一轮**：一次模型调用。模型看到：身份文件（Canon）、当前状态、最近两段剧本、她自己的笔记（`herLife`，来自 dsh-dot/memory 的 self 栏：她现在真实在做的事、会的事、习惯——这段生活围着它展开，虚构只填空隙，不发明学业/工作背景）、记忆里关于他的事（memory 的"关于他"一栏）、待办的打算、这段时间幕前发生了什么、现在是星期几什么时段、距上一次幕间多久。它以**一次 `interval` 工具调用**交出这些字段（参数由 API 保证是 JSON；只写了散文的回复也收，由第二次小调用把其余字段补齐）：
   - `script`：从上次故事光标到现在，它过的日子（≤150 字，第一人称，可以和用户无关）；
   - `state`：`mood` 一句话、`now` 在做什么、`next` 接下来打算、`threads` 挂念的事；
   - `intents`：确实要在未来某个时刻处理的事，带时间、类型（提醒 / 答应的回复 / 想联系）和意愿值；
   - `contact`：现在有没有具体理由想对用户说一句话，带意愿值和理由；没有就 `null`。
   - **提示词**：这一轮的系统提示词整段是一个文件 `src/prompts/interlude.round.txt`，全中文。它分几节：她在写什么、时间、什么是真的（观察到的账本、她自己的生活、`<contact/>` 标记）、上网看到的、这一段怎么写、输出字段（字段清单）；字段名和 JSON 键保持英文。随轮次变化的部分是 `{phase}` `{length}` `{contact}` 这类占位符，各自对应一个 `interlude.round.<名字>.txt` 小文件（阶段、篇幅、主动联系开/关、浏览、玩……）；某个占位符为空时那一行整行省掉。把它复制到 `~/dot/prompts/interlude.round.txt` 再改，替换的就是整段系统提示词；`npm run prompts` 页面里能直接改、预览。
3. **三种触发**：对话安静 `idleMinutes` 后一次 `follow-up`；没有对话时每 `advanceEveryMinutes` 一次 `advance`（只在 `activeHours` 内）；某个 intent 到时间时一次 `intent`。每天最多 `maxRoundsPerDay` 次。
4. **带进下一幕**：`~/dot` 里之后的每一轮，系统提示里多一段 `<interlude>`：状态、最近的剧本、待办的打算、距上次幕间多久、期间 dsh 有没有重启过。放在对话历史之后，不影响提示前缀缓存。
5. **网页观察（HDSI 的 browserIntent）**：主角在幕间里"想查点什么"（搜索或打开一个公开页面）时写进 `browserIntents`，这一轮写完后插件去看，结果存进 `web-context.jsonl`，作为下一轮的 `webContext`。这是她自己的好奇心驱动的"闲逛"，不是兴趣清单定时抓取；每天有上限。看的方式有两种：
   - **web**：dsh 的 `web` 服务。匿名、只读、便宜、看不见。适合好奇心：搜个新闻、看个公开页。
   - **vm**：她自己的电脑（dsh-computer 的虚拟机浏览器）。带着她的登录态和标签页，实时画面里看得见。适合"她的站"——微博、B 站、小红书、X 这些登录后才像样的地方。实现上是往她最近一个会话里追加一条 `[幕间观察]` 消息，让她用 `mcp__dot-vm__browser_*` 自己去看，最后那段回复就是观察结果；这一轮**不算幕**（不进剧本），也**没有审批**：只读工具（打开、滚动、读文字、截图、标签页）直接放行，其他任何工具——点击、输入、下载、shell——直接拒绝，不弹审批卡。她只能看，不能动。
   - `browser: auto`（默认）：先走 web；URL 的主机在 `vmSites` 里就直接走 vm（她的站从不匿名看）；web 结果太薄或被挡（JS 墙、验证码、登录墙）也升级到 vm，一天最多 `vmDailyCap` 次。
6. **玩**：幕间里她可以写一个 `playIntent`——此刻想在手机上做的一件事：给哪篇点个赞、评论一句、关注谁、发一条新帖（`playActions`；发帖每天 ≤ `postDailyCap`，要带正文；私信 / 花钱不在其中，也写不进去；不想让她发帖就把 `post` 从 `playActions` 去掉）。这一轮写完后变成她会话里的一条 `[想玩会儿手机] …` 消息，她用手机去做（正常轮次，手机闸门的审批照常），做完只回 `DOT_SILENT`。门控和主动联系一样：活跃时段、意愿 ≥ 阈值、每天 ≤ `maxPlaysPerDay`（默认不限）、App 在 `playApps` 里**且装在她手机上**（没装一个就等于关）。行为准则不是我们写的，是 [Moltbook](https://www.moltbook.com/heartbeat.md) 给住在社交网络上的 agent 定的守则（节译）：先回别人的回复，再慷慨点赞，再用心评论，再关注，最后才发新内容——而且只在真有话说时；参与 > 创造；真诚，不为凑数。
6b. **试点新的**：她想做一件没做过、或不常做的事——装个 App 试试、在电脑上画点写点、学个东西、换个玩法——写进 `tries`（每轮最多一个，每天 ≤ `tryDailyCap`）。交给跑腿真去做，怎么做由她，提示词里只有几条硬边界：不花钱、不改账号和资料、不注册、不私信陌生人、不碰他的东西、只删自己建的、要审批的等批准。做完的汇报和玩一样留进她的对话。
6c. **她自己的账（doings）**：玩、去看、试的每一件都记在 `doings.json`：做了什么、结果、花了多少 token（跑腿那一轮每一步的用量加起来；设了 `price` 还折成钱）、他怎么说。下一轮她看到 `yourDoings`：这七天她一直在做什么、各花多少、这周哪些 App 没碰过、最近几件的结果和他的反应、今天一共花了多少（含写生活本身）。值不值、要不要换着来，由她自己掂量，想法写进 `reflect`，也记在账上。他的反应有两条路进账：对话里他说起某件事时，她用 `doings` 工具记下；或者你直接 `/interlude feedback [#id] 一句话`（`/interlude doings` 看清单）。提示词不规定她该做什么：`interlude.round.free` 只说她不是照日程表过日子的人，其余交给她。
6d. **自己的时间**：每天 `freeTimesPerDay`（默认 2）次，在活跃时段里随机挑时刻（他正在聊天时不开），叫醒跑腿的她，只说"接下来这段时间是你自己的"，不给任务、不列动作表；一起给她的是：她现在的样子、她的笔记、她的账、最近的状态，和她自己的地方 `<home>/her`（只属于她的文件夹，放什么、怎么放随她，下次开始时她会看到里面有什么）。边界在代码里：这段时间 QQ 和账本工具被拒；在社交 App（小黑盒、B站、QQ、微信……）里打字要他批准；花钱、装 App 照旧走手机和电脑的审批；想找他用 `tell_him`，它走主动联系的闸门（`speak`、次数、活跃时段），交给她和他的对话决定说不说。预算：每次 `freeTokenCap`（15 万）token，用到 80% 提醒她收尾，到上限停下（停不下来时，之后的每个工具调用都被拒）；每天 `freeDailyTokens`（30 万）封顶。缓存命中的重复读取按十分之一计（DeepSeek 上它的价钱就是十分之一），不然每一步都把整个上下文重新算一遍，15 万只够三五步。同一时间最多一次。
   **已知还拦不住的**：手机上的点按（点赞、关注、转发、发表情）只看得到坐标，分辨不出点的是什么，所以不受「玩」的每日上限约束；审批通过到真正执行之间如果别的会话换了前台 App，打字会落在那个 App；用 `computer-auto` 预设（审批设为从不询问）时「要批准」会被自动通过；电脑浏览器里的发帖、网页版 QQ 也没拦。结束后，她真做过的事作为观察到的事进下一轮幕间，账上记一笔"自己的时间"。需要 dsh-dot（她的跑腿）。`/interlude free` 立刻给她一次。
6e. **成长**：每周 `growthAt`（周日 21:00）一次回顾：读这周的日记、她自己的笔记、关于他的笔记、她的账和他的反应，由她重写「她现在的样子」——第一人称、`portraitMaxChars`（900）字以内、一次最多改 `portraitMaxChange`（35%，改多了要她再写一次，还多就这周不改），并写下"这周变了什么"。这一段作为系统提示词跟在人设后面（她的对话和幕间都看得到），一周才变一次，不影响缓存。每一版存在 `<home>/interlude/growth/<周>.md`（不放在她自己的地方，免得她直接改文件绕过回顾；同一周第二次回顾存成 `<周>-2.md`，不覆盖）：错过了周日那个时刻（dsh 没开），下次开着时补上。`/interlude growth` 看现在的样子和每周变化，`/interlude growth <周>` 看那一版，`/interlude growth rollback <周>` 回到那一版，`/interlude growth now` 立刻回顾一次。回顾不写记忆：它觉得她笔记里过时的条目，留到她下次自己的时间，由她自己用 memory 工具去改。提示词里要她分清"我自己想要的"和"只是因为他喜欢"——后者不算她的变化。
7. **主动联系（Agency，默认关）**：`speak: true` 时，模型给出的 `contact` 过四道闸——在活跃时段、意愿 ≥ `willingnessThreshold`、当天未超 `maxContactsPerDay`、dsh-im 有投递目标——才通过 `dshIm.send()` 发出去。被拦下的会记在审计日志里。
8. **有 dot 时幕间不自己动手**：玩和用手机 / 电脑去看，都排队交给 dot 的跑腿（`dot.interludeQueueMax`、`dot.interludeTaskTtlMs`，优先级最低：通知的活先做），这一轮不等结果；做完、过期或作废后回到 `meta.json` 的 `returned`，下一轮读到：她当时想做什么、那会儿在忙什么、拖到几点才做（或没做成）、结果如何，写进剧情和 continuity。主动联系也不自己发：交给她的对话留一句，说不说由她定。网页（web）观察照旧当场看。没装 dot 时一切照上面的老办法。

### 三、和 HDSI 的对照

| HDSI | dsh-interlude |
|---|---|
| 网页观察（browserIntent → webContext） | 同名同义；多了一条路——她的站用她自己的虚拟机浏览器去看（只读、无审批、画面可见） |
| 四个阶段：用户消息 / 对话后续 / 到期意图 / 独立生活推进 | 用户消息由 dsh 自己处理；其余三个对应 `follow-up` / `intent` / `advance` |
| 故事光标 | `meta.cursor`；提示里写明"从上次光标到现在过了多久" |
| Canon / storyDefaults | `canon.json`，同一套字段；可用 HDSI 分享码直接导入 typ0.space 上的预设 |
| recentScript | `script.md` 最近两段 |
| continuitySnapshot | `state.json` |
| Overlay | 不移植：慢变化由 dsh-dot/memory 的 self 栏承担（整理时由模型写，有依据），幕间只读它（`herLife`） |
| intents | `intents.json`，到期触发 |
| Agency Window + 意愿 | `speak` / `activeHours` / `willingnessThreshold` / `maxContactsPerDay` |
| Alter（情绪漂移）、Perspective、长期事实检索、多参与者剧情、对话内的已读/延迟回复 | 没有移植。情绪由模型在幕间里写一句话；要长期记忆另装记忆插件 |

### 四、安装

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add dsh-dot-life
```

和 dsh-dot 共用 `~/dot`。装好后在 dsh 里发 `/interlude preset 6QA0-1PD6`（示例：HDSI 作者的「水濑」），人设就有了；或者去 typ0.space 挑一个，复制分享码。

`/interlude` 查看状态，`/interlude canon` 看当前人设，`/interlude seed` 给空剧本写一个开场（最近一天的 3–5 段，HDSI 的「剧本起点」），`/interlude now` 立即来一次 follow-up，`/interlude advance` 立即来一次生活推进。

`examples/canon.example.json`（在 dsh-dot 仓库根目录）是一份自带的示例 Canon，放到 `~/dot/interlude/canon.json` 即可使用，可以随意改。从预设站导入的人设各有自己的许可（导入时会显示），不随本仓库的 MIT。

### 五、配置

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `DSH_DOT_INTERLUDE=off` | | 整个组件不加载 |
| `home` / `DSH_INTERLUDE_HOME` | `~/dot`（跟随 `DSH_DOT_HOME`） | 幕间文件所在目录 |
| `browser` | `auto` | HDSI 的「网页观察」怎么看：`auto`（web 优先，`vmSites` 或 web 被挡时用 vm）、`web`、`vm`、`disabled` |
| `browseDailyCap` | `6` | 每天最多观察几次（两种方式合计） |
| `phoneApps` | 内置常见社区 App（`KNOWN_APPS.sites`） | 用她手机上的 App 看的站，`{ host: 包名 }`；需要 `dsh-dot/phone` 就绪。规则同 `vmSites`：从不匿名看、只读、无审批 |
| `phonePreferred` | `true` | web 被挡要升级时，手机和电脑都在就先用手机 |
| `phoneObservationTools` | 看、滑、点、开 App、返回 | 观察轮放行的手机工具；输入、装卸 App 一律拒绝 |
| `vmSites` | `[]` | 只在虚拟机里看的站（主机后缀匹配，如 `bilibili.com`）；虚拟机今天没额度就等，不会匿名去看 |
| `vmDailyCap` | `2` | 每天最多几次"自己去看"（手机 + 电脑合计） |
| `vmObservationTools` | 只读的 `browser_*` 工具 | 观察轮里唯一放行的工具；其余一律拒绝，不审批 |
| `vmSession` | 自动（她最近一幕所在会话） | 观察在哪个会话里做 |
| `vmTimeoutMinutes` | `5` | 观察轮最长等多久 |
| `webContextLimit` | `4` | 之后的轮次能看到最近几条观察 |
| `scope` | `home+im` | 哪些会话算"幕"：`home`（cwd 在 home 里）、`im`（任何 IM 机器人开的会话，不管工作区）、`home+im`、`all` |
| `canon` | 无 | HDSI `storyDefaults` 对象，作为初始人设；导入过预设后以 `canon.json` 为准 |
| `trimSections` | `harness:identity, deployment:persona-prefix, context:file-reference` | 主角的会话里从系统提示删掉的段（dsh 的「You are an AI agent / coding agent」开头，社区公认的 AI 味来源），让 Canon 成为第一段；`[]` 不删 |
| `canonOnly` | `false` | `true` 时主角的会话只保留 Canon、dot 规则和 MCP（虚拟机）工具段 |
| `voice` | `true` | 她和他的对话里，每轮最后（记忆、原话、幕间数据之后）放一两句「怎么说话」：人设里填了「说话提醒」（canon.json 的 `voice`）就用它，空着用 `interlude.voice`；跑腿会话不带 |
| `presetHub` | `https://typ0.space` | HDSI 预设分享站 |
| `identityFile` | 无 | 可选：额外追加到 Canon 后面的文本文件 |
| `idleMinutes` | `10` | 安静多久算一幕结束 |
| `advanceEveryMinutes` | `90` | 独立生活推进的间隔；`0` 关闭 |
| `activeHours` | `08:00-23:00` | 推进和主动联系只在这个时段 |
| `maxRoundsPerDay` | `20` | 每天幕间上限 |
| `maxTokens` | `16384` | 每轮输出上限 |
| `scriptEntriesInPrompt` | `2` | 下一幕能看到几段剧本 |
| `play` | `true` | 允许她在手机 App 上玩（点赞 / 评论 / 关注 / 发帖）；只在她装了的 App 里 |
| `playApps` | 内置常见社区 App（`KNOWN_APPS.labels`） | 可以玩的 App：`{ 小黑盒: com.max.xiaoheihe }`（标签 → 包名），再按手机上装了什么收窄 |
| `playActions` | `like, comment, follow, collect, post` | 允许的动作；`collect` = 去 App 逛逛攒表情包（`qq_sticker_keep`），表情包少于 5 张时幕间会被提醒；去掉 `post` 就不发帖；`dm` 永远不执行 |
| `maxPlaysPerDay` | `0` | 每天最多几次，`0` 不限 |
| `postDailyCap` | `1` | 每天最多发几条新帖 |
| `tries` | `true` | 允许她试没做过的事（交给跑腿，硬边界见上） |
| `tryDailyCap` | `3` | 每天最多试几件 |
| `price` | `null` | 每百万 token 的价钱 `{ in, cached, out }`（元），给了她就能看到花了多少钱；不给只看 token |
| `freeTimesPerDay` | `2` | 每天几次「自己的时间」，`0` 关；需要 dsh-dot |
| `freeTokenCap` / `freeDailyTokens` | `150000` / `300000` | 每次 / 每天自己的时间的 token 上限 |
| `growth` | `true` | 每周回顾、「她现在的样子」 |
| `growthAt` | `Sun 21:00` | 每周回顾的时刻（`Mon`…`Sun` + 时间） |
| `portraitMaxChars` / `portraitMaxChange` | `900` / `0.35` | 「她现在的样子」的字数、每周最多改动的比例 |
| `speak` | `false` | 允许主动联系 |
| `maxContactsPerDay` | `2` | 每天最多主动几次 |
| `willingnessThreshold` | `0.6` | 意愿低于此不发 |
| `imBot` / `imTarget` | 自动 | dsh-im 的机器人和投递目标 |

### 六、文件

全部在 `~/dot/interlude/`，纯文本，可以随时打开看、改、删：`canon.json`、`script.md`、`state.json`、`intents.json`、`pending.jsonl`（还没被幕间处理的幕）、`calls.jsonl`（每轮的模型和原始回复）、`meta.json`（光标、计数）、`doings.json`（她自己做的事、花费和反馈，最多留 200 件）。她自己的地方在 `~/dot/her/`，成长史在 `~/dot/interlude/growth/`。幕间事件也写进 dsh-computer 的审计日志（`kind: "interlude"`），如果装了它。

### 七、原则

- **不重复造轮子**：人设直接用 HDSI 社区的预设（分享码导入），字段和 HDSI 一致；对话、IM、定时都用现成的；模型调用走 dsh 的 `llm` 服务和默认模型。
- **不做记忆库**：剧本给人看，状态给下一幕看，都有上限。要长期记忆，另装记忆插件。
- **可审计**：模型看到什么、写了什么、为什么没发出去，`calls.jsonl` 和审计日志里都有。

### 八、验证情况

dsh 0.2.0-rc.2，云端，模拟模型：一幕结束后 `/interlude now` 发起真实模型调用，写出 `script.md`、`state.json`、`intents.json`（含一条两小时后的 intent）；之后的每一轮请求里都带上了 `<interlude>` 块。单元测试 11 项：时段判断、三种阶段的提示、解析（丢弃过期 intent、意愿值夹紧）、渲染、完整一轮、intent 到期触发、speak 关闭时不联系、意愿不足时不联系、每日上限。

待验证：真机上用真实模型跑几天，看剧本是否自然、主动联系是否节制。

MIT（随 dsh-dot）。想法来自 HDS-Interlude；代码和提示词都是这里自己写的。


## 说话的样子（口癖、标点、长度）

她怎么说话由 Canon 决定，三处：`storyDefaults.replyRules`（长度、先情绪后内容、标点习惯）、`blacklist`（出现即失败的 AI 口癖、转折套话、夸张修辞、符号）、`examples`（对话范例和「只学结构不照抄」的真人句式）。改 `~/dot/interlude/canon.json` 即可，立刻生效。机械能保证的一层放在代码里：`dsh-dot/qq` 的 `tidy` 会把发出去的文字里的句号、引号、破折号、冒号、星号、井号去掉；二十字、先情绪后内容、不用套话这些只能靠 Canon 和模型。