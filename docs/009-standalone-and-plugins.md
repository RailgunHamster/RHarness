# 009 Standalone Deployment & Plugin Guide (独立部署与全套插件指南)

本文档面向希望在自己的电脑、内网服务器或云主机上独立部署 `RHarness`（`dsh-superagent`）的用户，详细介绍单机与多机集群部署、多提供商模型配置、内置通用插件矩阵、手机端 PWA 接入，以及如何通过外部私有扩展包（`~/.rharness/private-pack`）挂载你自己的私有工具而绝不污染源码仓库。

相关架构设计请先阅读 [000 Philosophy](000-philosophy.md)、[005 Panel](005-panel.md)、[006 Deployment](006-deployment.md) 与 [008 Cookbook](008-cookbook.md)。

---

## 1. 环境准备与快速启动

### 1.1 运行环境要求

- **Node.js**：`22.19+` 或 `24+`（使用内置 `node:sqlite`，无需安装外部数据库）
- **包管理器**：`pnpm 10+`
- **Git**：`2.32+`（用于工单独立 `git worktree` 分支隔离与跨节点合入）
- **可选模型运行时（按需任选其一或多个）**：
  - `@deepseek-ai/dsh`（DeepSeek Harness 本地 Profile）
  - OpenAI `codex` CLI（`codex app-server`）
  - Anthropic `claude` CLI
  - `cursor` Agent CLI
  - `human`（无需任何模型 API，直接通过面板 Session Console 人工扮演评估或执行角色）

### 1.2 三步本地启动

```sh
git clone <your-repo-url> RHarness
cd RHarness
pnpm install
pnpm build
pnpm start
```

- 默认启动后台守护进程并监听 `http://127.0.0.1:4318`（所有状态持久化在 `.rharness-dev/superagent/orchestrator.sqlite`）。
- 常用启动参数与环境变量：
  - `--port <number>` 或 `DSH_SUPERAGENT_PORT=4318`：自定义 HTTP 端口。
  - `--host 0.0.0.0` 或 `DSH_SUPERAGENT_HOST=0.0.0.0`：允许局域网或 Tailscale 内网设备访问。
  - `--state-dir <path>` 或 `DSH_SUPERAGENT_STATE_DIR=/path/to/state`：指定独立的 SQLite 与会话状态目录。
  - `pnpm stop`：优雅停止后台常驻进程。

---

## 2. 生产环境常驻守护（Windows / Linux）

### 2.1 Linux (`systemd` 服务)

创建 `/etc/systemd/system/rharness.service`（建议绑定到 `127.0.0.1` 或你的 Tailscale 私网 IP，避免直接裸露公网）：

```ini
[Unit]
Description=RHarness Standalone Agent Workbench
After=network-online.target tailscaled.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/RHarness
Environment="DSH_SUPERAGENT_HOST=0.0.0.0"
Environment="DSH_SUPERAGENT_PORT=4318"
ExecStart=/usr/bin/node /opt/RHarness/lib/standalone.js --host 0.0.0.0 --port 4318
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> 说明：若 `--host` 绑定特定虚拟网卡（如 Tailscale IP），设置 `StartLimitIntervalSec=0` 可确保机器重启瞬间即使虚拟网卡尚未分配好 IP，`systemd` 也会每 5 秒持续重试直到网卡就绪，绝不触发 `start-limit-hit` 放弃启动。

启用并启动：

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now rharness.service
```

### 2.2 Windows（开机自启 + 双重看门狗常驻计划任务）

切勿长期依赖在 IDE 终端（如 Cursor / VS Code 内置终端）里手动跑子进程，因为终端关闭或 Windows Job Object 内存回收时会连带强杀子进程。生产或主力机推荐注册系统级计划任务 **`RHarnessGateway`**：

- **服务器 / 管理员权限（推荐 `S4U` Session 0 零窗口开机自启 + 15 分钟周期巡检兜底）**：

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
  -Argument "D:\RHarness\lib\standalone.js --supervisor --host 0.0.0.0 --port 4318" `
  -WorkingDirectory "D:\RHarness"
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerWatch = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "RHarnessGateway" -Action $action -Principal $principal `
  -Trigger @($triggerBoot, $triggerWatch) -Settings $settings -Force
Start-ScheduledTask -TaskName "RHarnessGateway"
```

- **个人桌面电脑 / 普通用户权限（登录自启 + `wscript.exe` 零黑框闪烁包装）**：
  若未使用管理员 `S4U`（即 `InteractiveToken` 模式），直接启动 `node.exe` 会在登录桌面时弹出控制台黑框；可用两行 VBS 交由 `wscript.exe`（Windows GUI 子系统）静默托管 `--supervisor`，既彻底消除黑框，又保持任务计划程序准确追踪 `Running` 状态。

### 2.3 节点崩溃四层自愈体系与排障速查

`RHarness` 内置从内到外的 4 层故障恢复能力：

1. **进程内防崩护栏（`[CRASH-GUARD]`）**：自动捕获未处理的异步异常（`unhandledRejection`）及远端断流/重置等瞬态 Socket 异常（`ECONNRESET` / `EPIPE` / `ETIMEDOUT`），只记录日志而不中断 HTTP 服务。
2. **父子进程秒级看门狗与死锁自清（`--supervisor` + `recoverStaleStateLock`）**：
   - `--supervisor`（以及 `pnpm start` / `--daemon`）以零业务负载父进程监控工作子进程；一旦子进程异常退出（如 OOM 强杀），看门狗会在 **2 秒内**（连续崩溃时指数退避至最高 30 秒）自动核对死 PID、清理残留的 `<stateDir>.lock` 目录并重新拉起新进程，彻底杜绝崩溃后报 `ELOCKED` 无法重启。
   - 所有看门狗与子进程输出统一写入 **`<stateDir>/standalone.log`**（单文件超过 10 MB 自动轮转归档为 `standalone.log.1`）。
3. **操作系统级守护与巡检兜底**：Linux `systemd`（`Restart=always`）与 Windows 计划任务（开机触发 + 15 分钟 `IgnoreNew` 巡检触发）确保即使看门狗父进程本身被人为结束，系统也会自动重新拉起。
4. **数据库与执行中工单断点续跑（SQLite WAL + `assignmentInterrupted`）**：
   - 状态库 `orchestrator.sqlite` 全程运行在 WAL 事务模式；
   - 若崩溃瞬间有工程 `Ticket` 正在执行，重启后 `DshExecutor` 会自动触发 `assignmentInterrupted` 恢复流程，保留独立 Worktree 已有改动并重新投递未读消息继续推进。

常用排障与手动重启命令：

```powershell
# 查看最新运行与自愈日志
Get-Content .rharness-dev\superagent\standalone.log -Tail 50

# Windows 手动重启常驻节点
Stop-ScheduledTask -TaskName "RHarnessGateway"; Start-ScheduledTask -TaskName "RHarnessGateway"
```

---

## 3. 手机端访问与全屏 PWA 安装

`RHarness` 内置了完整的移动端竖屏适配、Web App Manifest（`/manifest.webmanifest`）与原生 Tailscale HTTPS 监听：

1. **配置免端口 HTTPS（基于 Tailscale）**：
   在常驻节点生成你的 Tailscale 域名证书：
   ```sh
   tailscale cert <your-node>.<your-tailnet>.ts.net
   ```
   将生成的 `.crt` 和 `.key` 放入 `<stateDir>/tls/`（或 `~/.rharness/tls/`）。重启 `RHarness` 后，服务会自动同时监听 `:443`（免输端口号）与 `:8443` HTTPS。
2. **安装到手机主屏幕**：
   - **iOS (Safari)**：打开 `https://<your-node>.<your-tailnet>.ts.net` → 点击底部分享图标 → **「添加到主屏幕」**。
   - **Android (Chrome / Edge)**：打开上述 HTTPS 地址 → 右上角菜单 → **「安装应用」**。

---

## 4. 内置通用一等公民插件矩阵

打开顶部导航栏的 **「🧩 插件中心」**，所有内置插件均支持**实时热插拔启停**，且每个插件都提供独立的 **「🎛 状态与设置」** 面板。长期记忆库与思源双实例知识库已拆到独立的 **「记忆与知识库」** 标签栏下（内含「🧠 长期记忆库」与「📚 思源知识库」两个子视图）。顶栏采用可扩展的**标签栏分组**机制：多个 UI 视图只要注册同一个标签栏名字（`tabBarId`），就会合并为一个顶栏入口并在栏内按注册顺序自行分配位置，避免标签页无限膨胀：

| 插件 ID | 分类 | 默认状态 | 核心能力说明 |
| --- | --- | --- | --- |
| `dsh-claw-assistant` | 个人助理 / UI | 启用 | 顶栏「个人助理」独立对话窗；支持图文问答、交互式提问卡，并在需要改代码/查机器时携**一字不改的用户原话**单向递交至工程引擎 |
| `dsh-assistant-persona` | 个人助理 / UI | 启用 | **仅挂载个人助理**的人设·表情·自学习与环境感知：人设预设与风格旋钮、颜文字库、用户上传表情包图库（`~/.rharness/stickers/`，Web 预览/增删 + 助理工具增删 + 飞书真实图片；支持多选与**整文件夹递归扫描上传**——按文件名命名、子文件夹名作标签、重复/超限/非图片自动跳过，PNG/JPG/WebP/GIF 原图直存、动图不转码；删除先进 **1 天回收站**可恢复，过期自动彻底删文件）、自动生效可审计的相处默契学习、农历/节气/工作日节律、**常驻地址**（可存多个：每条 = 称呼 + 详细地址原文 + 解析出的所在城市，主要地址的城市作天气基准，详细地址会注入助理背景上下文；Open-Meteo 零 Key）、**高德导航**（可选 Web 服务 Key：名称类目的地走 POI 关键字搜索并按匹配度评分、门牌类地址校验地理编码 level、多候选歧义时停下让用户确认而非默默用第一个点、支持粘贴经纬度坐标直存、同标签重存地址视为替换；驾车实时路况时长/公交步行路线规划，未配置 Key 时自动降级为高德/百度导航深链接，助理 `navigation_route` 与 UI 查询面板共用同一编排）与新闻热点。**个人数据（常驻地址/人设/学习/高德 Key）以设备组中带「数据中心」标签的唯一节点为权威源（专用标签认定，不按机器名/角色标签，一组仅允许一台，可通过 `device-group/retag` 在线迁移）**：数据中心本地落库并向各节点广播，其它节点只做本地缓存、变更上推数据中心、启动与每 15 分钟拉取对账，离线编辑恢复后按 id/更新时间合并回推（删除以墓碑同步），无数据中心时退化为单机本地存储；表情图片文件仍各节点独立。**两档持久化变更审计与撤回（Web + 飞书一致）**：助理对记忆库、相处默契、表情包的修改立即生效并在当轮回复末尾附带醒目变更记录与「↩ 撤回」按钮；对常驻地址与人设配置的修改只生成待确认提案（`pendingApproval`），必须由用户点击「✓ 同意」（或在飞书/聊天直接回复 `同意` / `拒绝` / `撤回 [#编号]`）才正式落库，同意后同样可随时撤回，所有变更记录永久保留在对应对话气泡下可追溯。维护 UI 在顶栏 **「🧠 记忆与知识库」→「🎭 人设·表情·城市」子标签页**（整页工作台，与个人助理标题栏的 🎭 快捷入口弹窗内容完全一致、双向同步）：标题栏实时显示常驻城市/天气/农历胶囊，地址、人设、表情与学习条目既可在 UI 修改，也可直接对助理说「记住我家在上海市徐汇区…」「把常驻城市改成上海」「把我刚发的图存为表情包」「记住闲聊简短一点」，助理会调用 `ambient_save_address` / `ambient_set_home_city` / `sticker_*` / `persona_learning_*` 工具自己改好 |
| `ui-workbench` | UI 插槽 | 启用 | 顶栏「工程对话」研发工作台（话题侧栏 + 全宽内联工单回执对话区）；实时执行检视器已独立为顶栏专属标签页（回执点击直达），不再出现在其他页面下方 |
| `dsh-memory` | 记忆引擎 | 启用 | 高信噪比长期记忆库（初始为空白库），支持常驻置顶（Pinned）、混合语义自动召回、30 天防误删备份箱与多阶段纪念日倒计时（`milestone`）。条目可**直接编辑**（UI 行内编辑或助理 `memory_update` 工具）：编辑等价于删除旧条目 + 新建修改后的条目，旧版本自动以「✏️ 编辑替换的前版本」进入 30 天反悔恢复箱，随时可一键恢复，绝不丢字 |
| `dsh-lossless-context` | 记忆引擎 | 启用 | 无损分层摘要树（`lossless-claw` 模式）：滑出活跃窗口的历史对话自动构建 L1/L2 DAG 摘要树，可通过 `lcm_grep` 与 `lcm_expand` 100% 无损展开原文 |
| `dsh-self-improving` | 记忆引擎 | 启用 | 复利纠错经验账本（安全受控的 Propose 审阅晋升模式，绝不暗改系统 Prompt）+ `/btw` 零上下文污染旁路快问 |
| `dsh-runtime-guard` | 安全护栏 | 启用 | Tokenjuice 工具输出脱水压缩、连续重复报错死循环熔断器（Loop Breaker）、以及外部网页/文本防提示注入清洗 |
| `dsh-model-usage` | 观测与调度 | 启用 | 按角色（`Assistant` / `Eval` / `Worker`）、模型与日期统计本地输入/输出 Token、耗时与估算费用账单 |
| `dsh-model-profiles` | 观测与调度 | 启用 | 顶栏 `组1 / 组2 / 组3` 一键切换，支持为每个角色独立配置默认模型与任意 $N$ 段高低峰自动切换时间窗（含法定节假日/调休识别） |
| `dsh-web-research` | 助理与研发工具 | 启用 | 多源实时联网搜索（Tavily → SearXNG → DuckDuckGo 零 Key 自动降级）+ `web_readability` 网页去广告正文提取 |
| `dsh-browser-bridge` | 助理与研发工具 | 启用 | 连接本机已登录 Chrome（`:9222` CDP 或 `:18799` 扩展中继），保留登录态检视或打开标签页 |
| `dsh-data-sql` | 助理与研发工具 | 启用 | 基于内存只读 SQLite 的精确数据表/CSV SQL 聚合分析工具（`data_sql_query`），杜绝大模型心算误差 |
| `dsh-progress-card` | UI 与体验 | 启用 | 单会话原地刷新步骤进度条卡片（`progress_card_update`），长任务不刷屏 |
| `dsh-tool-search` | 核心底座 | 启用 | 跨插件工具关键词检索与 JSON Schema 参数自省（`tool_catalog_search` / `tool_catalog_describe`） |
| `dsh-device-group` | 分布式集群 | 启用 | `ECDSA P-256` 一次性签名邀请码多机配对 + 四重地址自动容灾回退（LAN IP → Hostname → Tailscale MagicDNS → Tailscale IP） |
| `dsh-worktree-merge` | 分布式集群 | 启用 | 每个工单自动检出独立 `agent/<slug>` Worktree 分支，汇报 `ready` 时自动无冲突快进合入主分支 |
| `ui-pipeline` / `ui-management` | UI 插槽 | 启用 | 顶栏「管线追踪」全链路视图与「系统管理」策略/来源/Prompt 版本审计套件 |

---

## 5. 多机分布式集群配对

如果你有多台电脑（例如一台 24 小时开机的轻量主机做入口，一台高性能台式机做重型代码编译）：

1. 在每台机器上分别启动 `RHarness`（`--host 0.0.0.0 --port 4318`）。
2. 在主控机点击顶栏 **「节点」** → **「创建设备组 / 生成一次性邀请码」**，复制 `rharness-group-invite:v1:...` 邀请串。
3. 在另一台机器点击顶栏 **「节点」** → 粘贴邀请码并点击 **「验证签名并加入设备组」**。
4. 配对完成后，主控机可根据工单标签或上下文自动将 `Worker` 会话派发到目标机器执行，并在完成后通过 Git Bundle 自动同步合入代码。

---

## 6. 挂载你自己的私有扩展包（Private Pack 机制）

如果你有自己私有的服务器工具（例如自建下载器、私有脚本路径、个人飞书 OpenID 或专属初始记忆），**请不要直接硬编码进 `RHarness` 源码仓库**，而是放在仓库外的 `~/.rharness/private-pack/` 目录（或通过环境变量 `RHARNESS_PRIVATE_PACK_DIR` 指定路径）。

- 当 `~/.rharness/private-pack/manifest.json` **不存在**时（任何人 `git clone` 后的默认状态）：`RHarness` 运行在 100% 纯净通用模式，不包含任何个人路径、私有 IP 或私有插件。
- 当你在自己的机器上创建 `~/.rharness/private-pack/manifest.json` 时：`RHarness` 启动时会自动发现并挂载你的私有配置、初始种子记忆与自定义 ESM 插件模块，升级公共仓库代码（`git pull`）时永远不会产生冲突或泄露隐私。
