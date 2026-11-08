# 和 qq-bridge 一起用

[qq-bridge](https://github.com/Derpyu520/qq-bridge) 是把 QQ 群接进 dsh 的桥：它自己跑一个进程，用 dsh 的 web API 建会话、收发消息。很多人先装了它，再想要 dsh-dot 的**手机和虚拟机**。这一页说两边怎么共处——全部改动在 dsh-dot 这边，qq-bridge 一个字节不用动。

## 结论先说

| 你要的 | 做法 |
|---|---|
| qq-bridge 照常跑，她的组件一个都别碰它 | 什么都不用设。装了 qq-bridge 就自动认出（`compat.qqBridge: auto`）：它的会话里不会出现 dot 的任何工具，它的目录不会被共享进她的虚拟机，它的机器人号她不回 |
| **只要手机和虚拟机，给 qq-bridge 的管理员私聊用** | qq-bridge 切到 **closed-agent 模式**（它的控制台或 `state/mode.json`）。这个模式下只有管理员私聊能建会话，用的是 dsh 默认 preset、全工具面；dsh-dot 把她的手机（`mcp__dot-phone__*`）和电脑（`mcp__dot-vm__*`、`bash` 进虚拟机）给这个会话，其他的（记忆、她的 QQ、账号库）不给。dot / 记忆 / 幕间 / QQ 组件可以在 dsh 插件页关掉，只留 phone + computer |
| 她和 qq-bridge 的机器人在同一个群 | 她自动不回它（号从它的 SnowLuma 配置里读）；它会不会回她看它的 `ignore.sendQQ`。`/dot doctor` 会列出共同的群 |

## 它在 dsh 里长什么样

- 会话 ID `qqb-g-<群号>-<随机>`（群）/ `qqb-p-<QQ号>-<随机>`（私聊）；所有会话共用一个工作目录（它的 `state/agents`，或 `sessionCwd`）；黑话学习会话在 `state/slang-agent`。
- 模式 `chat` / `reserved` / `reserved2`：会话挂它自己的 `qq-chat` / `qq-chat-v2` preset——工具白名单，`bash`、`read` 等本地工具在注册期就被藏掉。**私聊也一样**，所以这些模式下给它手机也用不了（会被它自己拒绝），dsh-dot 一律当沙箱会话处理。
- 模式 `closed-agent`：只有 `ownerQQ` 的私聊能建会话，dsh 默认 preset，全工具面。
- 它往 dsh 的 profile 里 patch 了三个全局 MCP server：`snowluma`、`snowluma-host`、`web-search-safe`——这些工具本来会出现在**她的**会话里。
- `~/.dsh/plugins/qq-agent-presets` 和 `qq-mode-console` 是指向它仓库的链接：dsh-dot 顺着找到它的 `config.json` 和 `state/`。

## dsh-dot 做了什么（`compat` 组件，`src/compat/qq-bridge.js`）

**1. 每个会话归谁。** 一个函数回答，别的组件只问它：

| 判定 | 条件 |
|---|---|
| `dot` | 她的：工作目录在 `~/dot` 下，或 dsh-im 开的会话，或她的跑腿 |
| `qqb-sandbox` | `qqb-g-*`；`qqb-p-*` 且会话 preset 是 `qq-chat*`（dsh 记在会话头里；没记的看它的 `state/mode.json`，不是 closed-agent 就算沙箱）；工作目录在它 `state/` 下的其他会话 |
| `qqb-owner` | `qqb-p-*` 且 preset 不是 `qq-chat*`（或模式是 closed-agent） |
| `other` | 其他所有会话 |

`qqb-*` 会话**永远不是她的**，哪怕 `dot.scope` 设成 `all`。

**2. 工具可见性。** dsh 的 `agent/created` 事件里按归属 `tools.restrict({ deny })`，全局工具集变了（她的虚拟机起来、手机挂上）就重算；另加一个执行期 guard 兜底。dsh 的 restrict 是**取交集**，和 qq-bridge 自己的 restrict 叠加、互不覆盖。

| 会话 | 藏掉 |
|---|---|
| `dot` | qq-bridge 的 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*`（`compat.hideBridgeTools`） |
| `qqb-sandbox` | dsh-dot 的全部：`memory` `recall` `account` `doings` `tell_him` `qq_send` `qq_sticker_keep` `phone_zoom`、`mcp__dot-phone__*`、`mcp__dot-vm__*`、`mcp__dot-qq__*` |
| `qqb-owner` | 她自己的：`memory` `recall` `account` `doings` `tell_him` `qq_send` `qq_sticker_keep`、`mcp__dot-qq__*`；手机和电脑给（`compat.ownerDevices`） |
| `other` | 她自己的那些（`account` 里存着她 App 的密码，不给任何第三方会话）；手机电脑照旧 |

名单在 `src/tool-prefixes.js`（`DOT_TOOLS` / `DEVICE_TOOL_PREFIXES`），测试会把它和源码里所有 `tools.register` 对账，加工具忘了归类会直接红。

**3. 电脑。** subprocess provider 只看得到命令的 cwd：

- qq-bridge 的目录**永远不共享进虚拟机**（共享要重建虚拟机，她虚拟机里的 QQ 会掉一次线；它 `state/` 下的东西也不该进去）。命令在虚拟机的家目录跑。
- closed-agent 模式下那个目录就是管理员私聊的：`compat.ownerComputer: vm`（默认）进她的电脑；`host` 走 dsh 自带的本机执行，相当于没装 dsh-dot。
- 审批不动：它自己会把 `approval/requested` 转到 QQ。

**4. QQ。** 她的 QQ 组件：

- 自动忽略 qq-bridge 的机器人号（从它 `config.json` 的 `snowluma.homeDir`（或 `SNOWLUMA_HOME`）下的 `config/onebot_<号>.json` 读；读不到体检会提示）；`qq.ignore` 手动加别的号。被忽略的消息不叫醒她、不打分、不记忆。管理员（`qq.owner`）永远不忽略。
- 防互刷熔断：一个聊天里和同一个号一来一回 `qq.loopMax`（默认 4）轮、中间没别人说话，她就 `qq.loopCooldownMinutes`（默认 10）分钟不理那个号。不依赖 qq-bridge，对任何机器人有效。记 `loop-break`。
- `/qq` 状态里有一行 `not answered: …`。

**5. 体检。** `/dot doctor` / `/phone doctor` / dot 页面：找到 qq-bridge 时列出它的目录、模式、机器人号；❌ 她的号和它的机器人号相同（互相挤下线）、她的号是它的 `ownerQQ`；⚠️ 读不到它的机器人号、两边在同一个群。

## 设置（`~/.dsh/dsh-dot.json` 的 `compat` 段）

| 键 | 默认 | 作用 |
|---|---|---|
| `qqBridge` | `"auto"` | `auto` 装了就认；`true` 没找到会提示；`false` 不管它（`DSH_DOT_COMPAT=off` 整个组件关掉） |
| `qqBridgeRoot` | `""` | 自动找不到时填它的目录（里面有 `config.json`） |
| `ownerDevices` | `true` | closed-agent 的管理员私聊能用她的手机和电脑 |
| `ownerComputer` | `"vm"` | 那个私聊里的命令在哪跑：`vm` 她的电脑（不共享它的目录）/ `host` 本机 |
| `hideBridgeTools` | `true` | 她的会话里不出现 qq-bridge 的 MCP 工具 |
| `refreshMs` | `5000` | 多久重读一次它的 `config.json` / `mode.json` |

`qq` 段新增：`ignore`（不回的号，逗号分开）、`loopMax`、`loopCooldownMinutes`。

## 没做的

- **SnowLuma 的部署**：qq-bridge 只连接用户自己装好的 SnowLuma；dsh-dot 的 `/qq install snowluma` 会在虚拟机里自动装（许可证问题另议）。两边各装各的互不影响，但**不要登录同一个号**。
- 不改 qq-bridge 的任何文件；它的 `ignore.sendQQ` 要不要加她的号，由用户决定。
