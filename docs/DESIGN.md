# 设计记录

本文件记录 dsh-computer 的现状、已做的决定和后续常驻 agent（暂名 dot）的设计约束。后续开发以这里为准；做重了就回到 `v0.4.0` 基线。

## 1. 目标

做 Dots / Grok Bot 这类常驻 agent：**一个有自己电脑、随时找得到、会主动做事、可以放心不管的 agent**，以 DeepSeek Harness（dsh）插件的形式提供，装上即用。

北极星场景：在微信里说一句“每天早上帮我看看 X 有没有更新，有就告诉我”。它在自己的电脑上浏览，每天把结果推到微信；遇到要登录的页面，发实时画面链接让人接管；全程有花费上限和操作记录。

## 2. 六层拆分与现状

| 层 | 回答的问题 | 状态 |
|---|---|---|
| 1. 自己的电脑 | 它在哪里干活 | ✅ dsh-computer v0.4.0 |
| 2. 一直在线 | 人不在时它还在不在 | ✅ 官方桌面版关窗口后继续运行（0.2.0-rc.2 起）；服务器用后台服务 |
| 3. 随时找得到 | 人怎么联系它、它怎么找人 | 🟡 现成 IM 插件，未验证 |
| 4. 会主动做事 | 没人说话时它会不会动 | 🟡 社区已有多个心跳插件，都不成熟 |
| 5. 记得你 | 跨会话的长期记忆 | ⚪ 第一版不做，用一个可编辑的 `DOT.md` 代替 |
| 6. 放心不管 | 无人值守时会不会乱花钱、乱操作 | 🔴 社区空白，这是差异化所在 |

## 3. 设计原则

1. **做集成，不重造。** 每层先找现成组件，只写缺的部分。不做新的 harness、IM 桥接或又一个心跳插件。
2. **每层一个独立插件，接口清晰。** 单独装也能用；组合包负责一键装齐。
3. **本机和服务器同一套。** 区别只在部署的机器。
4. **安全靠结构，不靠提示词。** 隔离靠虚拟机；危险操作走审批；花钱有硬上限；操作留审计记录。
5. **先跑通北极星场景，再加智能。** 自我进化、价值网络、多步自主循环都不做。
6. **每加一个功能都问：它是否服务于北极星场景。** 不是就往后放。

## 4. dsh-computer v0.4.0（已完成的基线）

### 架构

- `src/vm.js`：虚拟机生命周期。服务在启动时立即提供，`ready` 在虚拟机可用后完成；dsh 退出时不停虚拟机。
- `src/backends/microsandbox.js`：默认后端。用 npm 依赖自带的 `msb`（libkrun 微型虚拟机；Mac 用 Hypervisor.framework，Windows 用 WHP，Linux 用 KVM）。`create` 不运行镜像入口，所以服务用 `msb exec -d /opt/gem/run.sh` 启动。
- `src/backends/docker.js`：Intel Mac 的后备。
- `src/subprocess.js`：替换 dsh 的 `ctx.subprocess`，所有命令在虚拟机里执行；`spawn` 保持同步，虚拟机未就绪或换绑中时用等待前缀排队。
- `src/gate.js`：`tools/pre-execute` 审批闸门（危险命令、敏感浏览器动作），审批信息附实时画面链接。
- `cordis.patch.yml`：禁用本机 subprocess、`danger-full-access`（虚拟机即隔离边界）、Computer 权限预设、接入虚拟机里的 MCP（`mcp__vm__browser_*`）、界面行。
- `lib/client.js`（源码在 `ui/`）：右侧栏“虚拟机”标签页（noVNC 内嵌）和会话顶部的显示器按钮。

### 已验证（Mac 桌面版 0.2.0-rc.2，Apple 芯片）

- bash 在虚拟机里执行（gem / Ubuntu 22.04）；浏览器工具可用；`sudo` 弹审批，拒绝后不执行。
- 工作区自动共享进虚拟机，路径不变；共享新文件夹（停机 → 快照 → 带新挂载恢复）约 5–20 秒，期间命令排队。
- 换绑后虚拟机里的文件和浏览器 Cookie 保留；重启 dsh 约 1.3 秒重新连上。
- 隐藏目录、`~/Library`、家目录本身不会被共享；启动时会撤掉不允许的挂载。
- 界面按钮和标签页可用，嵌入的桌面可点击操作。

### 已知限制

- 快照是链式的，不能删旧快照；每次换绑多占约 15–20MB。
- 界面固定连 18080 端口（客户端插件拿不到 Loader 配置）。
- Docker 后端不支持自动共享新文件夹。
- 端口没有鉴权，只监听 127.0.0.1。
- Windows 只验证到虚拟化检测。

### 踩过的坑（别再踩）

- `pgrep -f` 会匹配到自己的 shell，用 `pgrep -x`。
- `msb exec` 默认转发 stdin，探测命令要 `--no-stdin </dev/null`。
- `msb restore` 不要加 `--disk-only`（那是给完整快照用的）；快照引用用 ID（`snap_…`）；要去掉旧挂载必须加 `--allow-missing-resources`。
- 先确认快照可以 `snapshot inspect`，再删旧虚拟机；虚拟机丢失时从最新快照恢复。
- 部署到 Mac 时每次用新的暂存路径，并核对文件大小，否则可能写入旧内容。

## 5. 调研结论（2026-10）

- **dsh 官方已有**：`dsh-schedule`（实验性定时任务）、`dsh-webhook`（外部事件开新会话）、桌面版关窗口后台运行（Windows 托盘；Mac 留在程序坞，无菜单栏图标、无开机自启）。
- **IM 插件**：dsh-bridge（微信 iLink / QQ / 飞书 / Telegram，带手机网页界面和白名单）、dsh-channels（微信扫码、QQ 官方机器人、钉钉、飞书、Telegram）。微信个人号走腾讯官方 ClawBot / iLink 接口。
- **心跳类插件**：fatatalia/dsh-heartbeat（HEARTBEAT.md + HEARTBEAT_OK 静默 + 免打扰）、Kanadego/dsh-heartbeat（代码层闸门）、ljsysfurryACE/dsh-aura-scheduler（不调模型的打分预检查）、LittleBlackTong/dsh-plugin-heartbeat、beijingwahw/dsh-proactive、houzch/dsh-plugin-agentheart。star 都在 0–13；都没有真实花费上限，几乎都不推 IM，都不和虚拟机联动。

## 6. dot 的范围（下一步）

**只写这些：**

- **主动模块**：心跳 + 不调模型的预检查（清单到期、关注页面哈希变化），有事才唤醒模型；没事静默；免打扰时段；固定投递到一个 dot 主会话。借鉴 fatatalia 的清单和静默、aura 的预检查。
- **约束模块**：每日 token / 金额上限、审计日志，超限暂停并通知。
- **推送联动**：主动模块的结果和审批请求推到 IM，附实时画面链接（现成 IM 插件能做就不写）。
- **组合包与部署**：一条命令装齐；服务器用 systemd + `dsh web --no-open`，Tailscale 访问。

**明确不做（第一版）：** 长期记忆系统、多个 dot、自我进化、在虚拟机里登录 IM 客户端靠截屏收消息、自己的托盘程序。

**待定：** IM 先接微信还是 QQ。

## 7. 可选的上游贡献

给官方桌面版提 PR：Mac 菜单栏图标（复用 `apps/desktop/src/tray.ts`）、开机自启开关（`setLoginItemSettings`）。目前没找到相关 issue / PR。
