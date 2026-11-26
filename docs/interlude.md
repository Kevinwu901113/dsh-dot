# dsh-dot/interlude · 她是谁，和她自己的时间

> 组件名、服务名、设置段、文件夹和提示词 id 都还叫 `interlude`，这样已经装好的一份（`canon.json`、`dsh-dot.json`、提示词覆盖）不用改。

## 0.24 起它不再是「幕间」

这个组件原来替她写一段「对话之外的生活」：一个叙述者模型每隔一阵写剧本、状态、打算，再带回她的对话（想法来自 [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude)）。0.24 把叙述者拿掉了：叙述者写的手机、账号、他交代的事，和真正发生的分不开，带回对话就成了「事实」。一起拿掉的还有：网页观察、玩 / 试的意图、每周成长、主动联系的四道闸（`speak`、意愿值、每日上限）。

留下的是不需要叙述者的部分。她的生活就是她真做过的事。

## 现在做什么

1. **人设（Canon）**：`~/dot/interlude/canon.json`，字段沿用 HDSI 的 `storyDefaults`，所以社区分享的人设能直接用。`/interlude preset <分享码>` 从预设站导入，`/interlude canon` 查看。Canon 是她系统提示词的第一段；dsh 自己的开场白（「You are an AI agent…」等，`trimSections`）在她的会话里去掉。
2. **人设卡和检查表**（`src/persona/card.js`）：启动时由 Canon 生成 `~/dot/persona.md`（进提示词的卡）和 `~/dot/persona.checks.txt`（黑名单拆成的一行一条，代码检查用，不进提示词）。换了 `canon.json` 会重新生成（旧的留 `.bak-<时间>`）；你手改过的文件不会被覆盖。
3. **说话提醒**（`voice`）：她对话每一轮的最后放一两句怎么说话，模型回话前最后读到的就是它。
4. **说出去的话先过检查**（`dot.replyCheck`）：括号里的动作描写去掉；命中检查表的句子每轮打回一次让她重说。对她所有说出去的话都一样：QQ、评论、手机里打的字。
5. **自己的时间**：他上一句话之后、或她的一天开始（`dot.awakeHours` 的起点）之后安静了 `idleMinutes`，来一次；用掉了，要等他再来找她或新的一天才有下一次——她自己做的事不推迟它，也不会让它再来。她可以在这段时间里用 `later` 留一个「下次」（几分钟后；一段只留一个，从「下次」来的那段不能再留，过了她睡的点作废）。每天最多 `freeTimesPerDay` 次。在她的对话里开始，只说「这段时间是你自己的」，不给任务。她要用手机或电脑，和平时一样把一步交给手。边界在代码里：token 预算到 80% 提醒、到 100% 停（她的手替她做的事的花费算在里面）；社交 App 里打字要你批准；花钱、装 App 照旧走审批。这段时间里她说的话不自动发给你，想找你由她自己发。
6. **她的账**（`doings.json`）：自己时间里做了什么、花了多少 token（设了 `price` 还折成钱）、你怎么说。`/interlude doings` 看最近的，`/interlude feedback [#id] 一句话` 记下你的反应。

什么时候主动找你没有开关也没有上限，见 [DESIGN.md](DESIGN.md) 的「什么时候找他：给事实，不设上限」。

## 命令

```
/interlude [preset <code> | canon | doings | feedback [#id] <一句话> | free]
```

`/interlude free` 立刻给她一次自己的时间。

## 配置（`~/.dsh/dsh-dot.json` 的 `interlude` 段）

| 键 | 默认 | 作用 |
|---|---|---|
| `DSH_DOT_INTERLUDE=off` | | 整个组件不加载 |
| `home` | `~/dot` | 文件在 `<home>/interlude/` |
| `scope` | `home+im` | 哪些会话算她的：`home`（工作目录在 home 里）、`im`（IM 机器人开的）、`home+im`、`all` |
| `canon` | 无 | 一份 `storyDefaults`，在导入预设之前用 |
| `presetHub` | `https://typ0.space` | HDSI 预设站 |
| `trimSections` | `harness:identity, deployment:persona-prefix, context:file-reference` | 她的会话里从系统提示词去掉的段 |
| `canonOnly` | `false` | `true` 时只留 Canon、dot 的规则和 MCP 段 |
| `voice` | `true` | 每轮最后的说话提醒 |
| `identityFile` | 无 | 追加到 Canon 后面的文本文件 |
| `idleMinutes` | `30` | 他上一句话（或她的一天开始）之后安静这么久，来一次自己的时间；`later` 最短也是这么久 |
| `freeTimesPerDay` | `2` | 每天最多几次自己的时间（`/interlude free` 不算），`0` 关；需要 dot 组件 |
| `freeTokenCap` / `freeDailyTokens` | `150000` / `300000` | 每次 / 每天的 token 上限 |
| `price` | `null` | `{ in, cached, out }` 元 / 百万 token |
| `maxTokens` | `16384` | 这个组件自己的模型调用的输出上限 |
| `imBot` / `imTarget` | 自动 | dsh-im 的机器人和投递目标 |

## 文件

`~/dot/interlude/`：`canon.json`、`doings.json`、`meta.json`（当天用量、自己时间的时刻）。`~/dot/persona.md`、`~/dot/persona.checks.txt`、`~/dot/persona.source.json`（记着卡和检查表是从哪份 Canon 生成的）。`~/dot/her/` 是她自己的文件夹。

以前版本留下的 `script.md`、`state.json`、`intents.json`、`growth/` 不再读，可以删。

MIT（随 dsh-dot）。人设格式来自 HDS-Interlude；代码和提示词是这里自己写的。
