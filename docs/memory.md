# dsh-dot/memory：她记得的

她的记忆分三种，各自借自一个已经被用过的设计：

| | 是什么 | 谁写 | 每轮都看得到吗 |
|---|---|---|---|
| **画像**（[Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)，经 dsh-hermes-memory） | `owner`：关于你（1375 字以内）；`self`：她自己的笔记——学会了什么、习惯、看法（2200 字以内）。满了要合并或删旧的 | 整理时由模型写；她自己用 `memory` 工具改 | 是 |
| **人物卡**（一张身份表，所有 App 共用） | 每个人一张卡，卡上有多个「把手」：`qq:919231551`（有号码时）、`qq:name:宽`（手机通知只显示名字时）、`xiaoheihe:name:暮看云`……不管从电脑 QQ、手机 QQ、小黑盒还是以后任何 App 来，都先在这张表里认人。「主人」是这张表里某个人身上的标记，不是单独的配置。档位：你 / 说过话 / 只在帖子里打过交道（只有次数和一句印象）/ 好友列表里但没说过话 | 互动次数、最后出现时间、名字、把手由**代码**按真实事件记；印象和事由模型写。关于别人的事先进**待核实** | 只在这个人叫醒她的那条消息后面附上 |
| **碎片**（[dsh-whale-inurqq](https://github.com/FABAGV/dsh-whale-inurqq)） | 发生过的具体的事，60 字以内，带 tag（0 知道就行 / 1 影响接下来怎么说话 / 2 不记住就会出错）。同一件事再被说起：被提到次数 +1、重要度 + tag；每 5 段老化一次；可以钉住 | 整理时由模型写 | 按重要度取，约 600 token |

## 不记的东西

密码和 API key / token / 密钥：哪一栏都不收（模型写了也会被丢掉），`recall` 的结果里也滤掉。手机号、验证码、账号这些照常记。另外有质量闸门：太短、讲系统和工具的话、空话不收。

## 认人与合并

同一个人第一次从两个地方出现，可能先有两张卡（比如手机通知里的「宽」和电脑 QQ 的 919231551）；认出是同一个人就合并（把手、名字、次数、事都并到一张上）：

- **QQ 好友列表**（确定）：电脑 QQ 在线时每 6 小时同步一次 `get_friend_list`。她给好友的备注就是手机通知里显示的名字，所以「宽」就此和号码连上；两张卡就此合并。两个好友备注相同的，名字不当把手（宁可不认）。
- **模型**（整理时）：记录里有证据说两张卡是同一个人，就写 `same`。不涉及你的直接合并；**涉及你的先进「待确认的合并」**，你 `/dot people approve m…` 才合（被认成你等于拿到最高信任）。
- **你**：`/dot people merge <a> <b>`。

认出是你的人，不管从哪条通道来，他的话都作为你本人的话交给她；从手机来、而电脑 QQ 不在线时，会提醒她去手机 QQ 里回。

## 素材：真实发生过的事

`~/dot/memory/transcript.jsonl` 只记她对话里真实发生的：你说的话、她真正用 `qq_send` 发出去的话（发给谁）、手机通知、跑腿留下的结论、定时任务。幕间写的虚构剧本不进这里，所以虚构的事不会变成「记忆」。`recall` 工具在这里、碎片和人物卡里找原话。

## 整理

一次模型调用，读上次整理之后的记录，输出画像的增删改、人物、碎片、待核实的确认。触发：新记录满 `consolidateEveryLines`（20）条；或安静 `consolidateIdleMinutes`（30）分钟且有 3 条以上；或交班；或 `/dot memory now`。

## 交班

她的对话会话（dsh-dot 记为「她的对话」的那个）每轮结束量一次 token。超过 `handoffTokens`（15 万）且这一段至少涨了 4 万：

1. 冻结投递（这期间来的消息排队）；
2. 整理一次，并让模型写交接：她此刻在做什么、手上没做完的、答应过的、还没问清的；
3. **先归档**旧会话（归档后的会话收到消息会静默丢弃，所以必须先归档、再切换）；
4. 在 `~/dot` 里开新会话「dot · 第 N 段」，交接文本加最后 12 句原话注入进去（不叫醒她）；
5. 解冻，排队的消息投进新会话。

dsh 自己的压缩要到窗口的 80%（DeepSeek 是约 84 万 token）才发生，而且摘要模板是给编程助手写的；交班让这件事不会发生在她身上。dsh-im 机器人开的会话不交班（绑定在 dsh-im 手里）。

## 文件和命令

- `~/dot/memory/memory.md`：给你看的版本；`memory.json`：数据；`handoffs.jsonl`：每次交班；`calls.jsonl`：每次整理的原始回复。
- `/dot memory`：状态（第几段、当前 token、距离下次整理还有几条）；`/dot memory now`：立刻整理；`/dot memory handoff`：立刻交班。
- `/dot people`：认识的人、待核实、待确认的合并；`approve <p…|m…>` / `drop <p…>`：处理待核实和合并；`merge <a> <b>`：手动合并两张卡；`forget <名字>`：删掉一个人。

## 配置（`dot-memory`）

`handoffTokens` 150000 · `minTokensBetweenHandoffs` 40000 · `consolidateEveryLines` 20 · `consolidateIdleMinutes` 30 · `fragmentBudgetTokens` 600 · `agingEveryGens` 5 · `maxFragments` 300 · `handoffTailLines` 12 · `maxTokens` 16384 · `limits: { owner: 1375, self: 2200, person: 400, impression: 40 }`
