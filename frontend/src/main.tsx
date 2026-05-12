import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

type Page = "runs" | "workflows";
type WorkflowMode = "auto" | "manual-confirm";

type WorkflowNode = {
  id: string;
  node: string;
  depends_on?: string[];
};

type Workflow = {
  name: string;
  label?: string;
  description?: string;
  mode: WorkflowMode;
  nodes: WorkflowNode[];
  path?: string;
};

type NodeDefinition = {
  name: string;
  label?: string;
  description?: string;
  capabilities?: Record<string, boolean>;
};

type NodeStatus = {
  id: string;
  node: string;
  status: string;
  startedAt?: string | null;
  endedAt?: string | null;
  error?: string | null;
  progress?: number;
};

type Run = {
  id: string;
  workflowName: string;
  workflowLabel: string;
  mode: WorkflowMode;
  status: string;
  currentNodeId?: string | null;
  startedAt: string;
  endedAt?: string | null;
  workflow: Workflow;
  nodeStatuses?: Record<string, NodeStatus>;
};

type WorkflowDraft = {
  name: string;
  label: string;
  description: string;
  mode: WorkflowMode;
  nodes: WorkflowNode[];
};

const emptyDraft: WorkflowDraft = {
  name: "",
  label: "",
  description: "",
  mode: "manual-confirm",
  nodes: [],
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || response.statusText);
  }
  return response.json() as Promise<T>;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "等待",
    running: "运行中",
    success: "成功",
    "waiting-confirmation": "待确认",
    confirmed: "已确认",
    failed: "失败",
    stopped: "已停止",
    stopping: "停止中",
  };
  return labels[status] ?? status;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function App() {
  const [page, setPage] = useState<Page>("runs");
  const [nodes, setNodes] = useState<NodeDefinition[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [selectedWorkflowName, setSelectedWorkflowName] = useState<string>("");
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  const [isCreateWorkflowOpen, setIsCreateWorkflowOpen] = useState(false);
  const [nodeSearch, setNodeSearch] = useState("");
  const [workflowSearch, setWorkflowSearch] = useState("");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.name === selectedWorkflowName) ?? null,
    [selectedWorkflowName, workflows],
  );
  const filteredNodes = useMemo(() => {
    const query = nodeSearch.trim().toLowerCase();
    if (!query) return nodes;
    return nodes.filter((node) => {
      const haystack = `${node.name} ${node.label ?? ""} ${node.description ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [nodeSearch, nodes]);

  const filteredWorkflows = useMemo(() => {
    const query = workflowSearch.trim().toLowerCase();
    if (!query) return workflows;
    return workflows.filter((workflow) => {
      const haystack = `${workflow.name} ${workflow.label ?? ""} ${workflow.description ?? ""} ${workflow.mode}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [workflowSearch, workflows]);

  async function refreshLists() {
    const [nodeData, workflowData, runData] = await Promise.all([
      api<{ nodes: NodeDefinition[] }>("/api/nodes"),
      api<{ workflows: Workflow[] }>("/api/workflows"),
      api<{ runs: Run[] }>("/api/runs"),
    ]);
    setNodes(nodeData.nodes);
    setWorkflows(workflowData.workflows);
    setRuns(runData.runs);
  }

  async function refreshRun(runId = selectedRunId) {
    if (!runId) {
      setSelectedRun(null);
      return;
    }
    const run = await api<Run>(`/api/runs/${runId}`);
    setSelectedRun(run);
  }

  async function withErrorBoundary(action: () => Promise<void>, successMessage = "") {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await action();
      if (successMessage) setNotice(successMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void withErrorBoundary(refreshLists);
  }, []);

  useEffect(() => {
    void withErrorBoundary(() => refreshRun(selectedRunId));
    const timer = window.setInterval(() => {
      if (selectedRunId) void refreshRun(selectedRunId);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedRunId]);

  async function startWorkflow(name: string) {
    await withErrorBoundary(async () => {
      const created = await api<{ runId: string }>(`/api/workflows/${name}/runs`, {
        method: "POST",
        body: JSON.stringify({ input: {} }),
      });
      await refreshLists();
      setSelectedRunId(created.runId);
      setPage("runs");
    }, "已创建运行记录");
  }

  function viewWorkflow(name: string) {
    setSelectedWorkflowName(name);
    setPage("workflows");
  }

  function viewWorkflowList() {
    setSelectedWorkflowName("");
    setPage("workflows");
  }

  function viewRun(runId: string) {
    setSelectedRunId(runId);
    void refreshRun(runId);
  }

  function viewRunList() {
    setSelectedRunId("");
    setSelectedRun(null);
    setPage("runs");
  }

  function addDraftNode(node: NodeDefinition) {
    setDraft((current) => {
      const count = current.nodes.filter((item) => item.node === node.name).length + 1;
      const idBase = slugify(node.name) || "node";
      const id = count === 1 ? idBase : `${idBase}-${count}`;
      const previous = current.nodes[current.nodes.length - 1];
      return {
        ...current,
        nodes: [
          ...current.nodes,
          {
            id,
            node: node.name,
            depends_on: previous ? [previous.id] : [],
          },
        ],
      };
    });
  }

  function removeDraftNode(index: number) {
    setDraft((current) => {
      const nextNodes = current.nodes.filter((_, itemIndex) => itemIndex !== index);
      return {
        ...current,
        nodes: nextNodes.map((node, itemIndex) => ({
          ...node,
          depends_on: itemIndex > 0 ? [nextNodes[itemIndex - 1].id] : [],
        })),
      };
    });
  }

  function updateDraftNodeId(index: number, value: string) {
    setDraft((current) => {
      const nextNodes = current.nodes.map((node, itemIndex) => (itemIndex === index ? { ...node, id: slugify(value) } : node));
      return {
        ...current,
        nodes: nextNodes.map((node, itemIndex) => ({
          ...node,
          depends_on: itemIndex > 0 ? [nextNodes[itemIndex - 1].id] : [],
        })),
      };
    });
  }

  async function createWorkflow() {
    await withErrorBoundary(async () => {
      await api<{ workflow: Workflow }>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({
          ...draft,
          name: slugify(draft.name),
          nodes: draft.nodes.map((node, index) => ({
            ...node,
            depends_on: index > 0 ? [draft.nodes[index - 1].id] : [],
          })),
        }),
      });
      setDraft(emptyDraft);
      setNodeSearch("");
      await refreshLists();
      setIsCreateWorkflowOpen(false);
    }, "工作流已创建");
  }

  function openCreateWorkflow() {
    setDraft(emptyDraft);
    setNodeSearch("");
    setIsCreateWorkflowOpen(true);
  }

  function closeCreateWorkflow() {
    if (busy) return;
    setIsCreateWorkflowOpen(false);
  }

  async function deleteWorkflow(name: string) {
    if (!window.confirm(`确认删除工作流定义 ${name}？历史运行记录不会被删除。`)) return;
    await withErrorBoundary(async () => {
      await api(`/api/workflows/${name}`, { method: "DELETE" });
      await refreshLists();
      if (selectedWorkflowName === name) {
        setSelectedWorkflowName("");
      }
    }, "工作流定义已删除");
  }

  async function confirmNode(nodeId: string) {
    if (!selectedRun) return;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${selectedRun.id}/nodes/${nodeId}/confirm`, {
        method: "POST",
        body: JSON.stringify({ note: "前端确认继续执行" }),
      });
      await refreshRun(selectedRun.id);
    });
  }

  async function stopRun() {
    if (!selectedRun) return;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${selectedRun.id}/stop`, { method: "POST" });
      await refreshRun(selectedRun.id);
      await refreshLists();
    }, "运行已停止");
  }

  async function deleteRun() {
    if (!selectedRun) return;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${selectedRun.id}`, { method: "DELETE" });
      setSelectedRunId("");
      setSelectedRun(null);
      await refreshLists();
    }, "运行已删除");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Local Workflow</p>
          <h1>Vibe Coding AI Workflow</h1>
        </div>

        <nav className="nav-tabs">
          <button className={page === "runs" ? "active" : ""} onClick={viewRunList}>运行控制台</button>
          <button className={page === "workflows" ? "active" : ""} onClick={viewWorkflowList}>工作流管理</button>
        </nav>
      </aside>

      <section className="content">
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        {page === "workflows" && (
          <WorkflowManagementView
            busy={busy}
            draft={draft}
            filteredNodes={filteredNodes}
            filteredWorkflows={filteredWorkflows}
            isCreateWorkflowOpen={isCreateWorkflowOpen}
            nodeSearch={nodeSearch}
            nodes={nodes}
            selectedWorkflow={selectedWorkflow}
            workflowSearch={workflowSearch}
            onAddDraftNode={addDraftNode}
            onCloseCreateWorkflow={closeCreateWorkflow}
            onCreateWorkflow={createWorkflow}
            onDeleteWorkflow={deleteWorkflow}
            onOpenCreateWorkflow={openCreateWorkflow}
            onRemoveDraftNode={removeDraftNode}
            onSelectWorkflow={setSelectedWorkflowName}
            onViewWorkflowList={viewWorkflowList}
            onSetDraft={setDraft}
            onSetNodeSearch={setNodeSearch}
            onSetWorkflowSearch={setWorkflowSearch}
            onStartWorkflow={startWorkflow}
            onUpdateDraftNodeId={updateDraftNodeId}
          />
        )}

        {page === "runs" && (
          <RunConsoleView
            busy={busy}
            runs={runs}
            selectedRun={selectedRun}
            onConfirmNode={confirmNode}
            onDeleteRun={deleteRun}
            onStopRun={stopRun}
            onViewRunList={viewRunList}
            onViewRun={viewRun}
            onViewWorkflow={viewWorkflow}
          />
        )}
      </section>
    </main>
  );
}

type WorkflowManagementProps = {
  busy: boolean;
  draft: WorkflowDraft;
  filteredNodes: NodeDefinition[];
  filteredWorkflows: Workflow[];
  isCreateWorkflowOpen: boolean;
  nodeSearch: string;
  nodes: NodeDefinition[];
  selectedWorkflow: Workflow | null;
  workflowSearch: string;
  onAddDraftNode: (node: NodeDefinition) => void;
  onCloseCreateWorkflow: () => void;
  onCreateWorkflow: () => void;
  onDeleteWorkflow: (name: string) => void;
  onOpenCreateWorkflow: () => void;
  onRemoveDraftNode: (index: number) => void;
  onSelectWorkflow: (name: string) => void;
  onViewWorkflowList: () => void;
  onSetDraft: React.Dispatch<React.SetStateAction<WorkflowDraft>>;
  onSetNodeSearch: (value: string) => void;
  onSetWorkflowSearch: (value: string) => void;
  onStartWorkflow: (name: string) => void;
  onUpdateDraftNodeId: (index: number, value: string) => void;
};

function WorkflowManagementView({
  busy,
  draft,
  filteredNodes,
  filteredWorkflows,
  isCreateWorkflowOpen,
  nodeSearch,
  nodes,
  selectedWorkflow,
  workflowSearch,
  onAddDraftNode,
  onCloseCreateWorkflow,
  onCreateWorkflow,
  onDeleteWorkflow,
  onOpenCreateWorkflow,
  onRemoveDraftNode,
  onSelectWorkflow,
  onViewWorkflowList,
  onSetDraft,
  onSetNodeSearch,
  onSetWorkflowSearch,
  onStartWorkflow,
  onUpdateDraftNodeId,
}: WorkflowManagementProps) {
  if (selectedWorkflow) {
    return (
      <section className="workflow-detail-page">
        <div className="section-header">
          <div>
            <p className="eyebrow">Workflow Detail</p>
            <h2>{selectedWorkflow.label ?? selectedWorkflow.name}</h2>
            <p className="muted">{selectedWorkflow.name}</p>
          </div>
          <div className="actions">
            <button onClick={onViewWorkflowList} disabled={busy}>返回工作流列表</button>
            <button onClick={() => onStartWorkflow(selectedWorkflow.name)} disabled={busy}>启动运行</button>
            <button className="danger-button" onClick={() => onDeleteWorkflow(selectedWorkflow.name)} disabled={busy}>删除定义</button>
            <span className="status">{selectedWorkflow.mode}</span>
          </div>
        </div>
        <div className="workflow-detail-meta">
          <span>{selectedWorkflow.mode}</span>
          <span>{selectedWorkflow.nodes.length} 个节点</span>
          {selectedWorkflow.path && <span>{selectedWorkflow.path}</span>}
        </div>
        {selectedWorkflow.description && <p>{selectedWorkflow.description}</p>}
        <div className="definition-node-list">
          {selectedWorkflow.nodes.map((node, index) => (
            <article className="definition-node" key={`${node.id}-${index}`}>
              <div className="node-index">{index + 1}</div>
              <div>
                <h3>{node.id}</h3>
                <p className="muted">{node.node}</p>
              </div>
              <span>{node.depends_on?.length ? `依赖 ${node.depends_on.join(", ")}` : "起始节点"}</span>
            </article>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <section className="management-list">
        <div className="section-header">
          <div>
            <p className="eyebrow">Workflow Registry</p>
            <h2>工作流管理</h2>
          </div>
          <div className="actions">
            <span className="count-pill">{filteredWorkflows.length} 个</span>
            <button onClick={onOpenCreateWorkflow} disabled={busy}>新增工作流</button>
          </div>
        </div>
        <input value={workflowSearch} onChange={(event) => onSetWorkflowSearch(event.target.value)} placeholder="按名称、展示名、描述或模式查询 workflow" />
        <div className="workflow-table">
          {filteredWorkflows.length === 0 && <p className="muted">没有匹配的工作流。</p>}
          {filteredWorkflows.map((workflow) => (
            <article className="workflow-row" key={workflow.name}>
              <div>
                <h3>{workflow.label ?? workflow.name}</h3>
                <p className="muted">{workflow.name}</p>
                {workflow.description && <p>{workflow.description}</p>}
                <div className="workflow-meta">
                  <span>{workflow.mode}</span>
                  <span>{workflow.nodes.length} 个节点</span>
                  {workflow.path && <span>{workflow.path}</span>}
                </div>
              </div>
              <div className="workflow-row-actions">
                <button onClick={() => onSelectWorkflow(workflow.name)} disabled={busy}>查看详情</button>
                <button onClick={() => onStartWorkflow(workflow.name)} disabled={busy}>启动运行</button>
                <button className="danger-button" onClick={() => onDeleteWorkflow(workflow.name)} disabled={busy}>删除定义</button>
              </div>
            </article>
          ))}
        </div>
      </section>

      {isCreateWorkflowOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={onCloseCreateWorkflow}>
          <section className="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="create-workflow-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Workflow Builder</p>
                <h2 id="create-workflow-title">新增工作流</h2>
              </div>
              <button onClick={onCloseCreateWorkflow} disabled={busy}>关闭</button>
            </div>

            <div className="modal-body">
              <div className="form-grid">
                <label>
                  名称
                  <input value={draft.name} onChange={(event) => onSetDraft({ ...draft, name: slugify(event.target.value) })} placeholder="customer-data-workflow" />
                </label>
                <label>
                  展示名
                  <input value={draft.label} onChange={(event) => onSetDraft({ ...draft, label: event.target.value })} placeholder="客户数据处理流程" />
                </label>
                <label>
                  模式
                  <select value={draft.mode} onChange={(event) => onSetDraft({ ...draft, mode: event.target.value as WorkflowMode })}>
                    <option value="manual-confirm">manual-confirm</option>
                    <option value="auto">auto</option>
                  </select>
                </label>
                <label className="span-2">
                  描述
                  <input value={draft.description} onChange={(event) => onSetDraft({ ...draft, description: event.target.value })} placeholder="描述这个工作流处理什么任务" />
                </label>
              </div>

              <div className="builder-grid">
                <section className="node-picker">
                  <div className="section-header compact">
                    <h3>选择节点</h3>
                    <span>{filteredNodes.length}/{nodes.length}</span>
                  </div>
                  <input value={nodeSearch} onChange={(event) => onSetNodeSearch(event.target.value)} placeholder="按名称、标签或描述筛选节点" />
                  <div className="available-nodes">
                    {filteredNodes.map((node) => (
                      <button className="available-node" key={node.name} onClick={() => onAddDraftNode(node)} disabled={busy}>
                        <strong>{node.label ?? node.name}</strong>
                        <span>{node.name}</span>
                        {node.description && <small>{node.description}</small>}
                      </button>
                    ))}
                    {filteredNodes.length === 0 && <p className="muted">没有匹配的节点</p>}
                  </div>
                </section>

                <section className="draft-flow">
                  <div className="section-header compact">
                    <h3>流程节点</h3>
                    <span>{draft.nodes.length} 个</span>
                  </div>
                  {draft.nodes.length === 0 && <p className="muted">从左侧选择节点加入流程。</p>}
                  {draft.nodes.map((node, index) => (
                    <article className="draft-node" key={`${node.node}-${index}`}>
                      <div className="node-index">{index + 1}</div>
                      <label>
                        节点 ID
                        <input value={node.id} onChange={(event) => onUpdateDraftNodeId(index, event.target.value)} />
                      </label>
                      <div>
                        <strong>{node.node}</strong>
                        <p className="muted">{index > 0 ? `依赖 ${draft.nodes[index - 1].id}` : "起始节点"}</p>
                      </div>
                      <button onClick={() => onRemoveDraftNode(index)} disabled={busy}>移除</button>
                    </article>
                  ))}
                </section>
              </div>
            </div>

            <div className="modal-footer">
              <button onClick={onCloseCreateWorkflow} disabled={busy}>取消</button>
              <button onClick={onCreateWorkflow} disabled={busy || !draft.name || draft.nodes.length === 0}>保存 workflow</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

type RunConsoleProps = {
  busy: boolean;
  runs: Run[];
  selectedRun: Run | null;
  onConfirmNode: (nodeId: string) => void;
  onDeleteRun: () => void;
  onStopRun: () => void;
  onViewRunList: () => void;
  onViewRun: (runId: string) => void;
  onViewWorkflow: (name: string) => void;
};

function RunConsoleView({ busy, runs, selectedRun, onConfirmNode, onDeleteRun, onStopRun, onViewRunList, onViewRun, onViewWorkflow }: RunConsoleProps) {
  if (selectedRun) {
    return (
      <section className="run-detail-page">
        <div className="section-header">
          <div>
            <p className="eyebrow">Run Detail</p>
            <h2>{selectedRun.workflowLabel}</h2>
            <p className="muted">{selectedRun.id}</p>
          </div>
          <div className="actions">
            <button onClick={onViewRunList} disabled={busy}>返回运行记录</button>
            <button onClick={() => onViewWorkflow(selectedRun.workflowName)} disabled={busy}>工作流定义</button>
            <span className={`status ${selectedRun.status}`}>{statusLabel(selectedRun.status)}</span>
            <button onClick={onStopRun} disabled={busy || selectedRun.status === "stopped"}>停止</button>
            <button onClick={onDeleteRun} disabled={busy}>删除</button>
          </div>
        </div>

        <div className="run-detail-meta">
          <span>{selectedRun.mode}</span>
          <span>开始：{selectedRun.startedAt}</span>
          {selectedRun.endedAt && <span>结束：{selectedRun.endedAt}</span>}
        </div>

        <div className="node-list">
          {selectedRun.workflow.nodes.map((node, index) => {
            const status = selectedRun.nodeStatuses?.[node.id];
            return (
              <article className="node-card" key={node.id}>
                <div className="node-index">{index + 1}</div>
                <div className="node-body">
                  <div className="node-title-row">
                    <h3>{node.id}</h3>
                    <span className={`status ${status?.status ?? "pending"}`}>{statusLabel(status?.status ?? "pending")}</span>
                  </div>
                  <p className="muted">{node.node}</p>
                  {status?.error && <p className="error-text">{status.error}</p>}
                  <div className="node-actions">
                    <a href={`${API_BASE}/ui/runs/${selectedRun.id}/nodes/${node.id}/`} target="_blank" rel="noreferrer">打开节点 UI</a>
                    {status?.status === "waiting-confirmation" && (
                      <button onClick={() => onConfirmNode(node.id)} disabled={busy}>确认继续</button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <section className="run-history">
        <div className="section-header">
          <div>
            <p className="eyebrow">Run History</p>
            <h2>运行记录</h2>
          </div>
          <span className="count-pill">{runs.length} 条</span>
        </div>
        <div className="run-table">
          {runs.length === 0 && <p className="muted">暂无运行记录。</p>}
          {runs.map((run) => (
            <article className="run-row" key={run.id}>
              <button className="run-row-main" onClick={() => onViewRun(run.id)} disabled={busy}>
                <span className={`status ${run.status}`}>{statusLabel(run.status)}</span>
                <span>
                  <strong>{run.workflowLabel}</strong>
                  <small>{run.id}</small>
                </span>
                <span className="run-time">{run.startedAt}</span>
              </button>
              <div className="workflow-row-actions">
                <button onClick={() => onViewRun(run.id)} disabled={busy}>查看节点状态</button>
                <button onClick={() => onViewWorkflow(run.workflowName)} disabled={busy}>工作流定义</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
