# dsh-dot

**English** | [中文](#中文说明)

Turn [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) into a **Dots / Grok-Bot-style always-on agent**: it has its own computer, you reach it over WeChat / Feishu / QQ / Telegram, it works on a schedule or when a page you watch changes, and it stops itself when the day's budget is spent.

dsh-dot is mostly composition plus a few hundred lines of glue:

| Layer | Plugin | Role |
|---|---|---|
| Its own computer | [dsh-computer](https://github.com/Kevinwu901113/dsh-computer) | microVM with shell, browser, live view, approval gates, audit log |
| Reachable over IM | [dsh-bridge](https://github.com/wenbin-wb/dsh-bridge) | WeChat / Feishu / QQ / Telegram, card approvals, files |
| Scheduled work | official `@deepseek-ai/dsh-experimental-schedule-bundle` | daily / weekly / cron, survives restarts, wakes cold sessions |
| Hard spending limit | [dsh-budget](https://github.com/PerryLink/dsh-budget) | session / daily / monthly caps, `block` policy |
| Glue | **dsh-dot** (this repo) | identity file, model-free page watching, silence protocol, budget → pause + IM notice, midnight reset |

### Install

```bash
# dsh desktop (quit the app first)
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add \
  github:Kevinwu901113/dsh-dot github:Kevinwu901113/dsh-computer @wenbin_wb/dsh-bridge dsh-budget \
  @deepseek-ai/dsh-experimental-schedule-bundle
```

All five go in one command: dsh only layers bundles that are direct dependencies of the profile. Then set `overLimit: block` and a daily cap in **Settings → Plugins → Budget**, and connect an IM account in **Settings → Remote access** (dsh-bridge).

---

<a id="中文说明"></a>

## 中文说明

dsh-dot 让 dsh 变成一个常驻 agent：**有自己的电脑、IM 上找得到、会定时和在页面变化时主动做事、花钱和危险操作有硬约束**。

北极星场景：在微信或飞书里说一句"每天早上看看 X 有没有更新，有就告诉我"。第二天到点，它在自己的电脑里打开网页检查；有更新就推到 IM，没更新就不打扰；遇到登录页推审批卡片，附实时画面链接；当天花费超限就自动暂停并通知你。

### 一、安装

先退出 dsh 桌面版，再用**一条命令**装齐五个包。dsh 只把 profile 的直接依赖加进层栈，所以必须一起装：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add \
  github:Kevinwu901113/dsh-dot github:Kevinwu901113/dsh-computer @wenbin_wb/dsh-bridge dsh-budget \
  @deepseek-ai/dsh-experimental-schedule-bundle
open -a "DeepSeek Harness"
```

命令行版把 `--profile desktop` 换成 `--profile web`，用 `dsh web` 启动。

### 二、第一次设置

1. **预算**：设置 → 插件 → Budget，把超限策略设为 `block`，填一个日预算。不设的话 dsh-budget 默认只提醒、不拦截。
2. **IM**：设置 → 远程访问（dsh-bridge），连接微信、飞书、QQ 或 Telegram。建议开发送者白名单，只听你的。
3. **dot 的身份**：编辑 `~/dot/AGENTS.md`，写它叫什么、长期负责什么、你的偏好。在 `~/dot` 里开的会话会自动读这个文件。
4. **主会话**：在 IM 里和 dot 说一句话，或者在 dsh 里从 `~/dot` 新建会话。dot 会把定时提醒以外的主动消息（页面变化）投递到 IM 当前绑定的会话；没有绑定 IM 时，投递到 `~/dot` 里最近的会话。建议在 IM 里用 `/sessions` 切到 `~/dot` 的会话。
5. **公网实时画面（可选）**：按 dsh-computer README 用 `tailscale serve` 暴露实时画面，审批卡片里的链接在手机上才能打开。

### 三、怎么用

| 你说 | 发生什么 |
|---|---|
| "每天早上 8 点看看 X 有没有更新" | agent 用官方 `schedule_create` 建任务；到点在虚拟机里检查 |
| "盯着这个页面" | agent 把它写进 `~/dot/watch.json`；dot 定期抓取比较，不调模型；变了才叫醒 agent |
| 发送 `/dot` | 查看 dot 状态：主会话、虚拟机、IM、预算、免打扰、关注项、积压事项 |
| 发送 `/dot check` | 立即检查一遍关注项 |

**静默协议**：被定时任务或页面变化叫醒时，检查后没有值得说的，agent 只回复 `DOT_SILENT`，这条不会发到 IM。

**预算**：dsh-budget 拦截后，dot 不再叫醒 agent，并在 IM 里通知你（模型不可用时直接发，不经过模型）；拦截期间的事项会攒着，解除后一并处理。日预算的拦截会在本地零点自动解除，第二天的定时任务照常运行。

**免打扰**：默认 23:00–08:00。期间检测到的变化先攒着，结束后再处理（官方定时任务不受影响）。

### 四、配置

在 profile 的 `cordis.patch.yml` 里覆盖 `dsh-dot` 行的 config，或用环境变量：

| 配置项 / 环境变量 | 默认值 | 作用 |
|---|---|---|
| `home` / `DSH_DOT_HOME` | `~/dot` | `AGENTS.md` 和 `watch.json` 所在目录 |
| `mainSession` | 自动 | 固定一个主会话 id |
| `quietHours` | `23:00-08:00` | 免打扰时段，空字符串关闭 |
| `autoUnblockDaily` | `true` | 本地零点自动解除日预算拦截 |
| `notifyWebhook` / `DSH_DOT_NOTIFY_WEBHOOK` | 空 | IM 不可用时的备用通知：飞书机器人、企业微信机器人、Server酱（`https://sctapi.ftqq.com/<key>.send`）或任意接收 JSON `{title, text}` 的地址 |
| `precheckSeconds` / `budgetPollSeconds` | `60` / `15` | 扫描关注列表、查询预算的间隔 |

`watch.json` 格式见 `~/dot/AGENTS.md`。

### 五、工作原理与限制

- **和 dsh-bridge 的衔接**：dsh-bridge 会把绑定会话里的所有助手回复转发到 IM，但没有对外接口。dot 在运行时包装了它会话桥基类的两个方法，实现静默、读取绑定会话、不经模型直接发消息。会先检测类的结构，对不上就关闭这部分并提示，退回 webhook。计划给 dsh-bridge 提 PR，把这三个能力做成正式接口。
- **必须有 dsh-computer**：没有虚拟机隔离，"放心不管"就不成立，所以 dot 依赖它，缺了就不启动。dot 的唤醒、预算事件都写进 dsh-computer 的审计日志 `~/.dsh/dsh-computer-audit.jsonl`（`kind: "dot"`）。
- **页面检查在本机发起**：用一个普通 GET 请求，不经过虚拟机。需要登录或 JS 渲染的页面看到的是空壳，这类页面请用定时任务让 agent 在虚拟机里看。
- **不做**：长期记忆、多个 dot、自我进化、自己的 IM 桥接或心跳框架。
- **需要电脑开着**：桌面版关窗口后仍在后台运行，但电脑休眠或退出 App 就停了；24 小时在线请部署到服务器。

### 六、验证情况

在 dsh 0.2.0-rc.2 上已验证（云端，Docker 后端，模拟模型）：五个包同装无冲突；`~/dot/AGENTS.md` 被模型读到；`schedule_create` 建的任务到点投递进 dot 会话；页面变化被检测到并叫醒主会话；预算拦截后 dot 发通知、暂停唤醒、攒着事项；零点自动解除并补发事项；静默、会话绑定、直接发消息在真实 dsh-bridge 类上通过单元测试。

待在真实 IM 上验证：飞书或微信里的审批卡片和回传；公网实时画面链接在手机上能否打开。

MIT License.
