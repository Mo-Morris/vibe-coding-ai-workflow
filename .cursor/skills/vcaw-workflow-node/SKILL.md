---
name: vcaw-workflow-node
description: >-
  Defines Vibe Coding AI Workflow nodes — node.md YAML schema, directory layout,
  fixed CLI subcommands (run/query/search/get/update), cwd and argv rules,
  result.json shape, capabilities flags, and UI static asset roots. Use when
  creating or editing nodes under the nodes directory, implementing node CLIs,
  aligning result.json with the UI, or troubleshooting workflow node references.
---

# VCAW 工作流节点

本 Skill 对应仓库 **Vibe Coding AI Workflow**：节点是 `NODES_DIR` 下的独立子目录（默认 `examples/nodes`），由 `node.md` 描述；主程序按固定 CLI 追加子命令与参数，工作流里通过 `node: <目录名>` 引用。

权威细节见仓库内 `README.md` 与 `docs/design/2026-05-08-vibe-coding-ai-workflow-technical-design.md` 第 5、9、10 节。

## 目录与发现规则

- 路径形态：`{NODES_DIR}/<nodeRef>/node.md`。环境变量 `VCAW_NODES_DIR` 可覆盖 `NODES_DIR`（见 `backend/app/main.py`）。
- **工作流中的 `node` 字段必须与目录名一致**（例如 `node: data-cleaning` → 目录 `examples/nodes/data-cleaning/`）。主程序用该字符串拼路径，**不会**用 `node.md` 里的 `name` 去解析路径。
- 建议 **`node.md` 中的 `name` 与目录名相同**，避免歧义。

## `node.md` 字段（YAML）

| 字段 | 说明 |
|------|------|
| `name` | 节点逻辑名；建议与目录名一致。 |
| `label` | 展示用短标题。 |
| `description` | 描述。 |
| `command` | 入口命令字符串；主程序用 `shlex.split` 拆成 argv 前缀，再追加子命令与参数。**工作目录（cwd）为节点源码目录**。路径含空格时需能在 shell 语义下正确拆分。 |
| `ui` | 可选。`ui.entry` 为相对节点根目录的 HTML 入口（如 `ui/index.html`）。 |
| `capabilities` | 可选。`query` / `search` / `get` / `update` 布尔值；声明节点是否实现对应 CLI。主程序 **不会** 根据该字段拦截 HTTP，调用始终进入节点 CLI；因此 **实现必须与声明一致**，否则会得到错误或无效 JSON。 |

模板：

```yaml
name: my-node
label: 我的节点
description: 一句话说明职责。
command: python3 main.py
ui:
  entry: ui/index.html
capabilities:
  query: true
  search: true
  get: true
  update: true
```

## 固定 CLI 协议

主程序调用形态：`{command 拆分后的 argv...} <action> [--run-dir ...] [--node-run-dir ...] [--node-dir ...] [各 action 专有参数]`。

所有 action 均含：

- `--run-dir`：本次运行根目录。
- `--node-run-dir`：当前工作流步骤实例目录（含 `data/`、`logs/` 等）。
- `--node-dir`：节点源码根目录（与含 `node.md` 的目录相同）。

### `run`

额外参数：

- `--workflow-file`：本次运行目录下的 `workflow.md` 快照路径。

约定：

- 进程 **退出码 0** 视为执行成功；非 0 由主程序记为 `failed`。
- 标准输出/标准错误写入 `<node-run-dir>/logs/`（主程序管道式运行 `run` 时落日志）。
- 在 `node-run-dir` 下写入 **`result.json`**（摘要与数据集清单，见下节）。大块数据放在 `node-run-dir/data/` 等，由节点自行组织。
- 节点状态 **`status.json`** 由主程序在调度过程中维护（`pending` → `running` → `success` / `waiting-confirmation` / `failed` 等）；实现 `run` 时无需依赖自写 `status.json` 来决定成功，以 **退出码** 为准。

### `query`

参数：`--dataset`、`--page`、`--page-size`、`--filters`（JSON 字符串）、`--sort`（JSON 字符串）。

成功时 stdout 为 **单行 JSON**：`ok`、`dataset`、`page`、`pageSize`、`total`、`columns`（`key`/`label`/`type`）、`rows`。

### `search`

参数：`--dataset`、`--q`、`--page`、`--page-size`。

成功时 stdout 为 JSON，字段同 `query` 类响应。

### `get`

参数：`--dataset`、`--id`。

成功：`ok: true` 与 `record`。失败：`ok: false` 与 `error.code` / `error.message`。

### `update`

参数：`--dataset`、`--id`、`--patch`（JSON 字符串，对象）。

成功：返回更新后的 `record`。失败格式同 `get`。

### 数据类 action 共性

- 主程序以 **子进程 + 捕获 stdout** 方式调用，且期望 stdout 为合法 **JSON**；非 0 退出码会触发 HTTP 500。
- 错误响应统一为 JSON：`{"ok": false, "error": {"code": "...", "message": "..."}}`。

## `result.json`（`run` 成功后）

轻量摘要，不承载大体量业务数据。与 `examples/nodes/data-cleaning/main.py` 及设计文档第 9 节对齐，典型字段：

- `status`：如 `"success"`。
- `summary`：人类可读摘要。
- `datasets`：数组；每项含 `name`、`label`、`type`（如 `"table"`）、`queryable`、`searchable`、`editable`、`total` 等，供 UI 列举数据集。
- `ui`：可选，如 `{"entry": "ui/index.html"}`（可与 `node.md` 的 `ui.entry` 一致）。

## UI 与静态资源

- 若配置 `ui.entry` 且文件存在，主程序提供节点 UI 入口；静态资源路由以 **`ui.entry` 所在目录** 为资源根（如 `ui/index.html` → `ui/` 下放 `style.css`、`main.js`），通过 `/ui/runs/.../nodes/.../assets/...` 访问。
- `ui.entry` 解析后必须仍在节点目录内（防路径穿越）；见 `node_ui_entry` / `node_ui_asset`。

## 实现新节点时的检查清单

- [ ] 目录名 = 工作流 `workflow.md` 中引用的 `node` 值。
- [ ] `node.md` 含 `command`，且本地从节点目录可执行。
- [ ] 使用 `argparse`（或等价）实现子命令 `run`、`query`、`search`、`get`、`update`（不需要的能力可在 `capabilities` 标 `false` 且 API 侧避免依赖，但仍建议实现 stub 返回明确 JSON 错误以免误调）。
- [ ] `run` 写 `result.json`，大数据写 `node-run-dir/data/`，退出码正确。
- [ ] 数据类子命令仅向 stdout 打印 JSON。
- [ ] `capabilities` 与实际行为一致；需要表格编辑的节点开启 `get`/`update`。
- [ ] 若有 UI：`ui/index.html` 及资源路径与 `ui.entry` 一致。

## 参考实现

- 完整 CLI 示例：`examples/nodes/data-cleaning/main.py`（含 `run` / `query` / `search` / `get` / `update`）。
- 弱数据能力示例：`examples/nodes/report-generator/`。
