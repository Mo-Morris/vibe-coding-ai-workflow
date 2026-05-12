import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

type Page = "runs" | "workflows" | "nodes";
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
  command?: string;
  ui?: {
    entry?: string;
  };
  capabilities?: Record<string, boolean>;
  path?: string;
  definitionPath?: string;
  rawDefinition?: string;
};

type NodeStatus = {
  id: string;
  node: string;
  status: string;
  startedAt?: string | null;
  endedAt?: string | null;
  error?: string | null;
  progress?: number;
  hasUi?: boolean;
  uiUrl?: string | null;
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

type NodeLogs = {
  stdout: string;
  stderr: string;
  combined: string;
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

/** 运行级状态（与后端 run.json 的 status 对齐） */
const RUN_STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: statusLabel("pending") },
  { value: "running", label: statusLabel("running") },
  { value: "success", label: statusLabel("success") },
  { value: "waiting-confirmation", label: statusLabel("waiting-confirmation") },
  { value: "failed", label: statusLabel("failed") },
  { value: "stopped", label: statusLabel("stopped") },
  { value: "stopping", label: statusLabel("stopping") },
];

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确认",
  cancelText = "取消",
  danger,
  busy,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-dialog modal-dialog-compact"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <p className="eyebrow">确认操作</p>
            <h2 id="confirm-dialog-title">{title}</h2>
          </div>
        </div>
        <div className="modal-body">
          <p id="confirm-dialog-desc" className="confirm-dialog-text">
            {description}
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            {cancelText}
          </button>
          <button type="button" className={danger ? "danger-button" : "primary-button"} onClick={onConfirm} disabled={busy}>
            {confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

type RouteSnapshot = {
  page: Page;
  selectedRunId: string;
  selectedWorkflowName: string;
  selectedNodeName: string;
};

function decodeRouteSegment(segment: string) {
  try {
    return decodeURIComponent(segment.replace(/\+/g, " "));
  } catch {
    return segment;
  }
}

function readRouteFromHash(): RouteSnapshot {
  const fallback: RouteSnapshot = {
    page: "runs",
    selectedRunId: "",
    selectedWorkflowName: "",
    selectedNodeName: "",
  };
  let raw = window.location.hash.replace(/^#/, "").trim();
  if (!raw || raw === "/") return fallback;
  if (!raw.startsWith("/")) raw = `/${raw}`;
  const parts = raw.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return fallback;

  const root = parts[0];
  if (root === "runs") {
    const runId = parts[1] ? decodeRouteSegment(parts[1]) : "";
    return { page: "runs", selectedRunId: runId, selectedWorkflowName: "", selectedNodeName: "" };
  }
  if (root === "workflows") {
    const workflowName = parts[1] ? decodeRouteSegment(parts[1]) : "";
    return { page: "workflows", selectedRunId: "", selectedWorkflowName: workflowName, selectedNodeName: "" };
  }
  if (root === "nodes") {
    const nodeName = parts[1] ? decodeRouteSegment(parts[1]) : "";
    return { page: "nodes", selectedRunId: "", selectedWorkflowName: "", selectedNodeName: nodeName };
  }
  return fallback;
}

function buildHashFromRoute(route: RouteSnapshot) {
  const { page, selectedRunId, selectedWorkflowName, selectedNodeName } = route;
  if (page === "runs") {
    return selectedRunId ? `#/runs/${encodeURIComponent(selectedRunId)}` : "#/runs";
  }
  if (page === "workflows") {
    return selectedWorkflowName ? `#/workflows/${encodeURIComponent(selectedWorkflowName)}` : "#/workflows";
  }
  if (page === "nodes") {
    return selectedNodeName ? `#/nodes/${encodeURIComponent(selectedNodeName)}` : "#/nodes";
  }
  return "#/runs";
}

const initialRoute = readRouteFromHash();

function App() {
  const [page, setPage] = useState<Page>(initialRoute.page);
  const [nodes, setNodes] = useState<NodeDefinition[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>(initialRoute.selectedRunId);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [selectedWorkflowName, setSelectedWorkflowName] = useState<string>(initialRoute.selectedWorkflowName);
  const [selectedNodeName, setSelectedNodeName] = useState<string>(initialRoute.selectedNodeName);
  const [selectedNode, setSelectedNode] = useState<NodeDefinition | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  const [isCreateWorkflowOpen, setIsCreateWorkflowOpen] = useState(false);
  const [nodeSearch, setNodeSearch] = useState("");
  const [nodeRegistrySearch, setNodeRegistrySearch] = useState("");
  const [workflowSearch, setWorkflowSearch] = useState("");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [runDeleteDialog, setRunDeleteDialog] = useState<{ runId: string; workflowLabel: string } | null>(null);

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

  const filteredRegistryNodes = useMemo(() => {
    const query = nodeRegistrySearch.trim().toLowerCase();
    if (!query) return nodes;
    return nodes.filter((node) => {
      const capabilityText = Object.entries(node.capabilities ?? {})
        .map(([key, value]) => `${key}:${value}`)
        .join(" ");
      const haystack = `${node.name} ${node.label ?? ""} ${node.description ?? ""} ${node.command ?? ""} ${capabilityText}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [nodeRegistrySearch, nodes]);

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
    const next = buildHashFromRoute({
      page,
      selectedRunId,
      selectedWorkflowName,
      selectedNodeName,
    });
    if (window.location.hash !== next) {
      window.location.hash = next;
    }
  }, [page, selectedRunId, selectedWorkflowName, selectedNodeName]);

  useEffect(() => {
    const onHashChange = () => {
      const route = readRouteFromHash();
      setPage(route.page);
      setSelectedRunId(route.selectedRunId);
      setSelectedWorkflowName(route.selectedWorkflowName);
      setSelectedNodeName(route.selectedNodeName);
      setSelectedRun(null);
      setSelectedNode(null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (page !== "nodes" || !selectedNodeName.trim()) {
      return;
    }
    const name = selectedNodeName;
    let cancelled = false;
    void (async () => {
      try {
        const node = await api<NodeDefinition>(`/api/nodes/${name}`);
        if (!cancelled) {
          setSelectedNode(node);
        }
      } catch {
        if (!cancelled) {
          setSelectedNode(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page, selectedNodeName]);

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

  function viewNode(name: string) {
    setSelectedNodeName(name);
    setPage("nodes");
  }

  function viewNodeList() {
    setSelectedNodeName("");
    setSelectedNode(null);
    setPage("nodes");
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

  function openRunDeleteDialog(run: Pick<Run, "id" | "workflowLabel">) {
    setRunDeleteDialog({ runId: run.id, workflowLabel: run.workflowLabel });
  }

  async function confirmRunDelete() {
    if (!runDeleteDialog) return;
    const { runId } = runDeleteDialog;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${runId}`, { method: "DELETE" });
      if (selectedRunId === runId) {
        setSelectedRunId("");
        setSelectedRun(null);
      }
      await refreshLists();
      setRunDeleteDialog(null);
    }, "运行已删除");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand-logo" href="#/" aria-label="Vibe Coding AI Workflow 首页">
          <svg viewBox="0 0 246 72" role="img" aria-labelledby="brand-logo-title">
            <title id="brand-logo-title">Vibe Coding AI Workflow</title>
            <defs>
              <linearGradient id="logo-mark-gradient" x1="7" x2="63" y1="8" y2="64" gradientUnits="userSpaceOnUse">
                <stop stopColor="#5EEAD4" />
                <stop offset="0.55" stopColor="#60A5FA" />
                <stop offset="1" stopColor="#A78BFA" />
              </linearGradient>
            </defs>
            <path
              d="M20 9h32c6.63 0 12 5.37 12 12v30c0 6.63-5.37 12-12 12H20C13.37 63 8 57.63 8 51V21C8 14.37 13.37 9 20 9Z"
              fill="url(#logo-mark-gradient)"
            />
            <path d="M25 23 15 36l10 13" fill="none" stroke="#0F172A" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5" />
            <path d="M47 23 57 36 47 49" fill="none" stroke="#0F172A" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5" />
            <path d="M40 20 31 52" fill="none" stroke="#F8FAFC" strokeLinecap="round" strokeWidth="5" />
            <circle cx="54" cy="18" r="4" fill="#F8FAFC" />
            <path d="M83 23h19.4l-9.7 27.2L83 23Z" fill="#F8FAFC" />
            <path d="M104.5 50.2V23h6.2v27.2h-6.2Z" fill="#F8FAFC" />
            <path d="M117 50.2V23h18.9v5.2h-12.7v5.5h11.4v5h-11.4V45h13.1v5.2H117Z" fill="#F8FAFC" />
            <path
              d="M145.7 50.2V23h9.9c8.5 0 14.1 5.4 14.1 13.6 0 8.1-5.6 13.6-14.1 13.6h-9.9Zm6.2-5.3h3.4c5 0 8-3.1 8-8.3 0-5.2-3-8.3-8-8.3h-3.4v16.6Z"
              fill="#F8FAFC"
            />
            <path d="M174.4 50.2V23h6.2v27.2h-6.2Z" fill="#F8FAFC" />
            <path d="M187.2 50.2V23h5.3l12.3 16.8V23h6v27.2h-5.2l-12.4-16.9v16.9h-6Z" fill="#F8FAFC" />
            <path d="M216.7 50.2V23h18.8v5.2h-12.6v5.5h11.3v5h-11.3V45H236v5.2h-19.3Z" fill="#F8FAFC" />
            <text x="84" y="64" fill="#94A3B8" fontFamily="Inter, ui-sans-serif, system-ui" fontSize="9" fontWeight="700" letterSpacing="1.8">
              AI WORKFLOW
            </text>
          </svg>
        </a>

        <nav className="nav-tabs">
          <button className={page === "runs" ? "active" : ""} onClick={viewRunList}>运行控制台</button>
          <button className={page === "workflows" ? "active" : ""} onClick={viewWorkflowList}>工作流管理</button>
          <button className={page === "nodes" ? "active" : ""} onClick={viewNodeList}>节点管理</button>
        </nav>
      </aside>

      <section className="content">
        <ConfirmDialog
          open={runDeleteDialog !== null}
          title="删除运行记录"
          description={
            runDeleteDialog
              ? `确定要删除「${runDeleteDialog.workflowLabel}」的运行记录吗？\n运行 ID：${runDeleteDialog.runId}\n删除后无法恢复。`
              : ""
          }
          confirmText="删除"
          cancelText="取消"
          danger
          busy={busy}
          onClose={() => {
            if (!busy) setRunDeleteDialog(null);
          }}
          onConfirm={confirmRunDelete}
        />

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
            workflows={workflows}
            onConfirmNode={confirmNode}
            onRequestDeleteRun={openRunDeleteDialog}
            onDeleteRun={() => {
              if (selectedRun) openRunDeleteDialog(selectedRun);
            }}
            onStopRun={stopRun}
            onViewRunList={viewRunList}
            onViewRun={viewRun}
            onViewWorkflow={viewWorkflow}
          />
        )}

        {page === "nodes" && (
          <NodeManagementView
            busy={busy}
            filteredNodes={filteredRegistryNodes}
            nodeSearch={nodeRegistrySearch}
            nodes={nodes}
            selectedNode={selectedNode}
            onSetNodeSearch={setNodeRegistrySearch}
            onViewNode={viewNode}
            onViewNodeList={viewNodeList}
          />
        )}
      </section>
    </main>
  );
}

type NodeManagementProps = {
  busy: boolean;
  filteredNodes: NodeDefinition[];
  nodeSearch: string;
  nodes: NodeDefinition[];
  selectedNode: NodeDefinition | null;
  onSetNodeSearch: (value: string) => void;
  onViewNode: (name: string) => void;
  onViewNodeList: () => void;
};

function capabilityEntries(node: NodeDefinition) {
  return Object.entries(node.capabilities ?? {});
}

function NodeManagementView({ busy, filteredNodes, nodeSearch, nodes, selectedNode, onSetNodeSearch, onViewNode, onViewNodeList }: NodeManagementProps) {
  if (selectedNode) {
    const capabilities = capabilityEntries(selectedNode);
    return (
      <section className="node-detail-page">
        <div className="section-header">
          <div>
            <p className="eyebrow">Node Detail</p>
            <h2>{selectedNode.label ?? selectedNode.name}</h2>
            <p className="muted">{selectedNode.name}</p>
          </div>
          <div className="actions">
            <button className="secondary-button" onClick={onViewNodeList} disabled={busy}>返回节点列表</button>
          </div>
        </div>

        <div className="node-detail-grid">
          <section className="node-definition-summary">
            {selectedNode.description && <p>{selectedNode.description}</p>}
            <div className="definition-fields">
              <div>
                <span>命令</span>
                <strong>{selectedNode.command ?? "未配置"}</strong>
              </div>
              <div>
                <span>UI 入口</span>
                <strong>{selectedNode.ui?.entry ?? "未配置"}</strong>
              </div>
              <div>
                <span>节点目录</span>
                <strong>{selectedNode.path ?? "未配置"}</strong>
              </div>
              <div>
                <span>定义文件</span>
                <strong>{selectedNode.definitionPath ?? "未配置"}</strong>
              </div>
            </div>
          </section>

          <section className="node-capabilities">
            <div className="section-header compact">
              <h3>能力</h3>
              <span>{capabilities.length} 项</span>
            </div>
            <div className="capability-list">
              {capabilities.length === 0 && <p className="muted">未声明能力。</p>}
              {capabilities.map(([name, enabled]) => (
                <span className={`capability-pill ${enabled ? "enabled" : "disabled"}`} key={name}>
                  {name}
                  <em>{enabled ? "开启" : "关闭"}</em>
                </span>
              ))}
            </div>
          </section>
        </div>

        <section className="definition-source">
          <div className="section-header compact">
            <h3>node.md 定义</h3>
          </div>
          <pre>{selectedNode.rawDefinition ?? "暂无定义内容。"}</pre>
        </section>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <section className="management-list">
        <div className="section-header">
          <div>
            <p className="eyebrow">Node Registry</p>
            <h2>节点管理</h2>
          </div>
          <span className="count-pill">{filteredNodes.length}/{nodes.length} 个</span>
        </div>
        <input value={nodeSearch} onChange={(event) => onSetNodeSearch(event.target.value)} placeholder="按名称、展示名、描述、命令或能力查询节点" />
        <div className="node-table">
          {filteredNodes.length === 0 && <p className="muted">没有匹配的节点。</p>}
          {filteredNodes.map((node) => {
            const capabilities = capabilityEntries(node);
            return (
              <article className="node-row" key={node.name}>
                <div>
                  <h3>{node.label ?? node.name}</h3>
                  <p className="muted">{node.name}</p>
                  {node.description && <p>{node.description}</p>}
                  <div className="workflow-meta">
                    {node.command && <span>{node.command}</span>}
                    {node.ui?.entry && <span>UI: {node.ui.entry}</span>}
                    {node.path && <span>{node.path}</span>}
                  </div>
                  {capabilities.length > 0 && (
                    <div className="capability-list compact-list">
                      {capabilities.map(([name, enabled]) => (
                        <span className={`capability-pill ${enabled ? "enabled" : "disabled"}`} key={name}>
                          {name}
                          <em>{enabled ? "开启" : "关闭"}</em>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="workflow-row-actions">
                  <button onClick={() => onViewNode(node.name)} disabled={busy}>查看定义</button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
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
            <button className="secondary-button" onClick={onViewWorkflowList} disabled={busy}>返回工作流列表</button>
            <button className="primary-button" onClick={() => onStartWorkflow(selectedWorkflow.name)} disabled={busy}>启动运行</button>
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
            <button className="primary-button" onClick={onOpenCreateWorkflow} disabled={busy}>新增工作流</button>
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
                <button className="primary-button" onClick={() => onStartWorkflow(workflow.name)} disabled={busy}>启动运行</button>
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
              <button className="secondary-button" onClick={onCloseCreateWorkflow} disabled={busy}>关闭</button>
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
              <button className="secondary-button" onClick={onCloseCreateWorkflow} disabled={busy}>取消</button>
              <button className="primary-button" onClick={onCreateWorkflow} disabled={busy || !draft.name || draft.nodes.length === 0}>保存 workflow</button>
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
  workflows: Workflow[];
  onConfirmNode: (nodeId: string) => void;
  onRequestDeleteRun: (run: Pick<Run, "id" | "workflowLabel">) => void;
  onDeleteRun: () => void;
  onStopRun: () => void;
  onViewRunList: () => void;
  onViewRun: (runId: string) => void;
  onViewWorkflow: (name: string) => void;
};

function RunConsoleView({
  busy,
  runs,
  selectedRun,
  workflows,
  onConfirmNode,
  onRequestDeleteRun,
  onDeleteRun,
  onStopRun,
  onViewRunList,
  onViewRun,
  onViewWorkflow,
}: RunConsoleProps) {
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedNodeLogs, setSelectedNodeLogs] = useState<NodeLogs>({ stdout: "", stderr: "", combined: "" });
  const [logError, setLogError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterWorkflowName, setFilterWorkflowName] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  const sortedWorkflowOptions = useMemo(
    () => [...workflows].sort((a, b) => a.name.localeCompare(b.name)),
    [workflows],
  );

  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (filterWorkflowName && run.workflowName !== filterWorkflowName) return false;
      if (filterStatus && run.status !== filterStatus) return false;
      if (filterFrom.trim() || filterTo.trim()) {
        const started = Date.parse(run.startedAt);
        if (!Number.isNaN(started)) {
          if (filterFrom.trim()) {
            const fromMs = Date.parse(filterFrom);
            if (!Number.isNaN(fromMs) && started < fromMs) return false;
          }
          if (filterTo.trim()) {
            const toMs = Date.parse(filterTo);
            if (!Number.isNaN(toMs) && started > toMs) return false;
          }
        }
      }
      return true;
    });
  }, [runs, filterFrom, filterTo, filterWorkflowName, filterStatus]);

  const hasRunFilters = Boolean(filterFrom.trim() || filterTo.trim() || filterWorkflowName || filterStatus);

  function clearRunFilters() {
    setFilterFrom("");
    setFilterTo("");
    setFilterWorkflowName("");
    setFilterStatus("");
  }

  useEffect(() => {
    if (!selectedRun) {
      setSelectedNodeId("");
      return;
    }
    const currentNodeId = selectedRun.currentNodeId ?? selectedRun.workflow.nodes[0]?.id ?? "";
    const stillExists = selectedRun.workflow.nodes.some((node) => node.id === selectedNodeId);
    if (!selectedNodeId || !stillExists) {
      setSelectedNodeId(currentNodeId);
    }
  }, [selectedNodeId, selectedRun]);

  useEffect(() => {
    if (!selectedRun || !selectedNodeId) {
      setSelectedNodeLogs({ stdout: "", stderr: "", combined: "" });
      return;
    }

    let cancelled = false;
    async function loadLogs() {
      try {
        const logs = await api<NodeLogs>(`/api/runs/${selectedRun!.id}/nodes/${selectedNodeId}/logs`);
        if (!cancelled) {
          setSelectedNodeLogs(logs);
          setLogError("");
        }
      } catch (err) {
        if (!cancelled) {
          setLogError(err instanceof Error ? err.message : "日志读取失败");
        }
      }
    }

    void loadLogs();
    const timer = window.setInterval(loadLogs, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedNodeId, selectedRun]);

  if (selectedRun) {
    const selectedWorkflowNode = selectedRun.workflow.nodes.find((node) => node.id === selectedNodeId) ?? selectedRun.workflow.nodes[0];
    const selectedStatus = selectedWorkflowNode ? selectedRun.nodeStatuses?.[selectedWorkflowNode.id] : undefined;
    const selectedLogText = selectedNodeLogs.combined || "暂无运行日志。";

    return (
      <section className="run-detail-page">
        <div className="section-header">
          <div>
            <p className="eyebrow">Run Detail</p>
            <h2>{selectedRun.workflowLabel}</h2>
            <p className="muted">{selectedRun.id}</p>
          </div>
          <div className="actions">
            <button className="secondary-button" onClick={onViewRunList} disabled={busy}>返回运行记录</button>
            <button onClick={() => onViewWorkflow(selectedRun.workflowName)} disabled={busy}>工作流定义</button>
            <span className={`status ${selectedRun.status}`}>{statusLabel(selectedRun.status)}</span>
            <button className="danger-button" onClick={onStopRun} disabled={busy || selectedRun.status === "stopped"}>停止</button>
            <button className="danger-button" onClick={onDeleteRun} disabled={busy}>删除</button>
          </div>
        </div>

        <div className="run-detail-meta">
          <span>{selectedRun.mode}</span>
          <span>开始：{selectedRun.startedAt}</span>
          {selectedRun.endedAt && <span>结束：{selectedRun.endedAt}</span>}
        </div>

        <div className="run-workspace">
          <aside className="run-node-rail" aria-label="运行节点">
            {selectedRun.workflow.nodes.map((node, index) => {
              const status = selectedRun.nodeStatuses?.[node.id];
              return (
                <button
                  className={`run-step ${selectedNodeId === node.id ? "active" : ""}`}
                  key={node.id}
                  onClick={() => setSelectedNodeId(node.id)}
                  disabled={busy}
                >
                  <span>
                    Step {index + 1} {node.id}
                    <em>{statusLabel(status?.status ?? "pending")}</em>
                  </span>
                  <small>{node.node}</small>
                </button>
              );
            })}
          </aside>

          <section className="run-node-panel">
            {selectedWorkflowNode && (
              <>
                <div className="node-panel-header">
                  <div>
                    <h3>{selectedWorkflowNode.id}</h3>
                    <p className="muted">{selectedWorkflowNode.node}</p>
                  </div>
                  <div className="node-actions">
                    <span className={`status ${selectedStatus?.status ?? "pending"}`}>{statusLabel(selectedStatus?.status ?? "pending")}</span>
                    {selectedStatus?.status === "waiting-confirmation" && (
                      <button className="primary-button" onClick={() => onConfirmNode(selectedWorkflowNode.id)} disabled={busy}>确认继续</button>
                    )}
                  </div>
                </div>

                {selectedStatus?.error && <p className="error-text">{selectedStatus.error}</p>}

                {selectedStatus?.hasUi ? (
                  <iframe
                    className="node-ui-frame"
                    title={`${selectedWorkflowNode.id} UI`}
                    src={`${API_BASE}${selectedStatus.uiUrl}`}
                  />
                ) : (
                  <div className="node-console-wrap">
                    <div className="console-title">运行日志</div>
                    {logError && <p className="error-text">{logError}</p>}
                    <pre className="node-console">{selectedLogText}</pre>
                  </div>
                )}
              </>
            )}
          </section>
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
          <span className="count-pill">
            {filteredRuns.length}
            {hasRunFilters ? ` / ${runs.length}` : ""} 条
          </span>
        </div>

        <div className="run-filters" role="search" aria-label="筛选运行记录">
          <label className="run-filter-field">
            <span>开始时间（含）</span>
            <input type="datetime-local" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </label>
          <label className="run-filter-field">
            <span>结束时间（含）</span>
            <input type="datetime-local" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
          </label>
          <label className="run-filter-field">
            <span>工作流</span>
            <select value={filterWorkflowName} onChange={(e) => setFilterWorkflowName(e.target.value)}>
              <option value="">全部工作流</option>
              {sortedWorkflowOptions.map((wf) => (
                <option key={wf.name} value={wf.name}>
                  {wf.label ?? wf.name} ({wf.name})
                </option>
              ))}
            </select>
          </label>
          <label className="run-filter-field">
            <span>运行状态</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">全部状态</option>
              {RUN_STATUS_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <div className="run-filter-actions">
            <button type="button" className="secondary-button" onClick={clearRunFilters} disabled={busy || !hasRunFilters}>
              清除筛选
            </button>
          </div>
        </div>

        <div className="run-table">
          {runs.length === 0 && <p className="muted">暂无运行记录。</p>}
          {runs.length > 0 && filteredRuns.length === 0 && <p className="muted">没有符合筛选条件的运行记录。</p>}
          {filteredRuns.map((run) => (
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
                <button className="danger-button" onClick={() => onRequestDeleteRun(run)} disabled={busy}>删除</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
