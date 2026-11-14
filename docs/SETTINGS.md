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
| 也弹出模拟器自己的窗口 | `phone.window: true` | 默认不弹，画面在 dsh 的手机标签页和 dot 页面看 |
| 关掉手机 / 电脑 | dot 页面顶部的开关，或 `/phone off`、`/computer off` | 立刻关机，重启 dsh 也保持关着；`on` 再开。组件仍然加载着，只是机器不开 |
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
| `qqSendOnPhone` | `false` | `false` = 手机 QQ 里只看不发（打字、回车会被拦下），发 QQ 用 `qq_send` |
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
| `tidy` | `true` | 去掉句号、引号、破折号等书面符号 |
| `dropLatinLeaks` | `true` | 不发整条都是英文的气泡（思考漏出来），短英文照发 |
| `ignore` | `""` | 不回复的 QQ 号（别的机器人），逗号或空格分开；qq-bridge 的机器人号自动认出，不用填 |
| `loopMax` | `4` | 防互刷（只管群聊）：一个群里和同一个号一来一回这么多轮、中间没别人说话，就暂停理它；0 关 |
| `loopCooldownMinutes` | `10` | 防互刷暂停多久 |

### `memory`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉 |
| `home` | `~/dot` | 和 `dot.home`、`interlude.home` 保持一致 |
| `handoffTokens` | `150000` | 对话多长换新会话 |
| `consolidateEveryLines` | `40` | 新记录攒满多少行整理一次（交班前也整理一次） |
| `dailyAt` | `"23:30"` | 每天写日记、整理关于他 / 她自己的时间（当天有记录才调用） |
| `limits` | `{ owner: 1375, self: 2200, open: 800, impression: 80 }` | 三栏笔记各多少字（关于他 / 她自己：硬上限，放不下的加不进去，满了要记新的就换掉一条；还没了的事是每轮显示多少，存的不限）、人物印象多少字 |
| `openKeepDaysAfterDue` | `3` | 还没了的事过了到期日几天后拿掉 |
| `openKeepDaysIdle` | `14` | 没日子的还没了的事多少天没被碰过就拿掉 |
| `coexist` | `"auto"` | `auto` / `people-only` / `full` |
| `recallBackend` | `"local"` | `local` / `siliconflow` / `dashscope` / `off`（建议用 `/dot memory recall backend`，命令设的值优先） |
| `recallModel` | `""` | 本机默认 `Xenova/multilingual-e5-small`；只用中文可填 `BAAI/bge-small-zh-v1.5`（更轻，23 MB / 约 0.13 GB）。建议用 `/dot memory recall model` |
| `recallRerankModel` | `""` | 本机默认 `Xenova/bge-reranker-base`（279 MB）；`BAAI/bge-reranker-v2-m3` 更强更慢（571 MB）；`none` 不重排。建议用 `/dot memory recall rerank` |
| `recallCandidates` / `recallTopK` / `recallMaxTokens` | `20` / `10` / `1500` | 向量、BM25 各出多少候选；重排后最多注入几条、多少 token（可以更少，不凑数） |
| `recallRerankMin` | `0` | 重排分（0–1）的可选门槛；0 = 只看重排的顺序 |
| `recallMinQueryLength` / `recallContrast` / `recallMinScore` | `4` / `0.35` / `0` | 话太少不查；不重排时，命中要比整个索引的中位数高出一截；不重排时可选的余弦下限。见 [memory.md](memory.md) |
| `recallLexical` | `true` | BM25 那一路候选（汉字 + 两字）；`false` 只用向量 |
| `recallMirror` | `""` | 本机模型下载镜像，默认 hf-mirror |

### `interlude`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉 |
| `home` | `~/dot` | 和另外两处保持一致 |
| `activeHours` | `"08:00-23:00"` | 活跃时段 |
| `idleMinutes` | `10` | 聊天安静多久后跑一轮 |
| `advanceEveryMinutes` | `90` | 自己过日子的间隔，0 关 |
| `maxRoundsPerDay` | `20` | 每天最多几轮 |
| `browseDailyCap` / `vmDailyCap` | `6` / `2` | 每天「去看」上限 |
| `vmSites` | `[]` | 用电脑浏览器看的网站（她登录过的） |
| `phoneApps` / `playApps` | 内置表 | 逛 / 玩的 App |
| `play` | `true` | 「玩」（点赞、评论、关注、发帖）；`playActions` 去掉 `post` 就不发帖，`postDailyCap`（默认 1）是每天发帖上限 |
| `tries` / `tryDailyCap` | `true` / `3` | 「试点新的」：她想做没做过的事，交给跑腿真去做（不花钱、不改账号、要审批的等批准） |
| `price` | `null` | `{ in, cached, out }` 元/百万 token；给了她的账上就有钱数 |
| `freeTimesPerDay` / `freeTokenCap` / `freeDailyTokens` | `2` / `150000` / `300000` | 「自己的时间」：每天几次、每次和每天的 token 上限；`0` 次关 |
| `growth` / `growthAt` | `true` / `Sun 21:00` | 每周回顾，重写「她现在的样子」（`portraitMaxChars` 900、`portraitMaxChange` 0.35） |
| `speak` | `false` | 主动找你；有 dot 时不自己发，交给她的对话（留一句「想跟他说的」），合不合适由她定，交过去才算一次 |
| `maxContactsPerDay` / `willingnessThreshold` | `2` / `0.6` | 主动联系的上限和门槛 |
| `presetHub` | `https://typ0.space` | HDSI 预设站 |

### `dot`

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | `false` 关掉联系人层 |
| `home` | `~/dot` | 和另外两处保持一致 |
| `phoneCheckEveryMinutes` | `30` | 隔多久拿起手机看一眼，0 关 |
| `manuals` | `true` | 她的会话里，手机那段和手机、电脑的 MCP 说明不每轮都带：换成一行，第一次用手机 / 电脑工具时那一下照常执行，说明书跟着结果一起给她（`dot.manuals.*` 提示词）；`false` 恢复每轮都带 |
| `howto` / `howtoMinSteps` / `howtoMaxChars` | `true` / `12` / `800` | 她自己的 App 经验（`~/dot/her/howto/`）：每轮按 App 记步数；走了 `howtoMinSteps` 步以上或出过错的那轮，结束后一次小调用整理这个 App 的笔记（教训、捷径）；之后一个会话里第一次打开这个 App 时笔记跟着给她。`/dot howto` 看每个 App 的步数变化 |
| `promptsPort` | `7870` | `/dot prompts` 提示词页面的端口（只监听 127.0.0.1） |
| `notifyHours` | `""` | 只在这个时段内通知叫醒她；空 = 一直 |
| `notifyBatchMs` | `1000` | 多少毫秒内的通知合并成一次叫醒（别人的；你的话见下面四项） |
| `ownerQuietMs` | `1500` | 你的 QQ 消息：你停下多少毫秒没新消息才送给她，每来一条重新计时 |
| `ownerMaxWaitMs` | `6000` | 你一直不停时，最多从第一条起等多少毫秒 |
| `ownerTypingMaxMs` | `15000` | QQ 报「正在输入」（NapCat）时最多等多少毫秒 |
| `ownerDenyMax` | `2` | 你有她没看的话时，她发给你的 `qq_send` 每轮最多被拦几次 |
| `notifyRules` | 见下 | 非聊天 App 的通知先过这张表（按顺序，第一条命中的算）：每条 `{ "pkg": 包名（可省）, "title": 正则, "text": 正则（可省）, "action": "ignore" / "direct" }`。`ignore` 只记一笔 `notification-ignored`，不叫醒她；`direct`（@、回复、私信、关注她的）`notifyBatchMs` 后就叫醒；都没命中的按话题合并（见下一项）。默认：小黑盒的「黑盒今日热点订阅」「签到提醒」「今日未签到」和正文是「来自《…》，点击查看>>」的推广、资讯忽略，标题含「@了你 / 回复了你 / 关注了你 / 私信」的算 `direct`。写了就整张替换默认 |
| `threadBatchMs` | `20000` | 同一话题（App + 通知里引用的帖子「来自“…”」，没有就只按 App）这么多毫秒内来的通知合并成一次叫醒；跑腿正在处理某个话题时，这个话题新来的都留给同一个跑腿，不另开 |
| `heldMaxMs` | `600000` | 通知等忙着的跑腿等了这么久，就交给一个新的跑腿会话（记 `notification-rerouted`）；那个跑腿正在处理的话题除外 |
| `loopRepeat` | `5` | 一轮里同一个工具、参数几乎一样（忽略空白和数字）调这么多次后，再调就被拦下，让她换个办法或说明卡在哪（记 `loop-stopped`）；0 关 |
| `errandMaxTokens` | `60000` | 跑腿会话多长换新 |
| `interludeQueueMax` | `3` | 幕间想做的事（玩、用手机 / 电脑去看）不自己动手，排队交给跑腿：优先级最低，没有通知在排、在等，也没有跑腿在跑时才做，一次一件；同一件事再来只刷新过期时间；排满这么多件，最早的作废（`dropped`） |
| `interludeTaskTtlMs` | `1800000` | 排队这么久还没轮到就作废（`expired`）。做完、过期、作废都回给幕间：她当时想做什么、那会儿在忙什么、拖到几点才做（或没做成），下一轮写进剧情 |
| `turnStallMs` | `300000` | 她的一轮这么久没有任何会话事件就算卡住：记 `turn-stalled`，面板标「卡住」；是她的对话就告诉你一次（不替她取消） |
| `errandStallMs` | `600000` | 跑腿会话卡住这么久就放弃：取消这一轮（保留收件箱），扣着的通知放出去交给新的跑腿会话，她对话里留一句「做到一半卡住了，放弃了：…」 |
| `approvalWaitMs` | `600000` | 她的会话里要审批时立刻告诉你（QQ 连着发 QQ，否则 IM；一轮只发第一条，后面的只计数）；这么久没人点就当拒绝，再告诉你一句过期了；0 = 一直等 |
| `imBot` / `imTarget` | `""` | dsh-im 的投递目标，空 = 第一个 |

### `llm`（模型请求闸门，`src/llm-gate.js`）

她后台的模型请求（幕间、整理记忆和日记、跑腿会话、群聊评分、App 经验整理）和你们的对话共用同一个 provider 的 key。这道闸门在每个请求前面：只压后台的，你们的对话（以及认不出来的请求）照常发。每个 provider 分开算。`/dot` 和 dot 页面「状态」里能看到近一分钟的请求数、后台上限、是否在冷却。

| 键 | 默认 | 作用 |
|---|---|---|
| `backgroundRpm` | `20` | 后台请求每分钟最多几次（近 60 秒内所有请求都算进去，但只压后台的；间隔至少 60/上限 秒，一次放一个）。`0` = 不限速（只计数） |
| `foregroundQuietSeconds` | `15` | 你们的对话有请求在发时后台不发（一个请求开着超过 10 分钟就当它已经被丢下）；发完后再等这么多秒（她一轮有好几步） |
| `maxBackgroundWaitSeconds` | `180` | 一个后台请求最多被压后多久，到了就放行。最多 270（比 `dot.turnStallMs` 的 300 秒短，跑腿不会被当成卡住；填更大也按 270） |
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
