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
- **对外不变**（v0.9.2 前）：`mcp__vm__*` 工具（v0.9.2 起改为 `mcp__dot-vm__*`，避免和别的插件撞名）、`dshComputer` 服务名、`~/.dsh/dsh-computer*` 文件、VM 名 `dsh-computer`、`DSH_COMPUTER_*` 环境变量都保留——已经跑着的虚拟机、快照、审计日志不用迁移。
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

- **P0 忙时攒消息**（v0.17.0 起只对别人的通知；他的话见文末「先读再说」）：dot 看得到她每轮的起止，她在跑时来的通知攒到那轮 `turn/end` 一次送达，按通知 key 分组、同一对话的文字按序列出，标题里 QQ 的 `(N条新消息)` 去掉。顺手修了一个旧漏洞：`turns` 只在定时轮删条目，用户轮一直留着（以前无害，现在它是"她忙不忙"的依据）。`notifyHours` 默认 08:00–23:00。
- **P1 拿起手机**：`phoneCheckEveryMinutes`（30）在 `notifyHours` 内、她不忙、最近没被叫醒时，来一轮 `[拿起手机]`——正常轮次，能回能点。`/dot check` 立刻来一次。幕间的 intent 轮只结算不新建（以前每天 7 轮 intent 自己滚自己）。
- **P2 玩**：提示词来源定为 **Moltbook 的 heartbeat.md / rules.md**——那是一份给"住在社交网络上的 agent"写的行为守则（优先级：回回复 > 点赞 > 评论 > 关注 > 发帖；不为凑数发；参与 > 创造；真诚；做客心态），和我们要的"玩"完全同构，节译进 `src/prompts/interlude.play-rules.txt`，去掉了它的 API 细节。机制：幕间 JSON 多一个 `playIntents`（≤1，大多为空），`playOut()` 过门控（开关、动作白名单、App 白名单、活跃时段、意愿、每日上限、手机就绪）后以 `PLAY_SOURCE` followup 一条 `[想玩会儿手机]` 进她的会话，正常轮次执行，手机闸门照常。`post` / `dm` 不在 `playActions` 里，提示词里也写不进去。
- 真机：P0/P1 代码已装，等重启；P2 默认关，`play: true` + `playApps` 由 Kevin 打开。

## v0.6（续）：P3 `dsh-dot/qq`

- **部署在她的电脑里，不开新端口**：AIO sandbox 的 nginx 有一条按 `Host: <port>-x` 转发到 VM loopback 端口的规则（`nginx-server-port-proxy.conf.template`），支持 WebSocket upgrade。在云端容器里验证过：`curl -H "Host: 3001-dot" http://127.0.0.1:18080/` 打到 VM 内 3001。所以 OneBot WS 走已有的 18080，外面没有新面。**（v0.8.4 起作废：这条转发不验网关密钥，已被封成 404；现在走网关验过密钥后的 `location /dsh-dot/napcat/`，见文末。）**
- **登录流程**：NapCat 的二维码存成 PNG → `adb push` 进她手机相册 → 她手机上的 QQ 扫一扫选相册 → 手机确认电脑登录。这就是 QQ 自己的多端登录，她的手机给她的电脑授权。**（实测不行：QQ 的电脑登录码不接受相册导入，只认摄像头。v0.8.x 起改为放到她手机虚拟摄像头前，见文末。）**
- **一条路**：QQ 消息和手机通知走同一条 wake 管道（合并、忙时攒、分组、静音），只是 `pkg: 'qq'`、提示换成"用 qq_send 回"。连上后手机的 QQ 通知自动忽略，避免双叫。
- **能力边界**：只有 `qq_send` 发文字。加好友、进群、撤回、发文件、改资料没有工具。
- dsh-im 官方机器人降为后备：dot 的通知器和幕间的主动联系先看 `dshQq.connected && owner`。
- 安装是显式动作（`/qq install`）：它往她的电脑里装一个 QQ 客户端和一堆 apt 包，几分钟，不该在启动时偷偷做。

## v0.6.1（2026-10-23）：长任务——QQ 上派的活她做不完

Kevin："感觉现在很难给他长任务。他很容易直接结束然后就回我。"

查她的会话日志：你在 QQ 上说"你可以做个长任务，多去刷刷"，她第一步就调了 `create_goal`（dsh 自带的长任务机制：目标存在会话里，每轮结束后 goal-round-driver 自动叫她继续，直到她标记完成或到轮数上限），被拒：`GOAL_TOOL_AUTHORITY_REQUIRED — this goal operation requires a direct human turn on a top-level agent`。dsh 只承认 `source.kind === 'user'` 的消息是人说的；我们把 QQ 消息当通知送进去（`kind: dsh-dot`），于是她只能写个 todo、搜一次就打勾、汇报、结束。单轮步数不是问题（她单轮跑过 45 步）；我们删掉的两段系统提示只是身份一句话，也不是原因。

- **A**：owner 的 QQ 私聊以 `{kind: 'user', rpcId: 'qq-…'}` 送进去——和 dsh-im 转发 IM 用的同一种来源，正文就是你打的字，"用 qq_send 回"挪到 `qq:channel` 段里。陌生人和群消息照旧是通知，建不了目标（一个陌生人不该能让她在手机上连跑十几轮）。随之 owner 不再自动学（否则第一个私聊她的人就拿到这个权限），必须 `/qq owner` 指定；夜间静音对 owner 不生效。
- **B**：dot 的工作规则加一条长任务规则，措辞照 dsh 的 `create_goal` 描述（"即使他没说'目标'"）：先回收到、分段汇报、确认做完才标记完成、一轮能做完的不建。
- **C**：目标进行中，dot 的"拿起手机"、幕间的"去看""去玩"都不插进来（`goals.get(agent).phase === 'active'`）；你的新消息照常在两轮之间送到。
- **D**（换 pro）不做：goal 每轮的提示要求"标记完成前收集证据确认整个目标达成"，先看 flash 在这个约束下的表现。

## v0.8.4–v0.10.18（2026-10-28 — 10-30）：安全加固、SnowLuma、摄像头扫码

**安全**（起因：插件市场的审核意见，之后按同一思路自查）
- 电脑网关（AIO sandbox 8080 → 本机 18080）启动 VM 时带 `SANDBOX_API_KEY`，密钥存 `$DSH_HOME/dsh-computer.key`（0600），所有进程内调用带 `X-AIO-API-Key`。网关的 `Host: <port>-x` 端口转发不验密钥，启动时改成 404；网关没加上密钥或转发没封住时电脑状态是 `unsafe`，不报告就绪，QQ 不连（`blocked`）。
- 实时画面挂在 dsh 自己的 web server 上（`/dsh-dot/computer/`），先过 dsh 的身份校验；noVNC 的 WebSocket 用 120 秒、一次性、绑定来源 IP 的票据（桌面版 App 走桥接没有 TCP 对端时不绑定）。
- 电脑工具的审批按工具分类（只读 / shell / 文件 / 浏览器动作 / 总是问），没见过的工具按动作处理并记审计；受保护路径（密钥、浏览器配置、凭据）出现在任何参数里都问。
- QQ：图片网址只收公网 http(s)（防 SSRF）；拼进 VM root shell 的账号、端口、token、网址先校验；群消息打分的提示词把消息隔离；手机通知里"昵称像你"不等于你（标未验证）；连上的不是她的号就断开（`wrong-account`）。

**SnowLuma 后端**（Kevin："我想搭配 snowluma"）
- 用 ptrace 钩住 Linux QQ 图形界面。装一个钉版本、校验 sha256 的干净 linuxqq（不用 NapCat 改过启动器的那份），SnowLuma 用自己的 Node 24（SQLite 存储要求，镜像自带 22），WS/HTTP 都只在 VM 回环、经网关认证路径进来；HTTP 给 SnowLuma 官方 MCP（`mcp__dot-qq__*`，219 个 action，`qqToolGate` 分级审批）。
- 真机踩到并修掉的：启动脚本里 `pkill -f` 匹配到自己的命令行而自杀；按 `/tmp/.X11-unix` 第一个 socket 选显示，选到 NapCat 留下的死 Xvfb；Xvnc 的显示写作 `:99.0`；GitHub API 限流拿不到 tag。

**摄像头扫码**（QQ 电脑登录码只认摄像头）
- AVD 后置摄像头设为 `virtualscene`。模拟器只在开机时读场景文件、海报图片每个进程只认第一次设置，实测得出的做法：开机前把 `wall` 海报挪到镜头正前方；换图时先回桌面（摄像头开着换不了）、清空海报、再设一个新文件名（`adb emu virtualscene-image`）。
- QQ 的码是圆点风格，zbar/OpenCV 读不出，用 zxing-cpp 读出内容，qrencode 重画成方块码，放在方形画布右侧（QQ 扫一扫的取景比相机近、偏左）。只在码读不出（过期）时点「刷新」——点有效的码会让 QQ 换码，作废她镜头里那张。
- 10-30 真机：她用手机 QQ 摄像头扫码，确认登录，SnowLuma `connected`。这几轮里关键的观察多是她自己说出来的（"格子动都没动""左边半张在画面外""那个框压住半个码"）。

**手机存储**：她 8 GB 数据分区满了；改 `disk.dataPartition.size` 不会扩大已有分区（实测）。新手机默认 16 GB，建之前可选（`/phone accept <GB>`、`/phone size <GB>`）。


## v0.12.3（2026-11-03）：面板「最近 30 场」、启动自检、mface 表情

- **最近 N 场**（`src/dot/activity.js`，参照别家养鱼面板的"按场列表"）：一场 = 一次叫醒到那轮结束（他的话、QQ / 手机通知、拿手机、幕间一轮、定时任务、玩、每天的日记），按会话 + 时间窗把已有记录拼起来——dot / interlude / memory 审计、QQ 审计（`private`/`group`、`sent`、`sticker-kept`）、memory 的 transcript / calls / diary、幕间的 calls / script。不新增任何写入；每个文件只读尾部（最近 3 天、至多 1 MB，审计含 `.1`），按 size+mtime 缓存，面板 3 秒一轮也只做几次 `stat`。每场：时间 · 进行中/完成/出错 · 来源，展开是动作（短标签 + 她的原话，截 80 字）和工具 / 模型次数 / token（只有幕间和日记的 token 有记录）。
- **启动自检**：`lastSession` 指向跑腿（在 pastErrands、或标题含"跑腿"）或已归档（`workspaceRegistry.archivedSessionIds`）就清空并记 `last-session-cleared`；查不到的跳过。起因：11-03 旧状态文件指向已归档的跑腿，他的 QQ 消息投进去没人回。
- **mface**：QQ 自带大表情的 summary 是 `[？]`、`[doge]`，没有"表情"二字，原来没被当表情包存；短方括号（1–8 字，`[图片]` 除外）也算。

## v0.17.0（2026-11-03）：先读再说——他连发一串消息时

调研见 dsh-dot-research/multi-message.md 的方案 A。以前他的话和通知一起走 1 秒固定窗口，她这轮没做完就攒到 `turn/end`，再 followup 开新一轮：她弄手机的 20–60 秒里看不到他新说的，还可能先对旧话题发了 `qq_send`，回复顺序就乱了。

- **单独的缓冲**：他的话不进 `batch`，进 `ownerBatch`：静默 `ownerQuietMs`（1.5 s，每条重置），上限 `ownerMaxWaitMs`（6 s，从第一条起）；NapCat 的 `notice` / `input_status`（「对方正在输入」，只认他的私聊）把上限放宽到 `ownerTypingMaxMs`（15 s），他停止输入后回到静默计时。SnowLuma 不推这个事件就当没有。
- **忙时 steer**：她空闲 → 和以前一样 `followup` 开一轮；她这轮进行中 → `agent.steer(...)`，下一个 step 边界就读到（一个正在跑的工具不会被打断；轮次快结束时进来的由 dsh 的 `agent/turn-stopping` 再跑一步）。这时文本多一行 `dot.owner-words.busy`；记忆记录他的原话时把这一行去掉。agent 上没有 `steer` 时退回 `followup`。别人的通知还是攒到 `turn/end`。
- **发出前拦截**：`tools/pre-execute` 里，发给他的 `qq_send` 遇到他还有没读的话——缓冲里有，或 `exec.agent.inbox.nextStep` 里还有 `qq-dot-` 来源的消息（steer 了、模型还没读）——就 `deny`，理由是 `dot.owner-interrupt`，并且立刻把缓冲 steer 进去（同步，用 `exec.agent`）。每轮最多 `ownerDenyMax`（2）次，之后放行（`owner-gate-passed`），免得他一直打字时她永远发不出去。
- **气泡可中断**：`qq.send` 发给他时，每个气泡（第 2 条起）发之前看 `qq.ownerSaidSince(开始时刻)`；他说了话就停，返回 `{ sent, interrupted: true, unsent }`，她看到 `qq.send-interrupted`。
- **规则**：`dot.rules` 加一条：他连着发几条时等他说完、按最后一条的意思回、不逐条回；回到一半他又说话，先看。
- **记忆只记发出去的**：`qq_send` 不再在 `tool/call` 时按参数记，而是等同一 `callId` 的 `tool/result`：出错或被拦（`isError`）→ 不记；否则记 `meta.said` / `meta.imagesSent`（`qq_send` 的 `output.presentationMeta`，落在持久的 `tool/result` 上：打断后没发的、丢掉的英文行、上传失败的图都不在里面）。没有 meta 的旧结果按 `sent N` 取前 N 行。时间用调用的时刻，按时间插回 `lines`（handoff 尾巴、recall 都读它），重放会话日志（`transcriptFromEvents`）走同一个 `qqSentText`。

## v0.17.2（2026-11-04）：图——她发的记成能发的样子，别人发的她看得见

两件事，0.17.1 的标记过滤（`markerOf`）只是兜底，这里修根上的原因。

- **记下的就是能发的**：交接尾巴里她的旧话写着 `… [图片×1]`（记录用的写法），新一段她照着打了一条 `[图片]`，dot 把对话里的回复原样转给他。现在 `qq_send` 的结果（`presentationMeta`）带上真正发出去的图的 ref（`images`，QQ 拒收的不在里面），记忆把它们写成 `[表情包 sticker:<id>]` / `[图 phone:screen]` / `[图 phone:latest]` / `[图 <网址>]`——照着打出来就是那张图（`markerOf` 认得，`sendGate` 也把它当 `images` 审）。只有数量的旧结果取调用里的前 N 张。交接尾巴的说明（`memory.handoff` 的 `tail`）跟着改；`qq.channel.owner` 说清两条路：直接写的回复会原样发给他，图和表情包只能用 `images`。
- **别人发的图她看得见**：以前进她会话的只有 `[图片 <网址>]` / `[表情包 sticker:<id>]` 这几个字。dsh 的用户消息本来就能带图（dsh-llm 的 `ImageBlock { type: 'image', attachment }`，`attachment` 是附件仓库 `ctx.attachments`——`@deepseek-ai/dsh-attachment` 的 `AttachmentStore`，cordis 服务名 `attachments`——`saveImages` 返回的 `ImageAttachmentRef`；mobile-mcp 截图走的也是这条：dsh-mcp-client 用 `ctx.get('attachments').saveImages` 存 MCP 结果里的图）。dot/qq 在会叫醒她的消息上取图、存进仓库，`m.images: [{ ref, text }]`；dot/core 把他的话和通知的叫醒文本拆成内容数组，图紧跟在它的文字后面（`withImages`）。文字部分拼起来和原来一字不差，所以记忆（只取 text 部分）、recall 索引都不变，也不会记下附件 id。模型不收图时 dsh 的请求组装自己换成文字占位（`projectImagesForTextModel`）。

## 0.18.0：活性、闸门、可见

起因：11-04 15:04 跑腿会话被一个没人点的审批卡了十几个小时，扣下 16 条通知，定时看手机全停。计划见 dsh-dot-research/plan-0.18.md。

- **审批有超时、有人知道**：dot 在 `approval/request` waterfall 上注册答复器（`prepend`，包在 UI 答复器外面；只管她的会话：`<home>` 里的、IM 的、跑腿）。收到就告诉他（QQ 连着走 QQ，否则 dsh-im），带工具名、原因、实时画面链接和"N 分钟没人点就当拒绝"；`next()`（UI）和 `approvalWaitMs`（10 分钟）赛跑，先到先得；超时返回 `'rejected'`，记 `approval-timeout`，再给他一句"过期了"。UI 晚到的答复被丢掉（waterfall 已经返回）。请求被撤回（`signal` abort，比如这一轮被停）→ `'cancelled'`，不发过期。dsh 把 rejected 写成 `the user rejected tool "…"`；过期的那个 `callId` 在 `tools/post-execute` 里换成 `dot.approval-timeout`。
- **轮次看门狗**：每个打开的轮记最后一个会话事件的时间；60 秒一看，`turnStallMs`（5 分钟）没动静记 `turn-stalled`（每轮一次）。跑腿卡住 `errandStallMs`（10 分钟，有审批在等时等审批先过期）→ `agent.cancel({ kind: 'hook', reason: 'dot-watchdog' }, { keepInbox: true })`（`ctx.agents` 里的活 agent），这一轮从 `turns` 删掉（晚到的 `turn/end` 不再留便条），会话进 `pastErrands`，下一次跑腿开新会话；扣着的通知交给新跑腿；她对话里留 `dot.errand-stalled`（"做到一半卡住了，放弃了：<最后在做的工具 / 等哪个审批>"）。她的对话卡住不取消，只告诉他一次（他已经收到这轮审批提醒时不再说）。
- **闸门按地盘分**（`src/computer/gate.js`）：`shellPatterns` 去掉 `rm -rf`、`python -c` / `node -e` 一类、`eval`、`nohup`、`chmod +x`、`crontab`、`systemctl`、`supervisorctl`（在她自己的虚拟机里都是正常用电脑），`truncate` 挪到下面；留 `sudo`、`curl|sh`、`curl|python`、`base64 -d|`、`ssh`/`scp`、`git push`、`dd if=`、`mkfs`、`shred`/`wipe`、`>/dev/sd`、受保护路径。新加 `sharedTouch`：把命令按 `; && || |` 和换行切段、跟着 `cd`，`rm`/`rmdir`/`unlink`/`mv`/`truncate`/`chmod`/`chown`/`chgrp`/`shred`、`find -delete`、`>` 覆盖写（`>>`、`/dev/null` 不算）的目标落在共享文件夹里或在它上面（`/Users/*`、`/`），或者是她整个家目录（`vmHome`，`~`、`$HOME`），就问。共享路径每次调用现读 `dshComputer.mounts`，经 `backend.toGuestPath`（Windows 是 `/mnt/<盘>/…`）；dsh 的 `bash` 的工作目录是会话文件夹（subprocess 第一次用时就共享它），所以相对路径算共享；虚拟机自带的 shell 从她家目录开始。粗糙是故意的：`$VAR` 当工作目录，引号外的转义不管。文件工具（`sandbox_file_operations` 删除/移动）没动，照旧问。
- **`phone_zoom`**（`src/phone/phone.js`）：mobile-mcp 1.0.12 的截图只能整体缩小（`scale` 0–1、`maxSize`），没有裁剪放大，她以前去电脑里裁图。现截一张（`phone.screenshot`），自带的 PNG 解码（`decodePng`，原来 `blankPng` 里那段）裁 `{x,y,w,h}`、双线性放大 ≤3 倍、`encodePng`（deflate + 自算 CRC，不加依赖），`attachments.saveImages` 存成图片块返回；值里只有坐标和 ref，不含字节。`phone.device` 加一句。幕间观察轮放行它。
- **看得见**：`dshDot.turn(id)` / `turns()` / `approvals()` 给出每个打开的轮的状态（`turnState`：`approval` 正在等审批、`stalled` 超过 `turnStallMs` 没事件、`timed-out` 审批过期后一直没动静、`running`）和最后在做什么。面板「最近 N 场」里进行中的那场按它显示「等审批 N 分钟」「卡住 N 分钟」「已超时」，顶上多一个黄 / 红徽章；`/dot` 列出每个在等的审批（在哪个会话、等了多久、上限）和每个卡住的轮（多久没事件、最后在做什么、跑腿会在多久后放弃 / 她的对话不取消），都没有时一行 `liveness: …` 带三个阈值。

## 0.19.0：一个她当家、手机租约、幕间派活

- **一个她当家**：只有她的对话跟他说话，跑腿只干活、交汇报；通知按会话线程过滤和合批；被忙会话扣住超过 `dot.heldMaxMs` 的通知改投新跑腿；同一轮里同一工具、几乎相同的参数达到 `dot.loopRepeat`（5）次就拒绝再调（`dot.loop-stopped`，审计 `loop-stopped`）；一轮里的审批提醒只发一条。
- **手机租约**：同一时间只有一个会话操作手机（她的对话优先，幕间观察轮也走租约）；QQ 只用 `qq_send` 发；dsh 停机期间漏掉的通知开机补回。
- **手机实时画面**：所有观看者共用一个截图循环，两帧之间至少歇截图耗时的 3 倍，失败退避，页面隐藏时暂停。起因：11-06 09:59 模拟器被自己的卡死检测杀掉（`detected a hanging thread 'QEMU2 main loop'`，主循环和 4 个 vCPU 同时 15 秒无响应）；API 35 + `-gpu auto` 被强制成 CPU 软件渲染，每次截屏都在宿主 CPU 上重合成整屏。`gpu` 的说明见 phone.md。
- **幕间**：不再自己动手，改为给跑腿派任务（排在真实工作后面、会过期），结果和延迟作为剧情回来；虚构生活跟着她真实做过的事走，虚构人物不引发真实动作，人设只在 canon。
- **记忆**：BM25 + 人名两路检索用 RRF 融合；改动的碎片替换旧的，日期写成绝对日期；使用记忆的规则（只答所问、不补细节、按记录时的状态说、不猜动机）。附 chat-memory-benchmark 适配器（`bench/`）。
- **提示词覆盖**记下它基于哪一版内置，内置更新后面板和 `/dot prompts` 标出，`/dot prompts rebase` 对齐。
- 小黑盒推广通知按通知正文（来自《…》，点击查看>>）识别。

## 0.19.1：把覆盖里修好的提示词收回内置

一位用户（作者本人）的 `~/dot/prompts` 里有 10 个覆盖，其中 6 个修的是内置本身的毛病，收回内置后覆盖可以删掉：
- `dot.approval-timeout`、`interlude.play`、`dot.rules`（审批那条）：被拒或超时就停下这一步，只做不依赖它的事，不换渠道绕过（原来的"换别的办法"读起来像去绕审批）。
- `interlude.round.phase.follow-up`：给用户的追发消息写 `<contact/>`、原话进 contact 字段（原来让她在 script 里写原话，和 `interlude.round` 的约定矛盾）；`interlude.round.refresh` 说清 `<contact/>` 只是标记。
- `interlude.round`：区分消息到达和她注意到消息。
- `phone.device.number`：注册用这个号，已有账号按 `account get` 的记录登录。
- `memory.standing`：记忆可能过时，和他现在说的冲突时以现在为准。
- `dot.rules`：问的是现在就能查的未来信息（天气、安排）就现在查，不建定时任务。

## 0.20.0：记忆大整理

起因：chat-memory-benchmark 上 0.19 比 0.18 多了 BM25、人名通道、取代、还没了的事、日历换算，花费从 ¥18.5 翻到 ¥37.8，分数 621 → 622（两轮各有约 50 题对错互换，差 1 题是噪声）。假模型回放量出来，整理调用占全部输入 token 的 88%，每次整理里新记录只占 2.8%，其余是每次重发的规则、碎片清单和画像；288 次里 272 次新记录不到 4 行（安静 30 分钟就触发）。外部调研（`reports/各家 agent 记忆系统设计.md`，不在仓库里）的结论相同：带时间戳的原话 + 检索（含重排）打平或超过模型抽取式记忆，抽取的 UPDATE/DELETE 基本没有收益；有证据的增益是强制检索、重排、时间锚。

一句话：原话负责证据，三栏笔记负责长期状态。

- **删**：碎片层（重要度、tag、次数、钉住、老化、300 上限、取代、`who`、`open`/`closed`）；整理时附的日历和碎片清单；召回的人名通道和 RRF；交接文本（新会话只带最后 12 句原话）；「安静 30 分钟就整理」；每天那次空跑的整理；人物卡上的事实和待核实队列；跑腿会话里的常驻记忆；共存检测里扫描 `node_modules`。
- **召回**：向量、BM25 各出 20 条候选，合并后交给重排（本机默认 `Xenova/bge-reranker-base`，向量模型之后下载；云端照旧），最多 10 条、可以更少、不凑数（`recallRerankMin` 可选门槛）；没有重排时每路用对比度、交替合并。结果按日期分组（`— 06-22 周一 · 15 天前`），原话里的「明天、下周三」由代码换算（`src/memory/when.js`；月底、X 号、引号、转述、假设都不换）。`recall` 工具查同一套索引。
- **三栏笔记**：关于他 / 她自己 / 还没了的事。第三栏一事一条（`due`、`owed`），只在原话显示办完时 `done`；超过 800 字不截断，最不紧的挪进「先搁着的」（没答应过、没日子的先挪），栏尾常驻一行列出它们，整理时可 `restore`，`recall` 工具搜得到。
- **整理**：只在攒满 40 行或交班前；提示词改成规则在前（每次相同，命中缓存）、已有内容其次、新记录最后；记录里的相对日期同样由代码先换算好。
- **日记**：独立的一次小调用，只读当天记录，当天没记录就不调用。
- **迁移**：读到 0.19 的 `memory.json` 自动迁移；没进第三栏的事挪到先搁着的，其余（碎片、卡上事实、待核实）原样存 `memory.v019.json`，`memory-migration.md` 写明去向。
- **测量工具**：`bench/recall-coverage.py` 按基准的证据标注算召回覆盖（候选池覆盖 / 注入覆盖，按考点、多证据题、字面重合低的题分组），不调模型；bench 的 `--save-prompts` 记下每题的候选和命中时间，`DSH_BENCH_EMBED` / `DSH_BENCH_RERANK` / `DSH_BENCH_MEMORY` 选变体。

## 0.21.0：幕间放开

起因：幕间里她能真去做的事只有点赞、评论、关注、攒表情包和"去看"，提示词又在好几处踩刹车（"不能在账本外编造手机电脑上的活动""不能安上没确立的项目""herLife 为空时保持小""只做这一件，不发新帖""事件保持克制"），玩多少还"按 herLife 里自己的习惯"——笔记里有什么就做什么，做完又记回笔记，越跑越像日程表。

- **边界写进代码和一份短清单，其余放开**：`interlude.round.free` 只说她不是照日程表过日子的人、重复会腻、做什么由她；真实性约定只管"什么算真的发生了"，不再限制她想做什么。`her-life` 改成"已确立的生活，不是只能做的事"；写作风格里"克制"改成"可信就好，不必保守"。
- **试点新的（tries）**：新的意图，交给跑腿真去做，手机、电脑都行；硬边界：不花钱、不改账号资料、不注册、不私信陌生人、不碰他的东西、只删自己建的、审批照常。每天 `tryDailyCap`（3）。
- **发帖**：`post` 进了 `playActions`，要带正文，每天 `postDailyCap`（1）；不要就从 `playActions` 去掉。
- **她自己的账（doings.json）**：玩、去看、试的每一件，带结果、token（跑腿那一轮每步用量相加，dot 的 task `onDone` 里新增 `cost`）和他的反应；下一轮作为 `yourDoings` 给她：七天里一直在做什么、各花多少、这周没碰的 App、今天一共花多少（含写生活本身）。值不值由她掂量，写进 `reflect`。
- **他的反馈进账**：她对话里的 `doings` 工具（他说起某件事时记下），或 `/interlude feedback [#id] …`；`/interlude doings` 看清单。
- **节奏**：`advanceEveryMinutes` 180 → 90，`maxRoundsPerDay` 12 → 20。

## 0.22.0（未发布）：自己的时间、成长

起因：0.21 的放开仍是"代码定格子、她往里填"——旁白写剧本、抽出意图交给跑腿，想做和去做是两个模型；她也没有会变的"自己"，Canon 锁死，记忆只记零散的"学会的事、习惯、看法"，覆盖写、没有历史。

约束：记忆系统的结构（代码、整理规则、召回、字数上限）不动，benchmark 成绩继续成立；内容她本来就能用 memory 工具改。这一版没有改 `src/memory/`、`memory.*` 提示词和 `bench/` 的任何一行。

- **自己的时间**：倒过来——先让她活，再让旁白记。每天随机两次，跑腿的她拿到全部工具和一句"这段时间是你自己的"，没有动作表。边界在能力层：QQ 和账本工具被拒、社交 App 里打字要批准、花钱和装 App 照旧审批、找他只能经 `tell_him`（主动联系的闸门）；token 预算 80% 提醒、100% 停。和 0.21 的格子并行，`/interlude doings` 按"自己的时间"和其余分开看，跑一阵再定留哪个。
- **她自己的地方** `<home>/her/`：延续性来自她留下的东西（草稿、清单、学会的步骤），不来自我们设计的字段。
- **成长**：「她现在的样子」——她每周自己重写的一段，系统提示词里紧跟 Canon；每次最多改 35%，分清"我想要的"和"他喜欢的"，每版存档（`<home>/interlude/growth`，不在她的文件夹里）可回滚。读记忆不写记忆，过时的笔记留给她自己的时间去改。
