# Vibe Coding AI Workflow 技术设计

## 1. 背景

日常工作里，经常会写一些一次性或半固定的代码来处理表格、文件、脏数据、报表和人工标注任务。传统工作流工具适合固定流水线，但不适合每个节点都高度自定义、既包含代码处理又包含人工检查页面的场景。

本项目要做一个本地优先的 AI 工作流编排运行平台。它允许用户把多个自定义节点串联成工作流。每个节点可以用任意语言实现核心逻辑，并提供自己的 HTML/CSS/JS 页面。主程序负责统一编排、执行、保存运行数据、渲染节点页面和提供数据访问 API。

## 2. 目标

- 支持本地单用户运行。
- 支持指定节点工作目录和数据存储目录。
- 支持通过文件定义节点和工作流。
- 支持自动运行和人工确认两种工作流模式。
- 支持节点自定义 UI，但由主程序统一渲染。
- 支持通过固定 CLI 协议进行节点执行、分页查询、搜索、详情读取和数据清洗写回。
- 支持保存每次运行的状态、日志、结果索引和确认记录。

## 3. 非目标

- MVP 不支持多用户、权限系统和远程部署。
- MVP 不实现真正的 DAG 并行调度，只在线性执行中预留依赖字段。
- 主程序不直接解析所有数据源格式，数据访问由节点按协议实现。
- 节点不单独启动 Web 服务，也不独立管理端口。

## 4. 核心架构

系统由三类对象组成：

1. 主程序
   - 发现节点和工作流定义文件。
   - 按工作流定义执行节点。
   - 保存运行状态、日志、结果索引和确认记录。
   - 作为统一 Web 宿主渲染节点 UI。
   - 将 HTTP API 请求转成节点 CLI 协议调用。

2. 节点
   - 一个节点是节点工作目录下的独立子目录。
   - 每个节点必须包含 `node.md`。
   - 节点可以用任意语言实现。
   - 节点通过固定 CLI action 暴露能力。
   - 节点的 HTML/CSS/JS 也放在自己的目录下。

3. 工作流
   - 一个工作流由 `workflow.md` 文件定义。
   - MVP 先按线性顺序执行节点。
   - 文件结构预留 `depends_on`，以后可扩展为 DAG、并行和分支。

## 5. 节点定义文件

`node.md` 放在每个节点目录下，用于描述单个节点。

```yaml
name: data-cleaning
label: 数据清洗节点
description: 清洗上传表格中的脏数据，并输出待人工确认的数据集。
command: python main.py
ui:
  entry: ui/index.html
capabilities:
  query: true
  search: true
  get: true
  update: true
```

节点目录示例：

```text
nodes/
  data-cleaning/
    node.md
    main.py
    ui/
      index.html
      style.css
      main.js
```

## 6. 工作流定义文件

`workflow.md` 用于串联多个节点，并记录运行模式。

```yaml
name: customer-data-workflow
label: 客户数据处理流程
description: 上传客户数据，完成清洗、人工确认和报告生成。
mode: manual-confirm
nodes:
  - id: clean
    node: data-cleaning
    depends_on: []
  - id: report
    node: report-generator
    depends_on: [clean]
```

`mode` 第一版支持：

- `auto`：节点成功后自动执行下一个节点。
- `manual-confirm`：节点成功后暂停，用户确认后再执行下一个节点。

## 7. 运行目录结构

每次执行工作流时，主程序在数据存储目录下创建一个运行目录。

```text
runs/
  2026-05-08-153000-customer-data-workflow/
    run.json
    workflow.md
    nodes/
      clean/
        status.json
        result.json
        confirm.json
        logs/
          stdout.log
          stderr.log
        data/
      report/
        status.json
        result.json
        logs/
          stdout.log
          stderr.log
        data/
```

文件职责：

- `run.json`：本次工作流运行的整体状态、当前节点、开始时间、结束时间和运行模式。
- `workflow.md`：本次运行使用的工作流快照，避免原文件后续修改影响历史记录。
- `status.json`：单个节点的状态、开始时间、结束时间、错误信息和进度。
- `result.json`：轻量结果元数据，不承载大体量业务数据。
- `confirm.json`：人工确认记录，仅在需要确认时生成。
- `logs/`：节点命令执行日志。
- `data/`：节点自由写入真实数据文件、清洗结果、图片、报表等。

## 8. 节点状态

节点状态包括：

- `pending`：等待执行。
- `running`：正在执行。
- `success`：节点命令执行成功。
- `waiting-confirmation`：人工确认模式下，节点成功后等待用户确认。
- `confirmed`：用户已确认，可以进入下一个节点。
- `failed`：执行失败。
- `skipped`：被跳过。

自动运行模式：

```text
pending -> running -> success -> next node running
```

人工确认模式：

```text
pending -> running -> success -> waiting-confirmation -> confirmed -> next node running
```

失败状态：

```text
running -> failed -> retry 或 cancel
```

## 9. 结果文件约定

`result.json` 只保存结果摘要、数据集清单和 UI 入口，不保存大数据本体。

```json
{
  "status": "success",
  "summary": "清洗完成，共处理 120000 行，发现 382 条异常",
  "datasets": [
    {
      "name": "error_rows",
      "label": "异常数据",
      "type": "table",
      "queryable": true,
      "searchable": true,
      "editable": true,
      "total": 382
    }
  ],
  "ui": {
    "entry": "ui/index.html"
  }
}
```

真实数据可以是 CSV、JSONL、SQLite、Parquet、Excel、远程 API 或任意自定义数据源。主程序不直接理解这些数据源，而是通过节点 CLI 协议访问。

## 10. 固定 CLI 协议

`node.md` 中的 `command` 是节点命令入口。主程序通过追加固定 action 和参数调用节点。

### 10.1 run

执行节点核心逻辑。

```bash
<command> run \
  --run-dir <本次工作流运行目录> \
  --node-run-dir <当前节点运行目录> \
  --node-dir <节点源码目录> \
  --workflow-file <本次运行的workflow.md快照>
```

节点执行完成后必须生成：

```text
<node-run-dir>/status.json
<node-run-dir>/result.json
```

### 10.2 query

分页查询数据集。

```bash
<command> query \
  --run-dir <本次工作流运行目录> \
  --node-run-dir <当前节点运行目录> \
  --node-dir <节点源码目录> \
  --dataset <数据集名称> \
  --page 1 \
  --page-size 100 \
  --filters <JSON字符串> \
  --sort <JSON字符串>
```

返回：

```json
{
  "ok": true,
  "dataset": "error_rows",
  "page": 1,
  "pageSize": 100,
  "total": 382,
  "columns": [
    { "key": "id", "label": "ID", "type": "string" },
    { "key": "name", "label": "姓名", "type": "string" },
    { "key": "issue", "label": "问题", "type": "string" }
  ],
  "rows": [
    { "id": "1", "name": "张三", "issue": "手机号格式错误" }
  ]
}
```

### 10.3 search

关键词搜索数据集。

```bash
<command> search \
  --run-dir <本次工作流运行目录> \
  --node-run-dir <当前节点运行目录> \
  --node-dir <节点源码目录> \
  --dataset <数据集名称> \
  --q <关键词> \
  --page 1 \
  --page-size 100
```

### 10.4 get

读取单条记录详情。

```bash
<command> get \
  --run-dir <本次工作流运行目录> \
  --node-run-dir <当前节点运行目录> \
  --node-dir <节点源码目录> \
  --dataset <数据集名称> \
  --id <记录ID>
```

### 10.5 update

写回人工清洗、标注或修正结果。

```bash
<command> update \
  --run-dir <本次工作流运行目录> \
  --node-run-dir <当前节点运行目录> \
  --node-dir <节点源码目录> \
  --dataset <数据集名称> \
  --id <记录ID> \
  --patch <JSON字符串>
```

返回：

```json
{
  "ok": true,
  "dataset": "error_rows",
  "id": "1",
  "record": {
    "id": "1",
    "name": "张三",
    "issue": "fixed"
  }
}
```

### 10.6 错误返回

所有 query、search、get、update action 的错误统一输出到 stdout：

```json
{
  "ok": false,
  "error": {
    "code": "DATASET_NOT_FOUND",
    "message": "Dataset error_rows not found"
  }
}
```

## 11. 主程序 HTTP API

节点 UI 不能直接读取本地文件，也不能直接调用节点命令。所有数据访问必须经过主程序 HTTP API。

```text
GET  /api/runs/:runId
GET  /api/runs/:runId/nodes/:nodeId
GET  /api/runs/:runId/nodes/:nodeId/result
GET  /api/runs/:runId/nodes/:nodeId/context

POST /api/runs/:runId/nodes/:nodeId/query
POST /api/runs/:runId/nodes/:nodeId/search
GET  /api/runs/:runId/nodes/:nodeId/records/:dataset/:id
PATCH /api/runs/:runId/nodes/:nodeId/records/:dataset/:id

POST /api/runs/:runId/nodes/:nodeId/confirm
POST /api/runs/:runId/nodes/:nodeId/retry
POST /api/runs/:runId/cancel
```

主程序转换关系：

```text
节点 UI
  -> 主程序 HTTP API
  -> 节点 command query/search/get/update
  -> stdout JSON
  -> 主程序返回给 UI
```

## 12. 节点 UI 渲染

节点 UI 的 HTML/CSS/JS 放在节点目录下，由主程序统一渲染。

```text
GET /ui/runs/:runId/nodes/:nodeId/
GET /ui/runs/:runId/nodes/:nodeId/assets/*
```

节点 UI 通过上下文接口获取当前运行信息：

```text
GET /api/runs/:runId/nodes/:nodeId/context
```

返回：

```json
{
  "runId": "2026-05-08-153000-customer-data-workflow",
  "nodeId": "clean",
  "nodeName": "data-cleaning",
  "mode": "manual-confirm",
  "status": "waiting-confirmation",
  "resultUrl": "/api/runs/xxx/nodes/clean/result"
}
```

## 13. 人工确认与数据清洗

在 `manual-confirm` 模式下，节点 `run` 成功后不会自动进入下一个节点，而是进入 `waiting-confirmation`。

用户可以在节点 UI 中执行人工清洗、标注和修正。UI 通过 `PATCH` API 写回数据，主程序再调用节点的 `update` action。后续节点读取的是清洗后的数据。

用户点击确认后，主程序写入 `confirm.json`。

```json
{
  "confirmed": true,
  "confirmedAt": "2026-05-08T15:45:00+08:00",
  "note": "异常手机号已修正，继续生成报告。"
}
```

## 14. MVP 验收标准

- 可以配置节点工作目录和数据存储目录。
- 可以发现多个包含 `node.md` 的节点。
- 可以读取文件化的 `workflow.md`。
- 可以按线性顺序运行工作流。
- 支持 `auto` 和 `manual-confirm` 两种模式。
- 每次运行生成独立运行目录。
- 每个节点生成状态、日志和结果文件。
- 主程序可以渲染节点目录里的 HTML/CSS/JS。
- 节点 UI 可以通过主程序 API 查询数据、搜索数据、读取详情和写回清洗结果。
- `result.json` 只作为轻量元数据和数据集索引，不承载大体量业务数据。

