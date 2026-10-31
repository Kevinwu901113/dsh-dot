# dsh-dot/qq · 她电脑上的 QQ

Her QQ on her computer: [NapCat](https://github.com/NapNeko/NapCatQQ) (a headless QQNT client) or [SnowLuma](https://github.com/SnowLuma/SnowLuma) (hooks the Linux QQ GUI) — both speak OneBot 11 — runs inside the computer VM, logged into **the same account as the QQ app on her phone** (QQ allows a phone and a computer at once). Messages arrive as events the moment they are sent, and she answers in a second with `qq_send`. The phone app stays for everything else.

## 为什么

手机 App 收消息靠通知栏：要 App 活着、要系统不冻结、要通知没被 App 自己撤回。我们把这些都修到了 2–4 秒，但它仍是"观察手机"，不是"收到消息"。协议端是"收到消息"：每条都有事件，群消息完整，发送即达。

## 怎么接

- NapCat 装在**她的电脑**（dsh-dot/computer 的 VM）里，以 root 身份 rootless 安装到 `/root/Napcat`，`xvfb-run -a /root/Napcat/opt/QQ/qq --no-sandbox -q <账号>` 后台运行。SnowLuma 的装法见下文。
- dsh 连它的 OneBot WebSocket **不开新端口，也不走网关的端口转发**（`Host: <端口>-xxx` 那条转发不验密钥，电脑组件启动时就把它改成 404 了）。插件往 VM 里写 `/opt/gem/nginx/dsh-dot-napcat.conf`，在网关**验过密钥之后**的那层 nginx 里加一个 `location /dsh-dot/napcat/` → VM 内 `127.0.0.1:<wsPort>`（WebSocket 也转）。dsh 连 `ws://127.0.0.1:<网关端口>/dsh-dot/napcat/`，带两样东西：`X-AIO-API-Key: <网关密钥>` 过网关，`Authorization: Bearer <OneBot token>` 给 NapCat。网关不认这种组合时（401）自动改成把 token 放进查询串 `?access_token=`。
- 只在电脑组件报告 `ready`（网关已加密钥、端口转发已关）之后才连；电脑报告 `unsafe` 时 QQ 不连，状态 `blocked`。
- 连续连不上（每 6 次）会查一下 QQ 进程还在不在，不在就重新 `/qq start`。
- OneBot token 第一次生成后存在 `~/.dsh/dsh-qq.json`（只有你能读，0600）。
- **只认她的号**：连上后每个事件都带登录的 QQ 号（`self_id`）。不是 `account` 设的号——尤其是 `owner`（你）的号——立刻断开、卸掉 QQ 工具、不处理任何消息，状态 `wrong-account`。没设 `account` 时也不会接受你的号。

## 第一次

```
/qq install            # 在她的电脑里装 NapCat（apt 依赖 + linuxqq + NapCat.Shell，几分钟；日志在 VM 的 /root/napcat-install.log）
/qq account 123456789  # 她的小号
/qq start              # 写 OneBot 配置、启动 NapCat、开始连
/qq qr                 # 把登录二维码放到她手机的摄像头前，也存到 ~/.dsh/phone/ 和她手机的相册（见下节）
```

然后她（或你在「手机」标签页里）打开 QQ → 右上角 + → 扫一扫 → 在手机上确认"电脑登录"。这就是真实的 QQ 多端登录流程——她的手机授权她的电脑。登录态保存在 VM 里，以后 `/qq start` 用账号快速登录，不用再扫。

`/qq` 看状态，`/qq log` 看日志（NapCat 或 SnowLuma 的日志和进程；SnowLuma 下还有监听端口和 WebUI 密码；安装中就是安装日志），`/qq stop` 停，`/qq owner <号>` 指定"你"——必须手动指定，不会从谁先私聊自动学。全部子命令：`install [snowluma]`、`backend <napcat|snowluma>`、`account <号>`、`start`、`stop`、`qr`、`log`、`owner <号>`、`group <mention|all|none|score>`。

## 扫码登录（`/qq qr`）

QQ 的电脑登录码**不接受相册导入，只认摄像头**。她手机的后置摄像头是模拟器的虚拟场景（`hw.camera.back=virtualscene`：一个带电视和书架的房间），`/qq qr` 把码放进这个房间，QQ 的扫一扫看到的就是它。

1. **拿到码**
   - NapCat：用 NapCat 自己写出的二维码文件；文件超过 45 秒或日志里有登录失败/过期，就重启 NapCat 等新码。
   - SnowLuma：截 VM 屏幕上名为 `QQ` 的窗口（找不到就截整屏）。QQ 的码是圆点风格，zbar 和 OpenCV 读不出，用 **zxing-cpp** 读出内容（第一次用时在 VM 里 `pip install zxing-cpp pillow`，先清华镜像再 PyPI；旧版 pip 不带 `--break-system-packages`；zbar 兜底）。读不出时视为已过期：窗口是 680×440 的登录窗就用 `xdotool` 点码中间的「刷新」再截一次——**只在读不出时点**，点一张有效的码会让 QQ 换码、作废已经在她镜头里的那张。读出后用 `qrencode` 重画成标准方块码，贴在两倍大的白色方形画布上、往右偏四分之一码宽（QQ 扫一扫的取景比系统相机更近、也偏，码放正中会被切掉左边的定位块）。实在读不出就用窗口截图本身，`/qq qr` 的输出会写明原因。
2. **存起来**：`~/.dsh/phone/qq-login-<时刻>.png`，并推到她手机相册 `/sdcard/Pictures/`（旧的 `qq-login*` 先删）。
3. **放到摄像头前**：手机组件先按 HOME 回桌面（**摄像头开着时换图不生效**），把场景里的 `wall` 海报清空，再设成新文件 `resources/dsh-dot-poster-<毫秒>.png`（`adb emu virtualscene-image wall <文件>`；同一路径、或不先清空，模拟器都会继续显示第一张）。这块海报在每次开机前已被挪到镜头正前方 1.5 米（改写模拟器的 `resources/Toren1BD.posters`，原文件存为 `.orig`）。手机是 0.10.8 之前开起来的，要 `/phone restart` 一次海报才会挪过去。
4. **保持新鲜**（SnowLuma）：之后 4 分钟里每 40 秒看一次，码过期换了新的才重新放上去；QQ 连上或 `/qq stop` 就停。码约一分钟过期——过期后关掉扫一扫、等几秒再打开，看到的就是新码。

## 之后发生什么

| | |
|---|---|
| **你**（owner）私聊她 | 你打的字原样进她的会话，以"人说的话"的身份（和 dsh-im 转发 IM 一样，`kind: user`）——所以你能在 QQ 上给她派长任务，她可以建目标（`create_goal`）一轮轮做下去。夜间静音对你不生效。**她这一轮的回答会送回你的 QQ**：她自己用 `qq_send(to: owner)` 发了就不重复，没发的话 dot 把她在对话里的最后一段回复转过去（`DOT_SILENT` 除外）。**只有电脑端 QQ 按 QQ 号认出的你才算**：手机通知只有昵称，谁都能改成和你一样，所以电脑端掉线时你从手机 QQ/微信发来的话会标成「未验证身份」，当普通消息看、不当指令 |
| 别人私聊她 / 群里 @ 她 | `[手机通知] QQ · 路人（123）：在吗` 叫醒她，和手机通知一条路（1 秒合并、忙时攒着、按对话分组、夜间静音）；这些不算人的直接输入，建不了目标 |
| 她回 | `qq_send(to: "owner" \| "user:<号>" \| "group:<号>", text, images)`，`<sep/>` 分几条发。**审批**（`sendPolicy: reply`）：发给你永远不问；回最近 30 分钟内给她发过消息的人或群（文字、网图）不问；发给没找过她的人、沉默的群，或者发她手机/电脑上的文件（`phone:*`、`/sdcard/…`、电脑路径）——先弹审批 |
| 她发图 | `images` 里每一项直接作为**图片**发出（不是链接）：网址（NapCat 下载）、`phone:screen`（手机此刻截图）、`phone:latest`（手机里最新的照片/截图/下载）、`/sdcard/…`（手机上的文件）、电脑上的绝对路径；≤10 MB |
| 图片网址规则 | 只接受公网 `http`/`https`、端口 80/443、不带账号密码；回环、私网、链路本地（含 169.254.169.254）、组播、`localhost`/`*.local`/`*.internal`/单段主机名一律拒绝并报错（NapCat 在 VM 里下载，防止她让它访问 VM 内部服务）。公网域名解析到内网（DNS rebinding）这里拦不住 |
| 别人发图给她 | 叫醒文本里是 `[图片 <网址>]`，她想看就打开 |
| dot 的提醒、幕间的主动联系 | 连上后优先走她的 QQ（发给 `owner`），dsh-im 的官方机器人退为后备 |
| 手机上 QQ 的通知 | 连上后自动忽略（否则同一条叫两次）；手机 QQ 照常可以看空间、看群、发图 |
| 她能做什么 | 发文字和图片。加好友、进群、撤回、发文件都没有工具 |

## SnowLuma 后端

[SnowLuma](https://github.com/SnowLuma/SnowLuma) 是另一种 OneBot 11 实现：不自己当 QQ，而是用 ptrace 把钩子注入一个**正在运行的 Linux QQ 图形界面进程**，对外提供 OneBot 11（219 个 action）。dsh 这边（WebSocket、`qq_send`、审批、群打分、转发给你）对两个后端完全一样。

```
/qq backend snowluma   # 切后端，写进 dsh-qq.json
/qq install snowluma   # 在后台装（几分钟，日志 VM 的 /root/snowluma-install.log），不需要先装 NapCat
/qq start              # 停掉 NapCat 和别的 QQ，在 VM 桌面上开 QQ 图形界面，再启动 SnowLuma
/qq qr                 # 码在 QQ 窗口里：读出来重画后放到她手机摄像头前和相册（见上节）；也可以直接打开「虚拟机」标签页扫
```

`/qq install snowluma` 装这些：
- **干净的系统版 Linux QQ** 到 `/opt/QQ`：钉在 SnowLuma 官方安装脚本同一版本 3.2.32_260812，sha256 校验不过就不装。不复用 NapCat 解压的那份（它的启动器被改成加载 NapCat，两个客户端会挤进同一个 QQ）。
- apt 依赖：QQ 图形界面要的库、中文字体、`imagemagick`（截图）、`xz-utils`、`zbar-tools` 和 `qrencode`（扫码登录）。
- **SnowLuma 自己的 Node 24** 到 `/root/snowluma-node`：它的 SQLite 存储要求 Node ≥ 24，而 VM 镜像自带 22。系统 Node 够新就链接过去；否则下载 `latest-v24.x`（先 npmmirror 再 nodejs.org），对 `SHASUMS256.txt` 校验后解压。
- SnowLuma lite 版（按 VM 的 arm64/x64）到 `/root/snowluma`：tag 先从 GitHub release 页的跳转拿（不受 API 限流影响），再试 API 和镜像；`snowlumaVersion` 可以固定。
- 写配置；在 `/etc/hosts` 屏蔽 QQ 热更新（`qqpatch.gtimg.cn`），免得 QQ 一升级钩子就失效。

`installed` 要求三样都在：`/opt/QQ/qq`、`/root/snowluma/index.mjs`、`/root/snowluma-node/bin/node`；少一样就提示再 `/qq install snowluma`。

`/qq start` 做这些（停进程放在单独一次 shell 调用里——`pkill -f` 按整条命令行匹配，和启动写在一起会把启动脚本自己杀掉）：
1. 停掉 SnowLuma、任何 `opt/QQ/qq` 进程，以及 NapCat 的 `xvfb-run` 留下的 Xvfb。
2. `kernel.yama.ptrace_scope` 为 3 就报错退出。
3. 选桌面显示：VNC 服务（Xvnc / Xtigervnc / x11vnc）用的那个（`:99.0` 记作 `:99`），否则任一不带 `-auth` 的 X 服务器，否则 `:99`。不能按 `/tmp/.X11-unix` 里第一个 socket 选：NapCat 的 `xvfb-run` 会留下已经死掉的 socket，QQ 连上去就退出。
4. 在这个显示上开 QQ 图形界面（日志 `/root/snowluma-qq.log`），5 秒后用 `/root/snowluma-node/bin/node` 启动 SnowLuma（日志 `/root/snowluma.log`）。
5. 启动这一步的 shell 偶尔会被报告失败，但两个进程其实都起来了；这时以进程为准，照常继续。

注意：QQ 图形界面会记住登录过的账号（勾了「记住密码」时连密码一起），登录窗出现的可能是**快捷登录**某个旧账号。不要在她电脑的 QQ 上登录你自己的号；万一登上了，上面的「只认她的号」会断开。

- **一个账号一个电脑端**：NapCat 和 SnowLuma 都是这个号的"电脑登录"，不能同时跑。`/qq start` 总会先停掉另一个。
- **需要 ptrace**：`kernel.yama.ptrace_scope` 为 3 时 SnowLuma 注入不了，`/qq start` 会直接报错，请换回 `napcat`。
- **配置**：`config/runtime.json`（WebUI 5099、自动加载钩子）和 `config/onebot.json`（回环 WS 服务器用 `wsPort` + 同一个 OneBot token；回环 HTTP 服务器 3000 给 MCP 用）。文档没说清配置目录是工作目录下的 `config/` 还是 `data/config/`，所以两处都写；`/qq start` 每次都重写，token/端口改动会生效。
- **WebUI**：端口 5099，只在 VM 回环、网关不转发它。每次启动打印的一次性管理员密码在 `/qq log` 里（没改密码时每次重新生成）。
- **早期软件**：SnowLuma 很新，QQ 版本一变钩子可能就失效（所以屏蔽了热更新）。出问题先 `/qq log`，不行就 `/qq backend napcat`。

### 219 个 action（MCP）

`snowlumaMcp: true`（snowluma 后端下默认开）时，WebSocket 连上后挂载 SnowLuma 官方的 MCP 服务器（`npx -y @snowluma/mcp`），工具名 `mcp__dot-qq__*`。它经网关的第二个认证路径 `/dsh-dot/onebot/` → VM 内 `127.0.0.1:3000`（同一个 conf 文件）访问 SnowLuma 的 HTTP API。MCP 只发一个 `Authorization: Bearer`：网关验它、原样透传，SnowLuma 再验同一个头，所以 HTTP 服务器的 accessToken 就是**网关密钥**；WS 仍用 OneBot token。

审批（`qqToolGate`）：

| 调用 | 结果 |
|---|---|
| 文档类（`list_actions`、`search_actions`、`get_action`、`list_categories`、`get_runtime_info`、`query_action*`） | 直接跑 |
| 只读 action（`get_*`、`fetch_*`、`can_*`、`list_*`、`search_*`、`*preview*`、`*_check`、`ocr_image`、`download_file`） | 直接跑 |
| 发消息（`send_private_msg`、`send_group_msg`、`send_msg`、两个 forward） | 和 `qq_send` 同一道 `sendPolicy` 审批；参数里有 `file`/`path` 视为本地文件，问 |
| `send_packet`、`get_cookies`、`get_csrf_token`、`get_rkey`、改资料/头像、删好友、踢人/禁言/设管理/退群、`set_restart`、QQ 空间发/删 | 永远问 |
| 其他所有 action、读不出 action 名的调用 | 问，理由里写 action 名 |

**前提**：SnowLuma 从工作目录读 `config/`，我们在 `/root/snowluma` 里启动它。它的 MCP（`@snowluma/mcp`）在**宿主机**（你的电脑，不是 VM）上用 `npx -y` 跑，SnowLuma 的说明要求宿主有 `npx` 且 Node ≥ 24.22；不满足时插件不会单独报错，只是 `mcp__dot-qq__*` 不出现，收发消息照常（`/qq` 里看 `mcp: mounted / not mounted`）。

## 配置

| 配置项 | 默认 | 作用 |
|---|---|---|
| `backend` | `napcat` | `napcat` / `snowluma`；`/qq backend <名>` 可改 |
| `snowlumaVersion` | 无 | 固定 SnowLuma 的 release tag；空 = latest |
| `snowlumaMcp` | `true` | snowluma 后端下挂载 SnowLuma 的 MCP（`mcp__dot-qq__*`） |
| `qq` / `DSH_DOT_QQ_ACCOUNT` | 无 | 账号；`/qq account` 也写进 `dsh-qq.json` |
| `owner` | 无 | 你的 QQ 号；`/qq owner <号>` 设置。只有它的私聊算你本人的话 |
| `wsPort` | `3001` | VM 内的 OneBot WS 端口（只听回环）。dsh 经网关的**认证**路径连它：插件在 VM 的 `/opt/gem/nginx/dsh-dot-napcat.conf` 放一个 `location /dsh-dot/napcat/`，网关先验密钥再转进来 |
| 校验 | 账号和 `owner` 必须是 5–12 位数字，`wsPort` 必须是 1–65535 的整数（它们会拼进 VM 里的 root shell 命令）；`/qq account`、`/qq owner` 输错直接报错，`dsh-qq.json` 里的非法值按未设置处理并警告 |
| `groupPolicy` | `mention` | 群消息：`mention`（@她）/ `all` / `none` / `score`。`/qq group <值>` 可改。`score`：没 @ 她的群消息先用一次很短的模型调用打 0–10 分（和她相关、问到她、她明显有话说才高分），到 `scoreThreshold`（默认 7）才叫醒她，@ 永远算；每群每分钟最多 `scoreMaxPerMinute`（6）次打分；`scoreModel`（"provider/model"）可指定便宜模型，默认用当前模型。这就是"价值评分插话" |
| `tidy` | `true` | 发出去的文字按她的聊天口吻整理：去掉行末句号、引号、破折号、冒号、星号、井号（网址和时间不动）。关掉就原样发 |
| `sendPolicy` | `reply` | `qq_send` 审批：`reply`（见上表）/ `always`（除了你，发谁都问）/ `off`（不问） |
| `replyWindowMinutes` | `30` | `reply` 策略里"最近给她发过消息"的时间窗 |
| `githubProxy` / `DSH_DOT_GITHUB_PROXY` | 无 | 安装脚本下载 GitHub 资源的镜像前缀 |
| `autoStart` | `true` | 电脑就绪后自动启动 |
| `DSH_DOT_QQ=off` | | 不加载；电脑关了它也不加载 |

## 风险

- 协议端个人号有被腾讯风控的可能（随机验证、封号）。**用小号**，低频。
- NapCat 2025-09 那次事故是公网弱口令被扫。这里 WebUI 和 OneBot 都只在 VM 的 loopback，token 随机，外面没有端口；dsh 进来要过网关密钥。
- 她电脑上的 QQ（SnowLuma 用的图形界面）会记住登录过的账号和密码。别在那里登你自己的号。
- 这是她的"电脑端 QQ"，和手机同号同时在线；手机那边不要退出登录。

## 已知限制

- 收发文字和图片；语音、视频进来显示为 `[语音]` `[视频]`。
- 第一次安装要 VM 能访问 GitHub 和腾讯的下载地址；GitHub 不通时配 `githubProxy`。
- VM 重建（换镜像）会丢 NapCat / SnowLuma 和登录态，`/qq install`（或 `/qq install snowluma`）重来。
- 扫码登录要她的手机（摄像头）；手机组件没开或没就绪时，`/qq qr` 只把图存到 `~/.dsh/phone/`。
