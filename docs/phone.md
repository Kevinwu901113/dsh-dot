# dsh-dot/phone · 她的手机

An Android phone the plugin installs and runs for the character, exposed to the model as `mcp__phone__*`. No Android Studio, no Java: the plugin fetches three archives from Google's repository, writes the AVD itself, boots the emulator and mounts [mobile-mcp](https://github.com/mobile-next/mobile-mcp) over adb.

## 它做什么

1. **安装**（第一次）：接受 [Android SDK 许可](https://developer.android.com/studio/terms)后（`/phone accept`，或配置 `acceptLicense: true`，或 `~/.dsh/dsh-phone.json` 里 `{"acceptLicense": true}`），从 `dl.google.com/android/repository` 读索引，下载 stable 通道的 emulator、platform-tools 和 `system-images;android-<api>;google_apis;<abi>`（约 1.7 GB），解压到 `~/.dsh/phone/`。`google_apis` 镜像没有 Play 商店——检测面最小，App 用 APK 装。
2. **AVD**：`~/.dsh/phone/avd/dot.avd/config.ini` 由插件写（Pixel 6 尺寸、1080×2400、3 GB 内存、8 GB 数据分区、不带 Play）。想改尺寸或内存，改配置后删掉这个目录重建。
3. **开机**：`emulator -avd dot -port 5554 -no-boot-anim -gpu auto`，等 `sys.boot_completed`，然后常亮屏幕、关动画、解锁。上一次 dsh 留下的还在跑的模拟器会被直接接管，不会开两个。模拟器自己退出会在 `restartDelayMs` 后重开。
4. **MCP**：开机后以 stdio 挂一个 mobile-mcp（随插件一起安装，`ANDROID_HOME` 指向 `~/.dsh/phone`，`ANDROID_SERIAL=emulator-5554`），工具名 `mcp__phone__mobile_*`：列设备、截图、列屏幕元素（带坐标）、点、滑、长按、输入、按键、打开/关闭 App、装卸 App、开 URL。
5. **提示**：手机就绪后系统提示里多一段 `phone:device`，告诉模型设备号和用法（先看元素再点；验证码、人脸停下来叫用户）。
6. **闸门**：`mobile_install_app` / `mobile_uninstall_app` 弹审批；`mobile_type_keys` 的内容像密码 / 支付 / 验证码时弹审批（`sensitivePatterns`）。幕间的观察轮只放行只读工具（看、滑、点进去、开 App、返回），其余直接拒绝、不审批。
7. **实时画面**：模拟器窗口本身（`window: true`）。无头跑（服务器）时 `window: false`，用 `/phone screenshot` 或让她截图。

## 配置

| 配置项 | 默认 | 作用 |
|---|---|---|
| `home` | `~/.dsh/phone` | SDK 三件套和 AVD 所在 |
| `api` / `tag` / `abi` | `35` / `google_apis` / 跟随宿主 CPU | 系统镜像；Apple silicon 用 `arm64-v8a`，x86 用 `x86_64` |
| `avd` / `device` | `dot` / `pixel_6` | AVD 名和机型 |
| `ramMb` / `dataGb` | `3072` / `8` | 内存、数据分区 |
| `port` | `5554` | 控制台端口；adb 序列号 `emulator-<port>` |
| `window` / `DSH_DOT_PHONE_WINDOW=off` | `true` | 显示模拟器窗口 |
| `gpu` | `auto` | 模拟器 `-gpu` |
| `acceptLicense` / `DSH_DOT_PHONE_ACCEPT_LICENSE=yes` | `false` | SDK 许可 |
| `channel` | `stable` | 模拟器通道 |
| `bootTimeoutMs` / `restartDelayMs` | `300000` / `10000` | 开机等待、崩溃重开间隔 |
| `mcp` / `toolCallTimeoutMs` | `true` / `60000` | 挂 mobile-mcp |
| `askTools` / `sensitivePatterns` | 装卸 App / 密码支付验证码 | 审批规则 |
| `DSH_DOT_PHONE=off` | | 整个组件不加载 |

桌面版没有 shell 环境变量时，用 `~/.dsh/dsh-phone.json` 写同名字段。

## 装 App 和登录

- 从各家官网下载 APK（QQ、微信、小黑盒、B 站都有 arm64 包），`~/.dsh/phone/platform-tools/adb install xxx.apk`；或者把 APK 放到她能看到的地方让她 `mobile_install_app`（会弹审批）。
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

- 第一次下载约 2 GB，取决于到 `dl.google.com` 的速度。
- 没有 Play 商店和 Google 服务；需要 GMS 的 App 不能用。
- 模拟器检测：部分 App 会限制功能或拒绝登录。退路是一台真安卓机接 adb——`ANDROID_SERIAL` 换成真机序列号即可，组件其余不变（待做：`serial` 配置项）。
- mobile-mcp 的工具每次调用都要带 `device`，模型偶尔会忘；提示段里给了设备号。
- 多台手机未做。
