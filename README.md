# RHarness (`dsh-superagent`)

> **迈向更自主的智能体系统（Towards a More Autonomous Agent System）。** 基于 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 架构构建，支持独立常驻服务、全模块化插件架构（涵盖 **个人助理 Claw**、**工程对话**、**长期记忆**、**前端 UI 视图插槽 `ctx.slots`**、**RHFiles/RHRemote 多路径分布式设备组** 与 **角色分时模型配置组**），并支持在 **DSH**、**Codex**、**Claude**、**Cursor** 与 **Human（人工控制台）** 之间按角色独立选型。

`RHarness`（`dsh-superagent`）是一套主动式研发与日常协同智能体系统：

1. **双域隔离与单向原话流转（`个人助理 → 工程对话`）**：
   - **个人助理（Tab 1，`@rharness/plugin-claw-assistant`）**：负责日常问答、随手记、图文交流与长期记忆（`memory_save` / `memory_search` / `memory_list` / `memory_delete`）。当个人助理判断某段对话需要推进工程代码研发时，助理会生成简短总结，并将**助理总结 + 用户发给助理的一字不改原话 + 全部原始图片**打包单向递交至「工程对话」。
   - **工程对话（Tab 2，`dsh-superagent`）**：工程评估主会话（`orchestrator` / `Eval`）100% 保持原生的 `complete: true` 严苛契约，零个人助理工具污染。工程 `Eval` 模型对所有请求（含个人助理递交的请求）拥有**独立研判与拒收权**：确认属于明确研发需求则建立带不可变授权（`Mandate`）的独立 Git Worktree 工单（`Ticket`）；若属日常备忘或方向未定则直接拒收（`ignore`）并给出理由。
2. **全系统一等公民插件化（Cordis / DSH Plugin Host + `ctx.slots`）**：
   - 顶栏各功能窗口（`个人助理`、`工程对话`、`记忆与插件`、`管线追踪`、`系统管理`）及后台扩展能力共 **13 个一等公民插件**，均可在「记忆与插件」中心实时启停与审计。
3. **分布式设备组与四重地址容灾（`@rharness/plugin-device-group`）**：
   - 融合 `ECDSA P-256` 签名一次性邀请码入组与四重网络地址自动容灾回退（`局域网 IP` → `不变机器名 Hostname` → `Tailscale MagicDNS 域名` → `Tailscale IP`），支持跨机器派发 Worker 工单并通过 Git Bundle 自动快进合入 `main` 分支。
4. **可视化模型配置组与角色 N 段分时调度（`@rharness/plugin-model-profiles`）**：
   - 与系统设置共享同一套双栏可视化模型选择器（点选提供商、模型与推理强度，无需手填字符串），支持配置组（`组1` / `组2` / `组3`）一键切换，以及每个角色（`Eval` 与 `Worker`）独立配置任意 $N$ 段高低峰时间窗口。

核心设计原则：**尽可能少地占用人的注意力，尽可能多地交付确定性价值。** 详见 [docs/000-philosophy.md](docs/000-philosophy.md)。

## 快速开始（独立服务模式）

```sh
pnpm install
pnpm build
pnpm start
```

默认监听 `http://127.0.0.1:4318`（可通过 `--port` / `DSH_SUPERAGENT_PORT`、`--host 0.0.0.0` 与 `--state-dir` / `DSH_SUPERAGENT_STATE_DIR` 覆盖；停止后台服务可执行 `pnpm stop`）。完整的单机/多机部署、手机端 PWA 接入与全套插件说明请直接阅读 **[009 Standalone Deployment & Plugin Guide（独立部署与全套插件指南）](docs/009-standalone-and-plugins.md)**。

- **内置消息源（Sources）**：默认启用本地面板源（`panel`），支持文字与多图粘贴/拖拽；飞书源（`feishu`）与 GitHub 仓库源（`github`）可在「系统管理 → 设置 → 来源」或「记忆与插件」中随时启用。
- **角色模型与分时配置组**：通过顶栏「配置组」或「系统管理 → 设置 → 评估 / 执行」，采用统一的可视化列表为 `Eval`（主控评估）和 `Worker`（工单执行器）选择 `dsh`、`codex`、`claude`、`cursor` 或 `human` 模型及高低峰自动切换时段。

## 初始化配置（Setup）

如需配置完整的 DSH Profile 或外部 CLI（`lark-cli` / `gh`），可直接对你的编码智能体说：

> 请阅读本仓库的 SETUP.md 并协助我完成 dsh-superagent 配置。

智能体会按 [SETUP.md](SETUP.md) 逐步提问、展示完整方案并自动完成安装与验证。

## 架构与设计文档

请按编号顺序阅读；每篇文档仅依赖其前面的编号文档：

- [000 Philosophy（设计哲学）](docs/000-philosophy.md)
- [001 Domain model（领域模型）](docs/001-domain.md)
- [002 Authorization（准入与授权）](docs/002-authorization.md)
- [003 Execution（执行与生命周期）](docs/003-execution.md)
- [004 Prompts（提示词体系）](docs/004-prompts.md)
- [005 Panel（管理面板规范）](docs/005-panel.md)
- [006 Deployment（部署、升级与排障）](docs/006-deployment.md)
- [007 Architecture（代码架构与模块索引）](docs/007-architecture.md)
- [008 Cookbook（扩展新消息源指南）](docs/008-cookbook.md)
- [009 Standalone & Plugins（独立部署、通用插件矩阵与私有扩展包指南）](docs/009-standalone-and-plugins.md)

## 开发与校验

运行 `pnpm check` 将依次执行 TypeScript 类型检查（`pnpm typecheck`）、全量单元与集成测试（`pnpm test`）以及生产构建（`pnpm build`）。

## 许可证

[MIT](LICENSE)

---

# dsh-superagent (English)

> **Towards a More Autonomous Agent System.** Redesigned from [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) with standalone service support, a built-in Local Panel Source alongside Feishu (and optional GitHub), and multi-provider role selection across **DSH**, **Codex**, **Claude**, **Cursor**, and **Human-in-the-loop**.

`dsh-superagent` is a proactive coding agent system. It listens to Sources (**Local Panel**, **Feishu**, and optionally **GitHub**). When someone allowed asks the agent for work, or when a written Policy rule matches an observed event, it opens a **Ticket** with an immutable **Mandate**, assigns it to an isolated **Executor Session** and worktree directory, and answers in the original conversation. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Quick Start (Standalone Service)

```sh
pnpm install
pnpm build
pnpm start
```

By default, the standalone server listens on `http://127.0.0.1:3082` (override with `--port` / `DSH_SUPERAGENT_PORT` and `--state-dir` / `DSH_SUPERAGENT_STATE_DIR`).

- **Built-in Sources**: `panel` (Local Panel direct requests & threads) and `feishu` are enabled out of the box; `github` is also registered and can be enabled in **Settings → Source** whenever needed.
- **Role-specific Actors / Models**: In **Settings → Eval** (Main Session / Orchestrator) and **Settings → Execution** (Worker Executor Session), each role can independently choose a model from `dsh`, `codex`, `claude`, `cursor`, or `human` (manual human-in-the-loop via the Session Console).
- **DSH Plugin Bundle**: Also exports the standard DeepSeek Harness bundle entries (`.`, `./client`, `./feishu-watch`, `./github-watch`, `./panel-watch`) and `cordis.patch.yml`.

## Setup

For full DSH profile or external CLI setup (`lark-cli` / `gh`), ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Standalone & Plugins](docs/009-standalone-and-plugins.md): standalone deployment, mobile PWA, built-in plugin suite, and external private packs

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
