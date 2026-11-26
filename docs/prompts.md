# 提示词：`src/prompts/` 和 `npm run prompts`

插件交给模型的每一段话都是 `src/prompts/` 里的一个 UTF-8 纯文本文件，文件名就是它的代号（`dot.rules.txt` → `dot.rules`）。代码只负责拼：按情况选文件、把 `{名字}` 换成实际内容。

**覆盖**：把文件复制到 `<home>/prompts/`（`<home>` 是她的家目录，默认 `~/dot`，即 `dot.home`）再改，同名文件优先于内置的。按修改时间重新读，改完她下一轮就用新的，不用重启 dsh；删掉覆盖文件就回到内置版本。升级插件不会动你的覆盖。

**基线**：覆盖文件第一行可以是 `# base: <hash>`，记着它是照哪版内置改的（内置文本的 sha256 前 12 位，这一行不算进提示词）；页面「保存」会自动写上。内置变了，`/dot prompts` 和 dot 面板会列出「默认已更新」的代号，没有这一行的列为「未记录基线」。`/dot prompts rebase <id>` 把你的覆盖和现在的内置逐行对比（`-` 只在覆盖里，`+` 只在内置里），并记下新基线，表示看过了；`/dot prompts rebase <id> --reset` 删掉覆盖，回到内置。

**写法**：
- `{名字}` 是占位符，代码填；没填到的原样留着，并在日志里提醒一次。别删，删了那部分内容就不出现了。
- 某一行只有一个 `{名字}` 且它是空的（比如没开电脑时的 `{computerRule}`），这一行整行省掉。
- 带条件的片段是单独的文件（`qq.channel.owner.txt` 只在设了主人时拼进 `{owner}`；`phone.device.number.txt` 只在设了手机号时拼进 `phone.device` 的 `{number}` 那一行，里面的 `{number}` 是号码本身；`phone.stickers.txt` 是 `phone.device` 的 `{stickers}`，各 App 怎么加表情包，整段手机提示词只在手机开着时出现）。
- 几个文件是表格，一行一项 `代号=文字`（`dot.now`、`memory.standing`、`memory.handoff`、`memory.daily.bank`、`memory.extract.things`）：只改等号右边。
- **时间戳**：叫醒她的每条消息开头都有同一种时间戳 `{stamp}`：`MM-DD HH:MM`，不是今年的写 `YYYY-MM-DD HH:MM`（和记忆里的日期一个规则）。他的 QQ 消息是 `[{stamp}] 他：原话`（一批盖一个，多条一行一条）；通知和自己的时间放在方括号里：`[{stamp} 手机通知]`、`[{stamp} 自己的时间]`；交给手的事回来时不带方括号：`{stamp} 刚才那件事做完了：…`（`dot.hands.result`，卡住、要他来的那两句同样）。改这些文件时保留 `{stamp}` 和方括号的样子，记忆记录时按这个样子把时间戳去掉（`clock.js` `unstamp`）。
- `dot.now` 是她对话里「现在」那一行：`line` 是整行，`since` 是「距上一条消息」那一段（不到一分钟、或还没说过话时整段省掉）。

**页面**：在 dsh 里发 `/dot prompts`，打开它回的网址（默认 http://127.0.0.1:7870/，只监听本机，端口用 `dot.promptsPort` 换；日志 `~/.dsh/dsh-dot-prompts.log`），`/dot prompts stop` 关掉，dsh 退出时也跟着关。开发时在仓库根目录跑 `npm run prompts` 是同一个页面（`PORT=xxxx` 换端口）。左边第一项是人设（canon.json），其余按她看到的顺序列出全部文件，标着「内置」或「已改过」；右边是整个文件，「保存」写到 `<home>/prompts/`，「恢复内置」删掉覆盖文件，「预览」用样例数据跑真实代码（没保存的改动也能预览），「全貌」拼出她对话里插件加的整段系统提示词。`npm run prompts -- --src` 时「保存」直接写进 `src/prompts/`，改的是内置版本。

| 分组 | 是什么 | 文件 |
|---|---|---|
| 她的对话：系统提示词 | 工作方式 | `dot.rules` |
| | 手机、电脑在她对话里的那一段 | `phone.hers` `dot.computer.hers`（操作说明 `phone.device` 只给手） |
| | 电脑上的 QQ | `qq.channel` `qq.channel.owner` `qq.channel.score` `qq.stickers` `qq.channel.no-stickers` `qq.faces` |
| | 手机/电脑还在装（只在第一次装、开机没好时） / 装好那一刻 | `dot.setup` / `dot.setup-done` |
| | 记忆 | `memory.standing` |
| 她的对话：跟着叫醒她的那条消息的短消息（每来一次东西说一次） | 现在几点、今天主动找过他几次、事情簿那几行 | `dot.now`；`dot.reach` `.reach.waiting`；`dot.things.running` `.stuck` `.stopped.his` `.awaiting` `.asking` `.untold` `.untold.done` `.more` |
| | 想起的原话 / 事实条 | `memory.recall.header` / `memory.facts.header` |
| | 她写的字没有人读 / 刚才替她说出去的话 | `dot.say.note` / `dot.say.said` `.say.interrupted` |
| | 醒来的第一轮 / 攒着的 App 推送 / 定时任务那一轮 | `dot.woke` `.woke.morning` / `dot.pushes` / `dot.scheduled` |
| | 说话提醒（默认关） | `interlude.voice`（人设里的「说话提醒」优先） |
| 叫醒她的消息 | 他的 QQ 消息 | `dot.owner-words`（她这轮进行中插进来时多一行 `dot.owner-words.busy`；她上一条有话没发出去时附 `dot.owner-words.unsent`） |
| | 手机通知、她 QQ 上的人 | `dot.notification` `.many` `.busy` `.how-qq` `.how-mixed` `.how-app` `.cards` `.unverified`；一件事在等的回复到了 `.awaited` |
| | 交给手的事结束了 | `dot.hands.result` `.result.his` `.result.answered` `.result.awaiting`；停在要她定 / 要他来的地方 `dot.hands.ask` `.ask.his` / `dot.hands.ask.him`；状态那一行 `dot.hands.status.*`、原因 `dot.hands.cause.*`；跟着的截图前那一句 `dot.hands.screen` `.screen.computer` |
| | 交接 | `memory.handoff` |
| | 自己的时间 | `interlude.free` `.budget` `.over` `.typing`；排着等时记下她在忙什么 `dot.busy.chat` |
| | 留在她对话里、不叫醒她的一句 | `dot.reach.unanswered`（那条他没回） |
| 她的工具和工具结果 | `hands` | `dot.hands-tool`；结果 `dot.hands.started` `.added` `.stopped` `.idle` `.add.idle` `.which` `.busy` `.busy.again` `.busy.other`；本机只替他做 `dot.hands.host.his`；不在她对话里调用时 `dot.hands.instead` |
| | `say` | `dot.say-tool`；`dot.say.silent`；要说给他的话被「先读再说」拦下 `dot.owner-interrupt`；`qq_send` 发到一半他说了话 `qq.send-interrupted`（`qq_send` 不在她精简过的对话里） |
| | `his_ok` 和被拦下时 | `dot.gates.ok-tool` `.ok` `.ok.refused`；被拦下时的工具结果 `dot.gates.forbid` `.him` `.ask` `.asked.her` `.refuse` `.shell` |
| | `later`（自己的时间里留「下次」） | `interlude.later-tool` `.later.ok` `.later.used` `.later.night` `.later.not-own` |
| | 不是她的工具 / 绕圈 | `dot.lean.not-hers` / `dot.loop-stopped` |
| 她的手（一件事一个会话） | 系统提示词、交给它的事 | `dot.hands.system`；手机的操作说明 `phone.device` `phone.device.number` `phone.stickers`（没有手的时候任何会话都拿这份，带 `phone.device.wake` / `.no-wake`）；事情前面那句「在哪做」`dot.hands.where.phone` `.where.computer` `.where.web` `.where.host`；接着上一件 `dot.hands.after`；要打的原话 `dot.hands.words` |
| | 手自己的工具 | `dot.hands.ask-tool`（问她）`dot.hands.done-tool`（收尾）`dot.hands.wait-tool`（等），以及它们的结果 `dot.hands.asked` `.done` `.done-missing` `.done.unsaid` `.done.unsaid-awaiting` `.wait.met` `.wait.timeout` `.wait.waited` |
| | 代码看到的事，跟在那一步的结果后面 | 同一个错 `dot.hands.same-error`、同一个屏幕 `.same-screen`、打了她没给的字 `.own-words`、她给的话被检查表退回 `.reply-check`；手艺簿 `dot.howto.given` |
| | 停下要他点头时记的那句 | `dot.gates.him.q` `.ask.q` `.spend.q` |
| 说话（「说」那次单独的调用） | 照对话说 | `dot.say.dialogue` `.dialogue.unprompted` `.end` `.end.unprompted` `.end.where` `.lead` `.lead.pick` `.about` `.fact` `.fact.running` `.fact.none` `.instead` `.faces` `.stickers` `.stickers.none` |
| | 照事情簿说 | `dot.say.report` `.report.his` `.report.may` `.report.about` `.report.unprompted`；事情簿写成的平白句子 `dot.plain.*`（刚交出去那件事的说法 `dot.plain.opened.sayings`，一行一个） |
| | 退回的理由 | `dot.reply-check` `.phrases` `.stage`（要说出去的话里有 `persona.checks.txt` 列的说法或括号动作） |
| 插件以自己的名义发给他 | 这一轮出错 / 他的话没接到 | `dot.turn-failed` / `dot.turn-lost` |
| | 模型额度用完 / 登录或 key 用不了 | `dot.account.quota` / `dot.account.auth`；提供方给了恢复时间时附 `dot.account.until` |
| | 插件文件在运行中被换 | `dot.drift` |
| 独立模型调用 | 整理记忆（还没了的事、人物） | `memory.extract`（规则，放在最前面）`memory.extract.input`（认识的人在还没了的事前面：前者少变，后者几乎每次都变）`memory.extract.things`（事情簿那一段的标题和状态的说法） |
| | 事实条 | `memory.facts.write` `memory.facts.pick` |
| | 每天一次：日记和关于他 / 她自己 | `memory.daily`（固定的说明在前，日子和记录在最后）`memory.daily.bank`（每栏的标题；`owner.full` / `self.full` 是这一栏满了（剩下不到 60 字）时的标题；`off` 是和别的记忆插件共存时那一行） |
| | 手艺簿：整理经验、翻旧笔记、夜里核对 | `dot.howto.reflect` `dot.howto.review` `dot.howto.nightcheck` |
| | 群消息打分 | `qq.score.system` `qq.score.who` `qq.score.user` |

**还在代码里的**：
- 工具说明（`memory` `recall` `qq_send` `qq_sticker_keep` `account`）和命令说明：跟参数定义写在一起，启动时注册一次，改了也要重启才生效。
- 人设 Canon：内容来自幕间的预设（`<home>/interlude/canon.json`，`/interlude preset` 导入），代码只加 `## 角色设定` 这类小标题。
- 数据的格式和空值占位：通知里的 App 名表、`（无内容）`、`（空）`、`（还没有）`、`（无）`，人物卡、召回结果、工具返回的话。

测试（`test/prompts.test.js`）检查：每个文件都被代码用到、代码里的每个代号都有文件、页面列全了所有文件、覆盖优先、几段代表性的提示词逐字等于预期。

## 人设（Canon）

`~/dot/interlude/canon.json` 不是提示词文件，但页面上「系统提示词」组第一项就是它：名字、角色设定、关系、回复规则、黑名单、对话范例各一个框，保存直接写回 canon.json（每天第一次保存前自动备份成 `canon.json.bak-YYYYMMDD`），她下一轮就用新的。
