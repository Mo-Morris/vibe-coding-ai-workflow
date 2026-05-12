import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

type WorkflowNode = {
  id: string;
  node: string;
  depends_on?: string[];
};

type Workflow = {
  name: string;
  label?: string;
  description?: string;
  mode: "auto" | "manual-confirm";
  nodes: WorkflowNode[];
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
  mode: "auto" | "manual-confirm";
  status: string;
  currentNodeId?: string | null;
  startedAt: string;
  endedAt?: string | null;
  workflow: Workflow;
  nodeStatuses?: Record<string, NodeStatus>;
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

function App() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const selectedWorkflow = useMemo(() => workflows[0], [workflows]);

  async function refreshLists() {
    const [workflowData, runData] = await Promise.all([
      api<{ workflows: Workflow[] }>("/api/workflows"),
      api<{ runs: Run[] }>("/api/runs"),
    ]);
    setWorkflows(workflowData.workflows);
    setRuns(runData.runs);
    if (!selectedRunId && runData.runs[0]) {
      setSelectedRunId(runData.runs[0].id);
    }
  }

  async function refreshRun(runId = selectedRunId) {
    if (!runId) {
      setSelectedRun(null);
      return;
    }
    const run = await api<Run>(`/api/runs/${runId}`);
    setSelectedRun(run);
  }

  async function withErrorBoundary(action: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await action();
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
    });
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
    });
  }

  async function deleteRun() {
    if (!selectedRun) return;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${selectedRun.id}`, { method: "DELETE" });
      setSelectedRunId("");
      setSelectedRun(null);
      await refreshLists();
    });
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Local Workflow</p>
          <h1>Vibe Coding AI Workflow</h1>
        </div>
        <section className="panel">
          <h2>工作流</h2>
          {workflows.length === 0 && <p className="muted">未发现 workflow.md</p>}
          {workflows.map((workflow) => (
            <button className="workflow-button" key={workflow.name} onClick={() => startWorkflow(workflow.name)} disabled={busy}>
              <strong>{workflow.label ?? workflow.name}</strong>
              <span>{workflow.mode}</span>
            </button>
          ))}
        </section>
        <section className="panel">
          <h2>运行记录</h2>
          <select value={selectedRunId} onChange={(event) => setSelectedRunId(event.target.value)}>
            <option value="">选择运行</option>
            {runs.map((run) => (
              <option value={run.id} key={run.id}>
                {run.id}
              </option>
            ))}
          </select>
        </section>
      </aside>

      <section className="content">
        {error && <div className="error">{error}</div>}
        {!selectedRun && (
          <div className="empty-state">
            <h2>{selectedWorkflow ? "启动一个工作流" : "等待配置"}</h2>
            <p>{selectedWorkflow?.description ?? "在 examples/workflows 中添加 workflow.md 后即可运行。"}</p>
          </div>
        )}
        {selectedRun && (
          <>
            <header className="run-header">
              <div>
                <p className="eyebrow">{selectedRun.mode}</p>
                <h2>{selectedRun.workflowLabel}</h2>
                <p className="muted">{selectedRun.id}</p>
              </div>
              <div className="actions">
                <span className={`status ${selectedRun.status}`}>{statusLabel(selectedRun.status)}</span>
                <button onClick={stopRun} disabled={busy || selectedRun.status === "stopped"}>停止</button>
                <button onClick={deleteRun} disabled={busy}>删除</button>
              </div>
            </header>

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
                          <button onClick={() => confirmNode(node.id)} disabled={busy}>确认继续</button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
