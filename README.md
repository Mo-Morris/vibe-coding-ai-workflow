# Vibe Coding AI Workflow

一个本地优先的 AI 工作流编排运行平台，用来把多个自定义代码节点串联成可执行流程。

它适合处理这类任务：

- 表格、文件、脏数据清洗。
- 数据处理后的人工检查、标注和修正。
- 自定义图表、报表、看板展示。
- 需要 AI 辅助快速编写节点逻辑和节点页面的半固定流程。

## 核心想法

传统工作流工具通常把节点定义、执行和展示都放在服务端平台里。这个项目采用更自由的方式：每个节点都是一个独立目录，可以用任意语言实现核心逻辑，也可以提供自己的 HTML/CSS/JS 页面。

主程序负责：

- 发现节点和工作流定义文件。
- 编排并执行工作流。
- 保存每次运行的日志、状态、结果索引和人工确认记录。
- 统一渲染节点 UI。
- 为节点 UI 提供分页查询、搜索、详情读取和数据清洗写回 API。

节点负责：

- 通过固定 CLI 协议执行核心逻辑。
- 通过固定 CLI 协议提供数据查询、搜索、详情和写回能力。
- 提供自己的前端页面资源。

## 文件协议

每个节点目录下必须有 `node.md`，用于描述节点信息：

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

每个工作流由 `workflow.md` 定义，用于串联节点：

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

MVP 先支持线性执行，文件结构预留 `depends_on`，以后可以扩展为 DAG、并行和分支。

## 运行模式

工作流支持两种模式：

- `auto`：节点成功后自动执行下一个节点。
- `manual-confirm`：节点成功后暂停，用户在节点 UI 中完成人工清洗、标注或检查，确认后再执行下一个节点。

## 数据访问模型

节点运行后生成 `result.json`，但它只保存轻量元数据和数据集索引，不保存大体量业务数据。

真实数据可以是 CSV、JSONL、SQLite、Parquet、Excel、远程 API 或任意自定义数据源。主程序不直接理解这些数据源，而是通过节点固定 CLI 协议访问：

- `run`：执行节点核心逻辑。
- `query`：分页查询数据集。
- `search`：关键词搜索。
- `get`：读取单条详情。
- `update`：写回人工清洗、标注或修正结果。

节点 UI 不能直接读取本地文件，也不能直接调用节点命令。所有访问必须经过主程序 HTTP API，再由主程序转成对应的节点 CLI action。

## 技术设计

完整技术设计见：

[docs/superpowers/specs/2026-05-08-vibe-coding-ai-workflow-technical-design.md](docs/superpowers/specs/2026-05-08-vibe-coding-ai-workflow-technical-design.md)
