# dsh-dot

**English** | [中文](#中文说明)

A character who lives on her own phone, for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). She has her own Android phone (this plugin installs and runs it), her own accounts, her own days: between your conversations she keeps living — writes what happened, goes to look at things she is curious about on her phone, and sometimes has a real reason to message you. You are one of her contacts on QQ / WeChat / Feishu…; dsh-im carries the chat. If you also want her to *work* — shell, scripts, a desktop browser, scheduled jobs — give her the optional computer.

One plugin, four components:

| Component | What it is | Needs |
|---|---|---|
| **`dsh-dot/phone`** | Her phone: an Android emulator the plugin downloads (emulator + platform-tools + one system image, ~2 GB, after you accept the SDK license), boots, keeps alive and exposes as `mcp__phone__*` ([mobile-mcp](https://github.com/mobile-next/mobile-mcp) over adb). The emulator window is the live view; her apps and logins live in the AVD and survive restarts. [Details](docs/phone.md) | hardware virtualization (Apple silicon or Intel Mac, Linux with KVM, Windows with WHPX) |
| **`dsh-dot/interlude`** | 幕间, after [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude): the Canon (persona; HDSI presets by share code) as a prompt section; a life between conversations — script, continuity, intents; going to look at things on her phone or in her browser (read-only, no approvals); optional proactive contact. [Details](docs/interlude.md) | — |
| **`dsh-dot/qq`** | Her QQ on her computer: [NapCat](https://github.com/NapNeko/NapCatQQ) (OneBot 11) inside the computer VM, the same account as the QQ app on her phone; messages wake her the moment they arrive, she answers with `qq_send`. [Details](docs/qq.md) | the computer component |
| **`dsh-dot/dot`** | The contact layer: scheduled results → IM unless the reply is `DOT_SILENT`, approval and device notices on IM, working rules as a prompt section | [dsh-im](https://github.com/xmanrui/dsh-im) for IM; dsh's built-in schedule service |
| **`dsh-dot/computer`** (optional) | A bundled microVM (no Docker needed) with shell, browser, desktop, live view, approval gates and an audit log — the isolation boundary for work. `DSH_DOT_COMPUTER=off` turns it off. [Details](docs/computer.md) | [microsandbox](https://github.com/zerocore-ai/microsandbox) (bundled) or Docker |

```bash
dsh plugin --profile desktop add @kevinwu901113/dsh-dot @xmanrui/dsh-im   # npm; or github:Kevinwu901113/dsh-dot for the source
# then, in dsh:  /phone accept      (Android SDK license → the phone installs itself)
#                /interlude preset 6QA0-1PD6   (a persona from the HDSI hub; pick your own on typ0.space)
```

History: `dsh-computer` (v0.1–0.5) and `dsh-interlude` were separate plugins; since dsh-dot v0.3/v0.4 they are components here with their git history merged. Nothing user-facing changed for them.

---

<a id="中文说明"></a>

## 中文说明

dsh-dot 让 dsh 里住进一个**在自己手机上过日子的角色**。她有自己的安卓手机（插件自己装、自己开）、自己的账号、自己的作息：你们不聊天的时候她也在过日子——把发生的事写下来、拿起手机去看她好奇的东西、偶尔有个真实的理由找你说句话。你是她 QQ / 微信 / 飞书里的一个联系人（dsh-im 负责通道）。想让她也能干活——shell、脚本、桌面浏览器、定时任务——再给她那台可选的电脑。

### 一、组成：一个插件、六个组件

| 组件 | 是什么 | 依赖 |
|---|---|---|
| **`dsh-dot/phone`** 她的手机 | Android 模拟器。插件自己从 Google 仓库下载模拟器、platform-tools 和一个系统镜像（约 2 GB，先要你接受 SDK 许可），自己写 AVD（不需要 Java / Android Studio），开机、保活，以 `mcp__phone__*` 暴露给模型（[mobile-mcp](https://github.com/mobile-next/mobile-mcp) 走 adb）。模拟器窗口就是实时画面；App 和登录态在 AVD 里，重启不丢。详见 [docs/phone.md](docs/phone.md) | 硬件虚拟化：Apple silicon / Intel Mac，Linux 要 KVM，Windows 要 WHPX |
| **`dsh-dot/interlude`** 幕间 | 按 [HDS-Interlude](https://github.com/REcklessNOLOve117/HDS-Interlude)：Canon（人设，HDSI 分享码导入）作为系统提示的一段；两次对话之间的生活——剧本、连续性、打算；想看什么就拿手机（或电脑浏览器）去看，只读、无审批；可选的主动联系。详见 [docs/interlude.md](docs/interlude.md) | — |
| **`dsh-dot/qq`** 她电脑上的 QQ | [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11）跑在她的电脑 VM 里，和手机上的 QQ 同一个账号；消息到的瞬间叫醒她，她用 `qq_send` 秒回；dot 的提醒和她的主动联系也走这里，官方机器人退为后备。详见 [docs/qq.md](docs/qq.md) | 电脑组件 |
| **`dsh-dot/memory`** 她记得的 | 关于你的画像和她自己的笔记（按 Hermes 的做法，有字数上限，她自己能改），她在各个 App 里遇到的人（每人一张卡：互动次数由代码根据真实事件记，印象和事由模型写；只在帖子里互动过的人只记次数和一句印象；关于别人的事先进待核实区），发生过的事（按 dsh-whale-inurqq：碎片带重要度、被说起几次、会老化）。她的对话到 15 万 token 就交班换一个新会话，远早于 dsh 自己在 80% 窗口时的压缩。详见 [docs/memory.md](docs/memory.md) | — |
| **`dsh-dot/dot`** 联系人层 | 定时任务的结果推到 IM（回复只是 `DOT_SILENT` 就不发）、审批和设备状况的提醒、工作规则作为系统提示的一段 | IM 用 [dsh-im](https://github.com/xmanrui/dsh-im)；定时用 dsh 内置的定时服务 |
| **`dsh-dot/computer`**（可选）她的电脑 | 自带 microVM（不需要 Docker），里面有 shell、浏览器、桌面；实时画面、审批闸门、审计日志。干活时的隔离边界。`DSH_DOT_COMPUTER=off` 关掉。详见 [docs/computer.md](docs/computer.md) | [microsandbox](https://github.com/zerocore-ai/microsandbox)（自带）或 Docker |

v0.2 之前"电脑"（dsh-computer）和"幕间"（dsh-interlude）是独立插件；v0.3 / v0.4 起并进来做组件，git 历史一起并了。对外没变：`mcp__vm__*`、`dshComputer`、`~/.dsh/dsh-computer*`、`~/dot/interlude/`、`/dot` `/interlude`。已经装了它们的，先 `dsh plugin --profile desktop remove dsh-computer dsh-interlude` 再装新版 dsh-dot。**v0.8 起包名改为 `@kevinwu901113/dsh-dot`**（npm 上 `dsh-dot` 已被他人占用）：之前按 `github:` 装过的，先 `dsh plugin --profile desktop remove dsh-dot` 再装；`~/dot`、`~/.dsh/phone`、虚拟机都不用动。

### 二、安装

需要 dsh ≥ 0.2.1。先退出 dsh 桌面版，再用一条命令装齐：

```bash
# macOS
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add \
  @kevinwu901113/dsh-dot @xmanrui/dsh-im
open -a "DeepSeek Harness"
```

```powershell
# Windows（PowerShell；需要开启 Windows 虚拟机监控程序平台 WHPX，手机才能跑）
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add `
  @kevinwu901113/dsh-dot @xmanrui/dsh-im
```

Web 版：`dsh plugin --profile web add @kevinwu901113/dsh-dot`。从源码装：把包名换成 `github:Kevinwu901113/dsh-dot`。

### 三、第一次设置

1. **手机**：在 dsh 里发 `/phone accept`——接受 [Android SDK 许可](https://developer.android.com/studio/terms)后插件开始下载（约 2 GB，进度在 `~/.dsh/dsh-phone.log`），装完自动开机，桌面上出现一个手机窗口。`/phone` 看状态。
2. **装 App、登录**：在手机窗口里像用真手机一样操作：从官网下 APK 用 `adb install`（`~/.dsh/phone/platform-tools/adb`），或者让她自己装（`mobile_install_app` 会弹审批）。登录、验证码、人脸都由你在窗口里亲手过——她遇到会停下来叫你。**用小号。** 各平台的条款都不允许自动化，封了就封了。
3. **人设**：`/interlude preset <分享码>` 从 [typ0.space](https://typ0.space) 导入一份 HDSI 预设，或者把 `examples/canon.minase-style.json` 放到 `~/dot/interlude/canon.json`。
4. **她在手机上看什么**：profile 的 `cordis.patch.yml` 里给 `dot-interlude` 加 `phoneApps: { xiaoheihe.cn: com.max.xiaoheihe, bilibili.com: tv.danmaku.bili }`——这些站她永远用手机上的 App 去看，只读、无审批、每天有上限。
5. **她的 QQ**：`/qq install` → `/qq account <小号>` → `/qq start` → `/qq qr`，在「手机」标签页里用她手机上的 QQ 扫相册里的码确认电脑登录（详见 [docs/qq.md](docs/qq.md)）。之后你在 QQ 里给她发消息，1–2 秒叫醒她，她用 `qq_send` 回。不想用协议端的，按 dsh-im 的说明接一个官方机器人也行。
6. **电脑（可选）**：默认装上并启动；不想要就在环境里设 `DSH_DOT_COMPUTER=off`。要公网实时画面按 [docs/computer.md](docs/computer.md) 用 `tailscale serve`。

### 四、她一天是怎么过的

- 你们聊天：dsh 自己跑对话，dsh-im 接 IM；她的人设（Canon）和工作规则是系统提示里的两段，不需要 `AGENTS.md`。
- 聊天安静下来 `idleMinutes` 后、或每 `advanceEveryMinutes` 一次（只在 `activeHours` 内）、或某个打算到了时间：**幕间一轮**——一次模型调用，她写下这段时间过的日子、更新连续性快照、记下打算，顺便说她想去看点什么（`browserIntents`）。
- **去看**：有 App 的站用手机（`phoneApps`），登录过的网站用电脑浏览器（`vmSites`），其他先走 dsh 的 `web` 服务；被挡了就自己去看。实现是往她最近的会话里追加一条"[幕间观察]"消息，她用 `mcp__phone__*` / `mcp__vm__browser_*` 自己看，最后那段回复作为 `webContext` 进入之后的幕间。这一轮不算幕，**也没有审批**——只读工具直接放行，输入、安装、下单一类直接拒绝。
- **跑腿会话**：拿起手机、App 通知、幕间的「去看」和「玩」都在她的另一个会话「dot · 跑腿」里跑，截图和屏幕元素不进你们的对话；跑腿有结果时，只在她的对话里留一句「[刚才拿起手机看了一眼] …」（不叫醒她，下一轮她就知道）。跑腿会话超过 6 万 token 自动换新。QQ / 微信的消息和你的话照常直接叫醒她的对话。
- **拿起手机**：手机没响她也会隔一阵拿起来看一眼（`phoneCheckEveryMinutes`，默认 30，最近没被叫醒过时）：有没回的消息就回，App 里有新动态就看，没事 `DOT_SILENT` 回桌面。`/dot check` 立刻来一次。
- **手机响了**：任何 App 的新通知（QQ 消息、小黑盒的更新、以后她自己装的任何 App）都会叫醒她：`[手机通知] QQ · 宽：在吗`，她自己去 App 里回，或者不理。按 App 静音：`/phone notify mute <包名>`。
- **玩**（默认开，`DSH_DOT_PLAY=off` 关）：幕间里她想"给那篇点个赞 / 评论一句 / 关注他"，就变成一条 `[想玩会儿手机]`，她用手机去做——只在她自己装了的 App 里。玩多少不是配额，是她自己的习惯（记忆 self 栏里她自己记下的）；发帖 / 私信 / 花钱不在允许的动作里。守则是 [Moltbook](https://www.moltbook.com/heartbeat.md) 给 agent 定的：参与 > 创造，真有话说才发。
- **找你**：`speak: true` 时，幕间里 `contact` 过四道闸（活跃时段、意愿值、每日上限、有投递目标）才通过 dsh-im 发出去。
- **干活**（装了电脑时）：你说"每天早上看看 X 有没有更新"，她建定时任务；到点在电脑里查，有新内容推到 IM，没有就 `DOT_SILENT`；危险操作弹审批卡，附实时画面链接。

### 五、文件和命令

| | |
|---|---|
| `~/dot/interlude/` | 人设 `canon.json`、剧本 `script.md`、连续性 `state.json`、打算 `intents.json`、看到的东西 `web-context.jsonl`、每轮原始回复和 token 用量 `calls.jsonl` |
| `~/dot/memory/` | `memory.md`（给你看的：关于你、她的笔记、认识的人、待核实、碎片）、`diary.md`（她每天 23:30 写的日记）、`memory.json`、真实发生过的对话 `transcript.jsonl`、交班记录 `handoffs.jsonl`、每次整理的原始回复 `calls.jsonl` |
| `~/.dsh/phone/` | 模拟器、platform-tools、系统镜像、AVD（`avd/dot.avd/`）；`~/.dsh/dsh-phone.log` 日志、`dsh-phone-audit.jsonl` 审计、`dsh-phone.json` 设置 |
| `~/.dsh/dsh-computer*` | 电脑的日志、审计、状态 |
| `/phone [accept\|restart\|screenshot]` · `/interlude [now\|advance\|seed\|preset <code>\|canon]` · `/dot [test\|check]` · `/dot memory [now\|diary\|handoff]` · `/dot people [approve <id>\|drop <id>\|forget <名字>]` | 各组件的状态和操作 |
| 右侧栏 **dot** 标签页（会话顶部 ◎ 按钮） | 一页看全：手机 / 电脑 QQ / 电脑 状态、她的对话交班进度、她此刻在做什么和打算、今天的轮数 / 玩 / 去看 / 叫醒 / token、记忆用量、日记、最近两段剧本。只读，3 秒刷新；页面由 `dsh-dot/dot` 挂在 dsh 自己的 web server 上（`/dsh-dot/panel/`），不开新端口 |
| 安全边界 | 手机实时画面与控制（`/dsh-dot/phone/`）和 dot 面板都挂在 dsh 的 web server 上，每个请求先过 dsh 的 `connection` 服务（dsh 登录态 + Host/Origin 围栏，不信任任何转发头）——插件不自带鉴权、不开自己的端口。电脑的实时桌面同样挂在 dsh 的 web server 上（`/dsh-dot/computer/`，含 VNC 的 WebSocket），由插件带密钥中继给虚拟机网关；网关端口（`127.0.0.1:18080`）只绑本机回环且要求密钥（`SANDBOX_API_KEY`，每台机器自动生成在 `~/.dsh/dsh-computer.key`），只有插件内部持有。若要从外面看，请暴露 dsh 本身而不是这个端口 |

dot 的通知相关：`notifyBatchMs`（1 秒内的通知合成一次叫醒）、`notifyHours`（可选的静音时段，默认不设：任何时候来通知都叫醒她）；她正在跑一轮时来的通知会攒到那轮结束，同一个对话的多条按顺序列出，一次叫醒。每个组件的配置项见各自的文档：[phone](docs/phone.md)、[interlude](docs/interlude.md)、[computer](docs/computer.md)；dot 自己只有 `home`、`scope`、`imBot` / `imTarget`、`autoUnblockDaily`。

### 六、原则

- **不重复造轮子**：手机用 Google 官方模拟器和 mobile-mcp，电脑用 microsandbox，IM 用 dsh-im，定时用 dsh 内置的，人设用 HDSI 社区的预设，幕间的提示词按 HDSI 原文。
- **她只能看，不能瞒着你动**：幕间的"去看"是只读的；有后果的动作（装 App、输密码、付款、发消息）走审批，或者根本不给。
- **可审计**：她看到什么、为什么没出声、哪次工具被拒了，`calls.jsonl` 和两份审计日志里都有。
- **用小号**。

### 七、路线

现状、分期和待定的决定见 [docs/ROADMAP.md](docs/ROADMAP.md)。

### 八、许可证

AGPL-3.0-only。幕间组件按原文使用 HDS-Interlude（AGPL-3.0）的提示词，所以整个包按 AGPL 发布；v0.3 之前以 MIT 发布的 computer / dot 代码，那些版本仍按 MIT 可用。
