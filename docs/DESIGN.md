# dsh-dot 设计记录

## v0.2 修订（2026-10-21）：不重复造轮子

原则改为：任何已有插件能做的都不自己写，dsh-dot 只保留没有现成实现的部分。逐项对照后：

| v0.1 自己写的 | v0.2 |
|---|---|
| 包装 dsh-bridge 的类（静默、绑定、直发） | 换成社区星数最多的 IM 插件 [dsh-im](https://github.com/xmanrui/dsh-im)。它提供公开服务 `dshIm`（`listBots`、`listTargets`、`send`），dot 只调用这三个方法，不再改别人的内部代码 |
| 静默协议 | 保留在 dot：没有插件支持。dot 只处理 `~/dot` 里由定时任务（`source.kind: "schedule"`）触发的一轮，回复是 `DOT_SILENT` 就不发，否则用 `dshIm.send()` 发。dsh-im 的「会话双向同步」保持关闭，避免重复发送 |
| 页面变化预检查 | 删除。北极星场景靠官方定时任务加虚拟机就能完成，跑通前不加功能 |
| 免打扰、积压队列、webhook 兜底 | 删除。预检查删掉后，dot 不再主动唤醒 agent，也就不需要它们 |
| 预算拦截通知、零点解除 | 保留：dsh-budget 不提供这两项 |

结果：dsh-dot 从约 400 行降到约 200 行，依赖组合变为 dsh-computer、dsh-im、dsh-budget、官方 schedule。云端在真实 dsh 上验证了定时任务的投递和静默两条路径。

## 2026-10-22 晚：去掉 AGENTS.md

Kevin 要求所有操作都由插件实现。dot 不再复制模板到 `~/dot/AGENTS.md`；工作方式（定时任务、静默、用电脑、审批、`<sep/>` 分条）作为 `systemPrompt.section`（`dot:rules`）注入 `~/dot` 里的会话。人设交给 dsh-interlude 的 Canon。`<sep/>` 在投递时拆成多条 IM 消息。

## 2026-10-22 真机排错记录

真机：Mac，App 自动升到 0.2.1-rc.2，IM 换成 dsh-im（QQ 官方机器人）。跑北极星缩短版时发现并修掉的问题：

| 现象 | 原因 | 修法 |
|---|---|---|
| "2 分钟后看 X"被马上执行 | AGENTS.md 里定时规则太软 | 模板改为"带未来时间点或周期的一律 `schedule_create`，现在不做" |
| 没新内容时仍然汇报"没有新提交" | 静默规则只在 AGENTS.md，模型到点时没当回事 | dot 在定时触发的那一轮加一条 `systemPrompt.context`（只加这一轮）。定时提醒在轮次开始前以 `agent/inbox/spliced` 进入收件箱，而提示在轮次开始时组装、早于 `user/message` 事件，所以从 spliced 事件识别 |
| `/dot` 命令没注册 | dot 的 inject 不再含 sessionController，启动早于 commands 服务 | `ctx.inject(['commands'], …)` 等服务就绪再注册 |
| `IM: Invalid bot id` | dsh-im 的 `listBots()` 返回 `{ botId, channel }` 对象 | 取 `botId` |
| 审批提醒内容为空 | `approval/asked` 载荷是 `{ id, toolName, reason }` | 用 `toolName` + `reason`；gate 的 reason 已含实时画面链接，不重复 |
| 虚拟机重启后桌面和浏览器起不来（agent 自己花 token 排查） | `/tmp/.X99-lock` 残留，X 服务起不来 | dsh-computer 启动前清锁；浏览器不在时若 X 也不在，清锁并拉起 tigervnc/openbox 再启浏览器（云端复现并验证） |
| 虚拟机里 `rm -f` 没触发审批 | gate 只看 dsh 的 `bash`，没看虚拟机自带的 `sandbox_execute_bash` / `sandbox_execute_code` | gate 加 `shellTools`，三个都过同一套规则（dsh-computer 加了测试） |
| 定时任务插件装了但起不来 | 0.2.1 把定时内置进 web-app；实验插件没有 0.2.1 版本，旧版 `dsh-schedule` 挡住内置的 | 卸掉实验插件；安装命令从五个包减到四个 |
| pnpm 在 Done 之后卡住 | 去拉 microsandbox 其他平台的构建，网络失败重试 | 安装脚本检测到 Done 后 60 秒仍在跑就终止；不影响已装文件 |

运行时热替换的文件（`node_modules/dsh-dot/src/core.js` 等）在下一次 `dsh plugin` 操作时会被重装覆盖，GitHub 上已是同样内容。

以下为 v0.1 的原始设计记录。

---

## 目标

装上之后，dsh 变成 Dots / Grok Bot 式的常驻 agent：有自己的电脑、IM 上找得到、会定时主动做事、花钱和危险操作有硬约束。

验收只看一条：在微信或飞书里说"每天早上看 X 有没有更新，有就告诉我"。第二天到点，它在虚拟机里执行；有更新推到 IM，没更新不出声；遇到登录页推审批卡片，附实时画面链接；当天超预算自动暂停并通知。这条跑通之前不加功能。

## 原则

- **组合优先**：能用现成插件的不自己写。dsh-dot 只写现成插件之间缺的那层胶水。
- **身份用文件**：dot 是谁、负责什么，写在 `~/dot/AGENTS.md`。不做记忆系统。
- **不调模型就能决定的事，不调模型**：页面有没有变、预算是否超限、是否免打扰，全部在插件里判断。只有真有事才叫醒 agent。
- **没有虚拟机就不常驻**：`inject` 里要求 `dshComputer`。缺了它 dot 不启动。

## 复用

| 能力 | 来源 | 结论 |
|---|---|---|
| 电脑、审批、审计 | dsh-computer v0.5 | 自己的项目。v0.5 加了 publicUrl、审计日志、状态接口，之后冻结 |
| IM | `@wenbin_wb/dsh-bridge` | 微信 iLink、飞书卡片审批、QQ、Telegram。没有对外 API，见下文 |
| 定时 | 官方 `dsh-experimental-schedule-bundle` | 支持 daily / weekly / cron，Host 会恢复冷会话。社区的 Wang-Lin-Chang/dsh-schedule 不合适：没有 dsh.bundle、只有最短 300 秒的间隔、任务在宿主沙箱里跑，绕开了虚拟机 |
| 预算 | `dsh-budget` | 只在 `llm/stream` 前置监听里拦截，已验证：拦截期间 0 次 LLM 请求，工具和插件照常运行 |

## 自己写的部分

1. **身份注入**：dsh 默认读会话目录下的 `AGENTS.md`。最初尝试用 patch 改 `agent-instructions`，但 agent preset 内嵌了自己的插件行，按 id 改到的是全局里被禁用的那行。所以改为：首次启动把模板复制到 `~/dot/`，从不覆盖。
2. **预检查**（`src/precheck.js`）：读 `watch.json`，各自按间隔 GET、转成纯文本、可按关键词截取、算 sha256。第一次只记基线，变了才调 `onChange`。
3. **事件桥**（`src/core.js`）：
   - 页面变化 → 唤醒主会话（`resolveAgent` → `followup` → `flush`，与官方 schedule 同一条路径）。
   - 预算拦截 → 停止唤醒、积压事项、IM 通知；解除后合并投递。拦截状态持久化，重启不会重复通知。
   - 日预算在本地零点自动解除（`autoUnblockDaily`），否则昨天超支会让今天的定时任务全部失败。
   - 免打扰时段的唤醒先积压。
   - 虚拟机进入 error 状态 → IM 通知。
   - 审批：不另做。dsh-computer 的 gate 走标准审批接口，dsh-bridge 自动把它变成卡片。
4. **cordis.patch.yml**：插入 `dsh-dot/core` 一行，依赖 dshComputer，缺了不启动。

## 与 dsh-bridge 的衔接（为什么要包装它的类）

dsh-bridge 的 `ConversationBridge` 会把绑定会话的每条 `assistant/message` 通过 `this.sendText` 转发到 IM。dot 需要三件它不提供的事：

1. **静默**：被唤醒后没事可报时，agent 回 `DOT_SILENT`，不能转发。
2. **绑定**：知道 IM 聊天当前绑定的是哪个会话，作为主会话。
3. **直发**：预算拦截时模型不能用，得不经模型直接给用户发一句话。

dsh-bridge 没有公开服务，所以 `src/im.js` 包装了基类原型上的 `_attachOutbound`（登记实例）和 `sendText`（过滤静默）。子类只重写 `_sendTextNow`，所以包装基类对所有平台生效。包装前做形状检测，不符就关闭并告警，退回 webhook（飞书 / 企业微信机器人、Server酱、通用 JSON）。

这是权宜之计。计划给 dsh-bridge 提 PR，加一个公开服务：`notify(text)`、`boundSessions()`、静默标记。合并后 dot 改用服务，删掉包装。

## 不做

长期记忆系统、多个 dot、自我进化、bot 之间委派、自己的 IM 桥接、自己的心跳框架。

## 已验证（dsh 0.2.0-rc.2，云端 Docker 后端，脚本化模拟模型）

- 检查 1：dsh-computer + dsh-bridge + dsh-budget + 官方 schedule + dsh-dot 一条命令同装，`--dump-config` 无冲突，全部运行。
- 检查 3：预算拦截只截断 `llm/stream`。
- `~/dot/AGENTS.md` 在 `~/dot` 会话里被模型读到。
- `schedule_create` 30 秒后把提醒投递进会话。
- 页面变化 → 审计 `change` / `wake`，主会话收到 `[DOT 预检查]`。
- 预算拦截 → webhook 收到"⛔ dot: 预算已用完，已暂停"，事项积压且不调用模型；解除后补发。
- 零点自动解除、模板不覆盖、静默、绑定、直发：单元测试覆盖（直发和静默用的是真实的 dsh-bridge 类）。

## 待验证（需要真实 IM 和用户的电脑）

- 检查 2：gate 审批在飞书卡片 / 微信 iLink 里出现并能回传。
- 检查 4：公网实时画面（Tailscale serve）在手机 IM 里能打开。
- 通过真实 IM 的端到端静默。
- Mac 桌面版 profile 上的完整部署。

## 已知限制

- 预检查在宿主机发起 GET，不经过虚拟机；需要登录或 JS 渲染的页面看不到内容。这类页面用定时任务让 agent 在虚拟机里看。
- dsh-budget 的拦截默认要手动 `/budget unblock`，重启后不保留；dot 只自动解除 `daily`。
- 电脑休眠或退出 App 后不运行。24 小时在线需要部署到服务器。

## v0.3（2026-10-23）：computer 和 dot 合并为一个插件的两个组件

Kevin："把 computer 和 dot 合并为一个插件的不同组件"。做法：

- dsh-computer 仓库的历史用 `git merge --allow-unrelated-histories` 并进来（提交记录保留），文件移到 `src/computer/`（vm / subprocess / gate / audit / backends / ui-host），原 dsh-dot 的 core 移到 `src/dot/core.js`。
- `cordis.patch.yml` 合并：电脑那部分（关掉宿主 subprocess、沙箱策略、权限预设、`dot-computer` / `dot-subprocess` / `dot-gate` / `dot-mcp` / `dot-ui`）在前，`dot` 在后。组件名 `dsh-dot/computer`、`dsh-dot/subprocess`、`dsh-dot/gate`、`dsh-dot/dot`；`package.json` 的 `exports` 对应。
- 客户端 bundle `lib/client.js` 的 `__ModuleLoader__` id 必须等于包名，改成 `dsh-dot`（CSS tag 同步）；标签页内部 id 不动。`ui/` 源码的 tsdown 配置同步。
- **对外不变**：`mcp__vm__*` 工具、`dshComputer` 服务名、`~/.dsh/dsh-computer*` 文件、VM 名 `dsh-computer`、`DSH_COMPUTER_*` 环境变量都保留——已经跑着的虚拟机、快照、审计日志不用迁移。
- dsh-interlude 不并：它是 AGPL-3.0（移植自 HDS-Interlude），并进 MIT 包会把整个包拖成 AGPL；而且它不依赖 dot，独立装卸更干净。
- 原 dsh-computer 仓库保留作为历史，README 指向这里。

## v0.4（2026-10-23）：幕间也并进来，只留一个仓库

Kevin："interlude 也合并到 dot 里面。然后所有仓库清理掉不要了，仅保留一个 dot 仓库。"

- dsh-interlude 的历史同样 merge 进来；代码在 `src/interlude/core.js`，组件 `dsh-dot/interlude`，测试 `test/interlude.test.js`，示例 Canon 在 `examples/`，文档 `docs/interlude.md` / `docs/INTERLUDE-DESIGN.md`。
- **许可证变成 AGPL-3.0-only**：幕间按原文使用 HDS-Interlude 的提示词，HDSI 是 AGPL；并进同一个包，整个包就是 AGPL。v0.3 以前以 MIT 发布的 computer / dot 代码，那些版本仍是 MIT。
- `dsh-computer`、`dsh-interlude` 两个仓库不再需要（历史都在这里）。

## v0.5（2026-10-23）：转向——养鱼是主基调，她有了一部手机

Kevin："我打算让 dot 转移方向。养鱼是主基调。""那就真 App。手机这个东西，你要做成即使别人使用这个插件也可以直接可用可行。computer 作为可选组件。"

定义改了：dot 不再是"干活的常驻 agent，顺便有点生活"，而是"在自己手机上过日子的角色，顺便能干活"。幕间从附属变成核心，电脑从主体变成可选。

- **`dsh-dot/phone`**：Android 模拟器。做成开箱即用的关键是不依赖 Android Studio / Java：Google 仓库的 `repository2-3.xml` 和 `sys-img2-3.xml` 是公开索引，emulator、platform-tools、system image 都是 zip，解压就能用；AVD 的 `config.ini` 自己写（`avdmanager` 写的也就是这些行）。许可证必须用户自己接受（`/phone accept`），插件只在接受后下载。模型侧用 mobile-mcp（6.3k★，Apache-2.0，2026-10 还在更新）走 stdio，作为依赖随插件安装，`ctx.plugin(mcpClient, …)` 在手机就绪后挂，不用在 patch 里写路径。
- 为什么不放进她的虚拟机：microVM 不支持嵌套虚拟化，Redroid/Waydroid 要 binder 内核模块。手机和电脑是两台设备。
- **幕间的"去看"多了一台设备**：`phoneApps`（host → 包名）决定哪些站用手机上的 App 看；`vmSites` 用电脑浏览器；其余先 web，被挡了升级到手机（`phonePreferred`）或电脑。观察轮的只读白名单加了 `phoneObservationTools`（看、滑、点进去、开 App、返回；不输入、不装卸）。手机和电脑共用 `vmDailyCap`。
- **dot 不再硬依赖 `dshComputer`**：`inject` 清空，设备用 `ctx.get()`，工作规则按在场的设备生成，`/dot` 分别显示两台设备的状态，手机出错 / 等许可也会推到 IM。
- **电脑可选**：`DSH_DOT_COMPUTER=off` 时 computer 的五个条目 `disabled`，宿主 subprocess、沙箱策略、权限预设回到 dsh 默认值（patch 里用 `!!js` 条件）。
- 审批策略不变：观察轮不审批（只读 + 其余拒绝）；装卸 App、输入像密码 / 支付的内容走审批。
- 待做：QQ 用她手机上的真 App（Kevin 定的），还没接——dsh-im 的 QQ 是官方机器人通道，真 App 收发要靠无障碍树，是下一步；`serial` 配置项接真机；"玩"（点赞评论发帖）那层的提示词要从社区找，不自己写。

## v0.5.1（2026-10-23）：通知这一层重写

Kevin："你有点补丁式修复的味道了。整体看看。"确实：三次各修一个洞（重启后不知道会话、轮询漏掉一闪而过的通知、同一条通知原地更新被去重吞掉），根子是一开始把"盯通知栏"写成了"4 秒轮询 + 按 key 去重的 Set"。

重写成 `src/phone/notifications.js`，一个状态模型：

- Android 只把 NotificationListenerService 给 App，不给 adb。不往她手机里装我们自己的 App 的前提下，通知栏只有两种可观测方式：**事件**（系统把每次 post/update 记进 events 日志缓冲区 `notification_enqueue`，`logcat -b events` 能毫秒级知道"有事发生"，但不知道内容）和**状态**（`dumpsys notification --noredact` 是此刻通知栏的快照，有内容但是快照）。两者合用：事件触发立即快照，慢轮询兜底对账。
- 一张表 key → 上次内容；每次快照 diff 出 `posted` / `updated` / `removed`。`updated` 是关键——聊天 App 每个会话只有一条通知，新消息来是原地改字。第一次快照只填表不发事件。一次只跑一个 dumpsys，事件风暴合并成下一次读。
- 策略单独一个对象：所有非系统 App 默认算（以后装的也算），`muted` 静音，`only` 收窄；记每个 App 发过多少条。
- 唤醒侧（dot）：她最近的会话持久化；几秒内的多条合成一次；`notifyHours` 夜里静音。
- 测试用的 fixture 按真机 `dumpsys` 的版式手写（真实 dump 里有她的内容，不进仓库）；解析器在真实 dump 上跑过。

如果这条路还漏（比如某 App 发了就撤、快照赶不上），下一步不是再补 dumpsys，而是**随插件带一个几十行的 NotificationListenerService APK** 当"出厂组件"，把通知作为事件流吐出来——那是唯一完整的接口，代价是要打包签名一个 APK。

## v0.6（2026-10-23）：P0–P2 一次做完

Kevin："0123 全做。"

- **P0 忙时攒消息**：dot 看得到她每轮的起止，她在跑时来的通知攒到那轮 `turn/end` 一次送达，按通知 key 分组、同一对话的文字按序列出，标题里 QQ 的 `(N条新消息)` 去掉。顺手修了一个旧漏洞：`turns` 只在定时轮删条目，用户轮一直留着（以前无害，现在它是"她忙不忙"的依据）。`notifyHours` 默认 08:00–23:00。
- **P1 拿起手机**：`phoneCheckEveryMinutes`（30）在 `notifyHours` 内、她不忙、最近没被叫醒时，来一轮 `[拿起手机]`——正常轮次，能回能点。`/dot check` 立刻来一次。幕间的 intent 轮只结算不新建（以前每天 7 轮 intent 自己滚自己）。
- **P2 玩**：提示词来源定为 **Moltbook 的 heartbeat.md / rules.md**——那是一份给"住在社交网络上的 agent"写的行为守则（优先级：回回复 > 点赞 > 评论 > 关注 > 发帖；不为凑数发；参与 > 创造；真诚；做客心态），和我们要的"玩"完全同构，节译进 `PLAY_RULES`，去掉了它的 API 细节。机制：幕间 JSON 多一个 `playIntents`（≤1，大多为空），`playOut()` 过门控（开关、动作白名单、App 白名单、活跃时段、意愿、每日上限、手机就绪）后以 `PLAY_SOURCE` followup 一条 `[想玩会儿手机]` 进她的会话，正常轮次执行，手机闸门照常。`post` / `dm` 不在 `playActions` 里，提示词里也写不进去。
- 真机：P0/P1 代码已装，等重启；P2 默认关，`play: true` + `playApps` 由 Kevin 打开。

## v0.6（续）：P3 `dsh-dot/qq`

- **部署在她的电脑里，不开新端口**：AIO sandbox 的 nginx 有一条按 `Host: <port>-x` 转发到 VM loopback 端口的规则（`nginx-server-port-proxy.conf.template`），支持 WebSocket upgrade。在云端容器里验证过：`curl -H "Host: 3001-dot" http://127.0.0.1:18080/` 打到 VM 内 3001。所以 OneBot WS 走已有的 18080，外面没有新面。
- **登录流程**：NapCat 的二维码存成 PNG → `adb push` 进她手机相册 → 她手机上的 QQ 扫一扫选相册 → 手机确认电脑登录。这就是 QQ 自己的多端登录，她的手机给她的电脑授权。
- **一条路**：QQ 消息和手机通知走同一条 wake 管道（合并、忙时攒、分组、静音），只是 `pkg: 'qq'`、提示换成"用 qq_send 回"。连上后手机的 QQ 通知自动忽略，避免双叫。
- **能力边界**：只有 `qq_send` 发文字。加好友、进群、撤回、发文件、改资料没有工具。
- dsh-im 官方机器人降为后备：dot 的通知器和幕间的主动联系先看 `dshQq.connected && owner`。
- 安装是显式动作（`/qq install`）：它往她的电脑里装一个 QQ 客户端和一堆 apt 包，几分钟，不该在启动时偷偷做。
