# 010 事故复盘：表情包"消失"三部曲（2026-11-19）

一次"个人助理说表情包库是空的"的排查，最终牵出三个叠加的 bug 和一个集群更新机制的坑。
全文按发现顺序记录，供以后排查"助理说的和事实不符"类问题时参考。

## 现象

用户图库里有 531 张表情包，个人助理却先后给出三种错误结论：

1. 「表情包功能开着，但库目前是空的」
2. 「表情包工具（sticker_list 等）在这个环境里搜不到了」
3. 修复上线几分钟后再次回退到旧错误（第 2 种的重复）

## Bug 1：工具输出里带 `undefined` 值的自有键 → 整个工具调用被判非法

**层：本仓库代码**（修复：`4ce4e2a`）

- 助理调用 `sticker_list` 时，工具返回的对象里固定带 `emotion: s.emotion`；
  文件夹批量上传的表情大多没有 emotion，于是键存在、值为 `undefined`。
- DSH 工具管线要求工具输出必须是**无损 JSON**（`snapshotJsonValue` 遇到
  `undefined` 值的自有键直接整体拒绝），报错：
  `Error: tool "sticker_list" returned invalid output: value is not lossless JSON`。
- 模型把这个报错理解成"库是空的"回复了用户。
- 同样问题存在于 `sticker_add_from_message`、`sticker_update`。

**修复**：可选字段一律条件展开（`...(s.emotion ? { emotion: s.emotion } : {})`）；
显式清除 emotion 用 `delete` 而不是赋 `undefined`。

**教训**：
- 写工具返回值时，可选字段永远不要写 `key: maybeUndefinedValue`。
- 回归测试断言工具输出能无损通过 `JSON.parse(JSON.stringify(x))` round-trip。

## Bug 2：工具目录（tool_catalog_search）漏登记人设/表情工具

**层：本仓库代码**（修复：`7c4951a`）

- `sticker_*` / `persona_*` / `ambient_*` 等工具直接 `agent.ctx.tools.register`
  （模型可调用），但没进 `tool_catalog_search` 枚举的 `sessionToolRegistry`——
  目录 40 个工具里搜 "sticker" 是 0 个。
- 模型在工具报错后用目录"交叉验证"，目录说没有，于是得出"工具消失了"的
  错误结论。**推理没错，索引是错的**。
- 顺带修复：`findSticker` 把 `"*"` 当普通子串匹配返回 0 条，强化了"库是空的"
  错觉。现在 `*` / `all` / `全部` 返回全部有效表情。

**修复**：人设/bridge 工具统一走 `registerWithMirror`（注册 + 目录镜像）。

**教训**：任何"列出可用工具"的目录/索引，必须和真实注册表同源，否则模型
的交叉验证会被它带偏。

## Bug 3（机制坑）：数据中心用旧构建"回顶"已修复的节点

**层：集群自动更新机制**（无代码改动，运维处理 + 已用 publish 对齐全集群）

时间线：

```
03:16  修复 1 上线（重启子进程，但当时还有 turn 在跑旧代码）
03:24  修复 2 (7c4951a) 提交推送 GitHub
03:25:33  数据中心 claw 用它仓库里的旧 main (b76dcdf) 构建更新包推给本机；
          本机空闲 → git checkout -B main FETCH_HEAD + 覆盖 lib/ + 重启
          → 本地 main 被重置回旧提交，两个修复从工作区消失（GitHub 上还在）
03:28  助理再次报旧错误（用户看到的"第三种"现象即此）
03:30  本机 checkout 回 origin/main，重建 lib
03:31  cluster-update/publish 把修复版发布到 claw → 全集群（claw/winserver/tc）
       统一到 7c4951a，claw 仓库也随 bundle 前进，回顶源头消除
```

**要点**：
- 集群更新是**数据中心权威推送**：`applyVerifiedReleaseToRepo` 会在本地树
  干净时 `git fetch <bundle> HEAD` + `git checkout -B main FETCH_HEAD`，然后
  原子替换 `lib/` 并重启。本地领先于数据中心的提交会被静默回退（reflog 表现
  为 `branch: Reset to FETCH_HEAD`）。
- **排查看 reflog**：push 莫名 non-fast-forward / 本地提交"消失"，先
  `git reflog` 找 `Reset to FETCH_HEAD` / `checkout -B`。
- **正确升级姿势**：修好 → push GitHub → 在任一节点
  `POST /orchestrator/standalone/cluster-update/publish`。发布包会上传数据
  中心成为 `latest.pkg.gz` 并广播，各节点（含数据中心自己）空闲时应用。
  数据中心仓库随 bundle 前进，之后不会再拿旧版顶人。
- **危险姿势**：只 push GitHub 不 publish——数据中心下次构建/推送仍会把它
  仓库里的旧 main 分发出来，把你的修复顶掉。
- 根因是数据中心那台 VM（claw / VM-0-14-ubuntu）的 main 落后于 GitHub。
  如果再次出现集体回退，先查数据中心仓库有没有被手动 reset。

## 排查工具箱（本次用到的）

- 读对话与工具调用记录（含每次调用的原始输出和错误）：
  `GET /orchestrator/standalone/assistant/messages`（需 `x-orchestrator-request: 1`）
- 验证人设/表情数据与服务状态：
  `GET /orchestrator/standalone/assistant/persona-state`
- 集群更新状态（本地构建 / 数据中心 latest / 各节点 buildId 与 staged）：
  `GET /orchestrator/standalone/cluster-update/status`
- 全集群发布：`POST /orchestrator/standalone/cluster-update/publish`

## 涉及提交

- `4ce4e2a` fix(persona): strip undefined emotion from sticker tool outputs
- `7c4951a` fix(plugins): mirror persona/bridge tools into the tool-search
  catalog + treat '*' as list-all
