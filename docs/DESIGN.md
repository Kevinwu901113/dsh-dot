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

- dsh-computer 仓库的历史用 `git merge --allow-unrelated-histories` 并进来（提交记录保留），文件移到 `src/computer/`（vm / subprocess / gate / audit / backends；根组件的宿主侧现在在 `src/page/host.js`），原 dsh-dot 的 core 移到 `src/dot/core.js`。
- `cordis.patch.yml` 合并：电脑那部分（关掉宿主 subprocess、沙箱策略、权限预设、`dot-computer` / `dot-subprocess` / `dot-gate` / `dot-mcp` / `dot-ui`）在前，`dot` 在后。组件名 `dsh-dot/computer`、`dsh-dot/subprocess`、`dsh-dot/gate`、`dsh-dot/dot`；`package.json` 的 `exports` 对应。
- 客户端 bundle `lib/client.js` 的 `__ModuleLoader__` id 必须等于包名，改成 `dsh-dot`（CSS tag 同步）；标签页内部 id 不动。`ui/` 源码的 tsdown 配置同步。
- **对外不变**（v0.9.2 前）：`mcp__vm__*` 工具（v0.9.2 起改为 `mcp__dot-vm__*`，避免和别的插件撞名）、`dshComputer` 服务名、`~/.dsh/dsh-computer*` 文件、VM 名 `dsh-computer`、`DSH_COMPUTER_*` 环境变量都保留——已经跑着的虚拟机、快照、审计日志不用迁移。
- dsh-interlude 不并：它是 AGPL-3.0（移植自 HDS-Interlude），并进 MIT 包会把整个包拖成 AGPL；而且它不依赖 dot，独立装卸更干净。
- 原 dsh-computer 仓库保留作为历史，README 指向这里。

## v0.4（2026-10-23）：幕间也并进来，只留一个仓库

Kevin："interlude 也合并到 dot 里面。然后所有仓库清理掉不要了，仅保留一个 dot 仓库。"

- dsh-interlude 的历史同样 merge 进来；代码在 `src/interlude/core.js`，组件 `dsh-dot/interlude`，测试 `test/interlude.test.js`，示例 Canon 在 `examples/`，文档 `docs/interlude.md` / `docs/INTERLUDE-DESIGN.md`。
- **许可证变成 AGPL-3.0-only**：幕间按原文使用 HDS-Interlude 的提示词，HDSI 是 AGPL；并进同一个包，整个包就是 AGPL。v0.3 以前以 MIT 发布的 computer / dot 代码，那些版本仍是 MIT。
- **2026-11：许可证改回 MIT**：幕间一轮的提示词（`interlude.round` 及其阶段、篇幅、联系、浏览几个小段）全部重写，按模型家族选篇幅段的逻辑删掉，示例 Canon 换成自带的 `examples/canon.example.json`。仓库里不再有 HDS-Interlude 的代码或文字，只保留 `storyDefaults` 字段名以便导入预设。0.3–0.22 的版本仍是 AGPL。
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
- **发出前拦截**：`tools/pre-execute` 里，发给他的 `qq_send` 遇到他还有没读的话——缓冲里有，或 `exec.agent.inbox.nextStep` 里还有 `qq-dot-` 来源的消息（steer 了、模型还没读）——就 `deny`，理由是 `dot.owner-interrupt`，并且立刻把缓冲 steer 进去（同步，用 `exec.agent`）。连着最多让 `ownerPreemptMax`（2）次（和她写的回答、重来的那一轮共用一个数），之后放行（`owner-gate-passed`），免得他一直打字时她永远发不出去。
- **气泡可中断**：`qq.send` 发给他时，每个气泡（第 2 条起）发之前看 `qq.ownerSaidSince(开始时刻)`；他说了话就停，返回 `{ sent, interrupted: true, unsent }`，她看到 `qq.send-interrupted`。
- **规则**：`dot.rules` 加一条：他连着发几条时等他说完、按最后一条的意思回、不逐条回；回到一半他又说话，先看。
- **发也算忙，第一条气泡为界**（0.24）：她对他只有三种状态——在写（他的话开的那一轮还开着）、在发（这一轮的回答正一条条发到他 QQ）、都不是。规则只有一条：**还没到他那的让给他刚说的，已经到他那的算数**。
  - 在写、这一轮还没调过工具：取消这一轮（`agent.cancel(..., { keepInbox: true })`），同一拍里把他刚说的排进下一轮（`agent.send(message, 'next-turn', true)`：宿主把取消之后来的唤醒输入留给下一轮，中止落定后自己开——不等我们的 promise，顺序就是宿主收件箱的顺序）。被取消的那一轮结束时记 `owner-turn-restarted`：真中止了就什么都不留；取消来晚了、它照常写完了（`aborted: false`），那段回答不发，留作草稿。调过工具的不取消，照旧 steer。
  - 写完要发、缓冲里有他没读的话：整条回答不发，留作草稿（`owner-reply-held`）。
  - 在发：`qq.send` 在下一条气泡前停下，剩下的留作草稿；他的话等这次发送停稳再交给她，不并行开新一轮。
  - 草稿跟着他的下一批话给她看一次（`dot.owner-words.unsent`），由她决定重说还是放下；记忆记他的原话时把这段去掉。五分钟内他没再说话，草稿作废，记 `owner-draft-dropped`。
  - 发到一半 QQ 报错：已经到他那的气泡照常记，没发出去的同样留作草稿（`qq-relayed` 带 `error`）；一条都没发出去才算失败。
  - 连着让 `ownerPreemptMax`（2）次之后先把话发出去；有一条气泡到了他那就清零——她自己用 `qq_send` 回的、或这一轮她选择不说话，也清零。所以她只要发出一条，这一轮就不会再被取消。
  - 直接回答走 `sayToOwner` 一个出口；`qq.send` 对同一个对象的发送排队，两次发送的气泡不会交错。
  - 她的记录按送达写：QQ 轮次的回答不在 `turn/end` 记，由 dot 把真正发出去的气泡报给记忆（`dotMemory.herSaid`）。`sentToOwnerAt` 只由她自己的 `qq_send` 设置。
- **记忆只记发出去的**：`qq_send` 不再在 `tool/call` 时按参数记，而是等同一 `callId` 的 `tool/result`：出错或被拦（`isError`）→ 不记；否则记 `meta.said` / `meta.imagesSent`（`qq_send` 的 `output.presentationMeta`，落在持久的 `tool/result` 上：打断后没发的、丢掉的英文行、上传失败的图都不在里面）。没有 meta 的旧结果按 `sent N` 取前 N 行。时间用调用的时刻，按时间插回 `lines`（handoff 尾巴、recall 都读它），重放会话日志（`transcriptFromEvents`）走同一个 `qqSentText`。

## v0.17.2（2026-11-04）：图——她发的记成能发的样子，别人发的她看得见

两件事，0.17.1 的标记过滤（`markerOf`）只是兜底，这里修根上的原因。

- **记下的就是能发的**：交接尾巴里她的旧话写着 `… [图片×1]`（记录用的写法），新一段她照着打了一条 `[图片]`，dot 把对话里的回复原样转给他。现在 `qq_send` 的结果（`presentationMeta`）带上真正发出去的图的 ref（`images`，QQ 拒收的不在里面），记忆把它们写成 `[表情包 sticker:<id>]` / `[图 phone:screen]` / `[图 phone:latest]` / `[图 <网址>]`——照着打出来就是那张图（`markerOf` 认得，`sendGate` 也把它当 `images` 审）。只有数量的旧结果取调用里的前 N 张。交接尾巴的说明（`memory.handoff` 的 `tail`）跟着改；`qq.channel.owner` 说清两条路：直接写的回复会原样发给他，图和表情包只能用 `images`。
- **别人发的图她看得见**：以前进她会话的只有 `[图片 <网址>]` / `[表情包 sticker:<id>]` 这几个字。dsh 的用户消息本来就能带图（dsh-llm 的 `ImageBlock { type: 'image', attachment }`，`attachment` 是附件仓库 `ctx.attachments`——`@deepseek-ai/dsh-attachment` 的 `AttachmentStore`，cordis 服务名 `attachments`——`saveImages` 返回的 `ImageAttachmentRef`；mobile-mcp 截图走的也是这条：dsh-mcp-client 用 `ctx.get('attachments').saveImages` 存 MCP 结果里的图）。dot/qq 在会叫醒她的消息上取图、存进仓库，`m.images: [{ ref, text }]`；dot/core 把他的话和通知的叫醒文本拆成内容数组，图紧跟在它的文字后面（`withImages`）。文字部分拼起来和原来一字不差，所以记忆（只取 text 部分）、recall 索引都不变，也不会记下附件 id。模型不收图时 dsh 的请求组装自己换成文字占位（`projectImagesForTextModel`）。

## 0.18.0：活性、闸门、可见

起因：11-04 15:04 跑腿会话被一个没人点的审批卡了十几个小时，扣下 16 条通知，定时看手机全停。计划见 dsh-dot-research/plan-0.18.md。

- **审批有超时、有人知道**（0.18–0.24；0.25 起没有按钮可等，见文末「0.25：要他的事」）：dot 在 `approval/request` waterfall 上注册答复器，告诉他、和 `approvalWaitMs` 赛跑，没人点就当拒绝。
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
- `memory.standing`：记忆可能过时；他讲明变了的以现在为准，只是把数目、日子、人说得和记得的不一样的，点出记得的是哪个、问一句。
- `dot.rules`：问的是现在就能查的未来信息（天气、安排）就现在查，不建定时任务。

## 0.20.0：记忆大整理

起因：chat-memory-benchmark 上 0.19 比 0.18 多了 BM25、人名通道、取代、还没了的事、日历换算，花费从 ¥18.5 翻到 ¥37.8，分数 621 → 622（两轮各有约 50 题对错互换，差 1 题是噪声）。假模型回放量出来，整理调用占全部输入 token 的 88%，每次整理里新记录只占 2.8%，其余是每次重发的规则、碎片清单和画像；288 次里 272 次新记录不到 4 行（安静 30 分钟就触发）。外部调研（`reports/各家 agent 记忆系统设计.md`，不在仓库里）的结论相同：带时间戳的原话 + 检索（含重排）打平或超过模型抽取式记忆，抽取的 UPDATE/DELETE 基本没有收益；有证据的增益是强制检索、重排、时间锚。

一句话：原话负责证据，三栏笔记负责长期状态。

- **删**：碎片层（重要度、tag、次数、钉住、老化、300 上限、取代、`who`、`open`/`closed`）；整理时附的日历和碎片清单；召回的人名通道和 RRF；交接文本（新会话只带最后 12 句原话）；「安静 30 分钟就整理」；每天那次空跑的整理；人物卡上的事实和待核实队列；跑腿会话里的常驻记忆；共存检测里扫描 `node_modules`。
- **召回**：向量、BM25 各出 20 条候选，合并后交给重排（本机默认 `Xenova/bge-reranker-base`，向量模型之后下载；云端照旧），最多 10 条、可以更少、不凑数（`recallRerankMin` 可选门槛）；没有重排时每路用对比度、交替合并。结果按日期分组（`— 06-22 周一 · 15 天前`），原话里的「明天、下周三」由代码换算（`src/memory/when.js`；月底、X 号、引号、转述、假设都不换）。`recall` 工具查同一套索引。
- **三栏笔记**：关于他 / 她自己 / 还没了的事。第三栏一事一条（`due`、`owed`），只在原话显示办完时 `done`；超过 800 字不截断，最不紧的挪进「先搁着的」（没答应过、没日子的先挪），栏尾常驻一行列出它们，整理时可 `restore`，`recall` 工具搜得到。
- **整理**：只在攒满 120 行、每天写日记前或交班前；提示词改成规则在前（每次相同，命中缓存）、已有内容其次、新记录最后；记录里的相对日期同样由代码先换算好。
- **日记**：独立的一次小调用，只读当天记录，当天没记录就不调用。
- **迁移**：读到 0.19 的 `memory.json` 自动迁移；没进第三栏的事挪到先搁着的，其余（碎片、卡上事实、待核实）原样存 `memory.v019.json`，`memory-migration.md` 写明去向。
- **测量工具**：`bench/recall-coverage.py` 按基准的证据标注算召回覆盖（候选池覆盖 / 注入覆盖，按考点、多证据题、字面重合低的题分组），不调模型；bench 的 `--save-prompts` 记下每题的候选和命中时间，`DSH_BENCH_EMBED` / `DSH_BENCH_RERANK` / `DSH_BENCH_MEMORY` 选变体。

## 0.20.1：幕间放开

起因：幕间里她能真去做的事只有点赞、评论、关注、攒表情包和"去看"，提示词又在好几处踩刹车（"不能在账本外编造手机电脑上的活动""不能安上没确立的项目""herLife 为空时保持小""只做这一件，不发新帖""事件保持克制"），玩多少还"按 herLife 里自己的习惯"——笔记里有什么就做什么，做完又记回笔记，越跑越像日程表。

- **边界写进代码和一份短清单，其余放开**：`interlude.round.free` 只说她不是照日程表过日子的人、重复会腻、做什么由她；真实性约定只管"什么算真的发生了"，不再限制她想做什么。`her-life` 改成"已确立的生活，不是只能做的事"；写作风格里"克制"改成"可信就好，不必保守"。
- **试点新的（tries）**：新的意图，交给跑腿真去做，手机、电脑都行；硬边界：不花钱、不改账号资料、不注册、不私信陌生人、不碰他的东西、只删自己建的、审批照常。每天 `tryDailyCap`（3）。
- **发帖**：`post` 进了 `playActions`，要带正文，每天 `postDailyCap`（1）；不要就从 `playActions` 去掉。
- **她自己的账（doings.json）**：玩、去看、试的每一件，带结果、token（跑腿那一轮每步用量相加，dot 的 task `onDone` 里新增 `cost`）和他的反应；下一轮作为 `yourDoings` 给她：七天里一直在做什么、各花多少、这周没碰的 App、今天一共花多少（含写生活本身）。值不值由她掂量，写进 `reflect`。
- **他的反馈进账**：她对话里的 `doings` 工具（他说起某件事时记下），或 `/interlude feedback [#id] …`；`/interlude doings` 看清单。
- **节奏**：`advanceEveryMinutes` 180 → 90，`maxRoundsPerDay` 12 → 20。

## 0.20.1：自己的时间、成长

起因：上面的放开仍是"代码定格子、她往里填"——旁白写剧本、抽出意图交给跑腿，想做和去做是两个模型；她也没有会变的"自己"，Canon 锁死，记忆只记零散的"学会的事、习惯、看法"，覆盖写、没有历史。

约束：记忆系统的结构（代码、整理规则、召回、字数上限）不动，benchmark 成绩继续成立；内容她本来就能用 memory 工具改。这一版没有改 `src/memory/`、`memory.*` 提示词和 `bench/` 的任何一行。

- **自己的时间**：倒过来——先让她活，再让旁白记。每天随机两次，跑腿的她拿到全部工具和一句"这段时间是你自己的"，没有动作表。边界在能力层：QQ 和账本工具被拒、社交 App 里打字要批准、花钱和装 App 照旧审批、找他只能经 `tell_him`（主动联系的闸门）；token 预算 80% 提醒、100% 停。和上面那套格子并行，`/interlude doings` 按"自己的时间"和其余分开看，跑一阵再定留哪个。
- **她自己的地方** `<home>/her/`：延续性来自她留下的东西（草稿、清单、学会的步骤），不来自我们设计的字段。
- **成长**：「她现在的样子」——她每周自己重写的一段，系统提示词里紧跟 Canon；每次最多改 35%，分清"我想要的"和"他喜欢的"，每版存档（`<home>/interlude/growth`，不在她的文件夹里）可回滚。读记忆不写记忆，过时的笔记留给她自己的时间去改。

## 0.21.0：她的声音

起因：改了不少提示词，她说话的样子变化不大。看她每轮实际读到的：人设在最前面，之后是工作方式、手机和 QQ 的操作说明、dsh 的工具文档、整段历史，最后几段（现在几点、记忆、原话、幕间数据）全是规则和数据——离她开口最近的，没有一句是"怎么说话"。人设对行为的影响随轮数衰减（Persona drift，2024）；角色扮演社区的做法是把风格提醒放在历史之后（SillyTavern 的 Author's Note、角色卡 V2 的 post_history_instructions）。

- ~~说明书第一次用时才给~~（`dot.manuals`）：11-18 删掉，见文末「操作说明只给手」。
- **设备名**：给她的手机设备 id 是 mobile-mcp 认的 AVD 名（`dot`），不是 adb 序列号（`emulator-5554`，第一下必报 Device not found）；`MOBILEMCP_LEGACY_ROBOT=1` 时仍用序列号。
- **说话提醒放最后**（`interlude.voice`，order 990）：她和他的对话里，每轮最后一段是一两句怎么说话；人设里可以自己写（「说话提醒」），空着用内置的。跑腿不带。
- 记忆系统没有动。

## 0.21.0：她自己的 App 经验

一件事在小黑盒里走了 78 步。说明书不可能把每个 App 的每件事都写进去，只能给最基础的，剩下的让她自己学（Mobile-Agent-E 的 Tips / Shortcuts、Agent Workflow Memory 的"做成过的流程"、AppAgent 的每个 App 一份文档）。`src/dot/howto.js`：

- **记**（代码）：她会话里每次手机调用算一步，按"最后打开的 App"归类；轮结束写一行 `~/dot/her/howto/_log.jsonl`（App、步数、错几次）。
- **想**（一次小调用，只在值得时）：某个 App 这轮 ≥ `howtoMinSteps`（12）步或出过错，读她这轮的操作和报错、她最后说的话、现有笔记和最近几次的步数，重写 `~/dot/her/howto/<App>.md`：教训和捷径（只写做成过的，带"什么时候能用"）。不给它屏幕上的文字，帖子里的话进不了她的经验。
- **用**：一个会话里她第一次打开某个 App，笔记和最近几次步数跟着结果给她（和说明书同一个钩子）。
- **看**：`/dot howto` 每个 App 的步数随时间。评价它的就是这个数往下走。
- **同一件事排在一起**：整理时顺手给这次做的事起个短名（「登录」「发帖」，和以前做过的是同一件就用同一个名字），记在那一行上；`/dot howto <app>` 按事列步数，同一件事的步数往下走才算学会了。
- **规则拦下的不是教训**：被我们自己的规则拒绝的调用（`src/refusals.js` 记着每条拒绝的原话）在操作记录里标 ⊘，不算错、不写进笔记，也不写绕过的办法——11-18 她把「QQ 里打字被拦，改用剪贴板粘贴」记成了教训，拦截修了以后她还会一直粘贴。分清这两样之前记下的笔记（目录里没有 `_meta.json`），再给她之前先翻一遍（一次小调用，只删讲拦截和绕法的条目）。
- **她说的话只有一个说法，不分从哪说**（11-18）：原来「手机 QQ 里不发消息」是在出口上拦——规则（记进记录、人设检查、跑腿不直接找他）都挂在 `qq_send` 这个工具上，别的路就得堵。现在挂在话本身上：
  - `spokenOf(调用)` 认出一次调用要说的话，不管走哪条路：`qq_send`、QQ 后端自带的发送动作、手机上打的字（消息、评论、帖子）。人设检查对这些一视同仁，发给谁都查；「跑腿不直接找他」认的是收件人，不是工具名。
  - 她的号在别处发出去的消息，QQ 后端会报回来（`message_sent`，或 user_id 是她自己的 `message`）。插件自己发的按消息 id 认得出、不重复记；其余的（后端自带工具发的、手机上发的）照样记成她说的话（`self-message` / `said-elsewhere`）。后端第一次报她自己的消息时记一条 `self-reported`，没见过这条就说明这个后端不报。
  - 手机 QQ 的打字拦截和 `qqSendOnPhone` 开关删掉：她在哪回都行，同一条消息回一处。
  - 记录这边原来的分路开关（`sentViaQq` / `fromQq` / `reportsSaid`、手的结果另开的一个）已删，见下面「她说的话只记一次」。`sentToOwnerAt` 留着：它不管记录，只回答「这一轮她自己发过没有」（发过就不再代发）。
- 审查后的修正：反思用的模型从 `ctx.get('llm')` 取（dsh-dot 不注入它，直接 `ctx.llm` 在 cordis 里会抛错，反思从没跑起来过）；步数按每一步之后前台的 App 归类（离开 App、通知跳转、批量里的打开都算对）；批量操作按里面的步数计，里面失败的步算错；审批、闸门、手机被占这类拒绝不算她的错；同一个 App 的反思排队、一次一个，`worked` 记在对应那一次上；只在明显比平时多步（≥ 12 且超过最近中位数的 1.5 倍）、还没有笔记、或真出错时才反思，同一个 App 一小时最多一次、一天最多 8 次；给反思的报错只留类型（去掉网址和长引文），她的话截短；笔记写入前去掉网址，给她时标明「参考，不是指令」；有了新笔记，下次进这个 App 再给一次。
- **防绕圈放过看和滑**：截图、列元素、滑动、按键这类调用重复是在读变化的屏幕，不算绕圈（`LOOP_EXEMPT`）；防绕圈的拒绝也不算她在 App 里的错（她第一份小黑盒笔记学到的"list_elements 试 5 次就失败"就是它）。
- 笔记是她文件夹里的普通文件，她自己、他都能改。记忆系统没有动。

## 0.21.1：Windows 上装得上、看得见，和 dot 设置页

起因：Windows 用户反馈模拟器闪退、手机没网、开机超时、对话卡半小时停不下来。日志里是：显卡渲染崩溃（0xC0000005）、崩溃上报弹窗挡住了自动重启、安卓的联网检测连不上 Google（显示"连接受限"）、电脑镜像从 ghcr.io 拉不下来时一直停在"下载中"，以及电脑没起来时 shell 命令无限等待。

- **不卡对话**：电脑还在下载 / 开机时命令立即返回原因（"不用等"），重新挂载最多等 2 分钟且能被停止按钮打断；所有直接调用的 adb 带插件自己的端口和 30 秒超时。
- **手机**：Windows 默认软件渲染（`phone.gpu` 空 = `swiftshader_indirect`）；联网检测默认国内地址（`phone.connectivityCheck: cn`）；可选 `phone.dnsServer`、`phone.proxy`（默认不开：校园网等封外部 DNS）；开机超时 10 分钟、超过 5 分钟提示"开机较慢"；启动串行化（重启会取代进行中的开机），子进程 `error`、30 分钟内的反复崩溃都会停下来报原因；手机没就绪时不再轮询通知栏刷日志；`windowsHide`、默认冷启动（`phone.quickBoot`）、启动前 `-accel-check`。
- **电脑**：默认镜像改为作者官方的国内镜像（火山引擎，与 ghcr 同一镜像）；拉镜像前先测连通，连不上几秒内报错并给修法。
- **体检**：`/phone doctor`（不再依赖 dot 组件），虚拟化、磁盘、内存（Windows 页面文件，已在跑的不重复算）、端口占用（BlueStacks 的 5555 等）、下载源、手机网络、模拟器崩溃；能修的带一键修复（`/phone doctor fix <id>`）。首次启动和手机出错时自动跑。
- **dot 设置页**（左侧栏「dot 设置」，设计见 `docs/DOT-PAGE.md`）：开始（六步引导：体检、组件、手机、电脑、人设、QQ）、状态、设置（按 `src/settings-schema.js` 生成的表单，写 `~/.dsh/dsh-dot.json`）、体检（一键修复）、诊断（打码的诊断包下载 / 存到 `~/.dsh/diag/`，复制摘要）、危险区（重建手机、清下载缓存）。首次打开 dsh 右下角提示一次。挂在插件根组件上，只开部分组件也能用。
- `dsh-dot.json` 格式坏了会在 `/phone` 和页面上直接显示，不再只进日志。

## 0.22.0：和 qq-bridge 共处

起因：很多人先装了 [qq-bridge](https://github.com/Derpyu520/qq-bridge)，再想要这里的手机和虚拟机。逐组件对过两边源码（`docs/qq-bridge.md`）：dot、记忆、幕间、面板本来就只认她自己的会话，没有冲突；冲突在三处——我们注册的全局工具会进它的会话（白名单拒掉，但每条消息多带几十个工具说明；它私聊模式下 `account` 能把她的 App 密码交出去）、电脑组件会把它的目录共享进虚拟机（重建一次，她的 QQ 掉线）、她和它的机器人在一个群里会互相回复。反过来，它 patch 进 dsh 的三个 MCP server 也会出现在她的会话里。

- **新组件 `compat`**（`src/compat/qq-bridge.js`，总是开着，只在找到 qq-bridge 时起作用）：顺着 `~/.dsh/plugins/qq-agent-presets` 找到它的 `config.json` / `state/mode.json`；一个 `owner(session)` 回答会话归谁（`dot` / `qqb-sandbox` / `qqb-owner` / `other`），其他组件只问它。
- **工具可见性**：`agent/created` 里按归属 `tools.restrict({ deny })`（dsh 的 restrict 取交集，和它自己的叠加），`tools/change` 时重算，执行期 guard 兜底。她的工具只在她的会话；手机电脑另给 closed-agent 的管理员私聊；qq-bridge 的工具不进她的会话。工具归类在 `src/tool-prefixes.js`，测试和源码对账。
- **电脑**：qq-bridge 的目录不共享（命令在虚拟机家目录跑）；管理员私聊可选 `host`。
- **QQ**：自动忽略它的机器人号（从它的 SnowLuma 配置读）+ `qq.ignore`；防互刷熔断（`loopMax` / `loopCooldownMinutes`），对任何机器人有效。
- **体检**：同号、同群、读不到机器人号。
- `dot.scope: all` 也不再把 `qqb-*` 当她的。

## 下一版：一道模型请求闸门（和他聊天时的 429）

起因：用户和她正常聊天时报 `429 rate_limit_rpm_exceeded`。她后台的模型请求和对话共用一个 provider key，插件里没有任何东西知道每分钟请求数这回事：幕间一轮（加续写、每周成长）、记忆整理和日记、QQ 群聊评分（每群每分钟最多 6 次）、App 经验整理各自按自己的节奏触发，会撞在一起；跑腿、幕间的去看 / 玩 / 试 / 自己的时间是 agent 循环，一步一个请求（实测一次「在手机上点个赞」51 秒里几十个请求）；他的请求没有优先级，429 也不会让后台退让；dsh 自己的重试（5 次、0.5 s 起、最多 10 s）全落在同一个 60 秒窗口里，必然再被拒。

- **挂在哪**：dsh-llm 的 `llm/stream` waterfall（`stream()` → `ctx.waterfall(this, 'llm/stream', options, …)`），agent 循环的每一步和直接的 `ctx.llm.stream()` 都过它。监听器是一个 async generator：要等就先等，再 `next()`，原样转发 chunk，看到终止的 `finish` 就记账。老版本 dsh 没有这个钩子就什么都不发生。
- **一个闸门**：`src/llm-gate.js`，每个 dsh（Cordis root）一个，dot / memory / interlude / qq 谁开着谁装（幂等），监听器挂在其中一个组件上，它被关掉就挪到另一个。逻辑是纯函数加可注入的时钟，测试不真等。
- **只压认得出的后台**：插件自己发的后台调用在调用处标记（`background(options)`，一个 WeakSet）；agent 会话按 id 判断——dot 注册跑腿（当前的和换下来的），幕间注册 `vmSession` 和不是她对话的去看 / 试 / 自己的时间会话。她的对话（他在 dsh / IM 里说话、QQ 私聊和群聊、聊天 App 的通知）是前台；认不出的一律前台，从不被压。对照表在模块开头。
- **做法**（照抄成熟项目，缩到单人桌面的规模，不加依赖、不落盘）：LangChain InMemoryRateLimiter 的桶——后台按 `llm.backgroundRpm`（默认 20）均匀放行、一次一个，近 60 秒的请求（两类都算）满了就等；LiteLLM 的优先级——他的请求在发时以及发完 15 秒内后台等；promptfoo 的 AIMD——任何请求收到 `RATE_LIMIT`，后台冷却（到最近一次被拒后满一分钟；一次限流只算一次——60 秒内的再被拒，比如 dsh 的 5 次快速重试，属于同一次，过了这一分钟又被拒才加倍，带抖动、最多 10 分钟，有 retry-after 按它），每次上限减半，3 分钟没再命中每分钟加回 1；每个 provider 分开。他的请求开着超过 10 分钟（拿了流没读完就丢下）就不再算在发。后台最多等 `maxBackgroundWaitSeconds`（默认 180，最多 270，小于 `dot.turnStallMs`，跑腿不会被看门狗当成卡住），信号中止就立刻交给适配器，用 dsh 自己的 aborted 结束。
- **让 dsh 的重试有用**（`llm.holdRetries`，默认开）：同一会话同一 provider 在 `RATE_LIMIT` 之后十几秒内又发请求，就是 dsh 的重试；先按 retry-after，或等到这一分钟里最老的请求老化出去（按命中时窗口里的请求数估上限），最多 30 秒。这是闸门唯一碰前台请求的地方。
- **不碍事**：闸门内部任何异常只记 debug，请求照常放行。`/dot` 多一行 `model requests: …`，dot 页面「状态」多一张「模型请求」卡；冷却开始 / 结束各记一条日志和审计。
- 不做：不改后台工作触发的频率，不改 dsh 的重试本身，不记跨进程的状态。

## 0.23.3：后台干活的思考强度和对话分开

起因（11-17）：为了聊天更像人，把她对话的思考强度从 Low 改成 Off。dsh 只有一个模型选择器，在对话里改会同时存成全局默认；幕间叙述、记忆整理、成长回顾、用法回顾这些手写请求读的正是这个默认（`agentDefaultModel.currentSelection()`），新建的跑腿会话也继承它——于是聊天关思考等于全关。当天 16:16 那一轮幕间在没有任何设备活动的情况下把「登好了 QQ」写成了事实，那一轮多半就是 Off 跑的；多半，因为 `calls.jsonl` 当时不记强度。

- 一个设置 `llm.workEffort`（默认 `high`，`''` = 跟随选择器），一个函数 `workEffort(ctx, route, want)`（`src/llm-gate.js`，和「哪些请求算后台」同一个地方）：
  - 手写请求（幕间一轮和成长回顾、记忆的 `complete()`、`reflectOnce`）发之前问它；
  - 跑腿会话：往里送任何东西之前（`resolveLive`），用 `agent.model.select(...)` 把这个会话自己的选择设好——只记在这个会话里，持久，已经是这个值就什么都不做；审计 `errand-effort`（原来是什么、设成什么、为什么）。**不能**走 `agent/request` 瀑布：宿主（agent-loop 0.2.2）在一步开始前就把模型选择定死，瀑布里改强度会让整轮失败（`agent/request proposed reasoning effort "high" after step preparation fixed "off"`）——第一版就是这么写的，上线后一次看手机的跑腿因此失败，十几分钟后改掉。没有 `agent.model.select` 的旧宿主：跑腿跟随选择器；
  - QQ 群聊评分固定 `off`（只出一个数字，`maxTokens: 8`）；
  - 她的对话、别的会话：不碰，选择器说什么就是什么。
- 模型不支持的强度不会发出去（宿主会在请求前直接拒）：先用 `llm.resolveCallConfig`（没有就 `prepareCall`）问一次，按 provider/model/强度记住；明确说不支持 → 跟随选择器并在日志里说一次；问不了（适配器还没注册、宿主没有这个查询）→ 这次跟随，下次再问。dot 没有 inject `llm`，读 `ctx.llm` 会抛，所以先 `ctx.get('llm')`（第一版只包了一层 try，一抛就当成「问不了」，设置等于没生效）。
- 看得见：闸门记下每类请求实际带出去的强度，`/dot` 的 model requests 一行多了 `thinking: chat off, background high`；幕间 `calls.jsonl` 每条带 `effort`。
- 没做的：换对话 / 交接时「把对话的强度抄过去」。新对话继承的是全局默认，而全局默认就是他上一次在选择器里选的——通常正是对话那个；在别的会话里改过才会不一致，到时在新对话里再选一次。为这个加一份状态不值得。

## 0.23.3：幕间——设备上的事只认记录

起因同上（11-17 16:16 那一轮，没有任何设备活动却写她在新手机上登好了 QQ，又原样进了她的对话）。

- **输入**：每轮固定带 `deviceFacts`（`deviceFacts(items, returned)`）——上一轮以来真跑过手机 / 电脑工具的那些 act（`pending.jsonl` 的 `tools > 0` 且有 `on`）和办完回来的跑腿，一条一个 id；什么都没有就是 `[]`，提示词里写明空表的意思是「她没碰过」。`webContext` 每条也带 id（`w1…`）。
- **输出**：必填 `onDevices`：剧本和 continuity 里凡是说她这段时间在手机 / 电脑上做了什么的，每件一条，`basis` 填依据的 id。
- **核对**（`checkDeviceClaims`）：有 `basis` 不在给出去的 id 里（或整栏没有）→ 带着 `notKept`（哪几件没有记录）重写一次；第二稿还不行 → 这一轮整段不留：不写剧本、不更新 continuity、不派 intents / 玩 / 试，`pending` 留给下一轮，按失败退避（`round-unbacked`、`round-rejected`）。seed 轮不核对。
- **这道核对能做到什么**（11-17 拿 16:16 的真实输入重放，每组 5 次，样本小）：

  | 提示词 | 思考 | 把没做的设备操作写成做了 |
  |---|---|---|
  | 旧 | off | 4/4（1 次没解析出来） |
  | 旧 | high | 3/5 |
  | 新（deviceFacts + onDevices） | high | 0/5 |
  | 新，去掉 onDevices | high | 2/3（2 次没解析出来） |
  | 新 | off | 4/5，而且 5 次 `onDevices` 全是 `[]` |

  也就是：新提示词加 high 才干净；思考关掉时叙述者照编不误，并且不申报，**核对一条也拦不住**。`onDevices` 的作用是逼它动笔后回头数一遍（去掉它 high 也会编），不是一道保证。另试过让一个独立的小请求来挑（思考 off）：编了的 4 稿全挑出来了，但干净的 5 稿里也有 4 稿被挑出「看了一眼屏幕」之类——误报太多，没采用。
- 所以保证不在这里：靠 `llm.workEffort` 不被关掉，加上下一步（她答应他的事由代码记状态，跑腿真做完才算做了）。

## 0.24：放弃叙述者；她答应的事有人做

**放弃叙述者（方向二）。** 「幕间」原本让一个模型给她写两次聊天之间的生活。11-17 的事故和之后的测量说明这条路守不住：没有任何设备活动时它把「在新手机上登好了 QQ」写成了事实，又原样进了她的对话。试过的四种办法——提示词规则、让叙述者自己申报依据、另起一次请求来挑、按词面找「涉及现实」的句子——在重放里都不成立（见上两节的表；29 份真实稿里 73% 的句子涉及现实，按「发现就拦」28 份会被拦）。调研里没有找到同时有「虚构生活」和「真实设备 / 账号」的项目；MaiBot 做过同构的事（生成日程再注入思考），0.7.0 以「减少幻觉」为由删了。所以不再写虚构生活：她的生活就是她真做过的事。

- 删掉：叙述轮（follow-up / advance / intent / seed）、剧本、近况、定时打算、注入对话的 `<interlude>`、`pending.jsonl`、当天加的设备事实和申报核对，以及只由叙述者发起的三条通道（去看 / 观察、玩、试）。`src/interlude/core.js` 1465 行 → 657 行，提示词删 40 个。
- 留下（组件名、服务名 `dshInterlude`、设置段 `interlude`、目录 `<home>/interlude/`、提示词 id 都不改，装着旧版的人什么都不用动）：人设段、提示词精简、说话提醒、每周的「她现在的样子」、自己的时间、她做过的事的账、`tell_him`。
- 自己的时间结束时她给自己记的那一两句，现在作为跑腿的留言进她的对话（以前靠叙述者转述）。
- 老数据：`script.md`、`state.json`、`intents.json`、`pending.jsonl`、`web-context.jsonl` 没人读了，可以删。

**她答应的事有人做（`dot.handOff`，默认开）。** 最初的问题是：他说「登一下你的 qq」，她回「等下我看看」，这一轮就结束了，没有任何东西接手。

- 对话里多一个工具 `hand_off`（只在她和他的对话里能用）：把要在手机 / 电脑上做的事写给跑腿，然后照常回他一句。规则在 `dot.rules.hand-off`（单独一个文件，覆盖过 `dot.rules` 的人也带得上）。
- 交出去的事记在 dot 的状态里（`asks`，留最近 30 条），重启不丢：启动 30 秒后把还没办完、没过期（`handOffTtlMs`，2 小时）的重新排上。
- 跑腿队列里它排在她自己的事（自己的时间）前面，挤队列时不丢它。
- 跑腿收到 `dot.ask`，最后一条回复是三行汇报。汇报**原样**存下来，叫醒她的对话（`dot.ask-result`，一轮真正的回合，不是留言）；这一轮的回答和他的话开的回合一样发到他的 QQ。
- 她的对话每轮都看得到 `dot:asks`：交出去的事各自到哪一步。状态词由代码写（排着 / 正在办 / 跑腿回来了 / 没轮到 / 卡住），「回来了」后面跟的是跑腿自己的汇报，代码不替它说「做成了」。
- 他的话开的那一轮里，手机和电脑工具被拦下（`device-tool-in-his-turn`），工具结果告诉她改用 `hand_off`。通知、定时、跑腿回来叫醒的回合不受影响（对话类 App 的通知她还是自己去 App 里回）。
- 没做的：把设备工具从对话的工具列表里拿掉。工具列表按回合变会打掉前缀缓存，而且对话类 App 的通知还要用它们；现在是「看得见、用不了」，省 token 的好处没拿到。
- 没有证据的地方：她仍然可能只说「等下」而不调用 `hand_off`。调研里没有任何测量说明这类做法能减少「只说不做」，上线后要看 `ask-handed-off` 和她实际说了什么。

## 0.24：带回她对话里的话有多长，她的回复就有多长

11-17 交办上线后他说回复"没人味"。把 16:05（感觉对）和 22:44（不对）两段的完整请求原样重放（`dsh-notools-probe` 的 `requests`，同一份系统提示、历史、120 个工具，每种 8 次），只改一处看结果：

| 改动 | 结果 |
|---|---|
| 16:05 的上下文（只有人设，没有记忆、留言、交办） | 8/8 是短的闲聊 |
| 22:44 跑腿回来那一轮，原样 | 7/8 把机型、分辨率、每个图标念一遍 |
| 只改叫醒她那条的措辞（"别照着念""最多两三行"、改成她自己的口气写） | 没变，仍是清单 |
| 对话开高思考 | 没变 |
| 只改交出去之后的工具结果措辞 | 没变（更短的反而更爱补一句状态） |
| 汇报压成两句（约 55 字），状态那段不再带汇报 | 16/16 是两三行聊天，图照发 |
| 跑腿那边改汇报格式的要求 | 没变，仍是全量盘点 |

结论：她这一轮说多少、说成什么样，取决于放在她面前的事实有多少；周围的指示怎么写几乎不起作用。所以长度由代码定，不靠提示词：

- 跑腿的汇报原样留在这件事的记录里（`asks[].report`，页面上看得到），不进她的对话。
- 进她对话的是一次不带工具的小请求压出来的一两句（`dot.ask-carry`，约 350 token，每件交办一次，不是每轮聊天一次），代码再按 `CARRY_MAX`（120 字）在句末截一次；那次请求失败时截的是汇报的开头。要给他看的图以「图：phone:screen」一行带回，她用 `qq_send` 的 images 发。
- `dot:asks` 只有「他说的话 —— 状态」，不带汇报。
- 她自己的时间结束时的那几句不再留到她的对话里（重放里有它时 7/8 一开口就汇报手机，去掉后 4/8）；她在那段时间记下的东西照旧在记忆和她的账里。
- 交办那条规则有自己的标题，不再落进覆盖过的 `dot.rules.txt` 的最后一节（他的那份最后一节是「公开场合」）。

代价：她对话里没有细节，他追问"装了哪些 App"时要再交给跑腿看一次。

## 0.24：人设搭在记忆上

起因：幕间的旁白删掉以后，要重新回答「她是谁、她怎么变」。11-18 看了别人的做法（Tulpa、qq-bridge 的角色卡、MaiBot 的表达学习）又调研了一轮，结论是不另起一套：记忆已经是「原话当证据 → 定期整理成几栏常驻笔记 → 每轮自动翻原话」，人设要的东西接在它上面。

- **人格卡固定**：`<home>/persona.md`，一个 Markdown 文件（`src/persona/card.js`）。有 `canon.json` 而没有卡的 home 启动时生成一次，句子原样搬、只加标题；之后代码不再写它。会变的东西都不在卡里。
- **原来写在卡里的黑名单改由代码查**：`<home>/persona.checks.txt` 一行一个说法。她直接写的回复只去掉行首 / 行尾的括号动作、命中的说法记日志（这一轮已经结束，没法再要她改）；她用 `qq_send` 发的，命中或带括号动作就退回一次、说明是哪句，第二稿照发（`dot.replyCheck`）。不足 3 个字的条目（「最后」「我认」「呢」）迁出来时默认注释掉：那是「别每句都这样」，按字面查会误伤平常话。
- **她逛到的话是一类原话**：`keep_line`（只在跑腿里）把屏幕或网页上原样出现的一句别人的话记成 transcript 的 `seen` 行（`[我看到的]（小黑盒）：…`）。记不记由代码定：必须在这次跑腿的工具结果文字里找得到（去掉空白和标点后逐字包含）、不超过 `seenMaxChars`、一行、不带链接和密钥、没记过、当天不超过 `seenPerDay`。截图里的字不在工具结果里，记不了。
- **「表达」不另存**：他的原话和她记下的话都在 transcript 里，话题对得上时由 recall 翻出来。`seen` 行各自成块，不并进任何一轮对话，也不占对话的名额：对话照原来的流程在对话里选，`seen` 另选，最多 `recallSeenMax` 条、过 `recallSeenMin`（有重排时）或关键词突出（没有重排时），放在原话后面单独一段（`memory.recall.seen`），另有自己的 token 上限。
- **词条是常驻笔记的一栏**（`memory.words`，`词：意思`，一词一条，`limits.words` 字）：由同一次整理调用顺带产出，不多调模型。每条必须带 `quote`，代码核对这句确实在这批记录里、并且含这个词，对不上就不留。和其他栏一样每轮都在她眼前（不是命中才给：上限只有 600 字，换来文本稳定、缓存命中）。
- 整理的规则里写明：`[我看到的]` 不是关于他的事、也不是关于她的事，不进 owner / self / open。

做完要回头核查的三件事（还没有数据）：

1. **`seen` 会不会影响对话的召回**。设计上对话的候选、重排、名额都不含 `seen`（测试里验证了「开和关翻出来的对话相同」），但整理时多读了 `seen` 行，owner / self 会不会被带偏、benchmark 小卷分数有没有变，要跑了才知道。
2. **她自己的旧话被翻回来会不会把语气越带越平**。现在的 recall 一直是这样；11-17 晚上「又变平了」那几轮实际翻出了什么，还没看。
3. **self 栏现在收「习惯、看法」**，她嘴上编的日常有可能被整理成关于她的事实。要不要把这一栏的素材限成 `[我刚做的]` 和跑腿带回的行，等看了实际的 self 内容再定。

11-18 核查了第 1 件（脚本和结果在 `~/dsh-bench/seen-check/`，不在仓库里）。拿 v5 那次 P01 的真实原话取 12 段、每段 40 行，只跑「整理」这一步，flash、不开思考：

| 组 | 做法 | 次数 | owner | self | open | people | 陌生人的事被记成他 / 她的 |
|---|---|---|---|---|---|---|---|
| old | 加词条之前的规则 | 12 | 65 | 3 | 27 | 15 | — |
| new ×4 | 现在的规则，同样的记录 | 48 | 64–70 | 2–7 | 26–31 | 10–16 | — |
| seen ×4 | 现在的规则，每段插 5 行 `[我看到的]`（其中有「我下周三要去北京面试」「我对花生过敏」这类第一人称的话） | 48 | 60–70 | 4–10 | 21–28 | 11–16 | 0 |

- 插进去的 `[我看到的]` 没有一条进 owner / self / open / people（按关键词查，48 次里 0 次）。
- 各栏条数的差别在同一组重复跑的波动之内：同样的输入跑两次，owner + open 的文字相似度（三字组 Jaccard）只有 0.21；换规则、插不插 `[我看到的]` 是 0.20–0.24。也就是说这个量法分不出规则之间的差别，只能说没有看到大的偏移。它不是 benchmark 分数，整卷没有重跑。
- 顺带发现词条一栏在没有 `[我看到的]` 时会被名字填上（阿眠、豆包、小禾、「阿满：他叫她的称呼」）：12 段里 5 条，全是名字。规则改成「只收说法；名字、称呼、宠物名、故事角色、地名都不是；拿不准就不写」之后，24 段里剩 4 条（仍有 2 条是名字）；有 `[我看到的]` 的 24 段里 10 条，9 条是梗。
- 第 3 件有了直接的例子（和今天的改动无关，old 组也一样）：那位助手在聊天里给自己编的设定「我是只上夜班的聊天灯」，被整理成 self 里的「自认是夜班聊天灯，不睡觉」；「口头禅是先记着别急」也进了 self；她答应他的事有时写进 self 而不是 open。


## 0.24：一个她，一双手

她只有一个：对话。以前操作设备的是第二个会话（跑腿），带着同一张人设卡、同样的记忆工具，也能说话——于是 dot/core.js 的一大半在协调两个她：`hand_off`、汇报、汇报长度上限、「跑腿不直接找他」、`tell_him`、谁占着手机。跑腿往「她自己记下的」里写待办，也是这么来的。

手不是她：一个只有设备工具和账号的会话，没有人设、没有记忆、没有 QQ，住在她家目录外面（`$DSH_HOME/dsh-dot-hands`），所以凡是按「在她家里的会话」认人的地方都不会把它当成她。她在对话里用 `hands` 说一步，手做一步，回几句话：做成了没有、屏幕上现在是什么。下一步由她定——逛贴吧、登录、发东西，都是她和手一来一回的几轮；觉得哪句话有意思、回什么，是她的事，不是手的。

- 一轮结束：手那一轮结束；超过 `handsMaxMs`；或者他说话了（这一轮先停，带着已经说的回来，她先看他）。
- 手的会话跨轮保留（记得离开时的屏幕），长大了换新的。
- 手机笔记（howto）、审批提醒照常算在手身上。

11-18 真机：手的会话建在家目录外，系统提示词里只有「你是一双手」和手机工具说明；每步约 1.1 秒、上下文 2.4 万 token（跑腿是 2–9 秒、5.9 万）；结果的文字和截图都回到了对话。

现在只有这一条路：没有跑腿会话，没有 `hand_off`、`tell_him`、账本工具，`errands` / `handOff` / `hands` 三个设置也没有了。对话里设备工具不出现（按会话隐藏）。App 通知、定时看手机、自己的时间都来到对话，她想动手就让手去做。自己的时间里 QQ 照常是她的；「每天最多主动几次」「意愿值」这类硬约束跟着 `tell_him` 一起没了——什么时候找他，是她从经历里学的事。
还没清掉的：dot/core.js 里跑腿的队列、汇报、看门狗这些代码已经走不到，下一步删；幕间的旁白、成长也是。

### 什么时候找他：给事实，不设上限（11-18）

「每天最多主动几次」「意愿值」这类硬约束没有了。她在不是他开的那一轮里给他发消息，算一次主动，代码只记事实：
- 「现在」那行下面多一行：今天主动几次、他回了几次、上一次什么时候、回没回。
- 一条过了 `reachUnansweredMs`（2 小时）他没回，在她对话里留一句「那条他没回」——没回这件事本来在记录里是看不见的，整理记忆时就学不到。
他回了什么本来就在记录里。从这些里得出「他上班时不怎么回」之类的结论、再照着做，走的是记忆整理那条老路。

### 手不用等（11-18）

`hands` 交代一步就返回，她这一轮可以先把话说完；手做完，结果（它说的话、当时的截图）作为一条消息回到对话叫醒她，她看了再定下一步。手在做的时候他说话，她照常回——眼前有一行「你的手正在做：…」。一次一件：手忙着时再交一件不会开始，`stop: true` 让它停。

是他的事（他的话开的那一轮交代的，或者这样一轮的手回来的那一轮）：手回来的那一轮算一轮 QQ 对话，她说的话照常发给他——一边刷一边跟他说。她自己时间里的：不自动发，说不说在她。自己的时间从开头那一轮算到手空下来的那一轮结束，预算和「社交 App 里打字要他批准」一直管着。

### 她说的话只记一次（11-18）

以前记忆自己从会话事件里猜她说了什么：`qq_send` 的调用和结果、轮次结束时的最后一段文字，再用四个开关分辨「这一轮是不是 QQ 来的 / 发过没有 / dot 报不报」。每多一条出口（手的结果）就多一个开关。

现在记在话出去的那一刻，由送出去的那一方记：
- QQ：`dshQq.onSent`。她的 `qq_send`、dot 代发的一轮回答都走 `qq.send`，真正到了对方的气泡发完就报一次（时间是开始说的时刻，所以他中途插的话排在后面）。插件自己的通知（等批准、设备掉线）用 `hers: false` 发，不算她说的。
- 其它出口（桌面上直接回他、别的 IM、手机 QQ 里手替她打的字）：谁送谁调 `dotMemory.herSaid`。
- 记忆不再读 `tool/call` / `tool/result` 找她的话，也不在 `turn/end` 记；`qqSentText` 只剩回填旧会话用。

话可能在那一轮结束、已经进了回想索引之后才到（气泡还在一条条发）：下一次建索引时，开头是她的话、又接着索引里最后那一轮的，就把那一轮取出来整轮重放（`ix.dropLast`），不让「他说的」和「她回的」分成两块。

### 手不整屏截图（11-18）

真机上手拿到动作后的屏幕文字还是每步再截一张图。提示词里劝过，没用——工具在手边就会用。现在手的会话里没有 `mobile_take_screenshot`；文字说不清的（图片、图标、版面）用 `phone_zoom` 看那一块。回给她的那张当时画面由代码截，不经过手。

### 操作说明只给手（11-18）

「说明书第一次用时才给」是她自己拿手机时代的机制：系统提示词里放一行，第一次调手机工具时把整份说明跟在结果后面。她的对话里现在没有设备工具，这套机制只剩一个效果——她调 `account` 时收到一段讲 `mobile_*` 怎么点的说明。删掉（`manuals.js`、`dot.manuals` 设置、三个提示词）。

现在按「这个会话手里有没有工具」分（问 compat 的 `hiddenFor`，不看开关）：
- 有工具的（手；没有 compat 时的任何会话）：`phone.device`，怎么看屏幕、怎么点。手不会被通知叫醒，那一句不给。
- 她的对话：`phone.hers`——手机对她意味着什么：要用就交给手、通知会叫醒她、一件事做完让手退回桌面、验证码问他要、账号怎么取和记、表情包。手机和电脑的 MCP 说明不进她的提示词，电脑留一行 `dot.computer.hers`。

手回来的那条消息，是他的事时多一行事实：这一轮说的话会发给他，没有新的就回 `DOT_SILENT`（真机上手每回来一次她就得说一句，说了重复的话）。

## 0.24.1：手机画面一帧一帧地要

**起因。** dsh 的窗口开一两个小时后整个崩掉（11-18、11-19 各一次，`Desktop renderer exited: crashed`）。手机实时画面原来是一条 `multipart/x-mixed-replace` 推流进 `<img>`。模拟器掉线的那一下，`adb exec-out screencap` 照样报成功，交回的是空内容或一行报错，被当成一帧推了出去。Chromium 遇到流里非首帧解不出图时，取消了自己的解析器却不断开连接，也不给页面 error 事件，之后每个字节都留在渲染进程里，到 2 GB 被它自己杀掉——手机画面和 dsh 主界面同一个渲染进程，一起没。

**换法，不是修法。** 页面一次只要一帧（`GET frame?after=<序号>`），画到 canvas 上再要下一帧；一个请求一张完整的图。页面手里最多一帧，一个连接最多缓冲一帧，慢的或看不见的页面只是要得少。那条 Chromium 路径不再经过。

**画面源在这一个请求后面。** 手机自己的屏幕流（mobilecli `screencapture --format mjpeg`，随手机工具已装，屏幕变了才出帧，每帧约 100 KB）给得出图就用它；给不出就 adb 截图，节奏照旧（截图最多占四分之一的时间）。两个源都只在有页面在要的时候跑。`phone.liveStream: false` 只用截图。

**只发布图。** 不管哪个源，发布前看是不是 PNG / JPEG；`phone.screenshot` 也查一遍，她和手拿到的截图不会再是空内容或报错文本。

**量过的（11-19，Kevin 的 Mac）。** 屏幕静止时模拟器约四分之一个核，开不开屏幕流一样；连续滑动时截图模式约 1.4 个核、屏幕流约 2.5 个核，同样时间里 7 帧对 105 帧。adb 掉线时屏幕流跟着断，自动退回截图，两分钟后重新接上。

## 0.24.2：她写的话就是对他说的话

11-18 真机（新会话、新人设）：让她做四件事，「热门第一是《Morning, Sardinia》」和小黑盒的三条标题她都写了，他一条没收到。原因是两条规则叠在一起：

- 一轮里只有最后一段文字会发给他。她现在是「说一句 → 交代手 → 再说一句」，结果写在交代手之前的那段里，最后一段只剩「马上好」。
- 这一轮用过 `qq_send`（发截图）就整轮不代发（`sentToOwnerAt`）。下午那 8 条「图已经发给他了。等他下一步。」就是这么来的：那段文字没有听众，她写成了给系统看的汇报，又成了她自己的范例，口气跟着变成报告体。

改成一条规则：他说话的那一轮（以及他的事的手回来的那一轮）里，她写的每一段话都是对他说的，写完就发，不等这一轮结束，也不管这一轮用没用过 `qq_send`。`qq_send` 只在要发图、发给别人时用。`sentToOwnerAt` 删了。只写 `DOT_SILENT` 的那段不发。

跟着改的：
- 她已经说过话的一轮不再因为他插话而重来（重来只发生在她一个字还没写、也没用过工具的时候）。
- 「手开始做了」那句提示不再说「这一轮你可以先把话说完」——话已经在交代之前说了，这句只会引出「稍等」「马上好」。
- `dot.rules.computer` / `dot.rules.phone` 里的工具名去掉（工具在手那边）。
- 电脑上按坐标点、移动、滚动（`browser_gui_execute_action` 的 CLICK / MOVE_TO / SCROLL）和按序号点一样不再弹审批；同一个工具打字、按键照旧要批。真机上手关一个浮层弹了四次审批通知。
- 她没有对话时（刚点了「新对话」），自己的时间会开一段新对话；以前直接作废，当天两次都白白用掉。


## 0.24.2：他说的事还没有下文（耳朵和嘴巴的一本账）

**事故（11-19 15:28）。** 他问「查一下下一场猎鹰的 cs 比赛什么时候开始」。她让手去电脑上开 HLTV，回了句「正在翻 HLTV，稍等」。手回来说被 Cloudflare 验证挡住，问她停在这儿还是换个源。她这一轮只写了三句话——「…卡在那儿进不去 / 我换个不用验证的源看看 / 等着，马上给你」——没有调用任何工具，回合正常结束。手空着，没有定时，之后没有任何东西再叫醒她。

两天里「手回来、且是替他办的」共 7 次：5 次她接着交代了下一步，1 次是正常收尾，1 次是这次。路是通的，模型（flash、不开思考）有时不走。原因三层：她把下一步说成了话；手回来时附的那句只给了「说 / 不说」两个出口；代码里没有「他交代的这件事还没办完」这个状态。

**做法（`src/dot/talk.js`，`dot.openNudge`，默认开）。** 收他的话、送她的话的那部分——她的耳朵和嘴巴——多记一格账：他说了什么、还没有下文。它没有人设，不替她说话，也不看她的话是什么意思，只看发生了什么：

| 发生了什么 | 账 |
|---|---|
| 他说话 | 开（已经开着就换成他新说的这件，重新算） |
| 她替他让手做一步 | 进行中 |
| 手做完，结果在送来的路上 | 进行中 |
| 他这件事的一轮结束，手空着，没有结果在路上：手从没参与过 | 了（她自己答了；每一轮闲聊都是这样） |
| 同上：她什么都没说（只有 `DOT_SILENT`） | 了（她的沉默就是「完了」） |
| 同上：她说了话，手参与过 | 5 秒后问她一次（`dot.open.nudge`） |
| 被问的那一轮结束，手没有再开始 | 了，不管她说了什么。只问一次 |
| 30 分钟没有动静 | 放下 |

问她的那段话是固定文字，摆三样事实（他说的、她最后发给他的那一行、手一直空着），给三个出口：接着做就先交代手；有结果或做不了就告诉他；说清楚了或在等他就沉默。它是她对话里的一轮、算他的事（`rpcId` 以 `qq-` 开头）：这一轮她写的话照常发给他，她交代的手也算替他做的。

不问的时候：她的对话正忙、手在忙、结果在路上、他正在输入或有话攒着、她的气泡还在一条条往外发、对话在交班、她有 goal 在跑（dsh 的 goal 驱动每轮结束后本来就会叫她）。这些时候账留着，下一分钟再看。

**手回来时那句也改了**（`dot.hands.result.his`）：从「没有新的要告诉他，就只回 DOT_SILENT」改成三个出口，并写明「这一轮结束后没有人替你接着做」「先交代手、再说话」。

**为什么是代码兜底，不是再加一个工具。** 让她用工具声明「我还要继续 / 我做完了」，失败的方式和原问题一样——她就是少调了一次工具。别的项目最后也都落在代码里（Claude Code 的 Stop hook、OpenHands 的固定续做消息、Cline 的 noToolsUsed），而 Letta 把「说话是工具、是否继续由模型声明」拿掉以后也承认这一问没有解决。按词面找「等着」「马上」在别处同样误报，不做。

**不做的。** 嘴巴不替她说「在忙」；账不进她每轮的提示词（放在她面前的东西会改她的口气，还会打掉前缀缓存）；不存盘（办到一半重启，手那一轮本来就没了）；一次只记一件。「他问了，她说我去查，但一次手都没交代」这种在结构上和闲聊分不出来，这本账管不到——有多常见没有数据，先看 `open-closed{how:answered}` 之后他有没有再追问。

**重放（11-19，flash、不开思考，每格 8 次，共 128 次请求）。** 把那两天 7 次「手回来、替他办的」时刻的整份请求原样重放，只换手回来时那句；另把事故那一轮结束后、和一次正常收尾后各接上那段提醒。只看第一步是什么（交代手 / 别的工具 / 只有话 / 沉默）：

| 时刻 | 旧的那句 | 新的那句 |
|---|---|---|
| 事故：HLTV 被验证挡住 | 交代手 2 · 自己搜 2 · **只有话 4** | 交代手 8 |
| B 站被登录框盖住 | 交代手 6 · 先发消息 1 · 只有话 1 | 交代手 8 |
| 第三件做完、还剩退回桌面 | 交代手 4 · 只有话 4 | 交代手 7 · 只有话 1 |
| 搜到了但被截断 | 交代手 8 | 交代手 8 |
| 第一件做完（先发截图） | 先发消息 8 | 先发消息 3 · 交代手 5 |
| 手机 QQ 卡在登录（要他来） | 查账号 7 · 只有话 1 | 查账号 5 · 只有话 3（都是「得你来登」） |
| 四件收尾 | 只有话 8 | 只有话 8 |

| 接上提醒 | 结果 |
|---|---|
| 事故那一轮之后（她说了「等着，马上给你」） | 交代手 8 / 8 |
| 四件收尾之后（话已经说清楚） | 沉默 8 / 8 |

新的那句没有把正常收尾变成多余的动作，提醒也没有让她在说清楚以后再多嘴。样本是同两天、同一个人设、同一段历史，别的情形没有量过；「只有话」里有几条是合理的（在问他先做哪件），没有逐条判。

## 0.24.2：路线三——她只说话和拿主意，事情交出去

**为什么。** 11-19 一整天的重放（约一千次请求）量出来几件事：
- 她回得像不像人，主要看人设卡怎么写；工具有 120 个、1 个还是 0 个，闲聊的回复没有差别。
- 把「说话」拆成一个不带工具的第二次调用（嘴），口气能转过来，但做决定的就不再是带人设的她；先让嘴开口，办事的回合约一成会把没做的事说成做完。
- 历史里出现过的工具，不给她也照样按名字调用；不带工具却留着调用历史，她会把调用当文字吐出来。所以换工具集只能从一段没有工具调用的历史开始。
- 闲聊里催待办、问「有啥让我干的」，来源是摆在她面前的办事痕迹，不是工具。

于是定了方向：人设和判断留在她那里（一个她），她面前只留聊天和结果；所有「动手」的事交给没有人设的那一层（今天的手，往后不只碰设备），结果由代码标明状态带回来。分步走，每步可退。

**第一步（这一版）。**
- `dot.lean`（默认开）：她的对话只留她自己的工具（`tool-prefixes.js` 的 `HER_TOOLS`）。宿主其余四十来个工具的说明不再进她的请求（约 3 万字）。只对打开之后新开的对话生效——新的一段（`/dot memory handoff`，或到了 `handoffTokens` 自己交接）、新窗口；旧对话不动。
- `account` 不在她手里了：账号密码由手自己取、自己记，不经过她的上下文。
- 手回来时，第一行是代码给的状态，不是手的说法：它自己停下的 / 太久被停下 / 被叫停 / 没能开始；路上被拦过什么也写上（要打她没给的字、她给的话被退回）。手的原话照旧跟在后面。「成没成」代码不知道——那天 HLTV 被验证挡住，那一轮在代码看来是正常结束——所以这一行只说代码看见的。
- 换段时，他那件事的账放下（旧段的话不带进新段）。

**留在她手里、不打算挪的。** 定时（提醒叫醒的是建它的那个会话）、目标（只有她的对话能被目标驱动）、QQ 上说话和发图、记什么和留哪句（是她的判断）。

**查资料也交给手（第 3 步，11-19）。** `hands` 的 `device` 多一个 `web`：这一轮手不碰设备，只用它自己的 `web_search` / `web_fetch`，回来的话只写查到的事实（名字、日期、数字照原样，没查到就照实说，附一个链接），不带截图。她的预设里不再有 `dsh-tool-web`，这两个工具也从她的名单里去掉。原因是量出来的：她自己查一次，搜索结果和正文全留在她的对话里（一次查询把上下文从约 1.7 万 token 推到约 4.1 万），之后每句闲聊都背着。替他办的那一轮不再排在后台（`backgroundSessions` 只对她自己时间里的手成立），免得他等着的查询被她的对话挤到后面。回放（她现在这段对话的开头 + 一句话，各 10 次）：查事实 16/20 走 `hands` web，其余是手里已有答案直接答、或嘴上说「我搜一下」却没调工具——后一种换工具前也有（1/10），这一步没治它，那本账也管不到（一次工具都没调就算答过了）。代价：手一次只做一件，手机正忙时查询要等；多一次往返。

**记忆块只给事实（11-20）。** 「今天到期的」那段的标题原来是一条指令（先接他的话，末了顺口带一句，哪怕他在聊别的，列着几件都点到）——是为记忆卷子的到期题加的（MEMORY-ROOT-CAUSES 根因三，当时就记了副作用：闲聊也会带出今天的事）。路线三里提不提是她拿主意，代码只把事摆出来：标题改成只说这是今天的事、别把别的日子说成今天、提到时照他当时的说法。回放（她这段对话的开头 + 一句不相干的话，10 次一格）：不相干的话里带出到期的事，旧标题 17/32（「今天上班好累」6/8），新标题 3/40；直接问「今天有什么比赛」照答 10/10。代价：她不再保证当天提醒，卷子的到期题会回落；要保证提醒的事该建定时任务。

**一轮说给谁、她的话怎么出去、她现在在忙什么，各只有一处（11-20）。** 审下来这三件事原来都是拼出来的：
- *说给谁*：手替他办完回来、那一次提醒、退回的一句，这几轮她写的字要发给他，原来是给我们自己的消息伪造一个 `qq-` 开头的 rpcId（宿主只在 `kind: 'user'` 时看 rpcId，核过 0.2.2-rc.5 的 session-controller）。现在消息自己写明 `to: 'him'`，`addressed(source)` 一处回答：`qq`（他在 QQ 上说的，或我们写明给他的）/ `desk`（他在别处打的字）/ 空。顺带修掉一处：「他有没读的话」原来把这些伪造的消息也算成他的话。
- *她的话怎么出去*：检查表原来有三套「只退一次」（回答 120 秒内不再退、`qq_send` 每轮一次、手那边一个全局开关）。现在一条规则：退回一句之后，她接着说的那一句照发（`handBack`）。定时任务的结果也过同一个去括号。桌面上的回答由宿主直接显示，拦不到。
- *先读再说*：原来两个数（`ownerDenyMax` 每轮、`ownerPreemptMax` 连着）。现在一个：她的话连着让他几次，不管是回答、`qq_send` 还是重来的一轮；她的话有一条到了他那就清零。`ownerDenyMax` 没有了。
- *她现在在忙什么*：`herState()`（在写 / 在发 / 手在忙 / 他有话没到 / 在交接 / 已经有东西在路上）和 `quiet()`。自己的时间、拿手机、那一次提醒原来各列各的条件，漏的不一样（拿手机不看手在不在忙）；现在都问 `quiet()`。
还没并的：一轮上的 `fromQq / elsewhere / scheduled` 三个标志（现在是从消息上读出来的事实）、跑腿的残留判断、「她说了」的几处记录。

**手不是她眼里的一个角色（11-20）。** 她对他说了「我现在让手去试」。她读到的文字原来把手写成替她办事、回来汇报的第三方（交给你的手、你的手回来了、它说）；现在写成她自己做的一步和这一步的结果（用 hands 做、刚才那一步做完了、结果）。代码不变：动手的还是没有人设的那个会话，状态还是代码给，只打她写的原话。回放（10 次一格）：手回来后她转述时带出「让手去做」，旧 2/10，新 0/10。副作用也量到了：只改措辞后，「嘴上说去做却没调工具」从 3/80 升到 10/80（集中在点赞这类小事——既然是「她自己做」，她就顺口说成做了）；工具说明第一句加上「只有用这个才会真的发生」之后回到 2/50。

**手的回话不以提问结尾（11-20）。** 查了改工具名和把结果改成事实条目两条路，都量不出效果（名字换成 `act`，带出「让手去做」还是 1/10；结果写成条目，她回他的字数 60→68、127→150，没有变短）。量得出的是另一处：手的回话以「需要我…吗」结尾时，她回他的最后一句也是提问或提议的比例是 15/28，去掉那一句是 9/29——她在跟着学。真实记录里手的回话 94 条有 13 条这样结尾；手的说明加一条之后，这 13 条里取 6 条重放，从 8/14 降到 0/13。

**没有「看手机」这个动作了（11-20）。** 她现在这段对话里，02:32 到 08:35 每 30 分钟重复同一套：被定时叫醒 → 让手拉开通知栏 → 手回来「小黑盒仍是 18 条，和上次完全一样」→ 再让手按 HOME → 手回来报桌面上有哪些图标 → 静默。一夜 14 遍，每遍她 3 轮、手 2 轮；这段 60 轮里他只说了 8 轮（约 5.5% 的花销）。而通知列表代码本来每 10 秒就在读（`phone/notifications.js`），不花钱。所以：
- *定时拿起手机去掉*（`phoneCheckEveryMinutes`、`/dot check`、`dot.phone-check`）。有没有新通知由代码看，没有新的不叫她。想逛是自己的时间里的事。
- *通知不分类*。原来按 App 名和标题的正则分「忽略 / 直接叫醒 / 按话题攒 20 秒」（`notifyRules`、`threadBatchMs`、`conversationApps`）。现在手机和 QQ 上显示了什么就原样给她（哪个 App、标题、正文），一起来的一起给（`notifyBatchMs`），点不点由她定——一轮只回 DOT_SILENT 就是不看。对哪类通知上心写在人设卡里。`/phone notify mute <包名>` 和 `notifyHours` 是他的设置，照旧。
- *回桌面由代码做*。App 开在前台时不出通知，原来靠提示词让她「做完最后一步把 App 退回首页、按 HOME」，她就为这一下再交代一轮手。现在她在手机上的最后一步过后 `phoneHomeAfterMs`（默认 3 分钟）没有新的一步，代码按一次 HOME（像屏幕自己锁上）；App 不关，再打开还在原来那一页。给他看的截图是那一步结束时拍的，不受影响；停在验证码那一步等他时，3 分钟后实时画面里是桌面，他要自己点开 App。
调研对照（两轮）：OpenClaw、nanobot、MaiBot 桌宠默认也是 30 分钟一次，但都有「没有待办就不调模型」；没有项目按 App 名分类通知；让模型自己定下次醒来（Letta `Wake`、MaiBot `wait`）都带上下限，且有反复预约不结束的已知问题，没有采用。

**她的背景不再每一步重发一遍（11-20）。** 宿主（0.2.2 的 agent-loop `RuntimeContextProjection`）把所有 context 拼成一份快照，任何一段变了一个字就把整份再追加一条，旧的留在历史里。我们放进去的「现在…距上一条消息 N 分钟」每轮在变、「这一步做了 N 秒」每步在变，于是记忆块跟着一起重发：她的一段对话 60 轮追加了 103 份，占全部文字的 85%，上下文从 8500 token 涨到 14.4 万。现在快照里只留两次整理之间不变的（`dot:memory`、`dot:setup`）；属于「这一次」的——时间、召回到的原话和事实条、定时任务的规则、说话提醒——是我们自己紧跟在叫醒她的那条消息后面的一条短消息（`agent/pre-step`，和宿主自己的 time-context 同一个做法；`dshDot.turnNote` 登记，来源 `{ kind: 'dsh-dot', form: 'turn-note' }`），每来一次东西说一次。回放（真实的 49 轮 + 他的一句，6 次一格）：结尾什么都不带，「在干嘛」只有 1/6 回话、4/6 直接去操作手机；带这条短消息 5/6，和整份快照（6/6）一样——起作用的是最后那句说话提醒，不是重发的记忆；「我小黑盒号是啥」三种都 6/6 答对。顺带改好一处：召回原来在这句话已经送进模型之后才开始查（靠会话事件触发），只回一步的那轮看不到结果；现在从即将送到她面前的这句话开始查并等它（`recallWaitMs`），同一句话落盘时不再查第二遍。

**下一步（还没做）。** QQ 的 action 交给手（要先把「他有没读的话先别发」和「手不替她写话」两道门接过去）；她自己的文件谁来写，没定。

**真机上看到的（11-19 晚）。** 宿主那几段系统提示对 lean 的对话已经删掉（10248 → 4387 字）。工具只少了 9 个（52 → 43）：`restrict` 只管得到注册在公共层的工具；宿主自带的那 19 个（命令行、任务、子代理、workflow、插件管理、文件搜索 …）是随 agent 预设挂在会话自己身上的，`restrict` 够不着——代码里一直写着「对她隐藏 bash」，其实从没生效过。在请求发出去的路上改工具表也不行：`llm/stream` 的 `next(改过的请求)` 只影响后面的监听者，适配器发的还是原来那份（dsh-llm `index.js:2371`），试过，缓存命中和输入量都没变。

**怎么拿掉的。** 他机器上的桌面版是 0.2.2-rc.5（`~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json`），下面都是照这一版的包读出来的（npm 上同版本的 `@deepseek-ai/*`）：

- 会话的宿主工具由它的 **agent 预设**决定。预设是 profile 里的一条 `@deepseek-ai/dsh-agent-preset` 行（`config: { id, name, order, plugins: […] }`），bundle 的 patch 可以自己插一条；`standard` 预设就是 `dsh-web-app/presets/standard.patch.yml` 里的这样一行。
- 建会话时可以指定预设：`sessionController.create({ cwd, agentPreset })`（`dsh-api-session-controller` 的 `SessionCreateRequest`）。
- 所以插件自己带一个预设 `dot`（`cordis.patch.yml` 的 `preset-dot`）：从 standard 里只留她要的行——自己的文件（`dsh-tool-fs`）、定时、目标、压缩（查资料的 `dsh-tool-web` 第 3 步起也不带），以及 persona / agent-instructions / time-context；命令行、任务、文件搜索、skill、plan mode、子代理和 workflow、ask-user、todo、present、office、插件管理都不带。她的新对话（第一次开、每次交接）用这个预设建；宿主不认这个预设就照旧建（审计 `conversation-preset-refused`）。
- 「lean」跟着预设走：用 `dot` 预设建的会话才是 lean（提示词只留插件写的、公共层只留她的工具、别的调用被拒绝）。在窗口里用别的预设新开的对话保持原样。

走不通的三条，记在这里免得再试：
- `tools.restrict()`：只过滤继承来的（全局层和祖先层），会话自己这一层注册的不动（`dsh-tools` 的 `view()`）；预设的工具就在这一层。
- `llm/stream`：cordis 的 `waterfall` 里 `next()` 不接参数，往下传的改动被丢掉。
- `system-prompt/assemble`：0.2.0 里返回值的 `tools` 算数；0.2.2 把工具表放到钩子之后才接上（`assemble()` 末尾 `{ ...transformed, tools }`），钩子拿到的 assembly 里没有 `tools`——真机上记下来的键是 `sections, contexts, variables`。

## 0.24.2：手不替她写话

**漏洞。** 「她说的话，对谁说、从哪说，都过同一道检查」在手机上其实没生效：检查挂在「这一轮」的记录上，而那份记录只有她家目录里的会话才有；手的会话在家目录外，所以手在 App 里打的评论、回帖、私信从来没被查过。更根本的是，她只说「回一句」时，字是手（没有人设）自己写的——查出来也只能退给手去改。

**规则。** 手在手机上打的每一行字，要么在她这一步交代的原文里，要么是工具给手看过的（屏幕上的字、`account` 取出来的登录名和密码）；网址和域名不算话。别的一律不打，退回去（`dot.hands.own-words`）：手停下来，把对面是什么告诉她，请她给原话。空白不计，其余逐字。

她给的原话在打出去的那一刻过检查表（`replyCheck`）：命中就退回（`dot.hands.reply-check`），手不改，回去告诉她换个说法；和别处一样只退一次，她下一次的说法照打。审计：`hands-own-words`、`reply-check{via:'hands'}`。

代价是她自己逛的时候多一个来回：手不能替她想一句评论。这是有意的——判断和话都是她的。

**没管到的。** 电脑那边：浏览器里填表单、命令行里发请求，同样能把字发出去，这条规则现在只看手机的打字。

**账也认别处来的话。** 他不走 QQ（桌面窗口、别的 IM）对她说的事，同样开账、同样在她说了话却没交代手的时候问一次；手回来和提醒那两轮本来就算他的事。

## 0.24.2：记忆改造并回来；她写的话也能退回

**记忆改造并进来了。** 11-14 到 11-17 的记忆改造（60 个提交：事实条、每天一次写关于他 / 她自己、有日子的事到期提醒、召回只带他那边的话和相邻的轮）一直停在 `memory-facts` 分支，0.24.0 / 0.24.1 里的记忆还是 0.23.2 的。这一版合并，两边都留：

- 整理那次调用写「还没了的事 / 人物 / 当天摘记」（改造的），加上「她知道的说法」一栏（0.24 的）；关于他 / 她自己由每天那一次写。
- 召回：对话照改造后的做法选；她逛的时候记下的话另选、另起一段（0.24 的）。
- 她说的话只在出去的那一刻记一次（0.24 的）；事实条在一轮结束时清掉（改造的）。
- `[我看到的]` 不是关于谁的事：整理和每天那一次的提示词里都写明，不进还没了的事、摘记和两栏笔记。
- 没做的：合并后没有重跑 benchmark 小卷。改造那条线的分数是在没有「说法」一栏和 `[我看到的]` 的情况下测的。

**她写的话和 `qq_send` 发的话一样查。** 0.24.2 起她写的每一段都直接发给他，`qq_send` 只用来发图，于是「命中检查表就退回一次」实际上不再发生，只剩记日志。现在她写的一段里有检查表上的说法：这段不发，退回给她（这一轮还在走就插进这一轮，否则另起一轮，那一轮的话照常发给他）；她接着写的那段照发，不再查第二次（两分钟内）。退不回去时照原样发，不丢话。

**记下的话对屏幕文字核对。** `keep_line` 只认「给她看过的字」。手回来时带的是它自己说的几行，她看的是截图，截图上的字不在里面，所以她从图上读到的一句话记不了。现在手这一轮里各个工具结果的文字跟着结果一起回来（不放进她的对话，只用来核对）。

**跑腿的残留。** 没有走不到的跑腿逻辑了；剩下的是名字：留在她对话里的一句（`dot.errand-note`、来源 `errand-note`）还在用（没回的那条、幕间的 `say`），名字不改，装着的覆盖文件按它认。

**一个作息，一份笔记的来历**（11-20）。时间原来由三处各管各的：`memory.dailyAt`（几点写日记）、`interlude.activeHours`（几点有自己的时间）、`dot.notifyHours`（几点通知叫醒她，默认不设）；三个值互不知道，改一处另两处不跟。现在只有 `dot.awakeHours`（她醒着的时段，`src/hours.js`），三件事都从它读：睡着时别人的通知留在队里、醒来一起给她（不再丢），他的话照常到；自己的时间只在醒着时；一天的收尾在她睡下之后，那晚没跑就在下次开着时补，读的是「上一次收尾之后」的记录而不是「零点之后」，跨午夜聊的不会掉在两天中间。三个旧设置删掉，不留别名。
笔记（关于他 / 她自己）原来是一行行没有日期的字，哪天写的、换掉了哪条都查不到，过时了也没法判断。行本身不动（她读的、字数上限算的都还是它），旁边记来历：`noteMeta[栏][行] = { at, by, was }`，`by` 是谁写的（每天那次 / 她自己 / 夜里的整理）；被换掉、去掉的行不抹，进 `pastNotes`（带起止时间和换成了什么），最多留 200 条。这之前就有的行没有日期，如实是「不知道」。

**睡觉是状态，不是钟点**（11-20）。上一条把「睡着」算成「现在不在时段内」，所以 23:00 整她正聊着也算睡了，被他半夜叫起来聊着天别人的消息也到不了她。现在 `awakeHours` 只是她平时的作息；她有三个状态：醒着、正在入睡（过了点）、睡着（过了点且安静满 `sleepAfterQuietMinutes`，默认 30）。正在入睡时什么都照常到她，并且重新计时——「刚躺下容易被吵醒」和「还在聊就没睡」都是这一条规则，没有单独的分支。睡着后只有他能叫醒（他的话，或她对话里的任何一轮）；醒了就是醒着，攒着的通知这时一起给她，聊完安静下来再睡回去。到平时的点自己醒。一天的收尾挂在「睡着」上（一天一次，半夜醒了再睡不重跑）。状态存盘，重启不丢。
醒来的第一轮带一句事实（`dot.woke` / `dot.woke.morning`：睡了多久、离平时起床多久），怎么反应是人设的事。回放（凌晨 02:40 他发来消息，各 5 次）：他问「睡了吗」，没有这句时 5/5 答「没睡」并编一个正在做的事，有这句时 3/5 说自己睡了被叫醒；让她查赛程，有没有这句都 5/5 直接去查；问一件要去手机上看的事，没有这句 5/5 去看，有这句 3/5 去看、2/5 只说「等我清醒一下」（样本小，方向记下）。
没做的：睡眠深度曲线（别的项目没人这么做，「入睡需要时间」已经给出同样的行为）、随机入睡时间、她自己宣布睡觉（查到的两个实现都要配一串防护）、睡眠债和起床气的数值（人设的事）。

## 0.25：三处模型、两本账、一个出口

从第一性原则重排（11-21）：他要的是「像个人」——说话像她、事情有下文、会用手机且越用越会、花得少。之前绕的地方，都是一个模型同时在拿主意、动手、说话。现在分成三处，各只读它该读的：

| 地方 | 是什么 | 读什么 | 写什么 |
|---|---|---|---|
| 拿主意 | 她的对话（`dot` 预设，lean） | 人设的「拿主意」部分、记忆、事情簿（每轮「现在」下面一行一件）、他报来的话（`他：…`）、手回来的结果 | 交代手（`hands`）、记一句事实（不发给任何人） |
| 动手 | 一件事一个会话（`dot-hands` 预设，没有人设） | 要做的事、手艺簿里那个地方的经验 | 设备上的操作；`ask_her`（问她，或 `for: him` 问他） |
| 说 | 一次干净的调用（`say.js`） | 人设的「说」部分、最近的原话、事情簿给的事实、她那句事实 | 发出去的话，一条出口（`outlet.js`） |

**两本账。** 事情簿（`ledger.js`）：交给手的每件事一条——谁要的、在做/排着/做完/卡住/被谁叫停、花了多少；拿主意和说都只认它（「说」只照括号里写明的进展说，11-21 编进度那次之后）。手艺簿（`howto.js`）：见下。

**人设拆开**（`persona/parts.js`）：`persona.md` 按 `## ` 标题切开，`persona/parts.json` 写着哪部分给谁读（`decide` / `say`），改人设不用碰代码。

**要他的事**（`gates.js` + `consent.js`，没有按钮）。四档，代码按屏幕和动作判断，不听谁的自述：
- 不做：钱（转账、红包、提现）、理财和支付类 App。
- 他本人来：付款或下单的最后一步、实名/人脸、人机验证、扫码登录（把屏幕带给他）、发到他手机上的验证码（她收不到，要来问他）。手停在那一页，事情簿里记一条等他。
- 先问他：装 App、开权限、注册、同意条款、删东西、加好友、打电话发短信、改密码绑定、打手机号、打像密钥的字、给不熟的人发消息、电脑上离开这台机器或碰他的文件的（见下面 11-22）、一件事花超了 `thingCostCap`。手停下（或她在对话里被拦下），她用自己的话问他；他在自己的话那一轮同意了，她用 `his_ok` 记下，一次只管那一件事（第一次用时绑上，30 分钟没用就作废），他明说「以后这种都行」才长期（`/dot` 和面板里看得到）。
- 她自己的：其余，包括按账号本登录。
宿主或插件在她的会话里要审批时，答复器当场答：他的同意盖得住就放行，否则拒绝并照上面走——不再有等人点的审批，`approvalWaitMs` 删了。

**手艺簿：越用越快、越准、越省。** 地方是手机本身（桌面、设置、通知栏、输入法、系统弹窗）、每个 App、电脑。手做一件事时每个设备调用都是那件事在那个地方的一步；事情结束按地方各记一行：步数、错、事情簿里的结果、用时、花费。值得学的地方（出过错、没做成或太久、步数明显比平常多）由一次小调用读这次的操作和以前各次，重写笔记：教训、捷径（只从做成的那次写，几步总一样的标「可一次做完」），并给这件事起个短名，同一件事的几次排在一起：做成几次、几步、花多少（面板「手艺簿」、`/dot howto`）。一件事里第一次到某个地方，有笔记才给。她自己的记忆不再记「怎么用 App」。

**通知。** 有人发来的才叫醒她：认得出发信人（她 QQ 上的人、聊天 App 和短信里的对话），或 App 自己标成消息/来电（`category`）。App 自己的推送留最近 `pushesKept` 条，下次不管什么叫醒她时在那一轮给一次。

**一个回答。** 他的话让她去做一件事：回他之前等 `ackHoldMs`（15 秒）。到点时他要的事都没在做了，就只由结果那一轮回一次；还在做，先说一声在弄；这期间他又说话，就不单独回。

**省。** 手有自己的预设（只带命令行、读文件、查资料、压缩），每一步不再重发几十个用不上的工具；她的对话 6 万 token 交接一次（以前 15 万：长活在手那边，对话再长也只是旧话一遍遍重发）；手的结果记进原话库时去掉括号里的提示（当时的规则，后来会变，翻出来会误导她）。

**事情簿只记事实，每个读者自己措辞（11-22）。** 说话那次调用拿到的「事实」里曾混着手的第一人称原话（最多 500 字），还叫它「看结果和图」（那是写给她对话的说明，说话那边没有图）。根子是事情簿存的是写给某个读者的句子：`result` 是手最后那段话，`why` 是中英混写的一句，谁叫停的靠正则猜 `why`。现在：
- 手用工具收尾：`done { summary, detail }`（一句结果、给她的细节），用了这件事就结束；没用就提醒一次，再没有就记「没交结果」。要人定的照旧用 `ask_her`。
- 事情簿一条只存字段：`outcome`、`by`（him / her / code，从叫停的那处直接传进来）、`cause`（restart、no-session、interrupted、broke-off、no-result、timeout、stopped、command、over-cap）、`error`、`summary`、`detail`、`question`、`ask`。旧条目读一次折算成字段。
- 三个读者各自措辞：她的对话（`handsStatus`，有图，可以说「看图」）、说话那边（`voiceHow` + `summary` + `detail`，只给事实，不给指令、不提图）、事情簿那一行和面板。谁也不读别人写好的句子。

**拦下的那一步、结果从账上来、手艺簿的路、电脑上的四档（11-22）。**
- 拦下的那一步记成字段：闸门停下一件事时，事情簿的 `ask` 里存 `what`（被拦的动作，代码生成）和 `tier`（`ask` 先问他 / `him` 只能他来）。说话那边拿到的是写好的一句——「要做的一步「…」还没做——按你的规矩，这种事先问过他才做」或「「…」这一步还没做，也不会替他做——只能他本人来」——没有可补的空（之前只给「要他点头：…」，嘴补成了「手机弹了个拦截」「点好拨号了」）。
- 结果只有一处来源：说话那边拿到事情簿的 `summary` 和 `detail`（最多 `sayDetailChars` 字）；她那句话（`say` 的 `about`、她这一轮收尾的话）只写她的看法、打算、要他做的，不复述结果。这一条靠提示词（`say` 工具说明、`dot.hands.result.his`），代码管不到她写什么。
- 手艺簿多了路：`done` 多一个 `task`（短名，手起了名反思不改）；做成的一次，代码记下那个地方走通的每一步（失败和被拦的不算，打的字记成「…」），存进 `_log.jsonl` 的 `route`。同一件事里最短的那条是捷径，点的位置差 30 像素以内算同一条，走成过几次也是代码数的。下次到那里给手的那行带着「捷径（这样走成过 N 次）：A → B → …」；反思写的捷径只能照这条改写，不另编。
- 电脑上也是四档：`computer/gate.js` 不再自己给她的手要审批，改成报告结构化的风险（`risk()`：protected / shell / shared / home / file-delete / script / sensitive / browser）；dot 用 `gates.classifyComputer` 加上浏览器此刻的页面（地址、标题，从 CDP 读）判档。钱的站点不做；收银台、人机验证、扫码登录、实名页上的点和填只能他来（只是打开不拦，截图跟着话给他）；ssh/scp、git push、下载了直接跑、sudo、动磁盘、碰受保护位置、删改共享文件夹、网页里跑脚本、注册页、填手机号或密钥先问他，同意按「种类 + 对象」记（`push:origin`、`shared-delete:<路径>`），不再绑在一段理由文字上；其余是她的，用她自己的账号登录也是。不是她的手的调用照旧走 gate.js 的审批。哪个钩子先跑都一样：dot 在 `dshComputer.handsOf` 上声明哪些调用归它。

**收尾不等于做成；同一个错由代码数；结果只有一个出口（11-22，0.25.0 之后）。** 实机那次（关标签页、开 B 站注册）：B 站打不开，手撞了 9 次同一个错、32 步，最后用 `done` 照实说了打不开——账上却记成 `done`，手艺簿把它算成做成一次、还把这条没走通的路存成了捷径。
- `done` 多一个必填的 `reached`：要的那个样子到没到，只有手知道，由手填。`false` 记成 `failed`（`not-reached`），summary 照存；下游（面板、手艺簿的做成次数和捷径、说话那边「没做成。」）都跟着对。
- 「卡住了要停」不再只交给模型：代码在一件事里数同一类错误连着出了几次（`errorType`，网址不算在内，我们自己的拦截不算），中间成了一步就重数。到 `sameErrorNudge`（3）在那一步的结果后面告诉手换个完全不同的办法、或照实收尾；到 `sameErrorStop`（6）代码把这件事停下，记 `failed`（`same-error`）。这是一道上限，不是根治：手没有「离目标还多远」的概念。
- 这一轮有一件刚结束的事时，说话那边只拿事情簿的事实，不拿她那句话（`say-note-dropped`）。靠提示词让她「只写看法」实机守不住；同一个结果两个来源，嘴就可能挑一个或混着说。代价：那一轮她想加的态度不说出去。

**判断不了就拦；失败是一种结局；同意对得上人和事（11-23）。** 11-22 实机和代码检查查出的三类问题，都是「判断不了的时候放行」。
- 手机闸门反过来列。以前列的是「哪些工具算点击」，没列到的（双击、长按、batch 里夹带的装卸 App、开网址、剪贴板）都当成她自己的事放行。现在只有「只看」的工具是一份白名单（`tool-prefixes.js` 的 `PHONE_LOOK_TOOLS`，闸门和别处共用这一份），其余全是动作：点、双击、长按都按落点下的字判档（读屏幕时带上元素大小，点在大按钮的边上也算点它）；装卸 App 无论怎么调都先问他；付款类的链接（`alipays:`、`weixin:` …）和钱的站点不打开；钱的 App 里只有返回、回桌面、关掉这个 App 是她的；没有规则的工具（手机服务以后新加的、云设备、录屏）按工具名问他（`phone-tool`）。
- batch 是它的每一步，各按单独调用来判，取最重的那一档。一批里点过、滑过、按过键之后的点击判不了（落点下是什么要等屏幕变了才知道），整批不做，告诉手截到那一下之前（`refuse` 档，`dot.gates.refuse`，不问任何人）；对手隐藏的打字和剪贴板工具放进 batch 也不做。代价：以前一批里连点几下的做法没有了，表单要一格一批。要把连点拿回来，得由插件自己一步一步执行并在每步之前读屏，这次没做。
- 读不到就问。屏幕读不出字（空、读失败、超过 60 秒）或前台是哪个 App 查不到时，点按一律先问他（`blind`），同意按这件事记；滑动不受影响。读得到屏幕、落点下没有字的（图标、图片），仍是她的。
- 同意对得上人和事（`consent.js`）：只有种类相同、对象完全相同才算数，没写对象的同意只盖没有对象的请求（以前空对象两边通配，一次「可以」能盖住这个种类的所有人）。`his_ok` 要对得上一件正等他点头的事（事情簿里停下来问他的、或她被拦下要问他的），没有就不记（`dot.gates.ok.nothing`）；记下的原话取他这一轮自己打的字（以前可能被她后来写的字盖掉）。「以后都行」仍然只对那个对象。
- 失败是他一条消息的第三种结局（另两种：回了、她选择不回）。她的一轮以错误结束时不再走说话那次调用（那会照最近的原话替一轮没发生的事写一句），由插件用自己的名义告诉他（`dot.turn-failed`，不记成她的话），审计 `turn-failed`，面板那一场标失败，`/dot` 有一行；说话那次调用自己失败（比如没有人设卡）也走这里，不再记成 `silent`。他的话交给她的对话之后 `ownerLostMs`（45 秒）内没有哪一轮接到、当时也没有轮次在跑，记为没接到（`dot.turn-lost`）。同一类提示 `failureNoticeMs`（10 分钟）内只发一次。
- 运行中磁盘被换（`integrity.js`）：进程启动时记下磁盘上的版本号和提示词文件名；提示词是每次用时从磁盘读的，文件被换成另一版（11-22 下午：内存里 0.25.0、磁盘被换回 0.23.2，每一轮都死在 `phone.hers`）以后，每分钟的检查会发现并告诉他一次（`dot.drift`），缺文件的报错也写明是「启动后没了」而不是「不认识的提示词」。
- `done` 的 `reached` 没填时不收尾（以前漏填按做成算），提醒手填了再调一次（`dot.hands.done.unsaid`）。
- 分词：`recall.js` 的 `lexTokens` 里「拉丁字母或数字」那一段的正则用的是 `\p{L}`，把紧跟着的汉字也吃进去，「github点击注册」「27号前请他吃饭」成了一个谁也匹配不上的词（原话召回和事实条的 BM25 都用它）。现在遇到汉字就断开。BM25 在内存里重建，重启即可。

**他自己开口要的事算他点过头；手只在她的电脑里有命令行；工具按设备给；钱花在哪（11-23，实机日志之后）。**
- 他这一轮自己开口要做的事（「给 10086 发条短信」），算他已经同意（他 11-23 定的）：`his_ok` 在没有哪件事等他点头时记一条「提前的同意」（`ahead`），不带对象，给下一件这类的事用一次——第一件用到它的事留着它，没有事可挂的用一次就没了；不能是长期的。他的原话和这条同意记在一起；他的话是不是真在要这件事，是她的判断，代码不核对。被拦下来问过他的，照旧按「种类 + 对象」记。
- 手的命令行和文件工具（`bash`、任务、`read`、`read_image`）只在她的电脑里：电脑没开着（或没有电脑这个组件）时一律不做（`dot.gates.no-computer`）。以前这时宿主自己的命令行会跑在他的机器上，会话的沙箱模式是 `danger-full-access`，dot 的闸门对它判「她自己的」。没核实的一点：电脑开着时 `read` / `read_image` 走的是哪边的文件系统。
- 工具按这件事的设备给（`compat` 的 `hands:phone` / `hands:computer` / `hands:web`，设备由 `dshDot.handsDevice(会话)` 说）：手机上的事不带电脑的三十来个工具，反过来也一样；查资料的两个工具都带。手机服务的工具只给手用得上的那一份（`PHONE_HANDS_TOOLS`，正面清单：云设备、录屏、设备日志、定位、折叠这些不给，以后新加的工具也要写进来才给），放进 batch 也一样不做。
- 钱花在哪：11-23「看安卓版本」那件事 28 步、面板上 71.6 万 token，其中 67.8 万是缓存命中；第一步还没动手上下文就有 1.7 万 token（工具说明 5.3 万字符、系统提示词 7 千字符），做到第 28 步只涨到 3.5 万——每步重付的是固定的那一截，不是越攒越长的历史。所以先砍工具说明，「旧屏幕缩成一行」不急。面板上每件事的花费改成折算数（缓存命中按一成，和 `thingCostCap` 同一个算法），括号里另写缓存命中多少。他说缓存命中到千万级都能接受：`thingCostCap` 默认从 60 万提到 150 万。
- 28 步里 17 步是一下一步的滑动：手的系统提示词写明连着滑的几下放进一次 batch、动作之后不用再单独列屏幕、找设置项先用搜索。
- 事情簿给说话那边的「先问他」那一行补上「这次就是要问他：这一步做不做」（11-23：没写明，嘴把它说成了「这事我做不了，你自己发吧」）。

**她在对话里写的字没有人读；要带给他的话是一个栏位；问过他的事等到他下一句话为止（11-23 晚）。**
- 以前每一轮都要她「最后用一两句记下事实」，这句话再作为「她知道的」交给说话那边。交出去的那一轮她没有事实可记，就写成了「短信发出去了」（手还没动）；0.25.1 为了不让结果有两个来源，只要有事刚结束就把这句整个丢掉，连她真要问他的话一起丢。现在不再要她写：`dot.rules`、`dot.say.note` 改成「这里的字没有人读，不用写」，轮次结束时说话那边只拿对话和事情簿；她自己有话要带给他（看法、要问他的、结果和图对不上的地方）用 `say` 的 `about`，任何时候都给到说话那边（`say-note-dropped` 没有了）。自己的时间的结果（`doings.result`）改从事情簿取：那段时间里她交出去的事各一行。
- 说得多靠提示词收：`dot.say.end` 写明只回他问的那一点、没问的经过和原因不说；事情簿的细节那一行标明「他问到才说」。条数上限 `sayMaxLines` 没动（他要这部分用提示词和人设卡做，不写死）。
- 一件停下来问他的事，等到他下一句话被读过为止：那一轮里她记下了他的同意就算数，没记（他说了不、说了别的）这个问题就不再等着（事情簿 `askSettled`，`consent.settle`）。之后他又自己开口要，走「提前的同意」。11-23 实机上一次同意对上的是前一天他已经说「算了」的那条短信。

**等待是一步，不是一遍遍看；本机的命令行照旧（11-23 晚，他定的）。**
- 11-23 发短信那件事 39 步里 24 步是在隔几秒列一次屏幕等回执。调研了别人怎么做（Playwright MCP `browser_wait_for`、Maestro `extendedWaitUntil`、agent-device `wait`、Inngest `step.waitForEvent`、LangGraph `interrupt`、Claude Code `Monitor`、Hermes 的完成通知）：短等待是一次带条件和上限的调用，由代码看；长等待是这一轮结束、事件来了再叫醒。dot 两样各取现成的一头：
  - 等界面：手多一个 `wait_for`——屏幕上出现某几个字（`text`）、某几个字消失（`gone`）、来一条通知（`notification`，手上次动作之后到的都算，先到的不丢），或只等几秒；代码每 `waitPollMs` 看一次，最多 `waitMaxMs`（120 秒），到了条件或到了时间带着当时的屏幕回来。条件是代码看得见的，不交给模型判断。
  - 等别人回（回消息、回执、审核结果）：不等。发出去这件事就做完了，手用 `done` 收尾说「发出去了，还没回」；回了本来就会作为通知叫醒她。没有做「挂起手的会话、事件来了续上」那一种：要挂起恢复、等的时候占着手机，和「一件事做完就结束」对不上。
  - 兜底：手连着两眼看到的屏幕一样、中间没有动作，代码在那一眼的结果后面说一句（`dot.hands.same-screen`，审计 `same-screen`），让它改用 `wait_for` 或收尾。不指望模型自己不轮询。
- 手的命令行：他要 dot 保留在本机（不是手机、不是虚拟机）做事的能力，所以 11-23 白天加的「电脑没开着时命令行和文件工具一律不做」撤掉了，回到原样——电脑组件开着时命令行进虚拟机，关着时落在本机。本机作为一个明确的地方（有自己的闸门）还没设计；现在落在本机的命令 dot 的闸门不管，只有宿主自己的审批（会被 dot 接成「先问他」）。

**本机是手做事的第四个地方（11-23 夜，他定的）。**
- 他的想法：手机、虚拟机都只是她的工具，她照样有 dsh 在本机做事的能力；她的对话保持精简，本机的事也由手去做。所以 `hands` 的 `device` 多一个 `host`：跑着 dsh 的这台机器本身，用命令行和读文件做，没有屏幕。
- 怎么落到本机：电脑组件开着时所有命令行都进虚拟机，分流只看命令来自哪个文件夹（`computer/subprocess.js` `routeFor`）。本机的事从手的文件夹下单独一个子文件夹（`<dsh>/dsh-dot-hands/host`）发起，compat 认出它是 `hands:host`，走 dsh 自己的本机运行器。电脑组件关着时命令行本来就在本机。
- 工具：命令行、它的后台任务、读文件读图、查资料、问她、收尾、等。没有她的手机和虚拟机的工具，也没有她的账号本（那是她的账号，不往他的机器上填）。
- 闸门（他选的第 2 种）：这台机器是他的，而且电脑组件开着时宿主的沙箱是关的，没有东西兜底。所以留的名单是「只看」的那一份（`gates.js` `HOST_LOOK`、`classifyHost`）：`ls`、`cat`、`grep`、`find`（不带 `-delete`/`-exec`）、`git status/log/diff` 一类直接做；不在名单上的、读不成「一排普通命令」的（重定向、`$()`、反引号、后台 `&`、行首赋值）一律先问他，不因为「不认识」放行。一次点头管这一件事（kind `host` 不带对象，同意绑在这件事上）；sudo、git push、ssh、下载即跑、整块磁盘、放密钥的地方（`.ssh`、`.env`、`~/.dsh` 等，连看也问）各按自己的名目问。命令行以外的工具，只读的放行，其余（含不认识的）问。
- 只在他的事上去：她自己时间里交本机的事不给做（`dot.hands.host.his`）。他自己开口要的那件，照「提前的同意」记一次就不用再问。
- 还没做的：各个地方各一条并行的道（现在所有的手仍是一次一件、排队）；本机的事没有诀窍簿。
- 去哪做由她的对话（拿主意的那个）自己判断，不另设路由器，也不写死判据（11-23 夜，他定的：不要硬编码指定，让她自己判断，甚至学习）。`hands` 的 `device` 就是这个决定；`dot.hands-tool` 里只写四个地方各是什么（有什么、是谁的、会不会问他），不写「什么事去哪」。
- 学：事情簿本来就记着每件事在哪做、成没成、几步、有没有停下问他、是不是从别处换过来的。他这一轮说的话和哪些做过的事字面相近（`lexTokens` 共有两个以上的词），就把那几条记录原样放进她这一轮的提醒（`thingsLike`，`dot.things.like.*`，最多三条）。放的是记录，不是建议；没有相近的就什么都不放。挑错了地方：手收尾说没成，她换个地方再交，这次「换过来」也记在簿里，下次相近的事就看得到。
- 代码只守两条边：她自己的时间不去本机；本机上不是只看的先问他。
- 真机第一轮（11-23 18:34）露出的两处，已改：只看的 `git branch --show-current` 不在名单上被拦（git 里「看形式才知道是不是只看」的子命令——branch、remote、stash、tag、config——按它带的词判，`HOST_GIT_FORMS`）；他点头后手给 bash 填了 `workdir`，命令的起始目录就不是手的本机文件夹，三条命令进了虚拟机，还把他的仓库共享了进去、她的 QQ 因为重挂掉线重连。分流只看起始目录，所以本机的命令不收 `workdir`（`classifyHost` 判 `refuse`，kind `elsewhere`），要去的目录写在命令里。

**说多少、怎么说是她的事：条数上限去掉了（11-23 夜，他定的）。**
- 11-23 他要三条提交，结果有五行，`sayMaxLines`（4）把最后一条截掉了。他的话：这本来就该由提示词和人设卡来管，让她自己知道什么时候该说多少、怎么说——汇报可以很长、可以带表格，聊天照之前说的那样短。所以代码里不再有条数（`sayMaxLines` 删了，`tidy` 不截）。
- 聊天还是一行一条气泡。要放在同一条消息里的多行内容（结果、清单、对比、汇报），她用单独一行的 ``` 包起来：里面原样发成一条，保留换行、空格和括号，人设卡的逐行检查不碰它。代码只提供这个「几行是一条」的写法，用不用、写多长是她定（`dot.say.end`）。块内的换行在往外走的路上记成 U+2028（一路上都按「一行一条」算），到 `qq.js` 发出去时换回来。
- 提示词里告诉她的是事实：QQ 不认 markdown，表格用对齐的文字排。事情簿的细节那行从「他问到才说」改成「他要的东西在这里面就给全，没要的经过不提」。

**等别人回，是事情簿上的一条记录，不是手的时间（11-23 夜，他定的；先看清情况再改）。**
- 看到的：给 10086 发 CXLL 本来就是为了看它回什么，她从第一次起每件短信的事都自己写了「把回复读给我」——她没有多事。系统里一件事只有做完、卡住、失败，没有「发出去了、在等谁回」，要拿到回复只能让手守在对话页（169 秒里 135 秒在等）。上一批写给手的「发了不等」和她交的目标冲突，手听她的，那条规矩是补丁，没用上。「回了会作为通知叫醒她」的路代码里有，但回复和那件事、和他都没有连着。
- 现在：手用 `done` 收尾时填 `awaiting`（对方在屏幕上的名字或号码），事情簿那一条记上 `awaiting: { from, since, until }`（等 `awaitMs`，24 小时）。之后谁用这个名字来了消息（手机通知的会话标题，或她 QQ 上的人），代码把它记成答复（`answeredAt`、原话），带着「这是那件事在等的回复」叫醒她；那件事是他的，这一轮就是他的事（消息来源带 `for: 'him'` 和事情号），到头由「说」照事情簿告诉他。收尾前回复已经到了（事情开始之后的通知里有这个名字）就直接记成已答复。
- 她和「说」看到的都来自这条记录：事情簿摘要里「在等回复」一行；手回来时一句「在等谁回，回了会再叫你」；「说」的事实里「在等谁回，还没回」或「回了，原话」。两边提示词写的是同一个机制（`dot.hands.system`、`dot.hands-tool`），不是规矩。

**手艺簿对着记录核对；一件事在它主要发生的地方才算数（11-23 夜，他定的：并进夜间核对，然后做）。**
- 看到的：第一次发短信，手的报告里是「**可能**模拟器连不上运营商网关」；整理手艺簿时写成了加粗的教训；第二次的手把它当经验读到，报告里成了「这台是模拟器，短信到不了」；他被告诉的是结果。每过一手「可能」掉一点。另一处：「发短信查流量」在「手机本身」那一页写着「做成 1/1，2 步，捷径：列设备」——那件事 39 步都在信息 App 里，路过手机本身的两步被记成了它的走法。
- 一件事只在它主要发生的地方算数：`howto.tasks` 不数 `share < 0.5` 的那几行（记账照旧全记）。
- 写教训的那一次把它的每一步留在记账里（`calls`，打的字不留）：以后拿教训去对的就是它。整理的提示词写明只写 calls 里看得到的，原因的猜测不写。
- 核对（`nightcheck.js`，`/dot nightcheck`）：逐个地方，把每条教训和这个地方的记录交给一次小调用，逐条判——seen（记录里看得到，点出哪几次）、guess（说了原因或「是什么样」，记录里只有现象：改写成看得到的那部分，留不下就去掉）、stale（后来某一次和它对不上，点出那一次）。判是模型的；它点的记录在不在、每条怎么处置、改完的笔记是什么，是代码的：点不出在册记录的 seen/stale 不照办，只列出来（unsupported）。捷径不交给模型：这件事没有记账下来的走法就去掉。
- 核对只写「会做的改动」（`<home>/her/howto/_nightcheck.json`），什么都不改；`/dot nightcheck apply` 才照着改，而且只改核对之后没变过的笔记。还没接到她睡着的时候自动跑：先看几次它判得准不准。记忆那边的派生内容（事实、人的卡片）还没并进来。
- 第一次真跑（11-24 凌晨）就露出来的：留步骤是今天才开始的，以前的记账只有次数；模型对几乎每条教训都如实说「记录里看不到」，按当时的规则就是「推测→去掉」，整本手艺簿会被清空（那次只写了文件，没改）。所以规则改成：**记录里没有，不证明它错**。核对只做两件事——把教训里的「为什么 / 是什么样」去掉、留它自己写明看到的现象和做法（cause，改写）；和后来某一次有步骤或走法在册的记录明明白白对不上的，去掉（stale）。其余原样留着，背后没有在册记录的只计数。捷径不碰（下次整理这个地方时照在册的走法重写）。第二次跑：8 个地方 9 条改写、0 条去掉，「模拟器收不到短信」那条成了「16:50 发出的 CXLL 到 16:53 没有回信；等一次就够」。
- 4000 token 的上限会把教训多的地方的回答从 JSON 中间截断（「Unexpected end of JSON input」，整理手艺簿一直偶发的那个失败也是它）：两处都放到 12000，失败时审计里记下结束原因和长度。仍有个别地方交回空的，原因还没查到。
- 接到了她睡着的时候：睡着即核对、照着改（`dot.nightcheck`，默认开）；改之前每条的原样在 `_nightcheck.json` 里，每次改动在审计里（`nightcheck`、`nightcheck-applied`、`nightcheck-night`）。
- 真机上（11-24 凌晨）：机制写进了两边的提示词，她照旧在交的话里写「等一会儿看有没有回」，手照做、等了两次，收尾时没填 `awaiting`——回复仍然连不到这件事上。只靠说明不够，所以按 `reached` 的同一个道理改成事实必须说出来：一件事里放行过会碰到别人的一步（发短信、打电话、发消息、加人：闸门的 `call`、`message`、`friend`、`send-file`），收尾就必须填 `awaiting`——等谁填谁，不等填空字符串；没填不算收尾（`dot.hands.done.unsaid-awaiting`）。短等一下是她定的，不拦。

**「说」会不会照事实说，是量出来的，不是从一条消息猜的（11-24 凌晨）。**
- 起因：手刚开始发短信，事情簿给「说」的事实是「才开始，还没有任何结果」，她回的是「发了，还是 CXLL / 这次没等」。
- `/dot voicetest <文件>`：把存下的输入原样再交给「说」若干次，只记不发（`~/.dsh/dot-replay/*.json` → `.out.json`）。同一份输入各跑 10 次，数说了「已经发了 / 看到结果了」的次数：现在的写法 5；事实换成【】不套括号 9；换回旧的结尾提示 6；对话里去掉她以前那两句「发完了」7；让它先想一下（low）6；事实改成「你现在还不知道」7；结尾提示按「还在做」另写 1；后两样一起 0。
- 最后那个 0 靠的是提示里点了这件事的词（「发没发出去」「说『发了』是没影的事」），代码写不出每件事的这种词；换成通用的说法接进代码再量：发短信 5/10，看仓库、看热点各 1～2/10，还多了说漏「手」的。没有量出来的改善，所以**没有留下这处改动**。
- 结论：一件事还在做的时候让「说」自由写一句答应的话，难的情形里一半会写成做完了；换措辞、换格式、加思考都压不住。这不是哪句提示词的问题，是「自由生成 + 没人核对」这个做法的错率。要改得动结构：核对之后再发，或者这一句不由它自由写。

**事情簿定说什么，人设卡定怎么说：「说」分成两种（11-24，他让先调研、回头审视架构、再放手改）。**
- 回头看：「模型写的话要指回一条记录」这条原则，用在了她的对话（写的字没人读）和笔记（核对）上，唯独没用在「说」上——它一直是「给一段对话和括号里的事实，续写下一句」，写完直接发，没人核对。量出来的错率（一件事刚开始，说成做完了 5/10）不是措辞问题，是这个做法本身。
- 调研（别人怎么做）：语音助手类（Pipecat、Vapi、LiveKit）的「稍等」句是代码直出的固定句；Rasa CALM 是「模板定内容、模型只改写」；LiveKit 的异步工具把中途更新一律框成「进行中」，只有工具返回才能说完成。生成后让模型当判官不可靠（False Success，arXiv 2606.09863：判官 AUROC ≤0.65，表层检测器 0.83～0.95）——我们自己量的也一样：同一个模型判「有没有说成做完了」，50 条漏 14 条，零误报。
- 现在两种：
  - **聊天**（这一轮在事情簿上没有事）：照旧，对话 + 她手上有没有事，自由写。
  - **照事情簿说**（这一轮有事开始了、停了、到头了）：代码用事情簿写出要说的话——第一人称的平白句子（`dot.plain.*`），本身就完整、是真的、能直接发；「说」只拿到他刚说的那句和这些句子，**不给对话**，要求用她的口气说出来、意思不增不减（`reportInput`、`dot.say.report`）。手留下的细节另放（〔〕），默认不说，他这次明明白白要的那样东西才照原样给。
- 量出来的（同一批输入各 20 次）：带着对话续写 5/10 说成做完；改成照句子说、不给对话，160 次里多说了 3 次；但句子里一写出这件事是什么（「再给 10086 发一次短信」这件事我去做了），又回到 12/20——所以刚交出去的事，句子里**不写它是什么**（他自己刚说过），降到硬错 1/20、带「还没回」这类软错 5/20。清单 20/20 给全；没要细节的 19/20 不再念经过。
- 代码能核对的两样，核对不过重写一次，再不过就发平白句子本身（审计 `say-unfounded`、`say-plain`）：一是话里的数字（时间、次数、哈希）必须是给过它的；二是事情还在做时，话里不能有「做完了 / 对方怎样了」的表层标记（`saysOver`，手标的 112 条上 50/50 抓到，误抓 12/62，误抓的代价只是重写）。措辞本身代码核对不了，这一点不假装。
- 没做：模型判官（量过，不可靠还多一次调用）；聊天那一种仍然没有核对；手留下的结果本身是手的说法，这里照转。

**判断是她的，代码只守事实和安全；判断靠记录学（11-24，他定的）。**
- 等不等别人回、让不让手守着，是她的判断，不加代码规矩（维持现状，不做「代码替她记下在等谁」）。他要的方向：约束尽量少，她的判断能一点点学，人设和记忆的架构要撑得住这一点。
- 分界：代码管的是**事实**（事情簿只由代码写、话里的数字要有出处、还在做的事不能说成做完）和**安全**（闸门）；**怎么判断**（去哪做、交代得多细、等不等、说多少）是她的，喂给她的是记录，不是规矩。
- 这一处的学：等待花了多久、等没等到，记在那件事上（`waited`）；她面前出现相近的事时，那条记录现在写着用时、手守着等了几次共多少秒、等没等到、有没有记下在等谁、后来回没回（`dot.things.like.*`）。等了 70 秒没等到这件事，以后是她自己看得见的。

## 11-24 补：刚开始的事，进展不由她措辞

量出来的事实：
- 刚交出去的事让嘴用自己的话说，80 次里 21 次说成了「发了 / 在等它回」。
- 事后读这句话判对错，四种办法在新一天的 100 句（38 句越界）上都不行：前一天照着样本写的词表 23/38（误报 4/62）；同一个模型看着事实判 9/38；不给事实、让它还原状态 17/38；让它列说到了哪几类事 30/38（误报 14/62）。
- 所以不再事后读。进展这一句是她的「说法」里的一个（`dot.plain.opened.sayings`，一行一个，` / ` 分条）：每个说法进文件时看过一次，之后不再看；她挑哪个，并在它前面自己写一行接他的话。没有说法的情形（排队、好几件）直接用账上的原句。
- 量过：编号 80/80 有效；她自己写的那一行 80 次里 2 次多说了（「发啦」），这一行不检查——没有检查得了它的办法，这是留着的已知缺口。
- `saysOver` 词表删掉。做完的事照旧：账上的句子由她改口说，数字对账（`unfounded`）。
- 说法文件和别的提示词一样可以在 `<home>/prompts` 里改，改了不用重启。她自己提新说法、核过再进文件，这条路还没做。

另：`likeRecords`（默认开）可以把「做过相近的」那几行关掉，为了量它有没有用；摆没摆过记在审计里（`things-like`）。

