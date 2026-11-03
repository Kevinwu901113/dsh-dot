# dsh-dot/memory：她记得的

她的记忆分三种，各自借自一个已经被用过的设计：

| | 是什么 | 谁写 | 每轮都看得到吗 |
|---|---|---|---|
| **画像**（[Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)，经 dsh-hermes-memory） | `owner`：关于你（1375 字以内）；`self`：她自己的笔记——学会了什么、习惯、看法（2200 字以内）。满了要合并或删旧的 | 整理时由模型写；她自己用 `memory` 工具改 | 是 |
| **人物卡**（一张身份表，所有 App 共用） | 每个人一张卡，卡上有多个「把手」：`qq:919231551`（有号码时）、`qq:name:宽`（手机通知只显示名字时）、`xiaoheihe:name:暮看云`……不管从电脑 QQ、手机 QQ、小黑盒还是以后任何 App 来，都先在这张表里认人。「主人」是这张表里某个人身上的标记，不是单独的配置。档位：你 / 说过话 / 只在帖子里打过交道（只有次数和一句印象）/ 好友列表里但没说过话 | 互动次数、最后出现时间、名字、把手由**代码**按真实事件记；印象和事由模型写。关于别人的事先进**待核实** | 只在这个人叫醒她的那条消息后面附上 |
| **碎片**（[dsh-whale-inurqq](https://github.com/FABAGV/dsh-whale-inurqq)） | 发生过的具体的事，60 字以内，带 tag（0 知道就行 / 1 影响接下来怎么说话 / 2 不记住就会出错）。同一件事再被说起：被提到次数 +1、重要度 + tag；每 5 段老化一次；可以钉住 | 整理时由模型写 | 按重要度取，约 600 token |

## 不记的东西

密码和 API key / 密钥 / 令牌：哪一栏都不收（模型写了也会被丢掉），`recall` 的结果里也滤掉。手机号、验证码、账号这些照常记；提到「token 消耗」「上下文」「提示词」的普通句子也照常记（你的工作就是做 agent，这些词不算秘密、也不算系统话）。另外有质量闸门：太短、讲她自己的工具调用和交接的话、空话不收。

## 认人与合并

同一个人第一次从两个地方出现，可能先有两张卡（比如手机通知里的「宽」和电脑 QQ 的 919231551）；认出是同一个人就合并（把手、名字、次数、事都并到一张上）：

- **QQ 好友列表**（确定）：电脑 QQ 在线时每 6 小时同步一次 `get_friend_list`。她给好友的备注就是手机通知里显示的名字，所以「宽」就此和号码连上；两张卡就此合并。两个好友备注相同的，名字不当把手（宁可不认）。
- **模型**（整理时）：记录里有证据说两张卡是同一个人，就写 `same`。不涉及你的直接合并；**涉及你的先进「待确认的合并」**，你 `/dot people approve m…` 才合（被认成你等于拿到最高信任）。
- **你**：`/dot people merge <a> <b>`。

认出是你的人，不管从哪条通道来，他的话都作为你本人的话交给她；从手机来、而电脑 QQ 不在线时，会提醒她去手机 QQ 里回。

## 素材：真实发生过的事

`~/dot/memory/transcript.jsonl` 只记她对话里真实发生的：你说的话、她真正用 `qq_send` 发出去的话（发给谁）、手机通知、跑腿留下的结论、定时任务。幕间写的虚构剧本不进这里，所以虚构的事不会变成「记忆」。`recall` 工具在这里、碎片和人物卡里找原话。

## 整理

每天 `dailyAt`（23:30）固定一次：把这一天新的记录整理掉，并让她写日记。

一次模型调用，读上次整理之后的记录（一次最多 `inputChars` 40000 字；积压更多就从最旧的开始分几次读，游标只走到真正读过的位置，不会跳过），输出画像的增删改、人物、碎片、待核实的确认。触发：新记录满 `consolidateEveryLines`（20）条；或安静 `consolidateIdleMinutes`（30）分钟且有 3 条以上；或交班；或 `/dot memory now`。

## 日记

`~/dot/memory/diary.md`：每天 `dailyAt` 一篇，她自己的口吻、第一人称、40–120 字，素材只许是真实记录（transcript）和她自己记下的东西，不引幕间的虚构。`/dot memory diary` 立刻写一篇。这是给你看的：她这一天过了什么、学了什么。

## 她的生活进幕间

幕间（dsh-dot/interlude）每轮拿到两样：`memories`（关于你的事 + 最要紧的碎片，作为已确立的过去）和 `herLife`（self 栏原文：她现在真实在做的事、会的事、习惯）。幕间的契约要求她这一段的生活围着 `herLife` 展开，虚构只填空隙。self 栏因此也是她"玩多少、什么时候玩"的来源——整理时模型会把她在手机上做什么、多常做写进去。

## 交班

她的对话会话（dsh-dot 记为「她的对话」的那个）每轮结束量一次 token。超过 `handoffTokens`（15 万）且这一段至少涨了 4 万：

1. 冻结投递（这期间来的消息排队）；
2. 整理一次，并让模型写交接：她此刻在做什么、手上没做完的、答应过的、还没问清的；
3. **先归档**旧会话（归档后的会话收到消息会静默丢弃，所以必须先归档、再切换）；
4. 在 `~/dot` 里开新会话「dot · 第 N 段」，交接文本加最后 12 句原话注入进去（不叫醒她）；
5. 解冻，排队的消息投进新会话。

dsh 自己的压缩要到窗口的 80%（DeepSeek 是约 84 万 token）才发生，而且摘要模板是给编程助手写的；交班让这件事不会发生在她身上。dsh-im 机器人开的会话不交班（绑定在 dsh-im 手里）。

## 自动召回（0.12 起）

画像和碎片是"整理过的"记忆；问到"三周前他到底怎么说的"，整理时没写下来的细节就没了。自动召回补这一块：她每次被叫醒（你的消息、QQ 消息、手机通知、定时任务）之前，用叫醒她的那句话去她自己的 `transcript.jsonl` 里找最像的旧对话，按时间顺序作为「你记得的相关原话」放在她面前，每条带日期。画像 / 碎片 / 日记 / 交班照旧，`recall` 工具也还在（她自己按关键词翻）。

- **一轮一块**：叫醒她的话 + 她回的话 + 日期。每轮结束增量建索引，向量存 `~/dot/memory/recall/<后端>-<模型>/`（`vectors.f32` + `meta.jsonl`，不用向量库）。每个后端 + 模型各存一份，来回切换不互相覆盖、不重算。
- **不重复**：她当前会话里的轮次本来就在上下文里，不再取（`recallWindowTurns`）；取 top 8（`recallTopK`），最多 1500 token（`recallMaxTokens`，超了先丢最不像的）。
- **只给她的对话**：作为动态 context 注入（dsh 放在历史之后，不破坏前缀缓存）；跑腿会话看不到。
- **密码 / key 不进**：和碎片同一个过滤，含密码、API key 的那行不入索引、不发给云端、不注入；问话本身像密钥时不查。
- **后端**：

| 后端 | 模型 | 要什么 | 说明 |
|---|---|---|---|
| `local`（默认） | `BAAI/bge-small-zh-v1.5`（ONNX q8，即 `Xenova/bge-small-zh-v1.5`），不重排 | 不要 key | transformers.js 在 CPU 上跑；模型 23 MB，常驻约 0.15 GB 内存，一次查询毫秒级。推理库 `@huggingface/transformers` 有 300–480 MB，不打进插件包：第一次用时装到 `$DSH_HOME/dsh-dot-recall/`（像 QQ / 手机按需 `npx` 拉 MCP 一样），模型从 `https://hf-mirror.com` 下（`recallMirror`，也认 `HF_ENDPOINT`），缓存也在那里。装好、下好之前按关键词找，状态里写着 |
| `siliconflow` | `BAAI/bge-m3` + `BAAI/bge-reranker-v2-m3` 重排 | key（免费档够用） | `SILICONFLOW_API_KEY` 或 `/dot memory recall key siliconflow <key>` |
| `dashscope` | `qwen3.7-text-embedding` + `qwen3.7-text-rerank` 重排 | key | `DASHSCOPE_API_KEY` 或 `/dot memory recall key dashscope <key>`；工作空间域名填 `recallDashscopeUrl` |
| `off` | — | — | 不自动召回 |

- **命令**（不用改文件、不用重启；写进 `$DSH_HOME/dsh-memory.json`，权限 0600，优先于插件配置）：
  - `/dot memory recall`：后端、模型、是否就绪、索引了几轮、上次查询耗时和条数、镜像、key 来源（打码）
  - `/dot memory recall backend <local|siliconflow|dashscope|off>`
  - `/dot memory recall key <siliconflow|dashscope> <key>`（`-` 删掉）
  - `/dot memory recall model <名字|default>`、`/dot memory recall rerank <名字|none|default>`（云端）
  - `/dot memory recall mirror <url|default>`
  - `/dot memory recall rebuild`：清掉当前后端的索引重建
  - `/dot memory recall test <一句话>`：看这句话会翻出什么（带分数）
- 右侧 dot 面板「记忆」卡片里有一行「自动召回」。

**数据**（[Ornn8/memory-system-benchmark](https://github.com/Ornn8/memory-system-benchmark) 公开示例 PUB01，108 题；答题和判分都是 deepseek-flash、关思考，判分是适配器自己的 LLM 判卷，不是基准作者的打分；适配器在 dsh-dot 仓库外）：

| 配置 | 通过 |
|---|---|
| 0.11 现状（画像 + 碎片 + 交班 + `recall` 工具） | 74 / 108 |
| 纯检索：本机 bge-small-zh，不重排 | 85 / 108 |
| 纯检索：云端 bge-m3 + bge-reranker-v2-m3（SiliconFlow） | 90 / 108 |
| 纯检索：云端 qwen3.7 embedding + rerank（DashScope） | 89 / 108 |
| **0.12：现状 + 自动召回（本机 bge-small-zh，真实代码路径）** | **93 / 108** |

现状赢在"约定、改口、生日"这类题（整理过的事实），检索赢在原话细节；所以是加一层，不是换掉。

## 文件和命令

- `~/dot/memory/memory.md`：给你看的版本；`diary.md`：她的日记；`memory.json`：数据；`handoffs.jsonl`：每次交班；`calls.jsonl`：每次整理的原始回复和 token 用量。
- `/dot memory`：状态（第几段、当前 token、今天整理花了多少 token、距离下次整理还有几条、上次日记）；`/dot memory now`：立刻整理；`/dot memory diary`：立刻整理并写日记；`/dot memory handoff`：立刻交班。
- `/dot memory recall …`：自动召回，见上一节。
- `/dot people`：认识的人、待核实、待确认的合并；`approve <p…|m…>` / `drop <p…>`：处理待核实和合并；`merge <a> <b>`：手动合并两张卡；`forget <名字>`：删掉一个人。

## 配置（`dot-memory`）

`handoffTokens` 150000 · `minTokensBetweenHandoffs` 40000 · `consolidateEveryLines` 20 · `consolidateIdleMinutes` 30 · `dailyAt` 23:30 · `fragmentBudgetTokens` 600 · `agingEveryGens` 5 · `maxFragments` 300 · `handoffTailLines` 12 · `maxTokens` 16384 · `limits: { owner: 1375, self: 2200, person: 400, impression: 40 }` · `coexist` auto · `otherMemoryServices` [hermesMemory, autoMemory, dshMemory, memoryBank]

自动召回：`recallBackend` local · `recallModel` ''（后端默认）· `recallRerankModel` ''（云端默认；`none` 不重排）· `recallMirror` ''（`HF_ENDPOINT`，否则 hf-mirror.com）· `recallInstall` true · `recallTransformersVersion` 4.3.2 · `recallTopK` 8 · `recallMaxTokens` 1500 · `recallMinScore` 0 · `recallCandidates` 40 · `recallWindowTurns` 0（整个当前会话不取）· `recallChunkChars` 1200 · `recallWaitMs` 3000 · `recallSiliconflowUrl` · `recallDashscopeUrl`。命令改的值存在 `$DSH_HOME/dsh-memory.json`，优先于这里。

`DSH_DOT_MEMORY=off` 整个组件不加载。

**和别的记忆插件共存**（`coexist`，环境变量 `DSH_DOT_MEMORY_COEXIST`）：`auto` 时，`otherMemoryServices` 里任何一个服务存在（每次用到时用 `ctx.get` 查，所以晚启动的插件也算；cordis 没有公开的服务枚举，只能按名单）就打一行 info 日志，进入 `people-only`：人物卡、碎片、日记、交班照旧，画像的 `owner` / `self` 两栏不再进系统提示，整理时模型给的这两栏改动也丢掉，交给那个插件。`full` 强制全开；`people-only` 强制只留人物。
