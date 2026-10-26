# dsh-dot/interlude · 幕间（原 dsh-interlude）

> Since dsh-dot v0.4 the interlude is a component of [dsh-dot](../README.md), not a separate plugin: install `github:Kevinwu901113/dsh-dot`. Everything below still applies; the component name is `dsh-dot/interlude`, its files stay under `~/dot/interlude/`, the command is still `/interlude`.

**English** | [中文](#中文说明)

> 聊天在幕前发生，生活在幕间继续。 — [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude)

A port of the *interlude* idea from [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude) (Hyperrealistic Dialogue System, a Koishi plugin by MOMOR1A) to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). **On stage** is any dsh conversation in your agent's home directory; dsh runs it, dsh-im carries it. **Between acts**, this plugin gives the character one bounded model call per round, in which it writes the life that happened since the last *story cursor*, keeps a small continuity snapshot, stores intents for later, and decides whether it has a real reason to reach out. The next conversation opens with that continuity in view.

Three kinds of rounds, after HDSI's phases:

| Round | When |
|---|---|
| `follow-up` | a conversation has gone quiet (`idleMinutes`) |
| `advance` | independent life progression on an interval, even with no conversation (`advanceEveryMinutes`, inside `activeHours`) |
| `intent` | a stored intent came due (a reminder, a promised reply, a contact check); settles it, plants no new one |

Files, all plain text under `~/dot/interlude/`: `canon.json` (who the character is — HDSI `storyDefaults`, imported from the HDSI preset hub with `/interlude preset <share code>` or set in config; no `AGENTS.md` needed), `script.md` (the life script, append-only), `state.json` (continuity: current / recent / salient), `intents.json`, `calls.jsonl` (audit). The Canon is injected as a system-prompt section for sessions in the home directory.

```bash
dsh plugin --profile desktop add github:Kevinwu901113/dsh-dot
```

No memory database, no retrieval, no tools inside the round; metered by dsh-budget like any other call. Works on its own; built to sit beside [dsh-dot](https://github.com/Kevinwu901113/dsh-dot).

---

<a id="中文说明"></a>

## 中文说明

### 一、来源

这是 [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude)（Hyperrealistic Dialogue System，MOMOR1A 的 Koishi 插件，AGPL-3.0）里"幕间"这一层想法在 dsh 上的实现。HDSI 的一句话："聊天在幕前发生，生活在幕间继续"。它把角色的连续性做成了一个生活在时间里的故事：对话只是故事里被看见的那部分，对话之外角色也在过自己的日子，有情绪漂移、有打算、有在合适时机主动找人的意愿。

dsh 这边不需要重做一个对话系统——对话由 dsh 自己跑，IM 由 dsh-im 接，定时结果由 dsh-dot 推。缺的只是幕间。所以这个插件只做 HDSI 里"对话之外"的部分，并且做得小。

### 二、它做什么

0. **Canon（人设）由插件管理，不用 AGENTS.md**：`/interlude preset <分享码>` 从 HDSI 官方预设站 [typ0.space](https://typ0.space) 拉一份 `storyDefaults`（角色设定、视角、关系、配角、世界、文风、回复规则）存到 `~/dot/interlude/canon.json`，立即作为系统提示的一段注入 `~/dot` 里的每个会话（紧跟 dsh 的 persona 之后，静态，不破坏提示前缀缓存）。也可以在 `cordis.patch.yml` 的 `canon` 配置里直接写。`/interlude canon` 查看当前人设。HDSI 社区分享的任何人设因此都能直接用在 dsh 上。
1. **看着幕前**：记录 `~/dot` 里每一轮对话的梗概（谁发起的、用户说了什么、它最后答了什么、有没有审批）。定时任务触发的轮次也算。
2. **幕间一轮**：一次模型调用。模型看到：身份文件（Canon）、当前状态、最近两段剧本、她自己的笔记（`herLife`，来自 dsh-dot/memory 的 self 栏：她现在真实在做的事、会的事、习惯——这段生活围着它展开，虚构只填空隙，不发明学业/工作背景）、记忆里的事、待办的打算、这段时间幕前发生了什么、现在是星期几什么时段、距上一次幕间多久。它以**一次 `interval` 工具调用**交出这些字段（参数由 API 保证是 JSON；只写了散文的回复也收，由第二次小调用把其余字段补齐）：
   - `script`：从上次故事光标到现在，它过的日子（≤150 字，第一人称，可以和用户无关）；
   - `state`：`mood` 一句话、`now` 在做什么、`next` 接下来打算、`threads` 挂念的事；
   - `intents`：确实要在未来某个时刻处理的事，带时间、类型（提醒 / 答应的回复 / 想联系）和意愿值；
   - `contact`：现在有没有具体理由想对用户说一句话，带意愿值和理由；没有就 `null`。
3. **三种触发**：对话安静 `idleMinutes` 后一次 `follow-up`；没有对话时每 `advanceEveryMinutes` 一次 `advance`（只在 `activeHours` 内）；某个 intent 到时间时一次 `intent`。每天最多 `maxRoundsPerDay` 次。
4. **带进下一幕**：`~/dot` 里之后的每一轮，系统提示里多一段 `<interlude>`：状态、最近的剧本、待办的打算、距上次幕间多久、期间 dsh 有没有重启过。放在对话历史之后，不影响提示前缀缓存。
5. **网页观察（HDSI 的 browserIntent）**：主角在幕间里"想查点什么"（搜索或打开一个公开页面）时写进 `browserIntents`，这一轮写完后插件去看，结果存进 `web-context.jsonl`，作为下一轮的 `webContext`。这是她自己的好奇心驱动的"闲逛"，不是兴趣清单定时抓取；每天有上限。看的方式有两种：
   - **web**：dsh 的 `web` 服务。匿名、只读、便宜、看不见。适合好奇心：搜个新闻、看个公开页。
   - **vm**：她自己的电脑（dsh-computer 的虚拟机浏览器）。带着她的登录态和标签页，实时画面里看得见。适合"她的站"——微博、B 站、小红书、X 这些登录后才像样的地方。实现上是往她最近一个会话里追加一条 `[幕间观察]` 消息，让她用 `mcp__vm__browser_*` 自己去看，最后那段回复就是观察结果；这一轮**不算幕**（不进剧本），也**没有审批**：只读工具（打开、滚动、读文字、截图、标签页）直接放行，其他任何工具——点击、输入、下载、shell——直接拒绝，不弹审批卡。她只能看，不能动。
   - `browser: auto`（默认）：先走 web；URL 的主机在 `vmSites` 里就直接走 vm（她的站从不匿名看）；web 结果太薄或被挡（JS 墙、验证码、登录墙）也升级到 vm，一天最多 `vmDailyCap` 次。
6. **玩（默认关）**：`play: true` 时，幕间里她可以写一个 `playIntent`——此刻真想在手机上做的一件小事：给哪篇点个赞、评论一句、关注谁（`playActions`，发帖 / 私信 / 花钱不在其中，也写不进去）。这一轮写完后变成她会话里的一条 `[想玩会儿手机] …` 消息，她用手机去做（正常轮次，手机闸门的审批照常），做完只回 `DOT_SILENT`。门控和主动联系一样：活跃时段、意愿 ≥ 阈值、每天 ≤ `maxPlaysPerDay`、App 在 `playApps` 里。行为准则不是我们写的，是 [Moltbook](https://www.moltbook.com/heartbeat.md) 给住在社交网络上的 agent 定的守则（节译）：先回别人的回复，再慷慨点赞，再用心评论，再关注，最后才发新内容——而且只在真有话说时；参与 > 创造；真诚，不为凑数。
7. **主动联系（Agency，默认关）**：`speak: true` 时，模型给出的 `contact` 过四道闸——在活跃时段、意愿 ≥ `willingnessThreshold`、当天未超 `maxContactsPerDay`、dsh-im 有投递目标——才通过 `dshIm.send()` 发出去。被拦下的会记在审计日志里。

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
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add github:Kevinwu901113/dsh-dot
```

和 dsh-dot 共用 `~/dot`。装好后在 dsh 里发 `/interlude preset 6QA0-1PD6`（示例：HDSI 作者的「水濑」），人设就有了；或者去 typ0.space 挑一个，复制分享码。

`/interlude` 查看状态，`/interlude canon` 看当前人设，`/interlude seed` 给空剧本写一个开场（最近一天的 3–5 段，HDSI 的「剧本起点」），`/interlude now` 立即来一次 follow-up，`/interlude advance` 立即来一次生活推进。

`examples/canon.minase-style.json`（在 dsh-dot 仓库根目录） 是一份按 Minase 风格拼出来的 Canon（角色设定来自 @MomoiCore 的预设，回复规则来自 @Tangink 的预设，均 CC-BY-NC；对话范例取自 HDSI 作者公开的聊天截图），放到 `~/dot/interlude/canon.json` 即可使用。

### 五、配置

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `home` / `DSH_INTERLUDE_HOME` | `~/dot`（跟随 `DSH_DOT_HOME`） | 幕间文件所在目录 |
| `browser` | `auto` | HDSI 的「网页观察」怎么看：`auto`（web 优先，`vmSites` 或 web 被挡时用 vm）、`web`、`vm`、`disabled` |
| `browseDailyCap` | `6` | 每天最多观察几次（两种方式合计） |
| `phoneApps` | `{}` | 用她手机上的 App 看的站，`{ host: 包名 }`（如 `xiaoheihe.cn: com.max.xiaoheihe`）；需要 `dsh-dot/phone` 就绪。规则同 `vmSites`：从不匿名看、只读、无审批 |
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
| `presetHub` | `https://typ0.space` | HDSI 预设分享站 |
| `identityFile` | 无 | 可选：额外追加到 Canon 后面的文本文件 |
| `idleMinutes` | `10` | 安静多久算一幕结束 |
| `advanceEveryMinutes` | `180` | 独立生活推进的间隔；`0` 关闭 |
| `activeHours` | `08:00-23:00` | 推进和主动联系只在这个时段 |
| `maxRoundsPerDay` | `12` | 每天幕间上限 |
| `maxTokens` | `16384` | 每轮输出上限 |
| `scriptEntriesInPrompt` | `2` | 下一幕能看到几段剧本 |
| `play` | `false` | 允许她在手机 App 上做小动作（点赞 / 评论 / 关注） |
| `playApps` | `{}` | 可以玩的 App：`{ 小黑盒: com.max.xiaoheihe }`（标签 → 包名） |
| `playActions` | `like, comment, follow` | 允许的动作；`post` / `dm` 永远不执行 |
| `maxPlaysPerDay` | `3` | 每天最多几次 |
| `speak` | `false` | 允许主动联系 |
| `maxContactsPerDay` | `2` | 每天最多主动几次 |
| `willingnessThreshold` | `0.6` | 意愿低于此不发 |
| `imBot` / `imTarget` | 自动 | dsh-im 的机器人和投递目标 |

### 六、文件

全部在 `~/dot/interlude/`，纯文本，可以随时打开看、改、删：`canon.json`、`script.md`、`state.json`、`intents.json`、`pending.jsonl`（还没被幕间处理的幕）、`calls.jsonl`（每轮的模型和原始回复）、`meta.json`（光标、计数）。幕间事件也写进 dsh-computer 的审计日志（`kind: "interlude"`），如果装了它。

### 七、原则

- **不重复造轮子**：人设直接用 HDSI 社区的预设（分享码导入），字段和 HDSI 一致；对话、IM、定时都用现成的；模型调用走 dsh 的 `llm` 服务和默认模型。
- **不做记忆库**：剧本给人看，状态给下一幕看，都有上限。要长期记忆，另装记忆插件。
- **可审计**：模型看到什么、写了什么、为什么没发出去，`calls.jsonl` 和审计日志里都有。

### 八、验证情况

dsh 0.2.0-rc.2，云端，模拟模型：一幕结束后 `/interlude now` 发起真实模型调用，写出 `script.md`、`state.json`、`intents.json`（含一条两小时后的 intent）；之后的每一轮请求里都带上了 `<interlude>` 块。单元测试 11 项：时段判断、三种阶段的提示、解析（丢弃过期 intent、意愿值夹紧）、渲染、完整一轮、intent 到期触发、speak 关闭时不联系、意愿不足时不联系、每日上限。

待验证：真机上用真实模型跑几天，看剧本是否自然、主动联系是否节制。

AGPL-3.0-only（随 dsh-dot）。想法和 lite 档提示词来自 HDS-Interlude（AGPL-3.0）；对话层没有复用其代码。
