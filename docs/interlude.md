# dsh-dot/interlude · 她是谁，和她自己的时间

> 组件名、服务名、设置段、文件夹和提示词 id 都还叫 `interlude`，这样已经装好的一份（`canon.json`、`dsh-dot.json`、提示词覆盖）不用改。

## 0.24 起它不再是「幕间」

这个组件原来替她写一段「对话之外的生活」：一个叙述者模型每隔一阵写剧本、状态、打算，再带回她的对话（想法来自 [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude)）。0.24 把叙述者拿掉了：叙述者写的手机、账号、他交代的事，和真正发生的分不开，带回对话就成了「事实」。一起拿掉的还有：网页观察、玩 / 试的意图、每周成长、主动联系的四道闸（`speak`、意愿值、每日上限）。

留下的是不需要叙述者的部分。她的生活就是她真做过的事。

## 现在做什么

1. **人设（Canon）**：`~/dot/interlude/canon.json`，字段沿用 HDSI 的 `storyDefaults`，所以社区分享的人设能直接用。`/interlude preset <分享码>` 从预设站导入，`/interlude canon` 查看。Canon 是她系统提示词的第一段；dsh 自己的开场白（「You are an AI agent…」等，`trimSections`）在她的会话里去掉。
2. **人设卡和检查表**（`src/persona/card.js`）：启动时由 Canon 生成 `~/dot/persona.md`（进提示词的卡）和 `~/dot/persona.checks.txt`（黑名单拆成的一行一条，代码检查用，不进提示词）。换了 `canon.json` 会重新生成（旧的留 `.bak-<时间>`）；你手改过的文件不会被覆盖。
3. **说话提醒**（`voice`，0.25 起默认关）：打开时，她对话每一轮的最后放一两句怎么说话。0.25 起她说出去的话由一次单独的调用照人设卡的「说」那部分写（`dot/say.js`），她的对话里写的字没有人读，所以默认不放。
4. **说出去的话先过检查**（`dot.replyCheck`）：括号里的动作描写去掉；命中检查表的句子，替她说话的那次调用重写一次，第二次照发；她的手要在 App 里打出去的话命中了，退回给她换个说法。对她所有说出去的话都一样：QQ、评论、手机里打的字。
5. **自己的时间**：他上一句话之后、或她的一天开始（`dot.awakeHours` 的起点）之后安静了 `idleMinutes`，她醒着、在平时的时段里、手上没别的事，来一次；用掉了，要等他再来找她或新的一天才有下一次——她自己做的事不推迟它，也不会让它再来。她可以在这段时间里用 `later` 留一个「下次」（至少 `idleMinutes` 分钟后；一段只留一个，再留就换掉；从「下次」来的那段不能再留；过了她睡的点不收；下一段不管因为什么来了都把它用掉；留下它的那一天结束就作废）。每天最多 `freeTimesPerDay` 次。时刻都挂在 dot 的同一个时钟上（30 秒一次），不另起定时器。在她的对话里开始，只说「这段时间是你自己的」，不给任务。她要用手机或电脑，和平时一样把一整件事交给手；这段时间持续到她在里面交出去的事都做完（别处替他做的事不拖住它）。结束时不用她写总结：做了什么以事情簿上她这段时间交出去的那几件为准，记进她的账。边界在代码里：token 预算到 80% 提醒、到 100% 停（她的手在她这件事上的每一步算在里面，停了以后手的下一步也被拒）；社交 App 里打字要先问你；花钱、装 App 照「要他的事」四档；她的手不去你这台电脑本机。这段时间里她不会自动对你说话，想找你由她自己用 `say` 说。
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
| `scope` | `home+im` | 只在没有 dot 组件时用：哪些会话算她的（`home` 工作目录在 home 里、`im` IM 机器人开的、`home+im`、`all`）。有 dot 时只认插件为她开的那一个对话（和她换下来的），在 home 里手动新建的会话不算她的 |
| `canon` | 无 | 一份 `storyDefaults`，在导入预设之前用 |
| `presetHub` | `https://typ0.space` | HDSI 预设站 |
| `trimSections` | `harness:identity, deployment:persona-prefix, context:file-reference` | 她的会话里从系统提示词去掉的段 |
| `canonOnly` | `false` | `true` 时只留 Canon、dot 的规则和 MCP 段 |
| `voice` | `false` | 每轮最后的说话提醒（见上第 3 条） |
| `identityFile` | 无 | 追加到 Canon 后面的文本文件 |
| `idleMinutes` | `30` | 他上一句话（或她的一天开始）之后安静这么久，来一次自己的时间；`later` 最短也是这么久 |
| `freeTimesPerDay` | `2` | 每天最多几次自己的时间（`/interlude free` 不算），`0` 关；需要 dot 组件 |
| `freeTokenCap` / `freeDailyTokens` | `100000` / `200000` | 每次 / 每天的折算 token 上限（见 [SETTINGS.md](SETTINGS.md)「花费怎么算」） |
| `price` | `null` | 你自己的价格 `{ in, cached, out }` 元 / 百万 token，代替内置价目表；她的账上也就有钱数 |
| `maxTokens`、`imBot` / `imTarget` | | 不再读取：这个组件现在不自己调模型，也不自己往 IM 发 |

## 文件

`~/dot/interlude/`：`canon.json`、`doings.json`、`meta.json`（当天用量、他上一句话的时刻、用过的那段安静 `ownFrom`、她留的「下次」`later`）。`~/dot/persona.md`、`~/dot/persona.checks.txt`、`~/dot/persona.source.json`（记着卡和检查表是从哪份 Canon 生成的）。`~/dot/her/` 是她自己的文件夹。

以前版本留下的 `script.md`、`state.json`、`intents.json`、`pending.jsonl`、`web-context.jsonl`、`calls.jsonl`、`growth/` 不再读，可以删（`calls.jsonl` 面板的「最近 N 场」还会读旧的几天）。

MIT（随 dsh-dot）。人设格式来自 HDS-Interlude；代码和提示词是这里自己写的。
