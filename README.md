# dsh-dot

**English** | [中文](#中文说明)

Turn [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) into a **Dots / Grok-Bot-style always-on agent**: it has its own computer, you talk to it over Feishu / WeChat / DingTalk / QQ / Telegram…, it works on a schedule, tells you only when there is something worth telling, and stops itself when the day's budget is spent.

dsh-dot is assembled from existing plugins. It adds only the glue none of them has:

| Need | Provided by |
|---|---|
| Its own computer, approval gates, live view, audit log | [dsh-computer](https://github.com/Kevinwu901113/dsh-computer) |
| Reachable over IM (9 platforms), approvals by reply | [dsh-im](https://github.com/xmanrui/dsh-im), the most-starred dsh IM plugin |
| Scheduled work (daily / weekly / cron, survives restarts) | official `@deepseek-ai/dsh-experimental-schedule-bundle` |
| Hard spending cap | [dsh-budget](https://github.com/PerryLink/dsh-budget) with `overLimit: block` |
| Identity and duties | dsh's own `AGENTS.md` loading |
| **Glue (this repo, ~150 lines)** | scheduled results → IM, unless the reply is `DOT_SILENT`; approvals and budget blocks announced on IM; daily block lifted at midnight |

```bash
dsh plugin --profile desktop add github:Kevinwu901113/dsh-dot github:Kevinwu901113/dsh-computer \
  @xmanrui/dsh-im dsh-budget @deepseek-ai/dsh-experimental-schedule-bundle
```

---

<a id="中文说明"></a>

## 中文说明

dsh-dot 让 dsh 变成一个常驻 agent：**有自己的电脑、IM 上找得到、会定时主动做事、没事不打扰、花钱和危险操作有硬约束**。

北极星场景：在飞书或微信里说"每天早上看看 X 有没有更新，有就告诉我"。第二天到点，它在自己的电脑里检查；有更新推到 IM，没更新不出声；遇到需要审批的操作，IM 里收到提醒和实时画面链接；当天花费超限就自动暂停并通知。

### 一、组成：能用现成的就不自己写

| 需要 | 用谁 |
|---|---|
| 自己的电脑、审批、实时画面、审计日志 | [dsh-computer](https://github.com/Kevinwu901113/dsh-computer) |
| IM（飞书、微信、钉钉、企业微信、QQ、Slack、Telegram、Discord、WhatsApp），回复文字审批 | [dsh-im](https://github.com/xmanrui/dsh-im)，dsh 社区星数最多的 IM 插件 |
| 定时任务（每天 / 每周 / cron，重启后补发） | 官方「自动化任务」`@deepseek-ai/dsh-experimental-schedule-bundle` |
| 预算硬上限 | [dsh-budget](https://github.com/PerryLink/dsh-budget)，`overLimit: block` |
| 身份和职责 | dsh 自带的 `AGENTS.md` 加载 |
| **dsh-dot 本身（约 150 行）** | 上面这些插件都没有的部分，见下文「工作原理」 |

### 二、安装

先退出 dsh 桌面版，再用**一条命令**装齐（dsh 只把 profile 的直接依赖加进层栈）：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add \
  github:Kevinwu901113/dsh-dot github:Kevinwu901113/dsh-computer \
  @xmanrui/dsh-im dsh-budget @deepseek-ai/dsh-experimental-schedule-bundle
open -a "DeepSeek Harness"
```

### 三、第一次设置

1. **预算**：在 profile 的 `cordis.patch.yml` 末尾加上（金额是美元）：
   ```yaml
   - id: budget
     name: dsh-budget
     config:
       budgets: { session: 3, daily: 3, monthly: 90 }
       overLimit: block
   ```
   不设 `block` 的话，dsh-budget 只提醒、不拦截。
2. **IM**：设置 → IM 机器人，接入一个机器人（飞书可扫码一键创建）。
3. **dot 的工作目录**：把这个机器人的工作区设为 `~/dot`。这样 IM 里开的会话会读 `~/dot/AGENTS.md`，定时任务也会跑在这里。编辑 `AGENTS.md`，写它负责什么、你的偏好。
4. **投递目标**：在机器人设置里点「新建目标」，选你和机器人的私聊，保存。dot 用 dsh-im 的公开接口往这个目标发消息。保持「会话双向同步」**关闭**，由 dot 决定发不发。
5. 在 dsh 里发送 `/dot test`，IM 里收到测试消息就说明通了。
6. **公网实时画面（可选）**：按 dsh-computer README 用 `tailscale serve` 暴露实时画面，审批提醒里的链接在手机上才能打开。

### 四、工作原理

dsh-dot 只做现成插件都不做的四件事：

1. **定时结果推送和静默**：`~/dot` 里由定时任务触发的一轮结束后，dot 取最终回复。内容只是 `DOT_SILENT` 就不发；否则通过 dsh-im 的 `ctx.dshIm.send()` 发到你的 IM。用户主动发起的对话由 dsh-im 自己回复，dot 不管。
2. **审批提醒**：定时任务那一轮里出现审批时，IM 里收到提醒和实时画面链接。
3. **预算**：dsh-budget 拦截后在 IM 通知你；日预算的拦截在本地零点自动解除，第二天的定时任务照常运行。
4. **虚拟机出错**时在 IM 通知你。

`/dot` 查看状态，`/dot test` 发测试消息。dot 的事件写进 dsh-computer 的审计日志 `~/.dsh/dsh-computer-audit.jsonl`（`kind: "dot"`）。

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `home` / `DSH_DOT_HOME` | `~/dot` | `AGENTS.md` 所在目录；只处理这个目录里的会话 |
| `imBot` / `imTarget` | 自动 | dsh-im 的 Bot ID 和 Target ID；默认用第一个有已保存目标的机器人 |
| `autoUnblockDaily` | `true` | 零点自动解除日预算拦截 |

### 五、限制

- 必须有 dsh-computer，缺了 dot 不启动：没有虚拟机隔离，"放心不管"就不成立。
- 审批要回到 DeepSeek Harness 里点；IM 里只是提醒。IM 里自己发起的对话，审批按 dsh-im 的方式回复文字。
- 电脑休眠或退出 App 后不运行；24 小时在线需要部署到服务器。
- 不做：长期记忆、多个 dot、自我进化、自己的 IM 或定时框架。

### 六、验证情况

dsh 0.2.0-rc.2，云端 Docker 后端，脚本化模拟模型：
- dsh-computer、dsh-im、dsh-budget、官方 schedule、dsh-dot 同装无冲突。
- 真实的 `schedule_create` 任务到点后：回复有内容，dot 走投递；回复是 `DOT_SILENT`，dot 记为静默、不发。
- 单元测试覆盖投递目标选择、审批提醒、预算拦截和解除通知、零点自动解除、重启不重复通知。

待在真实 IM 上验证：飞书里收到推送；审批提醒里的实时画面链接在手机上能否打开。

MIT License.
