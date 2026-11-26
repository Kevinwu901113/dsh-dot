# dsh-dot 用法手册

README 讲她是谁、怎么装；这里是装好以后查的东西：组件、命令、页面、数据放在哪、安全边界、和别的插件怎么共存、从旧版本升级。设置项单独在 [SETTINGS.md](SETTINGS.md)。

## 组件

一个插件，七个组件：三个是她自己，三个是她的东西，一个管和别的插件共处。每个都能单独关，缺了哪个其余照常跑。

**她自己**

| 组件 | 是什么 | 依赖 | 关掉 |
|---|---|---|---|
| **`interlude`** 🌙 | 人设卡和说话检查表、自己的时间、她自己做过的事的账 · [文档](interlude.md) | — | `DSH_DOT_INTERLUDE=off` |
| **`memory`** 🧠 | 原话库 + 自动召回（本机 multilingual-e5-small，可切 SiliconFlow / DashScope）；三栏笔记（关于你 / 她自己 / 还没了的事）；人物卡；日记；对话太长时交班 · [文档](memory.md) | — | `DSH_DOT_MEMORY=off` |
| **`dot`** ◎ | 联系人层：她的对话（只有插件为她开的那一个）、什么叫醒她（一个 30 秒的时钟）、她的手（手机、电脑、查资料、本机四个地方，各一次一件、不同地方同时做，每个地方自带只做事的预设）、事情簿、手艺簿、要你点头的事（代码分四档，在聊天里问你）、替她说话的那次调用、出错和额度用完时以插件名义告诉你、定时结果 → IM、右侧栏状态面板 | [dsh-im](https://github.com/xmanrui/dsh-im) | `DSH_DOT_CONTACT=off` |

**她的东西**

| 组件 | 是什么 | 依赖 | 关掉 |
|---|---|---|---|
| **`phone`** 📱 | Android 模拟器，以 `mcp__dot-phone__*` 暴露（[mobile-mcp](https://github.com/mobile-next/mobile-mcp) 走 adb）；有人发来的消息叫醒她，App 自己的推送攒着 · [文档](phone.md) | 硬件虚拟化 | `DSH_DOT_PHONE=off` |
| **`computer`** 🖥️ | 自带 microVM，以 `mcp__dot-vm__*` 暴露：命令行、浏览器、桌面、实时画面、闸门、审计 · [文档](computer.md) | [microsandbox](https://github.com/zerocore-ai/microsandbox)（自带）或 Docker | `DSH_DOT_COMPUTER=off` |
| **`qq`** 💬 | 她电脑里的 QQ（NapCat / SnowLuma，OneBot 11），和手机同号；表情包 · [文档](qq.md) | computer | `DSH_DOT_QQ=off` |

**共处**

| 组件 | 是什么 | 依赖 | 关掉 |
|---|---|---|---|
| **`compat`** 🤝 | 和别的插件共处：每个会话归谁、看得见哪些工具、命令在哪跑；现在认 [qq-bridge](https://github.com/Derpyu520/qq-bridge) · [文档](qq-bridge.md) | — | `DSH_DOT_COMPAT=off` |

## 她的一天

| 时候 | 发生什么 |
|---|---|
| **你找她** | QQ 消息 1–2 秒叫醒她；你连着发几条，她等你说完再看；她这一轮还在跑时你又说了话，插进这一轮，她下一步就看到；回复按行拆成多条。让她去做的事十几秒内做完的，只回你一次、带着结果；还在做，先说一声在弄 |
| **手机响了** | 有人发来的消息叫醒她（`[11-04 04:52 手机通知] QQ · 宽：在吗`），她自己去回，或者不理；App 自己的推送不叫醒她，下次她醒着时一起看一眼 |
| **用手机和电脑** | 她把一整件事交给「手」；手做完、没做成、或停在要人定的地方，结果和当时的画面才回到她的对话，她看了再定。手机、电脑、查资料、你这台电脑本机各自同时只做一件，不同地方可以同时做；交到一个正忙的地方，不排队，她当场知道那里在做什么，自己决定等、补一句、换地方还是停掉那件。每件事记在事情簿里 |
| **自己的时间** | 你上一句话之后、或她的一天开始之后安静 30 分钟（默认），她醒着、手上没事，来一次；来过一次就要等你再找她、或第二天，每天最多两次。她可以在那段时间里自己留一个「下次」。只告诉她「这段时间是你自己的」，结束时不用她写总结 |
| **想找你** | 没有次数上限：她眼前有今天主动了几次、你回了几次、上一条回没回，找不找由她定 |
| **睡觉** | 过了她平时的作息（默认 `08:00-23:00`），安静 30 分钟就睡着；睡着后写当天的日记、整理笔记、核对手艺簿。睡着时只有你的消息能叫醒她，到点自己醒 |
| **出了问题** | 她的一轮出错、或你的话她没接到，插件用自己的名义告诉你一次（不写成她说的）；模型额度用完、登录或 API key 用不了，告诉你是哪一种、怎么办，后台的事先停下，你改好后给她发一句话就接着 |

她只有一个对话：插件为她开的那一个（第一次有东西找她时开，太长了交接到新的一段）。在 dot 工作区里手动新建的会话是普通的 dsh 会话，不是她：没有她的人设、记忆和工具，通知和自己的时间也不会进去。

## 命令

```text
/dot [stop|doctor|test|howto [<app>]|nightcheck [apply]|replay <文件|latest> [次数]|voicetest <文件>|prompts [stop|rebase <id> [--reset]]]
/dot memory [now|diary|handoff|recall …]
/dot people [approve <id>|merge <a> <b>|forget <名字>]
/interlude [preset <code>|canon|doings|feedback [#id] <一句话>|free]
/phone [on|off|doctor [fix <id>]|accept [GB]|size <GB>|number <号码>|restart|retry|screenshot|notifications|notify [mute|wake <包名>]]
/computer [on|off]
/qq [install [snowluma]|backend|account|owner|start|stop|qr|log|clean [napcat]|stickers [sync]|group <mention|all|none|score>]
```

## 两个页面

- **「dot 设置」**（左侧栏）：装、设、查、导——初始化步骤、设置表单、体检、诊断包。
- **dot 面板**（会话顶部 ◎ 按钮打开的右侧栏）：她的生活——设备状态、她此刻在做什么、等你点头的事、手艺簿、今天的 token，以及**最近 30 场**（每次被叫醒到结束是一场，展开看她做了什么、说了什么）。

## 改人设和提示词

- **人设**：`~/dot/persona.md`，按 `## ` 标题分段；哪段给拿主意的读、哪段给说话的读，写在 `~/dot/persona/parts.json`。`/interlude preset <分享码>` 从 [typ0.space](https://typ0.space) 导入社区预设生成它。
- **提示词**：在 dsh 里发 `/dot prompts`，回一个本机网址（默认 http://127.0.0.1:7870/），打开就能改；`/dot prompts stop` 关掉。她收到的每段话都是 `src/prompts/` 里的纯文本，页面保存到 `~/dot/prompts/` 覆盖内置版本。开发时在仓库里 `npm run prompts` 也行，见 [prompts.md](prompts.md)。

## 数据都在哪

| 路径 | 内容 |
|---|---|
| `~/dot/persona.md`、`~/dot/persona/` | 人设卡和它拆开的各段 |
| `~/dot/interlude/` | 导入的预设 `canon.json`、她的账 `doings.json`、每天的用量 `meta.json` |
| `~/dot/memory/` | `memory.md`（给你看的）、`diary.md`、`transcript.jsonl`、召回索引 `recall/`、交班记录 |
| `~/dot/her/` | 她自己的地方：自己的时间里放的东西、手艺簿 `howto/`（手机本身、每个 App、电脑的笔记和每件事的记录） |
| `~/dot/prompts/` | 你改过的提示词，覆盖内置版本 |
| `~/.dsh/dsh-dot.json` | 所有个人设置 |
| `~/.dsh/phone/` | 模拟器、镜像、AVD；`~/.dsh/dsh-phone*.{log,jsonl,json}` 日志 / 审计 / 设置 |
| `~/.dsh/dsh-computer*` | 电脑的日志、审计（她的每一步、闸门的每次判断、替她说话的每次调用）、状态 |

## 安全边界

- **要你点头的事分四档，由代码判断**：钱的事（转账、红包、理财、支付类 App 和网站）不做；付款或下单的最后一步、实名和人脸、人机验证、扫码登录、发到你手机上的验证码，只能你本人来；装 App、开权限、注册、同意条款、删东西、加好友、打电话发短信、改密码绑定、打手机号或密钥、给不熟的人发消息，以及电脑上往外连（ssh、git push、下载了直接跑）、用 sudo、碰受保护的文件、改你共享的文件夹，先在聊天里问你。没有按钮：你在聊天里说同意才算，一次只管那一件，说「以后都行」才长期。
- **你这台电脑本机**：她的手只在你开口要的事上去，只看不改的命令直接做，要改动、安装、联网、碰密钥的先问你；她自己的时间里不去。
- 手机实时画面、dot 面板、dot 设置页、电脑实时桌面都挂在 dsh 自己的 web server 上（`/dsh-dot/*`），每个请求先过 dsh 的登录和来源检查。插件不开自己的端口、不自带鉴权。
- 虚拟机网关只绑 `127.0.0.1:18080`，要求密钥（自动生成在 `~/.dsh/dsh-computer.key`），只有插件内部持有。
- **「你」只有一个来源**：`/qq owner` 指定的号。手机通知上的昵称谁都能改，永远不算你的指令。

## 与其他插件共存

- **电脑组件开着时会改全局设置**：subprocess provider 换成虚拟机里的、`sandbox-policy` 设为 `danger-full-access`（虚拟机才是隔离边界）、权限预设改写成 `computer` / `computer-auto`。所以不要同时装别的沙箱 / subprocess / 权限预设插件；要用就 `DSH_DOT_COMPUTER=off`。
- **MCP 工具名有命名空间**：`mcp__dot-vm__*`、`mcp__dot-phone__*`，前缀定义在 `src/tool-prefixes.js`。
- **记忆共存**：`DSH_DOT_MEMORY_COEXIST` 默认 `auto`，发现 `hermesMemory` / `autoMemory` / `dshMemory` / `memoryBank` 等就切到 `people-only`，只保留人物卡、还没了的事、日记和召回。`full` / `people-only` 可强制。
- **一个 QQ 号只能有一个应答者**：不要在她的号上再跑别的 OneBot 机器人。
- **[qq-bridge](https://github.com/Derpyu520/qq-bridge)**：自动认出并共处，见 [qq-bridge.md](qq-bridge.md)——它的会话里不出现 dot 的工具，它的目录不进她的虚拟机，它的机器人号她不回；它 closed-agent 模式的管理员私聊能用她的手机和电脑。
- **`bash` 也过电脑闸门**：别的插件再给 `bash` 加审批，同一条命令会问两次。
- **上下文压缩插件**：dsh-dot 注入的消息带固定 `source`，压缩时请保留、别当成用户原话：

  | source | 含义 |
  |---|---|
  | `{ kind: 'dsh-dot', form: 'phone-notification' }` | 手机通知、她 QQ 上的人叫醒 |
| `{ kind: 'dsh-dot', form: 'turn-note' }` | 跟着叫醒她的那条的短消息（现在几点、想起的原话、事情簿那几行） |
| `{ kind: 'dsh-dot', form: 'errand-note' }` | 留在她对话里、不叫醒她的一句（如「那条他没回」） |
  | `{ kind: 'dsh-dot', form: 'hands-result' }` | 交给手的一件事结束了，结果和当时的画面回到她的对话 |
  | `{ kind: 'dsh-interlude', form: 'free' }` | 自己的时间 |
  | `{ kind: 'dsh-dot', form: 'reply-check' }` | 她写的话里有检查表上的说法，退回给她改一次 |
  | `{ kind: 'handoff', generation }` | 记忆交班 |
  | `{ kind: 'user', rpcId: 'qq-dot-…' }` | 主人的 QQ 消息（普通用户消息） |

## 从旧版本升级

升级后都要**完全退出并重新启动 dsh**。每个版本改了什么，见 [Releases](https://github.com/Kevinwu901113/dsh-dot/releases)。

- **v0.9 起 npm 包名是 `dsh-dot-life`**（`dsh-dot` 在 npm 上被占；v0.8.x 的 `@kevinwu901113/dsh-dot` 已 deprecated）。装过旧名的先 `dsh plugin --profile desktop remove @kevinwu901113/dsh-dot` 再装，`~/dot`、`~/.dsh/phone`、虚拟机都不用动。
- **v0.9.2 起工具名带命名空间**：`mcp__vm__*` → `mcp__dot-vm__*`，`mcp__phone__*` → `mcp__dot-phone__*`。
- **v0.20 起记忆精简成原话 + 三栏笔记**：旧的 `memory.json` 第一次加载时自动迁移，去向写在 `~/dot/memory/memory-migration.md`，见 [memory.md](memory.md#从-019-升级)。
- `dsh-computer`（v0.1–0.5）和 `dsh-interlude` 曾是独立插件，v0.3 / v0.4 起并入，git 历史一并合入。装过的先 `remove dsh-computer dsh-interlude`。
