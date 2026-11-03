# 提示词：`src/prompts/` 和 `npm run prompts`

插件交给模型的每一段话都是 `src/prompts/` 里的一个 UTF-8 纯文本文件，文件名就是它的代号（`dot.rules.txt` → `dot.rules`）。代码只负责拼：按情况选文件、把 `{名字}` 换成实际内容。

**覆盖**：把文件复制到 `<home>/prompts/`（`<home>` 是她的家目录，默认 `~/dot`，即 `dot.home`）再改，同名文件优先于内置的。按修改时间重新读，改完她下一轮就用新的，不用重启 dsh；删掉覆盖文件就回到内置版本。升级插件不会动你的覆盖，但内置文本变了你也收不到，留意更新说明。

**写法**：
- `{名字}` 是占位符，代码填；没填到的原样留着，并在日志里提醒一次。别删，删了那部分内容就不出现了。
- 某一行只有一个 `{名字}` 且它是空的（比如没开电脑时的 `{computerRule}`），这一行整行省掉。
- 带条件的片段是单独的文件（`qq.channel.owner.txt` 只在设了主人时拼进 `{owner}`；`phone.device.number.txt` 只在设了手机号时拼进 `phone.device` 的 `{number}` 那一行，里面的 `{number}` 是号码本身）。
- 几个文件是表格，一行一项 `代号=文字`（`dot.errand-note.what`、`interlude.play.verbs`、`interlude.play.parts`、`interlude.observation.where`、`memory.standing`、`memory.handoff`）：只改等号右边。
- `dot.rules.computer` / `dot.rules.phone` 各两行：第一行接在开头那段里，第二行是一条规则。

**页面**：仓库根目录跑 `npm run prompts`，打开 http://127.0.0.1:7870/（`PORT=xxxx` 换端口）。左边按她看到的顺序列出全部文件，标着「内置」或「已改过」；右边是整个文件，「保存」写到 `<home>/prompts/`，「恢复内置」删掉覆盖文件，「预览」用样例数据跑真实代码（没保存的改动也能预览），「全貌」拼出她对话里插件加的整段系统提示词。`npm run prompts -- --src` 时「保存」直接写进 `src/prompts/`，改的是内置版本。

| 分组 | 是什么 | 文件 |
|---|---|---|
| 系统提示词 | 工作方式 | `dot.rules` `dot.rules.computer` `dot.rules.phone` |
| | 手机 | `phone.device` `phone.device.number` |
| | 电脑上的 QQ | `qq.channel` `qq.channel.owner` `qq.channel.score` `qq.stickers` `qq.channel.no-stickers` `qq.faces` |
| | 定时任务那一轮 | `dot.scheduled` |
| | 记忆 / 想起的原话 | `memory.standing` / `memory.recall.header` |
| 叫醒她的消息 | 手机通知 | `dot.notification` `.many` `.busy` `.how-qq` `.how-mixed` `.how-app` `.cards` `.unverified` |
| | 拿起手机 / 跑腿回来 | `dot.phone-check` / `dot.errand-note` `dot.errand-note.what` |
| | 交接 | `memory.handoff` |
| | 幕间：去看一眼 | `interlude.observation` `.where` `.vm` `.phone` |
| | 幕间：玩一会儿 | `interlude.play` `interlude.play.collect` `.verbs` `.parts` `interlude.play-rules` |
| 独立模型调用 | 整理记忆 | `memory.extract`（规则）`memory.extract.input` `.banks` `.banks.off` `.earlier` `.handoff-yes/no` `.diary-yes/no` |
| | 幕间一轮 | `interlude.round.*`（`real-ledger` `her-life` `contact-mark` `contact-off` `play` `format` `script` `intents` … `refresh`） |
| | 群消息打分 | `qq.score.system` `qq.score.who` `qq.score.user` |

**还在代码里的**：
- HDS-Interlude 的原文（`src/interlude/core.js` 的 `HDSI.*`，以及它组装用的几行英文标题）：上游逐字照搬，不拆。
- 工具说明（`memory` `recall` `qq_send` `qq_sticker_keep` `account` `interval`）和命令说明：跟参数定义写在一起，启动时注册一次，改了也要重启才生效。
- 人设 Canon：内容来自幕间的预设（`<home>/interlude/canon.json`，`/interlude preset` 导入），代码只加 `## 角色设定` 这类小标题。
- 数据的格式和空值占位：通知里的 App 名表、`（无内容）`、`（空）`、`（还没有）`、`（无）`，人物卡、召回结果、工具返回的话。

测试（`test/prompts.test.js`）检查：每个文件都被代码用到、代码里的每个代号都有文件、页面列全了所有文件、覆盖优先、几段代表性的提示词逐字等于预期。
