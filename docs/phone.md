# dsh-dot/phone · 她的手机

An Android phone the plugin installs and runs for the character, exposed to the model as `mcp__phone__*`. No Android Studio, no Java: the plugin fetches three archives from Google's repository, writes the AVD itself, boots the emulator and mounts [mobile-mcp](https://github.com/mobile-next/mobile-mcp) over adb.

## 它做什么

1. **安装**（第一次）：接受 [Android SDK 许可](https://developer.android.com/studio/terms)后（`/phone accept`，或配置 `acceptLicense: true`，或 `~/.dsh/dsh-phone.json` 里 `{"acceptLicense": true}`），从 `dl.google.com/android/repository` 读索引，下载 stable 通道的 emulator、platform-tools 和 `system-images;android-<api>;google_apis;<abi>`（约 1.7 GB），解压到 `~/.dsh/phone/`。`google_apis` 镜像没有 Play 商店——检测面最小，App 用 APK 装。
2. **AVD**：`~/.dsh/phone/avd/dot.avd/config.ini` 由插件写（Pixel 6 尺寸、1080×2400、3 GB 内存、8 GB 数据分区、不带 Play）。想改尺寸或内存，改配置后删掉这个目录重建。
3. **开机**：`emulator -avd dot -port 5554 -no-boot-anim -gpu auto`，等 `sys.boot_completed`，然后常亮屏幕、关动画、解锁。上一次 dsh 留下的还在跑的模拟器会被直接接管，不会开两个。模拟器自己退出会在 `restartDelayMs` 后重开。
4. **MCP**：开机后以 stdio 挂一个 mobile-mcp（随插件一起安装，`ANDROID_HOME` 指向 `~/.dsh/phone`，`ANDROID_SERIAL=emulator-5554`），工具名 `mcp__phone__mobile_*`：列设备、截图、列屏幕元素（带坐标）、点、滑、长按、输入、按键、打开/关闭 App、装卸 App、开 URL。
5. **提示**：手机就绪后系统提示里多一段 `phone:device`，告诉模型设备号和用法（先看元素再点；验证码、人脸停下来叫用户）。
6. **闸门**：`mobile_install_app` / `mobile_uninstall_app` 弹审批；`mobile_type_keys` 的内容像密码 / 支付 / 验证码时弹审批（`sensitivePatterns`）。幕间的观察轮只放行只读工具（看、滑、点进去、开 App、返回），其余直接拒绝、不审批。
7. **通知叫醒她**：插件盯着系统的事件日志（`adb logcat -b events notification_enqueue`），每有 App 发通知就立刻读一次通知栏（`dumpsys notification`），另外每 `notifyPollMs` 兜底轮询一次——QQ 这类 App 在聊天窗口开着时会立刻撤回通知，光靠轮询会漏，新出现的通知（启动时已经在栏里的不算；系统包不算；`notifyApps` 可以只挑几个 App）交给 dot，dot 往她最近的会话里追加一条 `[手机通知] QQ · 宽：……`，她自己决定去 App 里回还是只回 `DOT_SILENT`。这条回复不会转发到任何 IM。所以她不需要定闹钟去看 QQ——有人找她，手机会响。**任何 App 都算**，包括她以后自己装的：新 App 默认叫醒；像手机自己的通知设置一样可以按 App 静音——`/phone notify mute <包名>` / `wake <包名>`（持久化在 `dsh-phone.json`），`/phone notify` 看每个 App 发过多少条和当前策略。她在 Android 设置里关掉某个 App 的通知也一样生效（通知栏里没有就不会叫）。几秒内连来的多条合成一次叫醒（dot 的 `notifyBatchMs`）；dot 的 `notifyHours` 可以设"手机夜里静音"。`/phone notifications` 看最近 20 条。
8. **实时画面**：两种。一是模拟器窗口本身（`window: true`）；二是插件自己的网页 `http://127.0.0.1:18090/`（`liveViewPort`）——dsh 右侧栏多一个「手机」标签页就是它：屏幕每秒刷新几次（PNG 流），能直接点、滑、按返回/主页、输入文字，登录 App 就在这里做。配 `publicUrl`（如 `tailscale serve`）后审批提醒里带这个链接，手机上也能看。无头跑（服务器）时 `window: false` 只用网页。网页里的文字输入走 `adb shell input text`，只支持 ASCII（账号、验证码够用）；中文由她自己的工具输。

## 配置

| 配置项 | 默认 | 作用 |
|---|---|---|
| `home` | `~/.dsh/phone` | SDK 三件套和 AVD 所在 |
| `api` / `tag` / `abi` | `35` / `google_apis` / 跟随宿主 CPU | 系统镜像；Apple silicon 用 `arm64-v8a`，x86 用 `x86_64` |
| `avd` / `device` | `dot` / `pixel_6` | AVD 名和机型 |
| `ramMb` / `dataGb` | `3072` / `8` | 内存、数据分区 |
| `port` | `5554` | 控制台端口；adb 序列号 `emulator-<port>` |
| `window` / `DSH_DOT_PHONE_WINDOW=off` | `true` | 显示模拟器窗口 |
| `liveViewPort` | `18090` | 实时画面网页端口；`0` 关闭 |
| `publicUrl` | 无 | 从外面访问实时画面的地址，写进审批提醒 |
| `gpu` | `auto` | 模拟器 `-gpu` |
| `locale` / `timezone` | `zh-CN` / `Asia/Shanghai` | 手机的语言和时区 |
| `installers` | 浏览器、文件管理器 | 开机时被允许安装未知应用的包；`[]` 则她得自己去设置里开 |
| `acceptLicense` / `DSH_DOT_PHONE_ACCEPT_LICENSE=yes` | `false` | SDK 许可 |
| `channel` | `stable` | 模拟器通道 |
| `bootTimeoutMs` / `restartDelayMs` | `300000` / `10000` | 开机等待、崩溃重开间隔 |
| `notifyPollMs` / `notifyApps` / `notifyMuted` | `4000` / `[]` / `[]` | 通知轮询间隔（`0` 关闭）；只关心哪些包（空 = 所有非系统 App，含以后装的）；静音的包（`/phone notify mute` 也写这里） |
| `mcp` / `toolCallTimeoutMs` | `true` / `60000` | 挂 mobile-mcp |
| `askTools` / `sensitivePatterns` | 装卸 App / 密码支付验证码 | 审批规则 |
| `DSH_DOT_PHONE=off` | | 整个组件不加载 |

桌面版没有 shell 环境变量时，用 `~/.dsh/dsh-phone.json` 写同名字段。

## 装 App 和登录

- **她自己装。** 手机没有应用商店，和一个人拿到新手机一样：她用手机上的浏览器打开官网，下载安装包，点开安装。插件开机时已允许浏览器和文件管理器安装未知应用（`installers`），所以不用进设置。这是故意的——养一个会自己折腾手机的角色，而不是替她把一切装好。`adb install` 当然也能用，但那是你的事，不是她的。
- 在模拟器窗口里亲手登录。验证码、人脸、短信验证都由你过；她遇到会停下来告诉你。
- **用小号**：各平台条款都不允许自动化，模拟器也可能被检测。登录态在 AVD 里，重启不丢；`~/.dsh/phone/avd/` 整个目录就是这部手机，可以备份。

## 平台

| | 可用 | 备注 |
|---|---|---|
| macOS Apple silicon | ✅ | arm64 镜像原生速度；第一次启动系统会问是否允许模拟器用虚拟化 |
| macOS Intel | ✅ | x86_64 镜像，依赖 Hypervisor.framework |
| Linux x86_64 | ✅ | 需要 KVM（`/dev/kvm` 可写）；无头跑用 `window: false` |
| Linux arm64 | ❌ | Google 不发 Linux arm64 模拟器 |
| Windows x64 | ✅ | 需要 WHPX 或 Hyper-V；解压用 PowerShell |
| 另一台 Linux 虚拟机里 | ❌ | 嵌套虚拟化。手机和电脑是两台设备，不是一台装另一台 |

## 已知限制

- App 开在前台时不会发通知（QQ 的聊天窗口开着就收不到那个人的消息通知）。提示里让她用完 App 按 HOME 回桌面。

- 第一次下载约 2 GB，取决于到 `dl.google.com` 的速度。
- 没有 Play 商店和 Google 服务；需要 GMS 的 App 不能用。
- 模拟器检测：部分 App 会限制功能或拒绝登录。退路是一台真安卓机接 adb——`ANDROID_SERIAL` 换成真机序列号即可，组件其余不变（待做：`serial` 配置项）。
- mobile-mcp 的工具每次调用都要带 `device`，模型偶尔会忘；提示段里给了设备号。
- 多台手机未做。
