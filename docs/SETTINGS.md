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
2. 顶层按组件分段：`phone`、`computer`、`gate`、`qq`、`memory`、`interlude`、`dot`、`compat`，外加不属于哪个组件的 `llm`（模型请求闸门）。键名和类型照下面的表，不要发明新键。
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
  "interlude": { "freeTimesPerDay": 2 },
  "dot": { "awakeHours": "09:00-01:00" }
}
```

## 常见需求

| 我想… | 改什么 | 注意 |
|---|---|---|
| **手机存储大一点** | 建手机前：`/phone size 32`，或 `/phone accept 32`，或 `phone.dataGb`（8–256） | 🔒 建立时。手机建好后**扩不了**（改 AVD 的 `config.ini` 实测无效）。已经满了：卸 App、清 App 数据；或者删掉 `~/.dsh/phone/avd/dot.avd/` 和 `dot.ini` 重建（手机里的 App 和登录全丢），重建前先 `/phone size <GB>` |
| 手机内存 / 机型 / 语言 / 时区 | `phone.ramMb`、`phone.device`、`phone.locale`、`phone.timezone` | `ramMb`、`device` 🔒 建立时（同上，删 AVD 重建） |
| 也弹出模拟器自己的窗口 | `phone.window: true` | 默认不弹，画面在 dsh 的手机标签页和 dot 页面看 |
| 关掉手机 / 电脑 | dot 页面顶部的开关，或 `/phone off`、`/computer off` | 立刻关机，重启 dsh 也保持关着；`on` 再开。组件仍然加载着，只是机器不开 |
| **电脑磁盘大一点** | `computer.rootDisk`，如 `"32G"` | 🔒 建立时。已有虚拟机扩不了，要重建：`msb rm -f dsh-computer` 并删 `~/.microsandbox/snapshots/dsh-computer/`（见 [computer.md](computer.md#六维护)），装过的东西和 QQ 登录会丢。0.11.3 之前建的虚拟机只有约 4 GB |
| 电脑内存 / CPU | `computer.memory`（如 `"6G"`）、`computer.cpus` | 重启 dsh 生效 |
| 电脑里 QQ 报 `no space left` / `ENOSPC` | 先 `/qq clean`（清缓存和残留），还不够 `/qq clean napcat`（用 SnowLuma 时删掉 NapCat） | 根治是加大 `computer.rootDisk` 重建 |
| 共享文件夹给电脑 | `computer.mounts: ["/Users/你/Projects/a"]` | |
| 国内网络下载慢 | QQ 安装：`qq.githubProxy`；召回模型：`/dot memory recall mirror <url>`（默认已走 hf-mirror）；虚拟机镜像：`computer.image` 换镜像源 | |
| 召回换云端 / 关掉 | `/dot memory recall backend siliconflow`，再 `/dot memory recall key siliconflow <key>` | 命令即时生效，不用重启，也不用改这个文件 |
| **她的作息** | `dot.awakeHours`（她平时醒着的时段，默认 `"08:00-23:00"`，可跨午夜）、`dot.sleepAfterQuietMinutes`（过点后安静多久算睡着，默认 30） | 睡觉是她的状态，不是钟点：过了点还在聊就还没睡；安静满这么久才睡着，这之前来的通知照常到她、重新计时。睡着后只有你能叫醒（别人的通知留到她醒来一起给）；到平时的点自己醒。醒来的第一轮告诉她睡了多久。睡着后写当天的日记、整理记忆；不开「自己的时间」 |
| 她主动找你 | 没有开关，也没有次数上限：她在自己的时间里想说就说。她眼前有今天主动了几次、你回了几次、上一条回没回（`dot.reachUnansweredMs` 过了多久算没回，默认 2 小时） | 找不找、多频繁由她自己从你的反应里学 |
| 她什么时候看手机 | 没有定时：手机来了新通知就原样给她看一眼（哪个 App、标题、正文），点不点由她定；没有新通知不叫她。想逛是「自己的时间」里的事 | 0.24.2 起；以前每 30 分钟叫她看一次 |
| 某个 App 的通知别叫醒她 | `/phone notify mute <包名>` | 命令即时生效 |
| 群聊里插话的规则 | `qq.groupPolicy`：`mention`（被 @ 才回，默认）/ `score`（按价值评分，配 `qq.scoreThreshold` 0–10）/ `all` / `none` | |
| 回复不拆条、不模拟打字 | `qq.typingMsPerChar: 0` | |
| 发 QQ 的审批松紧 | `qq.sendPolicy`：`reply`（默认）/ `always` / `off` | |
| 她逛 / 玩的 App | `interlude.phoneApps`（站点 → 包名）、`interlude.playApps`（名字 → 包名）、`interlude.play: false` 关掉「玩」 | 只对她自己装了的 App 生效 |
| 省 token | `interlude.maxRoundsPerDay`、`interlude.browseDailyCap`、`memory.handoffTokens`（交班阈值，默认 150000） | 每轮用量在 `~/dot/interlude/calls.jsonl`、`~/dot/memory/calls.jsonl` |
| 和别的记忆插件一起用 | `memory.coexist`：`auto`（默认）/ `people-only` / `full` | |
| **和她聊天时报 429 / `rate limit reached for RPM`** | `llm.backgroundRpm` 调小（默认 20，她后台的请求每分钟最多几次；你们的对话不受限） | 被限流后闸门自己会减半、冷却，`/dot` 有一行「model requests」看近一分钟的请求数 |
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
| `window` | `false` | 另外弹出模拟器自己的窗口 |
| `power` | `true` | 电源开关（见上） |
| `gpu` | `""` | 渲染方式。空 = Windows 用 `swiftshader_indirect`（软件渲染：显卡渲染在部分 Windows 上会崩，0xC0000005），其他系统 `auto`；也可填 `auto` / `host` / `angle_indirect` |
| `connectivityCheck` | `"cn"` | 安卓判断"有没有网"的检测地址：`cn` = `connect.rom.miui.com/generate_204`（国内能访问；默认的 Google 地址国内访问不了，会显示"连接受限"），`google` = 系统默认，或自填返回 204 的地址 |
| `dnsServer` | `""` | 给模拟器指定 DNS，如 `223.5.5.5`；空 = 用电脑的。校园网等封了外部 DNS 的网络必须留空 |
| `proxy` | `""` | 手机的流量走代理：`system` = 电脑的系统代理，或 `http://host:port`；空 = 不走 |
| `bootTimeoutMs` / `bootSlowMs` | `600000` / `300000` | 开机超时 / 超过这么久显示"开机较慢"（毫秒） |
| `quickBoot` | `false` | Quick Boot 快照（退出存、启动读）。默认关：每次冷启动，慢一些，但被强杀后不会读到写了一半的快照 |
| `adbPort` | `5137` | 插件自己的 adb server 端口，避开 MuMu、雷电、手机助手等自带旧 adb 占用的 5037；`0` = 用 5037 |
| `notifyMuted` | `[]` | 不叫醒她的包名（也可用 `/phone notify mute`） |
| `notifyCatchUpMs` | `43200000`（12 小时） | dsh 没开时到的通知，重启后这么久以内的照样叫醒她；更早的不叫 |
| `leaseIdleMs` | `120000` | 同一时间只有一件事在用手机：占着的那件事这么久没碰手机（或它这一轮结束）就让出来 |
| `leaseWaitMs` | `60000` | 别的事要用手机时最多等这么久，等不到就告诉她稍后再试；和你的对话排在最前 |
| `keepAppsAlive` | `true` | 不让后台 App 被冻结（聊天 App 收消息靠它） |
| `publicUrl` | `""` | 你对外暴露的 dsh 地址，用于实时画面链接 |

### `computer`

| 键 | 默认 | 作用 |
|---|---|---|
| `rootDisk` | `"16G"` | 磁盘 🔒 建立时 |
| `memory` / `cpus` | `"4G"` / `2` | 资源上限 |
| `mounts` | `[]` | 共享文件夹 |
| `backend` | `"auto"` | `microsandbox` / `docker` |
| `power` | `true` | 电源开关：`false` = 关机，重启 dsh 也保持关着（dot 页面顶部的开关、`/computer on`、`/computer off`） |
| `image` | 国内镜像 `enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest` | 镜像（作者官方的国内镜像，与 `ghcr.io/agent-infra/sandbox:latest` 同一镜像；海外用户可改回 ghcr）🔒 建立时 |
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
| `ignore` | `""` | 不回复的 QQ 号（别的机器人），逗号或空格分开；qq-bridge 的机器人号自动认出，不用填 |
| `loopMax` | `4` | 防互刷（只管群聊）：一个群里和同一个号一来一回这么多轮、中间没别人说话，就暂停理它；0 关 |
| `loopCooldownMinutes` | `10` | 防互刷暂停多久 |

### `memory`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉 |
| `home` | `~/dot` | 和 `dot.home`、`interlude.home` 保持一致 |
| `handoffTokens` | `150000` | 对话多长换新会话 |
| `consolidateEveryLines` | `120` | 新记录攒满多少行整理一次（每天写日记前、交班前也各整理一次） |
| `limits` | `{ owner: 1375, self: 2200, open: 800, impression: 80 }` | 三栏笔记各多少字（关于他 / 她自己：硬上限，放不下的加不进去，满了要记新的就换掉一条；还没了的事是每轮显示多少，存的不限）、人物印象多少字 |
| `openKeepDaysAfterDue` | `3` | 还没了的事过了到期日几天后拿掉 |
| `openKeepDaysIdle` | `14` | 没日子的还没了的事多少天没被碰过就拿掉 |
| `coexist` | `"auto"` | `auto` / `people-only` / `full` |
| `recallBackend` | `"local"` | `local` / `siliconflow` / `dashscope` / `off`（建议用 `/dot memory recall backend`，命令设的值优先） |
| `recallModel` | `""` | 本机默认 `Xenova/multilingual-e5-small`；只用中文可填 `BAAI/bge-small-zh-v1.5`（更轻，23 MB / 约 0.13 GB）。建议用 `/dot memory recall model` |
| `recallRerankModel` | `""` | 默认不重排。填名字打开：本机 `BAAI/bge-reranker-base`（279 MB）或 `BAAI/bge-reranker-v2-m3`（更强更慢，571 MB）。建议用 `/dot memory recall rerank` |
| `recallTopK` / `recallMaxTokens` | `30` / `1500` | 最多注入几轮、多少 token（只给他那边的话，不带她的回复；可以更少，不凑数） |
| `recallRecentTurns` / `recallNeighbors` | `20` / `1` | 窗口之前最近多少轮单独算一路名单（`0` 关掉）；预算有余量时，每条命中前后各带几轮（`0` 关掉） |
| `recallCandidates` | `20` | 设了重排模型时，向量、BM25 各交给它多少候选 |
| `recallRerankMin` | `0` | 重排分（0–1）的可选门槛；0 = 只看重排的顺序 |
| `recallMinQueryLength` / `recallContrast` / `recallMinScore` | `4` / `0.35` / `0` | 话太少不查；每一路的命中要比整个索引的中位数高出一截；可选的余弦下限（都只在不重排时用）。见 [memory.md](memory.md) |
| `recallLexical` | `true` | BM25 那一路候选（汉字 + 两字）；`false` 只用向量 |
| `recallMirror` | `""` | 本机模型下载镜像，默认 hf-mirror |
| `facts` | `true` | 事实条（memory.md）：整理时把以后用得上的事各写成一句话，他叫醒她时挑出用得上的几条给她看；`false` 或环境变量 `DSH_DOT_FACTS=off` 关掉 |
| `factsShown` / `factsPicked` / `factsWaitMs` | `60` / `6` / `8000` | 挑的那次调用读多少条；最多几条进她的提示词；提示词拼装最多等它多久 |

### `interlude`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉 |
| `home` | `~/dot` | 和另外两处保持一致 |
| `idleMinutes` | `10` | 她上一轮结束后这么久之内不开「自己的时间」 |
| `price` | `null` | `{ in, cached, out }` 元/百万 token；给了她的账上就有钱数 |
| `freeTimesPerDay` / `freeTokenCap` / `freeDailyTokens` | `2` / `150000` / `300000` | 「自己的时间」：每天几次、每次和每天的 token 上限；`0` 次关 |
| `presetHub` | `https://typ0.space` | HDSI 预设站 |

### `dot`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉联系人层 |
| `home` | `~/dot` | 和另外两处保持一致 |
| `phoneHomeAfterMs` | `180000` | 她在手机上的最后一步过后这么久，手机自己回到桌面（开在前台的 App 不出通知）；这之前接着做下一步就留在原地。App 不关，再打开还在原来那一页。0 = 不回 |
| `handsMaxMs` | `360000` | 她的手做一步最长多久；超过就停，带着已经说的回来 |
| `reachUnansweredMs` | `7200000` | 她主动发给你的一条过了这么久你没回，在她对话里留一句事实「那条他没回」；0 = 不留 |
| `replyCheck` | `true` | 她说出去的话先过代码检查（`~/dot/persona.checks.txt`）：括号里的动作描写去掉，命中清单的句子每轮打回一次让她重说 |
| `lean` | `true` | 她的新对话用插件自带的 `dot` 预设来建（第一次开、每次交接）：宿主的工具只带读写自己的文件、定时、目标（查资料交给手：`hands` 的 `device: web`）；加上插件自己的 `hands`、`qq_send`、`qq_sticker_keep`、`memory`、`recall`、`keep_line` 和她 QQ 的 action。提示词也只留插件为她写的几段。已有的对话不变（预设是建会话时定的）；想马上换：`/dot memory handoff`。宿主不认这个预设时照旧建会话 |
| `howto` / `howtoMinSteps` / `howtoMaxChars` | `true` / `12` / `800` | 她自己的 App 经验（`~/dot/her/howto/`）：每轮按 App 记步数；走了 `howtoMinSteps` 步以上或出过错的那轮，结束后一次小调用整理这个 App 的笔记（教训、捷径）；之后一个会话里第一次打开这个 App 时笔记跟着给她。`/dot howto` 看每个 App 的步数变化 |
| `promptsPort` | `7870` | `/dot prompts` 提示词页面的端口（只监听 127.0.0.1） |
| `awakeHours` | `"08:00-23:00"` | 她平时的作息（可跨午夜；`"00:00-24:00"` = 不睡，一天在零点结束）。写错格式按默认 |
| `sleepAfterQuietMinutes` | `30` | 过了平时的点，安静多久算睡着 |
| `notifyBatchMs` | `1000` | 多少毫秒内的通知合并成一次叫醒（别人的；你的话见下面四项） |
| `ownerQuietMs` | `1500` | 你的 QQ 消息：你停下多少毫秒没新消息才送给她，每来一条重新计时 |
| `ownerMaxWaitMs` | `6000` | 你一直不停时，最多从第一条起等多少毫秒 |
| `ownerTypingMaxMs` | `15000` | QQ 报「正在输入」（NapCat）时最多等多少毫秒 |
| `ownerPreemptMax` | `2` | 先读再说，一个数管所有出口：她的话还没到你那、你又说了话时，她连着最多让几次（重写这一轮、把写好的回答留作草稿、或拦下一条 `qq_send`）；之后先发出去。她的话有一条到了你那就清零 |
| `loopRepeat` | `5` | 一轮里同一个工具、参数几乎一样（忽略空白和数字）调这么多次后，再调就被拦下，让她换个办法或说明卡在哪（记 `loop-stopped`）；0 关 |
| `interludeQueueMax` | `3` | 她自己时间里的事（`interlude` 交来的）一次一件，在她的对话里做，只在没有别的事时开始；排满这么多件，最早的作废（`dropped`） |
| `interludeTaskTtlMs` | `1800000` | 排队这么久还没轮到就作废（`expired`） |
| `turnStallMs` | `300000` | 她的一轮这么久没有任何会话事件就算卡住：记 `turn-stalled`，面板标「卡住」；是她的对话就告诉你一次（不替她取消） |
| `approvalWaitMs` | `600000` | 她的会话里要审批时立刻告诉你（QQ 连着发 QQ，否则 IM；一轮只发第一条，后面的只计数）；这么久没人点就当拒绝，再告诉你一句过期了；0 = 一直等 |
| `imBot` / `imTarget` | `""` | dsh-im 的投递目标，空 = 第一个 |

### `llm`（模型请求闸门，`src/llm-gate.js`）

她后台的模型请求（整理记忆和日记、手的会话、群聊评分、App 经验整理）和你们的对话共用同一个 provider 的 key。这道闸门在每个请求前面：只压后台的，你们的对话（以及认不出来的请求）照常发。每个 provider 分开算。`/dot` 和 dot 页面「状态」里能看到近一分钟的请求数、后台上限、是否在冷却。

| 键 | 默认 | 作用 |
|---|---|---|
| `workEffort` | `high` | 她后台干活的思考强度：记忆整理和日记、用法笔记的回顾、手的会话。和对话分开——dsh 只有一个模型选择器，在任何对话里改思考强度都会变成全局默认；以前这些后台请求读的就是那个默认，把聊天的思考关掉等于把它们的也关了。可选 `off` / `low` / `high` / `max`，`''` = 跟随选择器。模型不支持所选强度时（问宿主一次）也跟随，不会发出被拒的请求。QQ 群聊评分固定 `off`。实际发出的强度在 `/dot` 的 model requests 一行（`thinking: chat …, background …`）和幕间 `calls.jsonl` 的 `effort` 里 |
| `backgroundRpm` | `20` | 后台请求每分钟最多几次（近 60 秒内所有请求都算进去，但只压后台的；间隔至少 60/上限 秒，一次放一个）。`0` = 不限速（只计数） |
| `foregroundQuietSeconds` | `15` | 你们的对话有请求在发时后台不发（一个请求开着超过 10 分钟就当它已经被丢下）；发完后再等这么多秒（她一轮有好几步） |
| `maxBackgroundWaitSeconds` | `180` | 一个后台请求最多被压后多久，到了就放行。最多 270（比 `dot.turnStallMs` 的 300 秒短，手不会被当成卡住；填更大也按 270） |
| `holdRetries` | `true` | 你们的对话被限流（429）后，dsh 自己的快速重试（几秒内连试 5 次，都在同一分钟里）先等到这一分钟有余量（或 provider 给的 retry-after）再发 |
| `retryHoldMaxSeconds` | `30` | 上一项最多等多久 |

被限流（任何请求收到 `RATE_LIMIT`）时：后台至少停到最近一次被拒后的 60 秒，后台上限减半（最少 1）。60 秒内的再次被拒（一批一起被拒、dsh 的几次重试）算同一次；过了这一分钟又被拒才算再一次：再减半，冷却加倍（带随机抖动，最多 10 分钟）；provider 给了 retry-after 就按它。3 分钟没再被限流后每分钟加回 1。冷却开始和结束各记一行日志和审计（`kind: llm-gate`）。

### `compat`（和 qq-bridge 共处，见 [qq-bridge.md](qq-bridge.md)）

| 键 | 默认 | 作用 |
|---|---|---|
| `qqBridge` | `"auto"` | `auto` 装了 qq-bridge 就认 / `true` / `false` |
| `qqBridgeRoot` | `""` | 自动找不到时填它的目录 |
| `ownerDevices` | `true` | qq-bridge closed-agent 模式的管理员私聊能用她的手机和电脑 |
| `ownerComputer` | `"vm"` | 那个私聊里的命令：`vm` 她的电脑（不共享它的目录）/ `host` 本机 |
| `hideBridgeTools` | `true` | 她的会话里不出现 qq-bridge 的 MCP 工具 |
| `refreshMs` | `5000` | 多久重读一次它的配置 |

## 优先级和旧文件

从弱到强：组件默认值 → 旧的单组件文件（`~/.dsh/dsh-phone.json`、`dsh-computer.json`、`dsh-qq.json`）→ 插件自带的 `cordis.patch.yml` → **`dsh-dot.json`** → 命令设的值（`/phone size`、`/phone accept`、`/phone number`、`/dot memory recall …` 写进 `dsh-phone.json` / `dsh-memory.json`）。

旧文件继续有效，不用迁移；新设置写进 `dsh-dot.json` 就行。不要去改 `node_modules` 里插件自带的 `cordis.patch.yml`，升级会被覆盖。
