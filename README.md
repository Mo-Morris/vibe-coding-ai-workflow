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
  upload: true
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
- `upload`：读取主程序保存到节点数据区的上传文件。
- `query`：分页查询数据集。
- `search`：关键词搜索。
- `get`：读取单条详情。
- `update`：写回人工清洗、标注或修正结果。

节点 UI 不能直接读取本地文件，也不能直接调用节点命令。所有访问必须经过主程序 HTTP API，再由主程序转成对应的节点 CLI action。

## 技术设计

完整技术设计见：

[docs/design/2026-05-08-vibe-coding-ai-workflow-technical-design.md](docs/design/2026-05-08-vibe-coding-ai-workflow-technical-design.md)

## 第一版实现

当前仓库包含一个可运行的 MVP：

- `backend/`：Python + FastAPI 主程序，负责发现节点/工作流、运行编排、状态持久化、节点 CLI 代理、确认/停止/删除接口和节点 UI 托管。
- `frontend/`：React + TypeScript 控制台，用于启动工作流、查看运行状态、确认节点继续执行。
- `examples/`：示例节点和示例工作流，可用于验证固定 CLI 协议。
- `data/runs/`：默认运行数据目录。

### 启动后端

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

可通过环境变量修改目录：

```bash
VCAW_NODES_DIR=/path/to/nodes \
VCAW_WORKFLOWS_DIR=/path/to/workflows \
VCAW_RUNS_DIR=/path/to/runs \
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### 启动前端

```bash
cd frontend
npm install
npm run dev
```

前端默认访问 `http://127.0.0.1:8000`。如需修改：

```bash
VITE_API_BASE=http://127.0.0.1:8000 npm run dev
```

### 验证示例流程

1. 打开前端页面。
2. 进入「工作流管理」页面，可以查询已有 workflow、创建 workflow 或删除 workflow 定义。
3. 创建 workflow 时填写名称、模式和描述，并在「选择节点」里按名称、标签或描述筛选节点，点击节点加入流程。
4. 保存后，新的 `workflow.md` 会写入 `examples/workflows/<workflow-name>/workflow.md`。
5. 回到「运行控制台」启动工作流运行。第一个节点进入 `待确认` 后，打开节点 UI 修改数据并保存。
6. 点击「确认继续」，第二个节点会生成报告。
