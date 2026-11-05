# 设置：`~/.dsh/dsh-dot.json`

dsh-dot 的所有个人设置都写在**一个文件**里：

| 系统 | 路径 |
|---|---|
| macOS / Linux | `~/.dsh/dsh-dot.json` |
| Windows | `%USERPROFILE%\.dsh\dsh-dot.json` |
| 设了 `DSH_HOME` 时 | `$DSH_HOME/dsh-dot.json` |

- 文件不存在就是全用默认值，需要时自己建。
- 它在插件包外面，**升级插件不会覆盖**；桌面版拿不到终端环境变量，也能用它配置。
- **改完重启 dsh 才生效**（退出桌面版再打开）。
- 文件写坏了（不是合法 JSON）会被整个忽略，日志里有一行 `dsh-dot.json ignored`。

## 让 dsh（或别的 agent）帮你改

把下面这段连同你的需求发给 dsh 即可：

```text
帮我改 dsh-dot 的设置：<你的需求，例如"手机存储改成 32 GB，晚上 1 点前都算她的活跃时间">。
设置文件是 ~/.dsh/dsh-dot.json，说明在 https://github.com/Kevinwu901113/dsh-dot/blob/main/docs/SETTINGS.md 。
先读这份说明，再读现有的设置文件，只改需要的键，保留其他内容，改完告诉我要不要重启、有没有只在新建时生效的项。
```

**给 agent 的规则**（dsh、Claude、Codex 等改这个文件时照做）：

1. 先读现有文件；不存在就新建 `{}`。只增改相关的键，**不要删别的段和键**。
2. 顶层按组件分段：`phone`、`computer`、`gate`、`qq`、`memory`、`interlude`、`dot`。键名和类型照下面的表，不要发明新键。
3. 写合法 JSON（不能有注释、尾逗号）。想留说明就用 `_` 开头的键，如 `"_note": "..."`，会被忽略。
4. 下文标 **🔒 建立时** 的项只对新建的手机 / 虚拟机生效，改之前先告诉用户要重建、会丢什么，得到同意再动。
5. 有专门命令的（`/phone size`、`/dot memory recall …`、`/qq owner` 等），优先告诉用户用命令，命令不用重启。
6. 改完提醒用户重启 dsh。

## 示例

```json
{
  "phone": { "dataGb": 32, "ramMb": 4096 },
  "computer": { "rootDisk": "32G", "memory": "6G", "cpus": 4 },
  "qq": { "githubProxy": "https://ghfast.top/", "groupPolicy": "score" },
  "memory": { "dailyAt": "01:30" },
  "interlude": { "activeHours": "09:00-01:00", "speak": true },
  "dot": { "phoneCheckEveryMinutes": 60 }
}
```

## 常见需求

| 我想… | 改什么 | 注意 |
|---|---|---|
| **手机存储大一点** | 建手机前：`/phone size 32`，或 `/phone accept 32`，或 `phone.dataGb`（8–256） | 🔒 建立时。手机建好后**扩不了**（改 AVD 的 `config.ini` 实测无效）。已经满了：卸 App、清 App 数据；或者删掉 `~/.dsh/phone/avd/dot.avd/` 和 `dot.ini` 重建（手机里的 App 和登录全丢），重建前先 `/phone size <GB>` |
| 手机内存 / 机型 / 语言 / 时区 | `phone.ramMb`、`phone.device`、`phone.locale`、`phone.timezone` | `ramMb`、`device` 🔒 建立时（同上，删 AVD 重建） |
| 不显示模拟器窗口 | `phone.window: false` | 画面仍可在 dsh 的手机标签页看 |
| **电脑磁盘大一点** | `computer.rootDisk`，如 `"32G"` | 🔒 建立时。已有虚拟机扩不了，要重建：`msb rm -f dsh-computer` 并删 `~/.microsandbox/snapshots/dsh-computer/`（见 [computer.md](computer.md#六维护)），装过的东西和 QQ 登录会丢。0.11.3 之前建的虚拟机只有约 4 GB |
| 电脑内存 / CPU | `computer.memory`（如 `"6G"`）、`computer.cpus` | 重启 dsh 生效 |
| 电脑里 QQ 报 `no space left` / `ENOSPC` | 先 `/qq clean`（清缓存和残留），还不够 `/qq clean napcat`（用 SnowLuma 时删掉 NapCat） | 根治是加大 `computer.rootDisk` 重建 |
| 共享文件夹给电脑 | `computer.mounts: ["/Users/你/Projects/a"]` | |
| 国内网络下载慢 | QQ 安装：`qq.githubProxy`；召回模型：`/dot memory recall mirror <url>`（默认已走 hf-mirror）；虚拟机镜像：`computer.image` 换镜像源 | |
| 召回换云端 / 关掉 | `/dot memory recall backend siliconflow`，再 `/dot memory recall key siliconflow <key>` | 命令即时生效，不用重启，也不用改这个文件 |
| **她的作息** | `interlude.activeHours`（如 `"09:00-01:00"`，可跨午夜）、`interlude.advanceEveryMinutes`（自己过日子的间隔，0 关）、`interlude.maxRoundsPerDay` | 活跃时段外不跑幕间、不主动找你 |
| 日记时间 | `memory.dailyAt`（默认 `"23:30"`） | |
| **让她主动找你** | `interlude.speak: true`，`interlude.maxContactsPerDay`、`interlude.willingnessThreshold`（0–1，越低越爱找你） | 默认关 |
| 拿手机看的频率 | `dot.phoneCheckEveryMinutes`（默认 30，0 关） | |
| 夜里通知不叫醒她 | `dot.notifyHours: "08:00-23:00"`（只有这个时段内通知才叫醒） | 默认空 = 任何时候都叫醒 |
| 某个 App 的通知别叫醒她 | `/phone notify mute <包名>` | 命令即时生效 |
| 群聊里插话的规则 | `qq.groupPolicy`：`mention`（被 @ 才回，默认）/ `score`（按价值评分，配 `qq.scoreThreshold` 0–10）/ `all` / `none` | |
| 回复不拆条、不模拟打字 | `qq.typingMsPerChar: 0` | |
| 发 QQ 的审批松紧 | `qq.sendPolicy`：`reply`（默认）/ `always` / `off` | |
| 她逛 / 玩的 App | `interlude.phoneApps`（站点 → 包名）、`interlude.playApps`（名字 → 包名）、`interlude.play: false` 关掉「玩」 | 只对她自己装了的 App 生效 |
| 省 token | `interlude.maxRoundsPerDay`、`interlude.browseDailyCap`、`memory.handoffTokens`（交班阈值，默认 150000）、`dot.phoneCheckEveryMinutes` 调大 | 每轮用量在 `~/dot/interlude/calls.jsonl`、`~/dot/memory/calls.jsonl` |
| 和别的记忆插件一起用 | `memory.coexist`：`auto`（默认）/ `people-only` / `full` | |
| 电脑审批多 / 少 | `gate.mode`：`risky`（默认）/ `browser`（每个浏览器动作都问）/ `off` | |
| 换她的家目录 | `dot.home`、`memory.home`、`interlude.home` **三处写同一个路径** | 默认 `~/dot` |
| **没有硬件虚拟化 / 不要手机** | `phone.enabled: false` | |
| 关掉某个组件 | `qq.enabled`、`memory.enabled`、`interlude.enabled`、`dot.enabled` 设 `false` | 其余组件照常 |
| **已有自己的角色，只要手机和电脑** | `dot`、`memory`、`interlude`、`qq` 四段都写 `"enabled": false` | 手机通知不再叫醒 agent，审批不推 IM；手机的提示词会随之改口，不提叫醒、表情包和记忆 |
| **不要电脑** | 只能用环境变量 `DSH_DOT_COMPUTER=off`（见下） | 电脑组件会改 dsh 的全局沙箱设置，必须在插件加载前决定，设置文件来不及 |

### 设置环境变量（只有关电脑等少数项需要）

```bash
# macOS 桌面版：设完退出并重开 dsh
launchctl setenv DSH_DOT_COMPUTER off
```

```powershell
# Windows：设完重开 dsh
setx DSH_DOT_COMPUTER off
```

## 全部键

只列常改的；完整列表和含义见各组件文档：[phone](phone.md)、[computer](computer.md)、[qq](qq.md)、[memory](memory.md)、[interlude](interlude.md)。源码里每个组件的 `defaults` 就是全集。

### `phone`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉手机 |
| `dataGb` | `16` | 存储（GB，8–256）🔒 建立时 |
| `ramMb` | `3072` | 内存 🔒 建立时 |
| `device` | `"pixel_6"` | 机型 🔒 建立时 |
| `api` / `abi` | `35` / 跟随 CPU | 系统镜像 🔒 建立时 |
| `locale` / `timezone` | `"zh-CN"` / `"Asia/Shanghai"` | 语言、时区 |
| `number` | `""` | 她的手机号，注册登录 App 用（也可用 `/phone number`；账号密码另存 `~/.dsh/dsh-dot-accounts.json`，见 [phone.md](phone.md)） |
| `window` | `true` | 显示模拟器窗口 |
| `gpu` | `"auto"` | 模拟器 GPU 模式 |
| `notifyMuted` | `[]` | 不叫醒她的包名（也可用 `/phone notify mute`） |
| `keepAppsAlive` | `true` | 不让后台 App 被冻结（聊天 App 收消息靠它） |
| `publicUrl` | `""` | 你对外暴露的 dsh 地址，用于实时画面链接 |

### `computer`

| 键 | 默认 | 作用 |
|---|---|---|
| `rootDisk` | `"16G"` | 磁盘 🔒 建立时 |
| `memory` / `cpus` | `"4G"` / `2` | 资源上限 |
| `mounts` | `[]` | 共享文件夹 |
| `backend` | `"auto"` | `microsandbox` / `docker` |
| `image` | `ghcr.io/agent-infra/sandbox:latest` | 镜像 |
| `publicUrl` | `""` | 你对外暴露的 dsh 地址 |

网关端口只能用环境变量 `DSH_COMPUTER_PORT` 改。

### `gate`

| 键 | 默认 | 作用 |
|---|---|---|
| `mode` | `"risky"` | `off` / `risky` / `browser` |

分类表（`readOnlyTools`、`alwaysAskTools`、`protectedPaths`、`shellPatterns` 等）也可以在这里覆盖，见 [computer.md](computer.md)。

### `qq`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉 |
| `backend` | `"napcat"` | `snowluma`（也可 `/qq backend`） |
| `qq` / `owner` | `""` | 她的号 / 你的号（建议用 `/qq account`、`/qq owner`） |
| `githubProxy` | `""` | GitHub 下载镜像前缀，如 `https://ghfast.top/` |
| `groupPolicy` | `"mention"` | `mention` / `score` / `all` / `none` |
| `scoreThreshold` | `7` | `score` 模式的插话门槛（0–10） |
| `sendPolicy` | `"reply"` | `reply` / `always` / `off` |
| `replyWindowMinutes` | `30` | `reply` 模式下多久内算"对方找过她" |
| `imageSeeMax` | `4` | 别人发来的图和表情包，每条消息最多给她看几张；0 只给文字 |
| `typingMsPerChar` | `60` | 分条发送的打字停顿，0 一次发完 |
| `tidy` | `true` | 去掉句号、引号、破折号等书面符号 |
| `dropLatinLeaks` | `true` | 不发整条都是英文的气泡（思考漏出来），短英文照发 |

### `memory`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉 |
| `home` | `~/dot` | 和 `dot.home`、`interlude.home` 保持一致 |
| `handoffTokens` | `150000` | 对话多长换新会话 |
| `dailyAt` | `"23:30"` | 每天整理 + 写日记的时间 |
| `coexist` | `"auto"` | `auto` / `people-only` / `full` |
| `recallBackend` | `"local"` | `local` / `siliconflow` / `dashscope` / `off`（建议用 `/dot memory recall backend`，命令设的值优先） |
| `recallModel` | `""` | 本机默认 `Xenova/multilingual-e5-small`；只用中文可填 `BAAI/bge-small-zh-v1.5`（更轻，23 MB / 约 0.13 GB）。建议用 `/dot memory recall model` |
| `recallTopK` / `recallMaxTokens` | `8` / `1500` | 每次叫醒注入多少旧对话 |
| `recallMinQueryLength` / `recallContrast` / `recallMinScore` | `4` / `0.35` / `0` | 话太少不查；命中要比整个索引的中位数高出一截；可选的绝对分数下限（和模型绑死，默认不用）。见 [memory.md](memory.md) |
| `recallMirror` | `""` | 本机模型下载镜像，默认 hf-mirror |

### `interlude`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉 |
| `home` | `~/dot` | 和另外两处保持一致 |
| `activeHours` | `"08:00-23:00"` | 活跃时段 |
| `idleMinutes` | `10` | 聊天安静多久后跑一轮 |
| `advanceEveryMinutes` | `180` | 自己过日子的间隔，0 关 |
| `maxRoundsPerDay` | `12` | 每天最多几轮 |
| `browseDailyCap` / `vmDailyCap` | `6` / `2` | 每天「去看」上限 |
| `vmSites` | `[]` | 用电脑浏览器看的网站（她登录过的） |
| `phoneApps` / `playApps` | 内置表 | 逛 / 玩的 App |
| `play` | `true` | 「玩」（点赞、评论、关注） |
| `speak` | `false` | 主动找你 |
| `maxContactsPerDay` / `willingnessThreshold` | `2` / `0.6` | 主动联系的上限和门槛 |
| `presetHub` | `https://typ0.space` | HDSI 预设站 |

### `dot`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉联系人层 |
| `home` | `~/dot` | 和另外两处保持一致 |
| `phoneCheckEveryMinutes` | `30` | 隔多久拿起手机看一眼，0 关 |
| `promptsPort` | `7870` | `/dot prompts` 提示词页面的端口（只监听 127.0.0.1） |
| `notifyHours` | `""` | 只在这个时段内通知叫醒她；空 = 一直 |
| `notifyBatchMs` | `1000` | 多少毫秒内的通知合并成一次叫醒（别人的；你的话见下面四项） |
| `ownerQuietMs` | `1500` | 你的 QQ 消息：你停下多少毫秒没新消息才送给她，每来一条重新计时 |
| `ownerMaxWaitMs` | `6000` | 你一直不停时，最多从第一条起等多少毫秒 |
| `ownerTypingMaxMs` | `15000` | QQ 报「正在输入」（NapCat）时最多等多少毫秒 |
| `ownerDenyMax` | `2` | 你有她没看的话时，她发给你的 `qq_send` 每轮最多被拦几次 |
| `errandMaxTokens` | `60000` | 跑腿会话多长换新 |
| `approvalWaitMs` | `600000` | 她的会话里要审批时立刻告诉你（QQ 连着发 QQ，否则 IM）；这么久没人点就当拒绝，再告诉你一句过期了；0 = 一直等 |
| `imBot` / `imTarget` | `""` | dsh-im 的投递目标，空 = 第一个 |

## 优先级和旧文件

从弱到强：组件默认值 → 旧的单组件文件（`~/.dsh/dsh-phone.json`、`dsh-computer.json`、`dsh-qq.json`）→ 插件自带的 `cordis.patch.yml` → **`dsh-dot.json`** → 命令设的值（`/phone size`、`/phone accept`、`/phone number`、`/dot memory recall …` 写进 `dsh-phone.json` / `dsh-memory.json`）。

旧文件继续有效，不用迁移；新设置写进 `dsh-dot.json` 就行。不要去改 `node_modules` 里插件自带的 `cordis.patch.yml`，升级会被覆盖。
