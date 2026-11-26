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
| 她自己的时间多久来一次 | `interlude.idleMinutes`（你上一句话、或她的一天开始之后安静多久来一次，默认 30）、`interlude.freeTimesPerDay`（每天最多几次，默认 2，`0` 关） | 来过一次就要等你再找她、或第二天；她可以在那段时间里自己留一个「下次」（`later`）。她自己做的事不推迟它 |
| 省 token | `interlude.freeTokenCap` / `freeDailyTokens`（自己的时间每次 / 每天的上限，她的手替她做的事算在里面）、`dot.thingCostCap`（一件事花到多少就停下问你）、`memory.handoffTokens`（交班阈值，默认 200000） | 三个上限的单位都是**折算 token**（见下「花费怎么算」）。每天的用量在 dot 面板，按官方价估的钱数在旁边；记忆的调用在 `~/dot/memory/calls.jsonl` |
| 模型额度用完 / API key 失效 | 不用设：插件用自己的名义告诉你一次是哪一种（不是「她出错了」），后台的请求（整理记忆、写经验、她自己的事）先不发，直到有一次请求成功、或提供方给的恢复时间到了 | 充值或改好 key 以后给她发一句话就接着。同一类出错提示 `dot.failureNoticeMs`（10 分钟）内只发一次 |
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
| `leaseIdleMs` / `leaseWaitMs` | — | 不再读取（11-26）。谁在用手机由 dot 管：她的手做一件事时从头占到尾；别的会话（如 qq-bridge 管理员私聊）直接用手机时占着，那一轮结束或 2 分钟不碰就放开；占着时别人当场被拒，不等 |
| `keepAppsAlive` | `true` | 不让后台 App 被冻结（聊天 App 收消息靠它） |
| `publicUrl` | `""` | 你对外暴露的 dsh 地址，用于实时画面链接 |

### `computer`

| 键 | 默认 | 作用 |
|---|---|---|
| `rootDisk` | `"16G"` | 磁盘 🔒 建立时 |
| `memory` / `cpus` | `"4G"` / `2` | 资源上限 |
| `mounts` | `[]` | 共享文件夹（空 = 只有 `~/dsh-computer/workspace`） |
| `autoShare` | `false` | 命令在哪个文件夹跑就把那个文件夹共享进电脑。默认关：只共享 `mounts`，以前自动共享进去的会在下次开机时撤掉（11-26：`~/dot` 和 `~/Documents/okx` 曾这样被带进电脑） |
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
| `handoffTokens` | `200000` | 对话多长换新会话（11-26 从 6 万提到 20 万：交接一次要整理一回记忆、她只带走最后 12 句原话；V4.1-Flash 有 100 万的窗口，多重发的部分几乎都命中缓存） |
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

### 花费怎么算

一次模型调用的花费由 `src/price.js` 算，一件事、自己的时间、面板和 `/dot` 用的是同一个算法：

- **钱**：按调用时的官方价。内置的价目表只有一行，DeepSeek 官方的 `deepseek-flash`（DeepSeek-V4.1-Flash，provider `deepseek-account` 或 `deepseek`），元/百万 token：

  | | 空闲时段 | 高峰时段 |
  |---|---|---|
  | 输入，缓存命中 | 0.02 | 0.04 |
  | 输入，缓存未命中 | 1.00 | 2.00 |
  | 输出（含思考） | 4.00 | 8.00 |

  高峰时段是北京时间周一至周五 9:00–12:00、14:00–18:00，其余（含周末）是空闲。落在工作日的法定节假日这里不认得，按高峰算（只会多估）。面板和 `/dot` 上的钱数标着「按官方价估」，是按这张表算的，不是账单。
- **折算 token**：同一次调用按**空闲价**、以「缓存未命中的输入」为 1 折算的数：缓存命中 0.02、输出 4。它不随时段变，所以 `dot.thingCostCap`、`interlude.freeTokenCap` / `freeDailyTokens` 用它：同样的活在上午和晚上停在同一个地方。100 万折算 token = 空闲时段 1 元、高峰时段 2 元（三样价格高峰都正好翻倍）。
- **表里没有的模型**（也没设 `interlude.price`）：每个 token 都算 1（缓存不打折），不显示钱数；日志里说一次，`/dot` 一直有一行写着这个模型没有价格。
- 0.25.2 以前缓存命中按 0.1、输出按 1 算：缓存多算了 5 倍、输出少算了 4 倍。上限的名字和单位名都没变，你在 `dsh-dot.json` 里自己写过的值照新的算法解释，不换算（两种算法之比看这件事里缓存和输出各占多少，换不准）：缓存占大头的活（一般都是）同一个数现在放过的钱约是以前的 1.3–2 倍，输出占得多的少一些。默认值已经按这个重新定过（见 DESIGN.md「11-26 补：按实际花费计」）；想按钱定上限，用上面「100 万 ≈ 空闲 1 元」来定。

### `interlude`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉 |
| `home` | `~/dot` | 和另外两处保持一致 |
| `idleMinutes` | `30` | 他上一句话（或她的一天开始）之后安静这么久，来一次「自己的时间」；她自己做的事不推迟它 |
| `price` | `null` | 你自己的价格 `{ in, cached, out }` 元/百万 token（`cached` 不写按 `in` 算）：给了就代替内置价目表，用于所有模型、所有时段（不分高峰），三个上限的折算也跟着它（以 `in` 为 1）；她的账上也就有钱数。`null`：用内置的 DeepSeek 官方价，她的账上只有 token 数（见下「花费怎么算」） |
| `freeTimesPerDay` / `freeTokenCap` / `freeDailyTokens` | `2` / `100000` / `200000` | 「自己的时间」：每天最多几次（`/interlude free` 不算）、每次和每天的折算 token 上限（她的手替她做的事算在里面，到了上限这一轮停、手在这件事上的下一步也被拒）；`0` 次关。10 万 ≈ 空闲时段 0.1 元 |
| `presetHub` | `https://typ0.space` | HDSI 预设站 |

### `dot`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉联系人层 |
| `home` | `~/dot` | 和另外两处保持一致 |
| `phoneHomeAfterMs` | `180000` | 她在手机上的最后一步过后这么久，手机自己回到桌面（开在前台的 App 不出通知）；这之前接着做下一步就留在原地。App 不关，再打开还在原来那一页。0 = 不回 |
| `handsMaxMs` | `600000` | 她的手做一件事（或她回答之后接着做的那一段）最长多久；超过就停，记为超时，带着手最后说的回来 |
| `reachUnansweredMs` | `7200000` | 她主动发给你的一条过了这么久你没回，在她对话里留一句事实「那条他没回」；0 = 不留 |
| `replyCheck` | `true` | 她说出去的话先过代码检查（`~/dot/persona.checks.txt`）：括号里的动作描写去掉；命中清单的句子，替她说话的那次调用重写一次，第二次照发；她的手要打出去的话命中了，退回给她换个说法 |
| `lean` | `true` | 她的新对话用插件自带的 `dot` 预设来建（第一次开、每次交接）：宿主的工具只带读写自己的文件、定时、目标（查资料交给手：`hands` 的 `device: web`）；加上插件自己的 `hands`、`say`、`his_ok`、`qq_sticker_keep`、`memory`、`recall`、`later` 和她 QQ 的 action。提示词也只留插件为她写的几段。已有的对话不变（预设是建会话时定的）；想马上换：`/dot memory handoff`。宿主不认这个预设时照旧建会话 |
| `nightcheck` | `true` | 她睡着时把手艺簿对着记账核对一遍并照着改（教训里的原因推测去掉、和后来记录对不上的去掉；改之前的原样留在 `~/dot/her/howto/_nightcheck.json`）。`false`：只在 `/dot nightcheck` 时核对，`/dot nightcheck apply` 才改 |
| `howto` / `howtoMinSteps` / `howtoMaxChars` | `true` / `12` / `800` | 手艺簿（`~/dot/her/howto/`）：她的手做一件事时按地方（手机本身、各个 App、电脑）记步数，一件事结束按地方各记一行（步数、错、记账里的结果、用时、花费）；出过错、没做成或太久、或步数明显比平常多（≥ `howtoMinSteps`）的地方，一次小调用重写那里的笔记（教训、捷径，≤ `howtoMaxChars` 字），并给这件事起个短名，好看同一件事是不是越做越快、越省。一件事里第一次到某个地方，那里的笔记跟着给手——最多给 `howtoMaxChars` 字（笔记文件本身她可以写得更长，给手时截到这么多，后面写「还有 N 字没给」）。`/dot howto [<地方>]` 看 |
| `thingCostCap` | `1000000` | 一件事花到这么多折算 token 就停下，变成一件要你点头的事（「还要接着做吗」）；0 = 不管。100 万 ≈ 空闲时段 1 元、高峰时段 2 元 |
| `handsStuckHoldMs` | `1800000` | 一件事停在要人来的地方，手机这么久不回桌面（屏幕留着，接着做时还在那一页） |
| `ackHoldMs` | `15000` | 你的话让她去做一件事时，回你之前等多久：到点时你要的事都做完了，就只回一次、带着结果；还在做，就先说一声在弄；这期间你又说话，就不单独回 |
| `sayDetailChars` | `800` | 一件事做完，替她说话那次调用拿到的细节（手在 `done` 里写的 `detail`）最多多少字；结果只从事情簿来，她自己那句话只写看法 |
| `sayPast` / `sayPastWaitMs` | `4` / `1500` | 替她说话那次调用（`回他` 的那种，不是事情簿的汇报）另外看几段以前聊到差不多的事时她是怎么回的：按他最后一句话从记忆里找（她先开口时按她想说的意思找），只取她回完他又接着说下去（半小时内）的那几段、在她看得到的最近对话之前的；每边最多 200 字。只当说话的样子看，不照抄。找最多等 `sayPastWaitMs` 毫秒，到点没找到就不带。recall 关着就没有。0 = 不看 |
| `sameErrorNudge` / `sameErrorStop` | `3` / `6` | 她的手在一件事里连着碰到同一类错误（网址不算在内）：到第一个数，提醒它换一个完全不同的办法，或用 `done` 照实收尾（`reached: false`）；到第二个数，代码把这件事停下，记为没做成（`same-error`）。中间有一步成了就重新数；0 = 不管 |
| `replayKeep` | `0` | 留下她的对话最近这么多次发给模型的完整请求（system 各段、消息、工具声明、模型和思考强度；按发出时的样子），供 `/dot replay <文件\|latest> [次数]` 原样重发、只记不做（结果写在旁边的 `.out.json`）。存在 `~/.dsh/dot-replay/decide/`，每份带 system 和工具表的指纹（`systemSha`、`toolsSha`）；只留最新这么多份。**含对话全文**，0 = 不留（默认，也不挂任何钩子）。想长期留一份就拷到 `~/.dsh/dot-replay/` 下，`/dot replay <文件名>` 也认那里 |
| `promptsPort` | `7870` | `/dot prompts` 提示词页面的端口（只监听 127.0.0.1） |
| `awakeHours` | `"08:00-23:00"` | 她平时的作息（可跨午夜；`"00:00-24:00"` = 不睡，一天在零点结束）。写错格式按默认 |
| `sleepAfterQuietMinutes` | `30` | 过了平时的点，安静多久算睡着 |
| `notifyBatchMs` | `1000` | 多少毫秒内的通知合并成一次叫醒（有人发来的：她 QQ 上的人、聊天 App 和短信里的对话、App 标成消息或来电的；你的话见下面四项） |
| `pushesKept` | `12` | App 自己的推送（不是人发来的）不叫醒她：留最近这么多条，下次不管什么叫醒她时一起给她看一次 |
| `ownerQuietMs` | `1500` | 你的 QQ 消息：你停下多少毫秒没新消息才送给她，每来一条重新计时 |
| `ownerMaxWaitMs` | `6000` | 你一直不停时，最多从第一条起等多少毫秒 |
| `ownerTypingMaxMs` | `15000` | QQ 报「正在输入」（NapCat）时最多等多少毫秒 |
| `ownerPreemptMax` | `2` | 先读再说，一个数管所有出口：她的话还没到你那、你又说了话时，她连着最多让几次（重来这一轮、或这次先不说）；之后先发出去。她的话有一条到了你那就清零 |
| `loopRepeat` | `5` | 一轮里同一个工具、参数几乎一样（忽略空白和数字）调这么多次后，再调就被拦下，让她换个办法或说明卡在哪（记 `loop-stopped`）；0 关 |
| `interludeQueueMax` | `3` | 她自己时间里的事（`interlude` 交来的）一次一段，在她的对话里做，只在她没有别的事（没在写、没在发、手上没事、没有你的话在路上）时开始；排满这么多件，最早的作废（`dropped`） |
| `interludeTaskTtlMs` | `1800000` | 排队这么久还没轮到就作废（`expired`） |
| `turnStallMs` | `300000` | 她的一轮这么久没有任何会话事件就算卡住：记 `turn-stalled`，面板标「卡住」；是她的对话就告诉你一次（不替她取消） |
| `ownerLostMs` | `45000` | 你的话交给她的对话之后这么久没有哪一轮接到（当时也没有轮次在跑），算没接到，以插件的名义告诉你 |
| `failureNoticeMs` | `600000` | 出错提示（这一轮出错、没接到、额度用完、key 失效）多久内最多发一次 |
| `waitMaxMs` / `awaitMs` | `120000` / `86400000` | 手等屏幕上出现 / 消失某几个字或等一条通知（`wait_for`），一次最多等多久；一件事发出去在等别人回，事情簿上记着等多久 |
| `imBot` / `imTarget` | `""` | dsh-im 的投递目标，空 = 第一个 |

### `llm`（模型请求闸门，`src/llm-gate.js`）

她后台的模型请求（整理记忆和日记、手替她自己做事的会话、群聊评分、App 经验整理）和你们的对话共用同一个 provider 的 key；手替你做的事算在你们的对话这边，不被压。这道闸门在每个请求前面：只压后台的，你们的对话（以及认不出来的请求）照常发。每个 provider 分开算。`/dot` 和 dot 页面「状态」里能看到近一分钟的请求数、后台上限、是否在冷却。

| 键 | 默认 | 作用 |
|---|---|---|
| `workEffort` | `high` | 她后台干活的思考强度：记忆整理和日记、手艺簿的整理和核对。和对话分开——dsh 只有一个模型选择器，在任何对话里改思考强度都会变成全局默认；以前这些后台请求读的就是那个默认，把聊天的思考关掉等于把它们的也关了。可选 `off` / `low` / `high` / `max`，`''` = 跟随选择器。模型不支持所选强度时（问宿主一次）也跟随，不会发出被拒的请求。QQ 群聊评分固定 `off`。实际发出的强度在 `/dot` 的 model requests 一行（`thinking: chat …, background …`）里。她的对话和手各有自己的强度（`dot.herEffort`、`dot.handsEffort`，默认 `low`），替她说话的那次调用是 `dot.sayEffort`（默认 `off`） |
| `backgroundRpm` | `20` | 后台请求每分钟最多几次（近 60 秒内所有请求都算进去，但只压后台的；间隔至少 60/上限 秒，一次放一个）。`0` = 不限速（只计数） |
| `foregroundQuietSeconds` | `15` | 你们的对话有请求在发时后台不发（一个请求开着超过 10 分钟就当它已经被丢下）；发完后再等这么多秒（她一轮有好几步） |
| `maxBackgroundWaitSeconds` | `180` | 一个后台请求最多被压后多久，到了就放行。最多 270（比 `dot.turnStallMs` 的 300 秒短，手不会被当成卡住；填更大也按 270） |
| `holdRetries` | `true` | 你们的对话被限流（429）后，dsh 自己的快速重试（几秒内连试 5 次，都在同一分钟里）先等到这一分钟有余量（或 provider 给的 retry-after）再发 |
| `retryHoldMaxSeconds` | `30` | 上一项最多等多久 |

被限流（任何请求收到 `RATE_LIMIT`）时：后台至少停到最近一次被拒后的 60 秒，后台上限减半（最少 1）。60 秒内的再次被拒（一批一起被拒、dsh 的几次重试）算同一次；过了这一分钟又被拒才算再一次：再减半，冷却加倍（带随机抖动，最多 10 分钟）；provider 给了 retry-after 就按它。3 分钟没再被限流后每分钟加回 1。冷却开始和结束各记一行日志和审计（`kind: llm-gate`）。

额度或余额用完（`QUOTA`）、登录或 API key 用不了（`AUTH` 一类）时，不是冷却：每个请求都会一样失败，直到你去处理。所以后台请求一个都不发（当场按同一个错误结束，`/dot` 的 model requests 一行写着 `account quota since …`），直到这个 provider 有一次请求成功，或者提供方给的恢复时间到了（到时放一个出去试）；dot 用插件自己的名义告诉你一次是哪一种、怎么办（`dot.account.quota` / `dot.account.auth`），不写成她说的话。审计 `account-held` / `account-resumed`。

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
