# 提示词一览：`npm run prompts`

插件放到模型面前的每一段话都写在源码里。开发时在仓库根目录跑：

```sh
npm run prompts          # http://127.0.0.1:7870/ ，PORT=xxxx 换端口
```

本机页面，左边是清单，右边是**模型看到的样子**（用样例输入跑真实代码）和源码。纯文字的字符串、模板里 `${…}` 之间的文字可以原地改、点「保存」：只替换那一段原文（在文件里必须恰好出现一次），保存后 `node --check`，不过就还原。拼接逻辑用「在编辑器里打开」（`code -g`）。「全貌」按顺序拼出她对话的系统提示词。

| | 项 | 位置 |
|---|---|---|
| A 系统提示词 | `interlude:canon` 人设 | `src/interlude/core.js` 段落 + `renderCanon` |
| | `dot:rules` 工作方式 | `src/dot/core.js` `workingRules` |
| | `phone:device` 手机 | `src/phone/phone.js` 段落 |
| | `qq:channel` QQ | `src/qq/qq.js` 段落 + `stickers.prompt()` |
| | `dot:memory` 记忆 | `src/memory/memory.js` → `store.js renderStanding` |
| | `dot:recall` 召回 | `src/memory/recall.js` 开头那句 |
| | `interlude` 连续性 | `src/interlude/core.js renderContext` |
| | `dot:scheduled-turn` | `src/dot/core.js SCHEDULED_RULE` |
| B 注入的消息 | 手机通知、拿起手机、跑腿回写、交班、幕间观察、玩 | `notificationText` `PHONE_CHECK_TEXT` `errandNote` `renderHandoff` `observationPrompt` `playPrompt`/`PLAY_RULES` |
| C 独立模型调用 | 记忆整理、幕间一轮、群消息打分 | `EXTRACT_RULES`（+ `consolidateOnce` 的拼接）、`buildPrompt`/`DOT`、`scorePrompt` |
| D 工具说明（只读） | `memory` `recall` `qq_send` `qq_sticker_keep` `interval`，`/dot` `/qq` `/phone` `/interlude` | 各自 `description` |

`HDSI.*` 是 HDS-Interlude 的原文，页面上只读。

清单（文件、行号、那一行的标识）在 `scripts/prompts.mjs` 的 `inventory` 里；`test/prompts.test.js` 检查每个行号上还是那个标识、每一项都能渲染。代码挪了位置测试就会失败——顺手把行号改了。
