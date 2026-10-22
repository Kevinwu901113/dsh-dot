# dsh-dot

**English** | [中文](#中文说明)

Turn [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) into a **Dots / Grok-Bot-style always-on agent**: it has its own computer, you talk to it over Feishu / WeChat / DingTalk / QQ / Telegram…, it works on a schedule, tells you only when there is something worth telling, and stops itself when the day's budget is spent.

dsh-dot is assembled from existing plugins. It adds only the glue none of them has:

| Need | Provided by |
|---|---|
| Its own computer, approval gates, live view, audit log | [dsh-computer](https://github.com/Kevinwu901113/dsh-computer) |
| Reachable over IM (9 platforms), approvals by reply | [dsh-im](https://github.com/xmanrui/dsh-im), the most-starred dsh IM plugin |
| Scheduled work (daily / weekly / cron, survives restarts) | built into dsh ≥ 0.2.1 (the official schedule service) |
| Hard spending cap (optional) | [dsh-budget](https://github.com/PerryLink/dsh-budget) with `overLimit: block`; without it dot runs the same, just uncapped |
| Identity | [dsh-interlude](https://github.com/Kevinwu901113/dsh-interlude)'s Canon (HDSI presets by share code), or dsh's persona config; dot only adds its working rules as a prompt section |
| **Glue (this repo, ~200 lines)** | scheduled results → IM, unless the reply is `DOT_SILENT`; approvals and budget blocks announced on IM; daily block lifted at midnight |

```bash
dsh plugin --profile desktop add github:Kevinwu901113/dsh-dot github:Kevinwu901113/dsh-computer @xmanrui/dsh-im
# optional spending cap: append dsh-budget to the same command
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
| 定时任务（每天 / 每周 / cron，重启后补发） | dsh 0.2.1 起内置的官方定时服务（「自动化任务」） |
| 预算硬上限（可选） | [dsh-budget](https://github.com/PerryLink/dsh-budget)，`overLimit: block`。不装也能用，只是没人拦花费 |
| 身份 | [dsh-interlude](https://github.com/Kevinwu901113/dsh-interlude) 的 Canon（HDSI 分享码导入）或 dsh 的 persona 配置；dot 只把自己的工作规则作为系统提示的一段注入 |
| **dsh-dot 本身（约 200 行）** | 上面这些插件都没有的部分，见下文「工作原理」 |

### 二、安装

需要 dsh ≥ 0.2.1（定时任务已内置）。先退出 dsh 桌面版，再用**一条命令**装齐（dsh 只把 profile 的直接依赖加进层栈）：

> 从 dsh 0.2.0 升级上来、装过 `@deepseek-ai/dsh-experimental-schedule-bundle` 的，请先卸掉它：它带的旧版 `dsh-schedule` 会挡住内置的新版。

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add \
  github:Kevinwu901113/dsh-dot github:Kevinwu901113/dsh-computer @xmanrui/dsh-im
open -a "DeepSeek Harness"
```

想要花费硬上限的，把 `dsh-budget` 加进同一条命令。

### 三、第一次设置

1. **预算（只在装了 dsh-budget 时）**：在 profile 的 `cordis.patch.yml` 末尾加上（金额是美元）：
   ```yaml
   - id: budget
     name: dsh-budget
     config:
       budgets: { session: 3, daily: 3, monthly: 90 }
       overLimit: block
   ```
   不设 `block` 的话，dsh-budget 只提醒、不拦截。
2. **IM**：设置 → IM 机器人，接入一个机器人（飞书可扫码一键创建）。
3. **dot 的工作目录**：把这个机器人的工作区设为 `~/dot`。dot 只处理这个目录里的会话，定时任务也会跑在这里。不需要 `AGENTS.md`：工作规则由 dot 注入，人设由 dsh-interlude 注入。
4. **投递目标**：在机器人设置里点「新建目标」，选你和机器人的私聊，保存。dot 用 dsh-im 的公开接口往这个目标发消息。保持「会话双向同步」**关闭**，由 dot 决定发不发。
5. 在 dsh 里发送 `/dot test`，IM 里收到测试消息就说明通了。
6. **公网实时画面（可选）**：按 dsh-computer README 用 `tailscale serve` 暴露实时画面，审批提醒里的链接在手机上才能打开。

### 四、工作原理

dsh-dot 只做现成插件都不做的四件事：

1. **定时结果推送和静默**：`~/dot` 里由定时任务触发的那一轮，dot 在系统提示里加一条静默规则（只加在这一轮）。这一轮结束后，dot 取最终回复。内容只是 `DOT_SILENT` 就不发；否则通过 dsh-im 的 `ctx.dshIm.send()` 发到你的 IM。用户主动发起的对话由 dsh-im 自己回复，dot 不管。
2. **审批提醒**：定时任务那一轮里出现审批时，IM 里收到提醒和实时画面链接。
3. **预算**（装了 dsh-budget 时）：拦截后在 IM 通知你；日预算的拦截在本地零点自动解除，第二天的定时任务照常运行。
4. **虚拟机出错**时在 IM 通知你。

`/dot` 查看状态，`/dot test` 发测试消息。dot 的事件写进 dsh-computer 的审计日志 `~/.dsh/dsh-computer-audit.jsonl`（`kind: "dot"`）。

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `home` / `DSH_DOT_HOME` | `~/dot` | 只处理这个目录里的会话 |
| `imBot` / `imTarget` | 自动 | dsh-im 的 Bot ID 和 Target ID；默认用第一个有已保存目标的机器人 |
| `autoUnblockDaily` | `true` | 零点自动解除日预算拦截 |

### 五、限制

- 必须有 dsh-computer，缺了 dot 不启动：没有虚拟机隔离，"放心不管"就不成立。
- 审批要回到 DeepSeek Harness 里点；IM 里只是提醒。IM 里自己发起的对话，审批按 dsh-im 的方式回复文字。
- 电脑休眠或退出 App 后不运行；24 小时在线需要部署到服务器。
- 不做：长期记忆、多个 dot、自我进化、自己的 IM 或定时框架。

### 六、验证情况

**真机**（Mac，dsh 0.2.1-rc.2，QQ 官方机器人，真实模型）：
- 在 QQ 里和 dot 对话，它以注入的身份回复。
- 说"2 分钟后看看 X 有没有新提交"，agent 建了定时任务（不再马上去做）；到点在虚拟机里查看，结果由 dot 推到 QQ。
- 再建一个任务，到点没有新提交，agent 只回复 `DOT_SILENT`，QQ 没有收到消息。
- `/dot test` 从 dsh 发测试消息到 QQ。
- 审批提醒（虚拟机里 `sudo`，gate 拦下 `sandbox_execute_bash`）推到 QQ；把日预算临时调到 $0.0005 触发拦截，⛔ 通知和恢复后的 ▶️ 通知都推到 QQ。

**云端**（dsh 0.2.0-rc.2，Docker 后端，脚本化模拟模型）：
- 五个包同装无冲突；定时触发那一轮的请求里有静默规则，用户自己发起的轮次没有。
- 定时任务那一轮里出现审批（`sudo`）时，dot 发出审批提醒（含实时画面链接）。
- 预算拦截 → 通知、不重复通知、零点自动解除：单元测试。

想让它在两次对话之间也"活着"（生活剧本、状态、打算，按 [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude) 的幕间思路），装 [dsh-interlude](https://github.com/Kevinwu901113/dsh-interlude)，和 dot 共用 `~/dot`。

MIT License.
