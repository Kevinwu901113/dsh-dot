# dsh-interlude 设计记录

## v0.2（2026-10-22）：按 HDS-Interlude 重做

Kevin 指明"幕间系统"指的是 [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude)（HDSI）。v0.1 是在他不在时按字面理解写的"日记 + 状态"，v0.2 按 HDSI 的框架重做，机制的对照见 README「和 HDSI 的对照」一节。决定：

- **只做对话之外的部分**。HDSI 是完整的对话系统（含幕前的已读、延迟、分段回复）；dsh 已有对话、IM、定时、预算，所以只移植幕间：三种轮次、故事光标、Canon / 剧本 / 快照 / Overlay / intents 五层、简化的 Agency。
- **不移植 Alter（情绪漂移）**：HDSI 用数值模型让情绪在幕间漂移。这里情绪是模型在幕间写的一句话，和 v0.1 一样。原因是不想维护一套调参，而且 dsh 的 agent 不是陪聊角色，情绪只需要"有连续性"，不需要"有动力学"。
- **不移植长期事实和检索**：生态里记忆插件很多，可并存。
- **主动联系默认关**，四道闸（时段、意愿阈值、每日上限、有投递目标），都写审计日志。这是 HDSI 的 Agency Window + 意愿的最小版本。
- **重新实现，不复用代码**：HDSI 是 AGPL-3.0 的 Koishi 插件，这里是 MIT 的 dsh 插件，按公开文档重写，README 里注明来源。

验证：单元测试 11 项；云端 dsh 0.2.0-rc.2 上 `/interlude now` 写出剧本、状态、intents，后续请求带 `<interlude>`。排错时遇到一个和插件无关的现象：dsh-computer 因为 Docker 没起来处于 error 状态时，`~/dot` 里的轮次在 `step/end` 之后不再发 `turn/end`，幕间因此收不到幕；Docker 起来后恢复正常。

以下为 v0.1 的记录。

---

## 来源

Kevin 的要求：人格部分做一个插件，用之前讨论过的"幕间系统"。这份记录是在他不在时写的，"幕间"按字面和 Lykoi 项目里的几条既定原则来理解：

- 自我是一个重建过程，不是存起来的对象：连续性靠"对记录的忠实"，不靠无缝拼接。
- 重启等于睡了一觉：要能察觉到断裂，并把它纳入叙事，而不是假装没发生。
- 笔记 → 洞见的蒸馏：只改投影层，不改核心身份文件。
- 独处时有自己的事做（"无聊时发展自己的兴趣"）。

所以：**幕 = 和用户的一段对话；幕间 = 对话之间属于 agent 自己的片刻**。幕间里它回顾、写日记、更新状态；下一幕带着状态上场。如果 Kevin 记忆中的"幕间系统"和这个不同，改的是这一段定义，机制大体可以复用。

## 现有插件对照（2026-10-22）

先查了社区，避免重复：

| 插件 | 做什么 | 和幕间的关系 |
|---|---|---|
| 官方 `@deepseek-ai/dsh-persona` / `dsh-system-prompt` 的 persona 配置 | 静态人设段 | 幕间不做人设，直接用它或身份文件 |
| dsh-soul-md、dsh-soul、SoulFusion、dsh-agentsoul | 人设卡 + 长期记忆（文件或 SQLite + 蒸馏） | 记忆库路线，幕间不做记忆库 |
| dsh-mood（155 次提交，2 星） | 33 种心情按定时随机漂移；每天 23:59 写日记；跨会话记忆靠工具查 | 最接近，但心情是随机数不是反思；日记是定点不是按幕 |
| dsh-companion（7 星） | SOUL + Hermes 记忆 + QQ | 路线图里写着"heartbeat/idle self-reflection"待做，正是幕间 |
| dsh-persona-memory、@max-null/dsh-memory、dsh-plugin-memory | 跨会话记忆 | 可与幕间并存 |

结论：这个生态里人设和记忆都很多，星数都很低（2–7），没有一个做"对话之间的反思并带入下一次对话"。幕间是空白，而且小。

## 机制

1. **观察幕**：监听 `session/event`，只看 cwd 在 `<home>` 里的会话。每一轮结束时把梗概追加到 `pending.jsonl`：发起者（用户 / 定时任务）、用户文本、最终助手文本、工具数、审批数。
2. **触发**：每分钟检查一次。条件：有待处理的幕；`<home>` 安静 ≥ `idleMinutes`；没有正在进行的轮；距上次 ≥ `minIntervalMinutes`；当天次数 < `maxPerDay`。也可用 `/interlude now` 手动触发。
3. **调用**：`ctx.llm.stream()` + `ctx.agentDefaultModel.currentSelection()`。system 是身份文件加幕间说明；user 是上次状态、最近日记、本次梗概。要求输出 JSON。走 dsh 自己的 LLM 服务，所以 dsh-budget 照常计费和拦截。
4. **落盘**：日记追加到 `journal.md`；状态写 `state.json`；原始回复写 `calls.jsonl`；清空 `pending.jsonl`。
5. **注入**：`systemPrompt.context()`，order 905，只对 `<home>` 的会话返回文本。内容：上次幕间距今、是否重启过（`meta.lastAt < 进程启动时间`）、状态、最近 N 条日记。上限 2000 字符。
6. **开口**（可选）：`speak: true` 且模型输出了 `say`，通过 dsh-im 的 `dshIm.send()` 发一句。默认关。

## 不做

- 不做人设编辑界面：改文件就行。
- 不做记忆检索：日记和状态都有上限；需要记忆装记忆插件。
- 不做情绪数值模型：状态是一句话，由模型在反思时写。
- 不替代 dsh-dot：dot 管定时结果推送、审批和预算通知；幕间管连续性。两者只共享 `~/dot`。

## 验证

- 单元测试 7 项：解析（围栏 / 裸 / 乱码）、渲染（空 / 重启标记 / 上限）、完整一次幕间（文件、注入、无新幕时不跑）、speak 开关、非 JSON 回复的兜底、每日上限、无身份文件时的提示。
- dsh 0.2.0-rc.2 云端（模拟模型）：`/interlude now` 发起真实模型调用；journal.md、state.json 写出；之后的请求里出现 `<interlude>`；其他目录的会话不出现。

## 待办

- 真机、真实模型跑几天，看日记质量；必要时调提示词。
- `speak` 的节制策略（比如一天最多一句）在真机验证后再定。
- 如果 Kevin 的"幕间系统"另有定义，先改本文件的"来源"一节，再改机制。
