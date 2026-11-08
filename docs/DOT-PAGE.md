# dot 页面（设计稿，已定）

左侧栏一个 dot 入口，点进去是一整页：装、设、查、导，全在这里点，不用敲命令。命令照留（老用户、agent、老版本 dsh 用）。

## 目标

- 新用户装完插件，第一次打开 dsh 就被引到这页，一路点按钮完成初始化
- 所有设置能在这页改，改的就是 `~/.dsh/dsh-dot.json`（手改、agent 改、页面改是同一份）
- 出问题时：一键体检、能修的一键修、一键导出打码后的日志包
- 任意组件组合都能用（只开手机 + 电脑的 runtime 用法也行）

不做：替代 dsh 的插件页（组件开关仍在那边）；记忆/幕间的设置项本轮不接（lean-memory 刚合并，等稳定后再接）。

## 挂载点（dsh 已有的客户端插槽）

| 插槽 | 用途 |
|---|---|
| `sidebar.panellist` | 左侧栏 dot 图标（id `dsh-dot`） |
| `main`（key `dsh-dot`） | 中间整页 |
| `settings.onboarding` | 首次打开 dsh 时一步提示："dot 还没装好 → 去设置"；装好了自动 complete |
| `plugins.bundle.config`（key `dsh-dot-life`） | 插件页里本插件的页面放一行"在 dot 页面里设置"+ 跳转 |

右侧栏面板保留，定位是 dot 的生活（她在干什么、手机画面）；设置、体检、导出都在这一页，不放右侧栏。

前端代码在 `ui/`，挂在 **dot-ui 组件**（插件根，组件列表里的 `dsh-dot-life`）上，不挂 dot 组件，关了 dot 也在。老版本 dsh 没有这些插槽时不挂，命令照常。

## 页面结构

顶部一行状态条：手机 / 电脑 / QQ / dot 各一个小灯 + 一句话（就绪、下载 57%、出错…），点了跳到对应位置。

### 1. 开始（未完成初始化时默认打开）

一列步骤卡片，每张：标题、为什么要做、一个主按钮、做完打勾。中途关掉下次从断点继续（进度存 `~/.dsh/dsh-dot-setup.json`）。

1. **检查这台电脑**：自动跑体检；❌ 项旁边有「修复」按钮或照做的命令；全绿或用户点「我知道了」进下一步
2. **选组件**：列出 phone / computer / subprocess / gate / qq / memory / interlude / dot，各一句话说明、当前开关状态；开关本身跳 dsh 插件页（见"待确认 1"）。推荐组合给三档：完整的 dot / 只要手机和电脑 / 只要手机
3. **手机**：存储大小（8/16/32/64，标"建好后不能改"）、渲染方式、联网检测地址（默认国内，可选国际）→「接受 Android SDK 许可并安装」→ 进度条（哪一段、MB、%、剩余时间）→ 开机 → 绿
4. **电脑**（开了才显示）：镜像源（默认国内火山引擎，可选官方 ghcr）、内存、磁盘 →「安装」→ 进度 → 绿
5. **人设**（dot 开了才显示）：粘贴 HDSI 分享码 / 选角色卡文件 → 预览名字和简介 → 确认
6. **QQ**（qq 开了才显示）：主人 QQ 号、她的 QQ 号、后端（napcat / snowluma）→「安装并显示登录二维码」→ 扫码 → 绿

### 2. 状态

完整版面板（右侧栏面板保留）：每个组件的状态、错误原文、最近事件；手机多一行网络（已验证 / 部分连通 / 无网络）；电脑多一行阶段。每块有「重启」「看日志」。

### 3. 设置

按组件分组的表单，组件关着的那组折叠并注明。每项：名称、说明、控件、默认值、生效方式标签：

- `即时`：保存就生效
- `重启手机` / `重启电脑`：保存后出现「现在重启」按钮
- `重启 dsh`
- `建立时`：只对新建生效；已建好的显示当前值 + 灰掉，旁边写"要改得重建（会丢 X）"

本轮表单项：`phone` 全部、`computer` 全部、`gate.mode`、`qq` 全部、`dot` 里非提示词类的项。另加本次新增：

| 键 | 默认 | 说明 |
|---|---|---|
| `phone.gpu` | Windows `swiftshader_indirect`，其他 `auto` | 显卡崩溃（0xC0000005、`context was preempted`）时用软件渲染 |
| `phone.connectivityCheck` | `cn`（面向国内用户） | `cn` = `connect.rom.miui.com/generate_204`，`google` = 系统默认，或自填 URL；开机后写进手机设置 |
| `phone.dnsServer` | `""`（自动） | 指定给模拟器的 DNS；校园网等封外部 DNS 的网络别填 |
| `phone.proxy` | `""` | `system` = 把电脑的系统代理给手机 |
| `phone.crashDialog` | `false` | 模拟器崩溃上报弹窗（开着会卡住自动重启） |
| `phone.bootTimeoutMs` | `600000` | 开机超时；5 分钟后先显示"开机较慢" |
| `computer.image` | 国内镜像（面向国内用户） | 下拉可选官方 ghcr 和国内镜像（`enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:<版本>`） |
| `computer.whenNotReady` | `fail` | 电脑没起来时命令：`fail` 立即报原因 / `host` 先在本机执行 |

文件解析失败时，页面顶上红条显示错误位置，表单只读，给「用默认值覆盖（先备份）」按钮。

### 4. 体检

就是 `/phone doctor` 的结果，分项列出；每个问题可能有：

- **一键修**（插件能直接做的）：切国内电脑镜像、改联网检测地址、改用软件渲染、换 adb 端口、加开机超时
- **照做**（要管理员或系统设置的）：开 WHPX、改页面文件、BIOS 虚拟化——显示命令 + 复制按钮

### 5. 日志导出

一个按钮「导出诊断包」，下载 `dsh-dot-diag-<时间>.zip`：

| 内容 | 处理 |
|---|---|
| `dsh-phone.log`、`dsh-computer.log`、各组件日志 | 只取最近 2 MB |
| `phone/emulator.log` | 最后 3000 行 |
| `dsh-phone-audit.jsonl` 等审计 | 最近 2000 条 |
| 体检结果 | 导出时现跑一次 |
| `dsh-dot.json` | 打码：所有含 `key`/`token`/`password`/`secret` 的键值 |
| 版本 | 插件、dsh、Node、系统、模拟器、系统镜像、电脑镜像 |
| 组件开关、当前状态 | |

页面上另有「复制摘要」：版本、组件状态、体检的问题项、各组件最后几条错误，纯文本，方便贴 issue 或发群；同样打码。

默认**不含**：记忆、日记、人物卡、聊天记录、账号密码文件、QQ 消息。"附带她的记忆和最近对话（排查人格问题用）"做成单独勾选，默认不勾。
打码规则单独写测试（API key、QQ token、手机号、邮箱、`Bearer xxx`、URL 里的 `key=`）。

### 6. 危险区（页底，折叠）

重建手机（会丢她装的 App 和登录）、删电脑、释放下载缓存；都要输入名字确认。

## 服务端

新文件 `src/page/`（挂 dot-ui 组件），HTTP 路由走 dsh 的 web server，`rejectUnlessOwner` 把关（和面板、实时画面同一套）：

| 路由 | 作用 |
|---|---|
| `GET /dsh-dot/api/status` | 各组件状态（面板已有的扩展） |
| `GET /dsh-dot/api/settings` | 配置定义 + 当前值 + 文件错误 |
| `PUT /dsh-dot/api/settings` | 校验后写 `dsh-dot.json`（原子写、保留 `_` 开头的键和未知键） |
| `POST /dsh-dot/api/doctor` | 跑体检 |
| `POST /dsh-dot/api/fix/:id` | 体检的一键修 |
| `POST /dsh-dot/api/action/:id` | 接受许可、安装、重启手机/电脑、QQ 二维码等，复用现有命令的实现 |
| `GET /dsh-dot/api/diag` | 诊断包 zip |
| `GET/PUT /dsh-dot/api/setup` | 引导进度 |

组件之间不直接互相 import：各组件把自己的 `doctorInfo()`、`status()`、动作注册成服务，页面按"有就显示"取用。

## 配置定义（单一来源）

新文件 `src/settings-schema.js`：每个键一条 `{ section, key, type, default, enum?, min?, max?, apply: 'live'|'restart-phone'|'restart-computer'|'restart-dsh'|'create', zh, en, secret? }`。

由它生成/驱动：组件读配置时的默认值和校验（替代各组件里散落的默认值表）、页面表单、`docs/SETTINGS.md` 的「全部键」表（脚本生成，测试检查一致）、诊断包打码（`secret: true`）。

## 顺带修的 bug（不做成选项）

- 电脑镜像拉取失败时卡在"下载中" → 报错 + 原因
- `dsh-dot.json` 解析失败只进日志 → 页面红条、`/phone`、`/computer` 都显示
- 体检把已运行的手机/电脑内存重复计算
- 体检挪到 phone 组件（`/phone doctor`，`/dot doctor` 留作别名），自动体检跟着挪
- 启动串行化、监听子进程 `error`、慢崩溃循环
- 手机没就绪时停止读通知栏轮询

## 交付批次

进度：第 1 批（08fd032）、第 2 批已完成；页面是同源 iframe（`/dsh-dot/page/`），不需要重新编译 React，`lib/client.js` 只加了左侧栏入口和 main 面板。

1. 配置定义、服务端接口、诊断包导出、上面的 bug 修复（无前端，命令可用）
2. 页面骨架 + 设置 + 体检（含一键修）
3. 开始引导 + 状态 + `settings.onboarding` + 危险区

每批各自能发版。

## 已定

1. 组件开关：dsh 不开放给插件时，只显示状态 + 跳插件页。
2. 国内默认：联网检测地址、电脑镜像源默认国内（面向用户大多在国内），设置里可改。
3. 诊断：下载 zip，另加「复制摘要」。
4. 右侧栏面板保留，是 dot 的生活；dot 页只管设置。
