# 提示词：`src/prompts/` 和 `npm run prompts`

插件交给模型的每一段话都是 `src/prompts/` 里的一个 UTF-8 纯文本文件，文件名就是它的代号（`dot.rules.txt` → `dot.rules`）。代码只负责拼：按情况选文件、把 `{名字}` 换成实际内容。

**覆盖**：把文件复制到 `<home>/prompts/`（`<home>` 是她的家目录，默认 `~/dot`，即 `dot.home`）再改，同名文件优先于内置的。按修改时间重新读，改完她下一轮就用新的，不用重启 dsh；删掉覆盖文件就回到内置版本。升级插件不会动你的覆盖，但内置文本变了你也收不到，留意更新说明。

**写法**：
- `{名字}` 是占位符，代码填；没填到的原样留着，并在日志里提醒一次。别删，删了那部分内容就不出现了。
- 某一行只有一个 `{名字}` 且它是空的（比如没开电脑时的 `{computerRule}`），这一行整行省掉。
- 带条件的片段是单独的文件（`qq.channel.owner.txt` 只在设了主人时拼进 `{owner}`；`phone.device.number.txt` 只在设了手机号时拼进 `phone.device` 的 `{number}` 那一行，里面的 `{number}` 是号码本身；`phone.stickers.txt` 是 `phone.device` 的 `{stickers}`，各 App 怎么加表情包，整段手机提示词只在手机开着时出现）。
- 几个文件是表格，一行一项 `代号=文字`（`dot.now`、`dot.errand-note.what`、`interlude.play.verbs`、`interlude.play.parts`、`interlude.observation.where`、`memory.standing`、`memory.handoff`）：只改等号右边。
- **时间戳**：叫醒她的每条消息开头都有同一种时间戳 `{stamp}`：`MM-DD HH:MM`，不是今年的写 `YYYY-MM-DD HH:MM`（和记忆里的日期一个规则）。他的 QQ 消息是 `[{stamp}] 原话`（一批盖一个，多条一行一条）；其他的放在方括号里：`[{stamp} 手机通知]`、`[{stamp} 拿起手机]`、`[{stamp} {what}]`（跑腿回来）、`[{stamp} 幕间观察]`、`[{stamp} 想玩会儿手机]`。改这些文件时保留 `{stamp}` 和方括号的样子，记忆记录时按这个样子把时间戳去掉。
- `dot.now` 是她对话里「现在」那一行：`line` 是整行，`since` 是「距上一条消息」那一段（不到一分钟、或还没说过话时整段省掉）。
- `dot.rules.computer` / `dot.rules.phone` 各两行：第一行接在开头那段里，第二行是一条规则。
- `interlude.round` 是幕间一轮的整段系统提示词，从上到下就是模型看到的顺序（HDS-Interlude 1.0.1-rc57 的提示词，AGPL-3.0 © MOMOR1A/MomoiCore，译成中文后合并）。覆盖它就替换整段；`{phase}` `{length}` 这类占位符各对应一个 `interlude.round.<名字>` 小文件，空的那行省掉。

**页面**：仓库根目录跑 `npm run prompts`，打开 http://127.0.0.1:7870/（`PORT=xxxx` 换端口）。左边按她看到的顺序列出全部文件，标着「内置」或「已改过」；右边是整个文件，「保存」写到 `<home>/prompts/`，「恢复内置」删掉覆盖文件，「预览」用样例数据跑真实代码（没保存的改动也能预览），「全貌」拼出她对话里插件加的整段系统提示词。`npm run prompts -- --src` 时「保存」直接写进 `src/prompts/`，改的是内置版本。

| 分组 | 是什么 | 文件 |
|---|---|---|
| 系统提示词 | 工作方式 | `dot.rules` `dot.rules.computer` `dot.rules.phone` |
| | 手机 | `phone.device` `phone.device.number` `phone.stickers` |
| | 电脑上的 QQ | `qq.channel` `qq.channel.owner` `qq.channel.score` `qq.stickers` `qq.channel.no-stickers` `qq.faces` |
| | 现在几点（每一轮，在对话历史之后） | `dot.now` |
| | 定时任务那一轮 | `dot.scheduled` |
| | 记忆 / 想起的原话 | `memory.standing` / `memory.recall.header` |
| 叫醒她的消息 | 他的 QQ 消息 | `dot.owner-words` |
| | 手机通知 | `dot.notification` `.many` `.busy` `.how-qq` `.how-mixed` `.how-app` `.cards` `.unverified` |
| | 拿起手机 / 跑腿回来 | `dot.phone-check` / `dot.errand-note` `dot.errand-note.what` |
| | 交接 | `memory.handoff` |
| | 幕间：去看一眼 | `interlude.observation` `.where` `.vm` `.phone` |
| | 幕间：玩一会儿 | `interlude.play` `interlude.play.collect` `.verbs` `.parts` `interlude.play-rules` |
| 独立模型调用 | 整理记忆 | `memory.extract`（规则）`memory.extract.input` `.banks` `.banks.off` `.earlier` `.handoff-yes/no` `.diary-yes/no` |
| | 幕间一轮 | `interlude.round`（整段系统提示词，HDS-Interlude 的规则译成中文后合并）；按情况填进去的：`.canon` `.length` `.length.deepseek` `.length.claude` `.length.gemini-flash` `.length.gpt` `.phase.advance` `.phase.follow-up` `.phase.intent` `.her-life` `.contact-rule` `.contact-rule.off` `.browsing.deferred` `.browsing.disabled` `.agency` `.play` `.play.collect` `.glm` `.style.none` `.seed` `.play-intents` `.play-intents.off` `.contact` `.contact.off`；补全那一次：`.refresh` |
| | 群消息打分 | `qq.score.system` `qq.score.who` `qq.score.user` |

**还在代码里的**：
- 工具说明（`memory` `recall` `qq_send` `qq_sticker_keep` `account` `interval`）和命令说明：跟参数定义写在一起，启动时注册一次，改了也要重启才生效。
- 人设 Canon：内容来自幕间的预设（`<home>/interlude/canon.json`，`/interlude preset` 导入），代码只加 `## 角色设定` 这类小标题。
- 数据的格式和空值占位：通知里的 App 名表、`（无内容）`、`（空）`、`（还没有）`、`（无）`，人物卡、召回结果、工具返回的话。

测试（`test/prompts.test.js`）检查：每个文件都被代码用到、代码里的每个代号都有文件、页面列全了所有文件、覆盖优先、几段代表性的提示词逐字等于预期。

## 人设（Canon）

`~/dot/interlude/canon.json` 不是提示词文件，但页面上「系统提示词」组第一项就是它：名字、角色设定、关系、回复规则、黑名单、对话范例各一个框，保存直接写回 canon.json（每天第一次保存前自动备份成 `canon.json.bak-YYYYMMDD`），她下一轮就用新的。
