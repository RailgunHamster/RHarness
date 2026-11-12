# RHarness (`dsh-superagent`) 项目说明

本项目采用 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 架构，使用 TypeScript、Node.js 24、React、SQLite (`node:sqlite`) 与 `tsdown` 构建。

- 架构与设计原则遵循编号文档：[000 Philosophy](docs/000-philosophy.md) 至 [008 Cookbook](docs/008-cookbook.md)。
- 核心概念保持收敛：`Source` → `Trigger` → `Thread` → `Eval` (`Gate` + `Assessment` → `Decision` / `Mandate`) → `Ticket` → `Assignment` → `Executor` → `Outbox` / `Channel`。
- 双层角色架构：
  - **Main Session (`orchestrator`)**：只做路由与主动规则研判（`orchestrator_route`、`orchestrator_eval*`、`orchestrator_reply`），不写技术方案或执行计划。
  - **Executor Session (`worker`)**：在独立工单目录中自主调查、实现、验证并通过 `orchestrator_report` 汇报，自行处理所属线程的后续消息与交回（`orchestrator_trigger_handback`）。
- 多执行端抽象：通过统一 Session 宿主协议支持为不同角色（`eval.model` 与 `executor.model`）分别选择 `dsh`、`codex`、`claude`、`cursor` 或 `human`（人工通过面板 Session Console 扮演角色）。
- 本仓库使用 Git 保存源码修改。开始修改前检查 `git status`，保留已有未提交工作；每批修复完成并验证通过后（`pnpm check`）都要 `git commit` 并 `git push` 到已确认的远端分支，提交说明写清改动和验证结果。用户已持续授权此流程，不要每次重复询问是否提交或推送。不要用 reset、amend、强制推送或清理未跟踪文件覆盖历史或他人的工作。
- Git 只保存源码、测试和文档，不提交 `.rharness*`、`.artifacts`、依赖、构建产物（`lib/`）、密钥、环境配置或运行日志。
