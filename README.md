# dsh-interlude · 幕间

**English** | [中文](#中文说明)

A conversation with your agent is an act. **dsh-interlude is what happens between acts.** When the conversation has gone quiet, the agent gets one model call of its own: it reads who it is, what just happened, and what it wrote last time, then leaves two things behind:

- `~/dot/interlude/journal.md` — a short first-person entry, append-only, yours to read;
- `~/dot/interlude/state.json` — mood in one line, open threads, things worth bringing up next time.

Every later conversation starts with that state in view, placed after the history so the cached prompt prefix is untouched. No memory database, no retrieval, no tools: one bounded call per quiet period, metered by dsh-budget like any other call.

It is persona-agnostic. Who the agent is comes from the file you already keep (`~/dot/AGENTS.md`, or any file) or from dsh's own persona config; interlude only adds continuity between conversations.

```bash
dsh plugin --profile desktop add github:Kevinwu901113/dsh-interlude
```

Works on its own; built to sit beside [dsh-dot](https://github.com/Kevinwu901113/dsh-dot).

---

<a id="中文说明"></a>

## 中文说明

### 一、它解决什么

常驻 agent 最容易丢的不是知识，是**连续性**：上一次聊到一半的事、它当时的判断、它答应过要跟进的事，到下一次对话就没了。现有的办法要么是长期记忆库（抽取事实、向量检索，重），要么是人设卡（静态，不会变）。

幕间走另一条路，和戏剧一样：**每一幕之间，角色有一段独处的时间**。对话安静下来以后，agent 自己回顾一遍刚才发生的事，写一段日记，更新一个很小的状态。下一幕开场时，它带着这个状态上场。

### 二、它做什么

1. **看着每一幕**：记录 `~/dot` 下每一轮对话的梗概（谁发起的、用户说了什么、它最后答了什么、有没有审批）。定时任务触发的轮次也算一幕。
2. **幕间**：`~/dot` 里连续 20 分钟没有动静，且距上次幕间超过 45 分钟，就发起一次模型调用。模型看到：身份文件、上次的状态、最近 3 条日记、这段时间的梗概。它输出一个 JSON：日记一段（≤120 字）、状态（心情一句话、进行中的事 ≤5 条、下次想主动提的事 ≤3 条）。
3. **带进下一幕**：`~/dot` 里之后的每一轮，系统提示里多一段 `<interlude>`：上次幕间是多久前、期间 dsh 有没有重启过、状态、最近的日记。放在对话历史之后，不影响提示前缀的缓存。
4. **可选开口**：`speak: true` 时，幕间里如果真有事想说，可以通过 dsh-im 给用户发一句。默认关闭。

每天最多 8 次，每次最多 700 个输出 token。只有定时检查且结果为 `DOT_SILENT` 的幕不会单独触发幕间（会被记录，下次幕间一并看到）。

### 三、安装

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add github:Kevinwu901113/dsh-interlude
```

和 dsh-dot 共用 `~/dot`，装上就能用。没有 dsh-dot 也可以：把身份写在 `~/dot/AGENTS.md`，在 `~/dot` 里开会话。

在 dsh 里发送 `/interlude` 查看状态，`/interlude now` 立即来一次幕间。

### 四、配置

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `home` / `DSH_INTERLUDE_HOME` | `~/dot`（跟随 `DSH_DOT_HOME`） | 哪个目录里的会话算"幕" |
| `identityFile` | `<home>/AGENTS.md` | 幕间时读的身份文件 |
| `idleMinutes` | `20` | 安静多久算一幕结束 |
| `minIntervalMinutes` | `45` | 两次幕间的最小间隔 |
| `maxPerDay` | `8` | 每天上限 |
| `maxTokens` | `700` | 每次幕间的输出上限 |
| `journalEntriesInPrompt` | `3` | 下一幕能看到几条日记 |
| `speak` | `false` | 允许幕间通过 dsh-im 给用户发一句话 |
| `imBot` / `imTarget` | 自动 | dsh-im 的机器人和投递目标 |

### 五、文件

全部在 `~/dot/interlude/`，纯文本，可以随时打开看、改、删：

- `journal.md`：日记，按时间追加。
- `state.json`：当前状态。
- `pending.jsonl`：还没被幕间处理的幕的梗概；幕间之后清空。
- `calls.jsonl`：每次幕间调用的记录（用的模型、看了几幕、模型原始回复），用来审计。

幕间事件也写进 dsh-computer 的审计日志（`kind: "interlude"`），如果装了它。

### 六、原则

- **不重复造轮子**：人设用 dsh 自带的 persona 或你已有的身份文件；定时、IM、预算都用现成的；模型调用走 dsh 自己的 `llm` 服务和默认模型。
- **不做记忆库**：日记是给人看的，状态是给下一幕看的；都有上限，不会越积越多。要长期记忆，另装记忆插件，两者不冲突。
- **可审计**：模型看到什么、写了什么，`calls.jsonl` 里都有。

### 七、验证情况

dsh 0.2.0-rc.2，云端，模拟模型：一幕结束后 `/interlude now` 发起了真实的模型调用（预算插件可见），写出 journal.md 和 state.json；之后的每一轮请求里都带上了 `<interlude>` 块；别的目录里的会话没有。单元测试覆盖解析、渲染、文件写入、speak 开关、每日上限。

待验证：真机上用真实模型跑几天，看日记和状态是否自然、是否有价值。

MIT License.
