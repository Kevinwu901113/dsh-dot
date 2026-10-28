# dsh-dot/qq · 她电脑上的 QQ

Her QQ on her computer: [NapCat](https://github.com/NapNeko/NapCatQQ) — a headless QQNT client speaking OneBot 11 — runs inside the computer VM, logged into **the same account as the QQ app on her phone** (QQ allows a phone and a computer at once). Messages arrive as events the moment they are sent, and she answers in a second with `qq_send`. The phone app stays for everything else.

## 为什么

手机 App 收消息靠通知栏：要 App 活着、要系统不冻结、要通知没被 App 自己撤回。我们把这些都修到了 2–4 秒，但它仍是"观察手机"，不是"收到消息"。协议端是"收到消息"：每条都有事件，群消息完整，发送即达。

## 怎么接

- NapCat 装在**她的电脑**（dsh-dot/computer 的 VM）里，以 root 身份 rootless 安装到 `/root/Napcat`，`xvfb-run -a qq --no-sandbox -q <账号>` 后台运行。
- dsh 连它的 OneBot WebSocket **不开新端口**：VM 的网关（AIO sandbox 的 nginx）把 `Host: 3001-xxx` 的请求转到 VM 内 `127.0.0.1:3001`，WebSocket 也行。所以 dsh 连的是 `ws://127.0.0.1:18080/` + `Host: 3001-napcat` + `Authorization: Bearer <token>`，外面什么都看不到。
- token 第一次生成后存在 `~/.dsh/dsh-qq.json`。

## 第一次

```
/qq install            # 在她的电脑里装 NapCat（apt 依赖 + linuxqq + NapCat.Shell，几分钟；日志在 VM 的 /root/napcat-install.log）
/qq account 123456789  # 她的小号
/qq start              # 写 OneBot 配置、启动 NapCat、开始连
/qq qr                 # 把登录二维码放到她手机的摄像头前（模拟器虚拟场景的海报），也存到 ~/.dsh/phone/ 和相册
```

然后在「手机」标签页里：打开 QQ → 右上角 + → 扫一扫，**摄像头画面里就是这张码**（QQ 的登录码不接受相册导入，只认摄像头；她手机的后置摄像头是模拟器的虚拟场景，`/qq qr` 把码贴在场景的墙上）→ 在手机上确认"电脑登录"。这就是真实的 QQ 多端登录流程——她的手机授权她的电脑。登录态保存在 VM 里，以后 `/qq start` 用账号快速登录，不用再扫。码约一分钟过期，过期就再 `/qq qr`。如果摄像头里只有房间没有码：这部手机是在摄像头加进来之前建的，`/phone restart` 一次即可（配置已自动改好）。

`/qq` 看状态，`/qq log` 看 NapCat 日志，`/qq stop` 停，`/qq owner <号>` 指定"你"——必须手动指定，不会从谁先私聊自动学。

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

## 配置

| 配置项 | 默认 | 作用 |
|---|---|---|
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
- NapCat 2025-09 那次事故是公网弱口令被扫。这里 WebUI 和 OneBot 都只在 VM 的 loopback，token 随机，外面没有端口。
- 这是她的"电脑端 QQ"，和手机同号同时在线；手机那边不要退出登录。

## 已知限制

- 收发文字和图片；语音、视频进来显示为 `[语音]` `[视频]`。
- 第一次安装要 VM 能访问 GitHub 和腾讯的下载地址；GitHub 不通时配 `githubProxy`。
- VM 重建（换镜像）会丢 NapCat 和登录态，`/qq install` 重来。
