import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const API_ORIGIN = new URL(API_BASE, window.location.href).origin;

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
  tags?: string[];
  command?: string;
  validationInputExample?: unknown;
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
  supportsParams?: boolean;
  uiUrl?: string | null;
};

type NodeProgress = {
  runId: string;
  nodeId: string;
  status: string;
  progress: number;
  startedAt?: string | null;
  endedAt?: string | null;
  error?: string | null;
};

type Run = {
  id: string;
  kind?: string;
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
  description: string;
  mode: WorkflowMode;
  nodes: WorkflowNode[];
};

type NodeLogs = {
  stdout: string;
  stderr: string;
  combined: string;
  stdoutOffset: number;
  stderrOffset: number;
};

type DataPreview = {
  nodeId: string;
  kind: "array" | "object" | "primitive" | "empty";
  total: number;
  preview: unknown;
};

type ValidationInput = {
  runId: string;
  nodeId: string;
  input: unknown;
};

type DataPreviewDialog = {
  sourceNodeId: string;
  sourceNodeName: string;
  data: DataPreview | null;
  loading: boolean;
  error: string;
} | null;

type ImagePreviewDialog = {
  imageUrl: string;
} | null;

const emptyDraft: WorkflowDraft = {
  name: "",
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

function runStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "等待",
    running: "运行中",
    success: "成功",
    "waiting-confirmation": "待确认",
    confirmed: "已确认",
    failed: "失败",
    stopped: "已停止",
    terminated: "已终止",
    stopping: "停止中",
  };
  return labels[status] ?? status;
}

function nodeStatusLabel(status: string) {
  if (status === "stopped") return "已终止";
  return runStatusLabel(status);
}

function formatDateTime(value?: string | null) {
  if (!value) return "";
  const normalized = value.replace("T", " ");
  return normalized.length >= 19 ? normalized.slice(0, 19) : normalized;
}

/** 运行级状态（与后端 run.json 的 status 对齐） */
const RUN_STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "pending", label: runStatusLabel("pending") },
  { value: "running", label: runStatusLabel("running") },
  { value: "success", label: runStatusLabel("success") },
  { value: "failed", label: runStatusLabel("failed") },
  { value: "stopped", label: runStatusLabel("stopped") },
  { value: "terminated", label: runStatusLabel("terminated") },
  { value: "stopping", label: runStatusLabel("stopping") },
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

type ToastItem = {
  id: string;
  variant: "error" | "success";
  message: string;
};

const TOAST_MAX = 6;

function ToastHost({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <article
          key={toast.id}
          className={`toast toast-${toast.variant}`}
          role="status"
          aria-live={toast.variant === "error" ? "assertive" : "polite"}
        >
          <div className="toast-accent" aria-hidden />
          <div className="toast-main">
            <p className="toast-title">{toast.variant === "error" ? "错误" : "提示"}</p>
            <p className="toast-message">{toast.message}</p>
          </div>
          <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="关闭">
            <span aria-hidden>×</span>
          </button>
        </article>
      ))}
    </div>
  );
}

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
  nodeValidationRunId: string;
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
    nodeValidationRunId: "",
  };
  let raw = window.location.hash.replace(/^#/, "").trim();
  if (!raw || raw === "/") return fallback;
  if (!raw.startsWith("/")) raw = `/${raw}`;
  const parts = raw.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return fallback;

  const root = parts[0];
  if (root === "runs") {
    const runId = parts[1] ? decodeRouteSegment(parts[1]) : "";
    return { page: "runs", selectedRunId: runId, selectedWorkflowName: "", selectedNodeName: "", nodeValidationRunId: "" };
  }
  if (root === "workflows") {
    const workflowName = parts[1] ? decodeRouteSegment(parts[1]) : "";
    return { page: "workflows", selectedRunId: "", selectedWorkflowName: workflowName, selectedNodeName: "", nodeValidationRunId: "" };
  }
  if (root === "nodes") {
    const nodeName = parts[1] ? decodeRouteSegment(parts[1]) : "";
    const validationRunId = parts[2] === "validate" && parts[3] ? decodeRouteSegment(parts[3]) : "";
    return { page: "nodes", selectedRunId: "", selectedWorkflowName: "", selectedNodeName: nodeName, nodeValidationRunId: validationRunId };
  }
  return fallback;
}

function buildHashFromRoute(route: RouteSnapshot) {
  const { page, selectedRunId, selectedWorkflowName, selectedNodeName, nodeValidationRunId } = route;
  if (page === "runs") {
    return selectedRunId ? `#/runs/${encodeURIComponent(selectedRunId)}` : "#/runs";
  }
  if (page === "workflows") {
    return selectedWorkflowName ? `#/workflows/${encodeURIComponent(selectedWorkflowName)}` : "#/workflows";
  }
  if (page === "nodes") {
    if (selectedNodeName && nodeValidationRunId) {
      return `#/nodes/${encodeURIComponent(selectedNodeName)}/validate/${encodeURIComponent(nodeValidationRunId)}`;
    }
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
  const [nodeValidationRunId, setNodeValidationRunId] = useState<string>(initialRoute.nodeValidationRunId);
  const [nodeValidationRun, setNodeValidationRun] = useState<Run | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeDefinition | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  const [isCreateWorkflowOpen, setIsCreateWorkflowOpen] = useState(false);
  const [nodeSearch, setNodeSearch] = useState("");
  const [nodeRegistrySearch, setNodeRegistrySearch] = useState("");
  const [workflowSearch, setWorkflowSearch] = useState("");
  const [toasts, setToasts] = useState<ToastItem[]>([]);
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
      const tagText = (node.tags ?? []).join(" ");
      const haystack = `${node.name} ${node.label ?? ""} ${node.description ?? ""} ${tagText}`.toLowerCase();
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
      const tagText = (node.tags ?? []).join(" ");
      const haystack = `${node.name} ${node.label ?? ""} ${node.description ?? ""} ${node.command ?? ""} ${capabilityText} ${tagText}`.toLowerCase();
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

  async function refreshNodeValidation(runId = nodeValidationRunId) {
    if (!runId) {
      setNodeValidationRun(null);
      return;
    }
    const run = await api<Run>(`/api/runs/${runId}`);
    setNodeValidationRun(run);
  }

  const pushToast = useCallback((variant: ToastItem["variant"], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setToasts((prev) => [...prev.slice(-(TOAST_MAX - 1)), { id, variant, message }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  async function withErrorBoundary(action: () => Promise<void>, successMessage = "") {
    setBusy(true);
    try {
      await action();
      if (successMessage) pushToast("success", successMessage);
    } catch (err) {
      pushToast("error", err instanceof Error ? err.message : "操作失败");
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
      nodeValidationRunId,
    });
    if (window.location.hash !== next) {
      window.location.hash = next;
    }
  }, [page, selectedRunId, selectedWorkflowName, selectedNodeName, nodeValidationRunId]);

  useEffect(() => {
    const onHashChange = () => {
      const route = readRouteFromHash();
      setPage(route.page);
      setSelectedRunId(route.selectedRunId);
      setSelectedWorkflowName(route.selectedWorkflowName);
      setSelectedNodeName(route.selectedNodeName);
      setNodeValidationRunId(route.nodeValidationRunId);
      setSelectedRun(null);
      setSelectedNode(null);
      setNodeValidationRun(null);
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

  useEffect(() => {
    if (!nodeValidationRunId) {
      setNodeValidationRun(null);
      return;
    }
    let cancelled = false;

    async function loadValidationRun() {
      try {
        const run = await api<Run>(`/api/runs/${nodeValidationRunId}`);
        if (!cancelled) setNodeValidationRun(run);
      } catch (err) {
        if (!cancelled) pushToast("error", err instanceof Error ? err.message : "立即运行记录读取失败");
      }
    }

    void loadValidationRun();
    const timer = window.setInterval(() => {
      void loadValidationRun();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [nodeValidationRunId, pushToast]);

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

  async function startNodeValidation(name: string) {
    await withErrorBoundary(async () => {
      const created = await api<{ runId: string; run: Run }>(`/api/nodes/${name}/validations`, {
        method: "POST",
      });
      setSelectedNodeName(name);
      setNodeValidationRunId(created.runId);
      setNodeValidationRun(created.run);
      setPage("nodes");
    }, "已开始立即运行");
  }

  function viewWorkflow(name: string) {
    setSelectedWorkflowName(name);
    setNodeValidationRunId("");
    setNodeValidationRun(null);
    setPage("workflows");
  }

  function viewWorkflowList() {
    setSelectedWorkflowName("");
    setNodeValidationRunId("");
    setNodeValidationRun(null);
    setPage("workflows");
  }

  function viewNode(name: string) {
    setSelectedNodeName(name);
    setNodeValidationRunId("");
    setNodeValidationRun(null);
    setPage("nodes");
  }

  function viewNodeList() {
    setSelectedNodeName("");
    setSelectedNode(null);
    setNodeValidationRunId("");
    setNodeValidationRun(null);
    setPage("nodes");
  }

  function viewRun(runId: string) {
    setSelectedRunId(runId);
    setNodeValidationRunId("");
    setNodeValidationRun(null);
    void refreshRun(runId);
  }

  function viewRunList() {
    setSelectedRunId("");
    setSelectedRun(null);
    setNodeValidationRunId("");
    setNodeValidationRun(null);
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
          name: draft.name.trim(),
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

  async function retryNode(nodeId: string) {
    if (!selectedRun) return;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${selectedRun.id}/nodes/${nodeId}/retry`, { method: "POST" });
      await refreshRun(selectedRun.id);
      await refreshLists();
    }, "节点已重新运行");
  }

  async function stopNode(nodeId: string) {
    if (!selectedRun) return;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${selectedRun.id}/nodes/${nodeId}/stop`, { method: "POST" });
      await refreshRun(selectedRun.id);
      await refreshLists();
    }, "节点已停止");
  }

  async function retryValidationNode(nodeId: string) {
    if (!nodeValidationRun) return;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${nodeValidationRun.id}/nodes/${nodeId}/retry`, { method: "POST" });
      await refreshNodeValidation(nodeValidationRun.id);
    }, "节点已重新运行");
  }

  async function stopValidationNode(nodeId: string) {
    if (!nodeValidationRun) return;
    await withErrorBoundary(async () => {
      await api(`/api/runs/${nodeValidationRun.id}/nodes/${nodeId}/stop`, { method: "POST" });
      await refreshNodeValidation(nodeValidationRun.id);
    }, "节点已停止");
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
        <a className="brand-lockup" href="#/" aria-label="Vibe Coding AI Workflow 首页">
          <span className="brand-logo" aria-hidden="true">
            <svg viewBox="0 0 72 72" role="img" aria-labelledby="brand-logo-title">
              <title id="brand-logo-title">Vibe Coding AI Workflow</title>
              <defs>
                <linearGradient id="logo-mark-gradient" x1="8" x2="64" y1="8" y2="64" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#5EEAD4" />
                  <stop offset="0.55" stopColor="#60A5FA" />
                  <stop offset="1" stopColor="#A78BFA" />
                </linearGradient>
                <linearGradient id="logo-v-gradient" x1="20" x2="52" y1="18" y2="56" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#F8FAFC" />
                  <stop offset="1" stopColor="#DFFBFF" />
                </linearGradient>
              </defs>
              <rect x="8" y="8" width="56" height="56" rx="14" fill="url(#logo-mark-gradient)" />
              <path d="M18 20h10l8 23 8-23h10L41 54H31L18 20Z" fill="#0F172A" opacity="0.9" />
              <path d="M22 20h8.5L36 40.5 41.5 20H50L39 52H33L22 20Z" fill="url(#logo-v-gradient)" />
              <path d="M30 20h6l-3.5 13.5L26 20h4Z" fill="#BFF5EF" opacity="0.78" />
              <circle cx="36" cy="52" r="3.8" fill="#F8FAFC" />
              <path d="M20 36h8" stroke="#0F172A" strokeLinecap="round" strokeWidth="4" opacity="0.55" />
              <path d="M44 36h8" stroke="#0F172A" strokeLinecap="round" strokeWidth="4" opacity="0.55" />
            </svg>
          </span>
          <span className="brand-text">
            <strong>Vibe Coding</strong>
            <span>AI Workflow</span>
          </span>
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
            onRetryNode={retryNode}
            onStopNode={stopNode}
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
          nodeValidationRunId ? (
            <NodeValidationView
              busy={busy}
              node={selectedNode}
              run={nodeValidationRun}
              onBack={viewNodeList}
              onRefreshRun={() => refreshNodeValidation(nodeValidationRunId)}
              onRetryNode={retryValidationNode}
              onStopNode={stopValidationNode}
            />
          ) : (
            <NodeManagementView
              busy={busy}
              filteredNodes={filteredRegistryNodes}
              nodeSearch={nodeRegistrySearch}
              nodes={nodes}
              selectedNode={selectedNode}
              onSetNodeSearch={setNodeRegistrySearch}
              onStartValidation={startNodeValidation}
              onViewNode={viewNode}
              onViewNodeList={viewNodeList}
            />
          )
        )}
      </section>

      <ToastHost toasts={toasts} onDismiss={dismissToast} />
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
  onStartValidation: (name: string) => void;
  onViewNode: (name: string) => void;
  onViewNodeList: () => void;
};

function capabilityEntries(node: NodeDefinition) {
  return Object.entries(node.capabilities ?? {});
}

function isNodeImplemented(node: NodeDefinition) {
  return node.capabilities?.implemented !== false;
}

function CapabilitySwitchRow({ name, enabled, compact }: { name: string; enabled: boolean; compact?: boolean }) {
  const stateLabel = enabled ? "开启" : "关闭";
  return (
    <div className={`capability-switch-row${compact ? " capability-switch-row--compact" : ""}`}>
      <span className="capability-switch-name">{name}</span>
      <span
        role="switch"
        aria-checked={enabled}
        aria-readonly="true"
        aria-label={`${name} ${stateLabel}`}
        tabIndex={-1}
        className={`capability-switch-track${enabled ? " is-on" : ""}`}
      >
        <span className="capability-switch-thumb" aria-hidden />
      </span>
    </div>
  );
}

function NodeManagementView({ busy, filteredNodes, nodeSearch, nodes, selectedNode, onSetNodeSearch, onStartValidation, onViewNode, onViewNodeList }: NodeManagementProps) {
  const [detailNode, setDetailNode] = useState<NodeDefinition | null>(null);

  if (selectedNode) {
    const capabilities = capabilityEntries(selectedNode);
    const implemented = isNodeImplemented(selectedNode);
    return (
      <section className="node-detail-page">
        <div className="section-header">
          <div>
            <p className="eyebrow">Node Detail</p>
            <h2>{selectedNode.label ?? selectedNode.name}</h2>
            <p className="muted">{selectedNode.name}</p>
            {Boolean(selectedNode.tags?.length) && (
              <div className="node-tags">
                {selectedNode.tags!.map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            )}
          </div>
          <div className="actions">
            <button className="primary-button" onClick={() => onStartValidation(selectedNode.name)} disabled={busy || !implemented}>立即运行</button>
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
            <div className="capability-list capability-list--switches">
              {capabilities.length === 0 && <p className="muted">未声明能力。</p>}
              {capabilities.map(([name, enabled]) => (
                <CapabilitySwitchRow key={name} name={name} enabled={Boolean(enabled)} />
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

  const detailCapabilities = detailNode ? capabilityEntries(detailNode) : [];

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
        <div className="node-registry-grid">
          {filteredNodes.length === 0 && <p className="muted">没有匹配的节点。</p>}
          {filteredNodes.map((node) => {
            const implemented = isNodeImplemented(node);
            return (
              <article className={`node-registry-card${implemented ? "" : " node-registry-card--pending"}`} key={node.name}>
                <div className="node-registry-card-body">
                  <h3>{node.label ?? node.name}</h3>
                  <p className="muted">{node.name}</p>
                  {Boolean(node.tags?.length) && (
                    <div className="node-tags">
                      {node.tags!.map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                  )}
                  {node.description && <p>{node.description}</p>}
                </div>
                <div className="node-registry-card-actions">
                  <button
                    className="primary-button"
                    onClick={() => onStartValidation(node.name)}
                    disabled={busy || !implemented}
                    title={implemented ? undefined : "节点待实现"}
                  >
                    立即运行
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => setDetailNode(node)}
                    disabled={busy || !implemented}
                    title={implemented ? undefined : "节点待实现"}
                  >
                    查看详情
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {detailNode && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDetailNode(null)}>
          <section className="modal-dialog node-registry-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="node-registry-detail-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Node Detail</p>
                <h2 id="node-registry-detail-title">{detailNode.label ?? detailNode.name}</h2>
                <p className="muted">{detailNode.name}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setDetailNode(null)} aria-label="关闭详情">×</button>
            </div>
            <div className="modal-body node-registry-detail-body">
              {detailNode.description && (
                <section className="node-registry-detail-section node-registry-detail-section--full">
                  <h3>说明</h3>
                  <p>{detailNode.description}</p>
                </section>
              )}

              <section className="node-registry-detail-section">
                <h3>运行入口</h3>
                <div className="definition-fields">
                  <div>
                    <span>命令</span>
                    <strong>{detailNode.command ?? "未配置"}</strong>
                  </div>
                  <div>
                    <span>UI 入口</span>
                    <strong>{detailNode.ui?.entry ?? "未配置"}</strong>
                  </div>
                </div>
              </section>

              <section className="node-registry-detail-section">
                <h3>文件位置</h3>
                <div className="definition-fields">
                  <div>
                    <span>节点目录</span>
                    <strong>{detailNode.path ?? "未配置"}</strong>
                  </div>
                  <div>
                    <span>定义文件</span>
                    <strong>{detailNode.definitionPath ?? "未配置"}</strong>
                  </div>
                </div>
              </section>

              <section className="node-registry-detail-section node-registry-detail-section--full">
                <div className="section-header compact">
                  <h3>能力配置</h3>
                  <span>{detailCapabilities.length} 项</span>
                </div>
                <div className="capability-list capability-list--switches">
                  {detailCapabilities.length === 0 && <p className="muted">未声明能力。</p>}
                  {detailCapabilities.map(([name, enabled]) => (
                    <CapabilitySwitchRow key={name} name={name} enabled={Boolean(enabled)} />
                  ))}
                </div>
              </section>
            </div>
            <div className="modal-footer">
              <button onClick={() => {
                const nodeName = detailNode.name;
                setDetailNode(null);
                onViewNode(nodeName);
              }} disabled={busy}>查看定义</button>
              <button className="primary-button" onClick={() => {
                const nodeName = detailNode.name;
                setDetailNode(null);
                onStartValidation(nodeName);
              }} disabled={busy || !isNodeImplemented(detailNode)}>立即运行</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

type NodeValidationProps = {
  busy: boolean;
  node: NodeDefinition | null;
  run: Run | null;
  onBack: () => void;
  onRefreshRun: () => Promise<void> | void;
  onRetryNode: (nodeId: string) => void;
  onStopNode: (nodeId: string) => void;
};

function formatJson(value: unknown) {
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

function appendLogText(current: string, addition: string) {
  const next = addition.trim();
  if (!next) return current;
  return current ? `${current}\n${next}` : next;
}

function NodeValidationView({ busy, node, run, onBack, onRefreshRun, onRetryNode, onStopNode }: NodeValidationProps) {
  const validationNode = run?.workflow.nodes[0];
  const nodeId = validationNode?.id ?? node?.name ?? "";
  const nodeStatus = nodeId ? run?.nodeStatuses?.[nodeId] : undefined;
  const [logs, setLogs] = useState<NodeLogs>({ stdout: "", stderr: "", combined: "", stdoutOffset: 0, stderrOffset: 0 });
  const [logError, setLogError] = useState("");
  const [progress, setProgress] = useState<NodeProgress | null>(null);
  const [progressError, setProgressError] = useState("");
  const [inputText, setInputText] = useState("");
  const [inputError, setInputError] = useState("");
  const [inputNotice, setInputNotice] = useState("");
  const [defaultParamsNotice, setDefaultParamsNotice] = useState("");
  const [defaultParamsError, setDefaultParamsError] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [outputError, setOutputError] = useState("");
  const [imagePreviewDialog, setImagePreviewDialog] = useState<ImagePreviewDialog>(null);
  const [nodeUiDialogOpen, setNodeUiDialogOpen] = useState(false);
  const nodeUiFrameRef = useRef<HTMLIFrameElement | null>(null);

  const status = progress?.status ?? nodeStatus?.status ?? "pending";
  const progressValue = Math.max(0, Math.min(100, Math.round(Number(progress?.progress ?? nodeStatus?.progress ?? 0))));
  const canStop = ["running", "stopping"].includes(status);
  const canRetry = ["failed", "stopped"].includes(status);
  const uiVersion = [nodeId, status, nodeStatus?.startedAt, nodeStatus?.endedAt].filter(Boolean).join(":");
  const logText = logs.combined || "暂无运行日志。";
  const validationInputExample = formatJson(node?.validationInputExample);
  const acceptsValidationInput = node?.validationInputExample !== undefined;
  const canSaveDefaultParams = Boolean(node?.capabilities?.params && run && nodeId);

  async function loadOutput() {
    if (!run || !nodeId) return;
    try {
      const [nextResult, nextPreview] = await Promise.all([
        api<unknown>(`/api/runs/${run.id}/nodes/${nodeId}/result`),
        api<DataPreview>(`/api/runs/${run.id}/nodes/${nodeId}/data-preview`),
      ]);
      setResult(nextResult);
      setPreview(nextPreview);
      setOutputError("");
    } catch (err) {
      setOutputError(err instanceof Error ? err.message : "输出读取失败");
    }
  }

  async function saveInput() {
    if (!run) return;
    setInputError("");
    setInputNotice("");
    let payload: unknown;
    try {
      payload = inputText.trim() ? JSON.parse(inputText) : [];
    } catch (err) {
      setInputError(err instanceof Error ? err.message : "JSON 格式无效");
      return;
    }
    try {
      await api(`/api/runs/${run.id}/validation-input`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setInputNotice("测试输入已保存为虚拟上游输出。");
      await onRefreshRun();
    } catch (err) {
      setInputError(err instanceof Error ? err.message : "保存测试输入失败");
    }
  }

  async function saveCurrentParamsAsDefault() {
    if (!run || !nodeId) return;
    setDefaultParamsError("");
    setDefaultParamsNotice("");
    try {
      const params = await requestCurrentNodeParams();
      if (params && typeof params === "object" && "__vcawError" in params) {
        throw new Error(String((params as { __vcawError: unknown }).__vcawError));
      }
      await api(`/api/runs/${run.id}/nodes/${nodeId}/default-params`, {
        method: "PUT",
        body: JSON.stringify(params ?? {}),
      });
      setDefaultParamsNotice("当前参数已保存为节点默认值。");
      await onRefreshRun();
    } catch (err) {
      setDefaultParamsError(err instanceof Error ? err.message : "保存默认值失败");
    }
  }

  async function requestCurrentNodeParams(): Promise<unknown | null> {
    const target = nodeUiFrameRef.current?.contentWindow;
    if (!target) return null;
    const requestId = `params-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(null);
      }, 800);
      function onMessage(event: MessageEvent) {
        if (event.origin !== API_ORIGIN) return;
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type !== "vcaw:node-params" || message.requestId !== requestId) return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        if (typeof message.error === "string" && message.error) {
          resolve({ __vcawError: message.error });
          return;
        }
        resolve(message.params ?? null);
      }
      window.addEventListener("message", onMessage);
      target.postMessage({ type: "vcaw:get-node-params", requestId }, API_ORIGIN);
    });
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== API_ORIGIN) return;
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "vcaw:node-ui-dialog") {
        setNodeUiDialogOpen(Boolean(message.open));
        return;
      }
      if (message.type !== "vcaw:image-preview") return;
      if (typeof message.imageUrl !== "string" || !message.imageUrl.trim()) return;
      setImagePreviewDialog({ imageUrl: message.imageUrl });
      if (event.source) {
        (event.source as Window).postMessage(
          { type: "vcaw:image-preview:handled", requestId: message.requestId },
          event.origin,
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    setNodeUiDialogOpen(false);
  }, [run?.id, nodeId]);

  useEffect(() => {
    if (!run) {
      setInputText("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await api<ValidationInput>(`/api/runs/${run.id}/validation-input`);
        if (!cancelled) setInputText(formatJson(data.input) || validationInputExample);
      } catch {
        if (!cancelled) setInputText(validationInputExample);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [run?.id, validationInputExample]);

  useEffect(() => {
    if (!run || !nodeId) {
      setLogs({ stdout: "", stderr: "", combined: "", stdoutOffset: 0, stderrOffset: 0 });
      return;
    }
    let cancelled = false;
    let stdoutOffset = 0;
    let stderrOffset = 0;
    setLogs({ stdout: "", stderr: "", combined: "", stdoutOffset: 0, stderrOffset: 0 });

    async function loadLogs() {
      try {
        const query = stdoutOffset > 0 || stderrOffset > 0
          ? `?stdoutOffset=${stdoutOffset}&stderrOffset=${stderrOffset}`
          : "";
        const nextLogs = await api<NodeLogs>(`/api/runs/${run!.id}/nodes/${nodeId}/logs${query}`);
        if (!cancelled) {
          setLogs((prev) => {
            const stdoutReset = nextLogs.stdoutOffset < stdoutOffset;
            const stderrReset = nextLogs.stderrOffset < stderrOffset;
            const stdout = stdoutReset ? nextLogs.stdout : prev.stdout + nextLogs.stdout;
            const stderr = stderrReset ? nextLogs.stderr : prev.stderr + nextLogs.stderr;
            const combined = stdoutReset || stderrReset ? nextLogs.combined.trim() : appendLogText(prev.combined, nextLogs.combined);
            return {
              stdout,
              stderr,
              combined,
              stdoutOffset: nextLogs.stdoutOffset,
              stderrOffset: nextLogs.stderrOffset,
            };
          });
          stdoutOffset = nextLogs.stdoutOffset;
          stderrOffset = nextLogs.stderrOffset;
          setLogError("");
        }
      } catch (err) {
        if (!cancelled) setLogError(err instanceof Error ? err.message : "日志读取失败");
      }
    }

    void loadLogs();
    const timer = window.setInterval(loadLogs, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [run?.id, nodeId]);

  useEffect(() => {
    if (!run || !nodeId) {
      setProgress(null);
      setProgressError("");
      return;
    }
    let cancelled = false;

    async function loadProgress() {
      try {
        const nextProgress = await api<NodeProgress>(`/api/runs/${run!.id}/nodes/${nodeId}/progress`);
        if (!cancelled) {
          setProgress(nextProgress);
          setProgressError("");
        }
      } catch (err) {
        if (!cancelled) setProgressError(err instanceof Error ? err.message : "进度读取失败");
      }
    }

    void loadProgress();
    const timer = window.setInterval(loadProgress, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [run?.id, nodeId]);

  useEffect(() => {
    void loadOutput();
  }, [run?.id, nodeId, nodeStatus?.endedAt, nodeStatus?.status]);

  if (!run || !validationNode) {
    return (
      <section className="node-detail-page">
        <div className="section-header">
          <div>
            <p className="eyebrow">Run Node</p>
            <h2>{node?.label ?? node?.name ?? "节点立即运行"}</h2>
            <p className="muted">正在加载验证会话...</p>
          </div>
          <div className="actions">
            <button className="secondary-button" onClick={onBack} disabled={busy}>返回节点列表</button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`node-validation-page${nodeUiDialogOpen ? " node-validation-page--expanded-ui" : ""}`}>
      <ImagePreviewModal dialog={imagePreviewDialog} onClose={() => setImagePreviewDialog(null)} />
      <div className="section-header">
        <div>
          <p className="eyebrow">Run Node</p>
          <h2>{node?.label ?? validationNode.node}</h2>
          <p className="muted">{run.id}</p>
        </div>
        <div className="actions">
          <button className="secondary-button" onClick={onBack} disabled={busy}>返回节点列表</button>
          <button onClick={() => void loadOutput()} disabled={busy}>刷新输出</button>
          {canSaveDefaultParams && <button onClick={() => void saveCurrentParamsAsDefault()} disabled={busy}>保存当前参数为默认值</button>}
          {canStop && <button className="danger-button" onClick={() => onStopNode(nodeId)} disabled={busy}>停止节点</button>}
          {canRetry && <button className="primary-button" onClick={() => onRetryNode(nodeId)} disabled={busy}>重新运行</button>}
        </div>
      </div>

      {defaultParamsError && <p className="error-text">{defaultParamsError}</p>}
      {defaultParamsNotice && <p className="success-text">{defaultParamsNotice}</p>}

      <div className="run-detail-meta">
        <span>单节点运行</span>
        <span>{validationNode.node}</span>
        <span>{nodeStatusLabel(status)}</span>
      </div>

      <div className={acceptsValidationInput ? "node-validation-grid" : "node-validation-grid no-validation-input"}>
        {acceptsValidationInput && (
          <section className="validation-side-panel">
            <div className="section-header compact">
              <h3>测试输入</h3>
            </div>
            <p className="muted">用于模拟上游节点输出，节点会从 validation-input 读取这份 data.json。</p>
            <textarea
              className="json-editor"
              value={inputText}
              onChange={(event) => setInputText(event.target.value)}
              placeholder={validationInputExample || '[{"id":"case-1","value":"demo"}]'}
            />
            {inputError && <p className="error-text">{inputError}</p>}
            {inputNotice && <p className="success-text">{inputNotice}</p>}
            <button className="primary-button" onClick={saveInput} disabled={busy}>保存测试输入</button>
          </section>
        )}

        <section className="run-node-panel validation-node-panel">
          <div className="node-panel-header">
            <div>
              <h3>{validationNode.id}</h3>
              <p className="muted">{validationNode.node}</p>
              <div className="node-progress" aria-label={`节点进度 ${progressValue}%`}>
                <div className="node-progress-meta">
                  <span>{nodeStatusLabel(status)}</span>
                  <strong>{progressValue}%</strong>
                </div>
                <div className="node-progress-track" aria-hidden>
                  <span style={{ width: `${progressValue}%` }} />
                </div>
                {progressError && <p className="error-text">{progressError}</p>}
              </div>
            </div>
          </div>

          <div className="node-runtime-stack">
            {nodeStatus?.hasUi && (
              <iframe
                ref={nodeUiFrameRef}
                key={uiVersion}
                className="node-ui-frame"
                title={`${validationNode.id} UI`}
                src={`${API_BASE}${nodeStatus.uiUrl}?v=${encodeURIComponent(uiVersion)}`}
              />
            )}
            <div className="node-console-wrap">
              <div className="console-title">运行日志</div>
              {logError && <p className="error-text">{logError}</p>}
              <pre className="node-console">{logText}</pre>
            </div>
          </div>
        </section>
      </div>

      <section className="validation-output-panel">
        <div className="section-header compact">
          <h3>输出查看</h3>
          {preview && <span>{preview.total} 条</span>}
        </div>
        {outputError && <p className="error-text">{outputError}</p>}
        <div className="validation-output-grid">
          <div>
            <div className="console-title">result.json</div>
            <pre className="data-preview-json">{formatJson(result) || "暂无结果。"}</pre>
          </div>
          <div>
            <div className="console-title">data-preview</div>
            <pre className="data-preview-json">{formatJson(preview) || "暂无输出数据。"}</pre>
          </div>
        </div>
      </section>
    </section>
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
                  <input value={draft.name} onChange={(event) => onSetDraft({ ...draft, name: event.target.value })} placeholder="客户数据处理流程" />
                </label>
                <label>
                  模式
                  <span className="mode-switch" role="group" aria-label="工作流模式">
                    <button
                      type="button"
                      className={draft.mode === "manual-confirm" ? "active" : ""}
                      onClick={() => onSetDraft({ ...draft, mode: "manual-confirm" })}
                      disabled={busy}
                    >
                      手动确认
                    </button>
                    <button
                      type="button"
                      className={draft.mode === "auto" ? "active" : ""}
                      onClick={() => onSetDraft({ ...draft, mode: "auto" })}
                      disabled={busy}
                    >
                      自动运行
                    </button>
                  </span>
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
                        {Boolean(node.tags?.length) && (
                          <span className="node-tags compact-tags">
                            {node.tags!.map((tag) => <em key={tag}>{tag}</em>)}
                          </span>
                        )}
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
              <button className="primary-button" onClick={onCreateWorkflow} disabled={busy || !draft.name.trim() || draft.nodes.length === 0}>保存 workflow</button>
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
  onRetryNode: (nodeId: string) => void;
  onStopNode: (nodeId: string) => void;
  onRequestDeleteRun: (run: Pick<Run, "id" | "workflowLabel">) => void;
  onDeleteRun: () => void;
  onStopRun: () => void;
  onViewRunList: () => void;
  onViewRun: (runId: string) => void;
  onViewWorkflow: (name: string) => void;
};

function formatPreviewValue(value: unknown) {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function DataTransferIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 7h10" />
      <path d="m11 4 3 3-3 3" />
      <path d="M20 17H10" />
      <path d="m13 14-3 3 3 3" />
    </svg>
  );
}

function DataPreviewModal({ dialog, onClose }: { dialog: DataPreviewDialog; onClose: () => void }) {
  if (!dialog) return null;
  const { data } = dialog;
  const previewItems = data?.kind === "array" && Array.isArray(data.preview) ? data.preview : [];

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-dialog data-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="data-preview-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <p className="eyebrow">Data Transfer</p>
            <h2 id="data-preview-title">{dialog.sourceNodeId} 返回数据</h2>
            <p className="muted">{dialog.sourceNodeName}</p>
          </div>
          <button className="secondary-button" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-body">
          {dialog.loading && <p className="muted">正在读取上个节点返回的数据...</p>}
          {dialog.error && <p className="error-text">{dialog.error}</p>}
          {!dialog.loading && !dialog.error && data?.kind === "empty" && <p className="muted">暂无数据。</p>}
          {!dialog.loading && !dialog.error && data?.kind === "array" && (
            <div className="data-preview-stack">
              <div className="data-preview-summary">
                已展示 {previewItems.length} / 共 {data.total} 条
              </div>
              {previewItems.map((item, index) => (
                <article className="data-preview-item" key={index}>
                  <span>#{index + 1}</span>
                  <pre>{formatPreviewValue(item)}</pre>
                </article>
              ))}
            </div>
          )}
          {!dialog.loading && !dialog.error && data && data.kind !== "empty" && data.kind !== "array" && (
            <pre className="data-preview-json">{formatPreviewValue(data.preview)}</pre>
          )}
        </div>
      </section>
    </div>
  );
}

function ImagePreviewModal({ dialog, onClose }: { dialog: ImagePreviewDialog; onClose: () => void }) {
  useEffect(() => {
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, onClose]);

  if (!dialog) return null;

  return (
    <div className="image-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="image-preview-dialog" role="dialog" aria-modal="true" aria-label="原图预览" onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="image-preview-close" onClick={onClose} aria-label="关闭预览">
          关闭
        </button>
        <img className="image-preview-full" src={dialog.imageUrl} alt="放大原图" />
      </section>
    </div>
  );
}

function RunConsoleView({
  busy,
  runs,
  selectedRun,
  workflows,
  onConfirmNode,
  onRetryNode,
  onStopNode,
  onRequestDeleteRun,
  onDeleteRun,
  onStopRun,
  onViewRunList,
  onViewRun,
  onViewWorkflow,
}: RunConsoleProps) {
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [selectedNodeLogs, setSelectedNodeLogs] = useState<NodeLogs>({
    stdout: "",
    stderr: "",
    combined: "",
    stdoutOffset: 0,
    stderrOffset: 0,
  });
  const [logError, setLogError] = useState("");
  const [selectedNodeProgress, setSelectedNodeProgress] = useState<NodeProgress | null>(null);
  const [progressError, setProgressError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterWorkflowName, setFilterWorkflowName] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [dataPreviewDialog, setDataPreviewDialog] = useState<DataPreviewDialog>(null);
  const [imagePreviewDialog, setImagePreviewDialog] = useState<ImagePreviewDialog>(null);

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

  async function openDataPreview(sourceNode: WorkflowNode) {
    if (!selectedRun) return;
    setDataPreviewDialog({
      sourceNodeId: sourceNode.id,
      sourceNodeName: sourceNode.node,
      data: null,
      loading: true,
      error: "",
    });
    try {
      const data = await api<DataPreview>(`/api/runs/${selectedRun.id}/nodes/${sourceNode.id}/data-preview`);
      setDataPreviewDialog({
        sourceNodeId: sourceNode.id,
        sourceNodeName: sourceNode.node,
        data,
        loading: false,
        error: "",
      });
    } catch (err) {
      setDataPreviewDialog({
        sourceNodeId: sourceNode.id,
        sourceNodeName: sourceNode.node,
        data: null,
        loading: false,
        error: err instanceof Error ? err.message : "数据读取失败",
      });
    }
  }

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== API_ORIGIN) return;
      const message = event.data;
      if (!message || typeof message !== "object" || message.type !== "vcaw:image-preview") return;
      if (typeof message.imageUrl !== "string" || !message.imageUrl.trim()) return;

      setImagePreviewDialog({ imageUrl: message.imageUrl });
      if (event.source) {
        (event.source as Window).postMessage(
          { type: "vcaw:image-preview:handled", requestId: message.requestId },
          event.origin,
        );
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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
      setSelectedNodeLogs({ stdout: "", stderr: "", combined: "", stdoutOffset: 0, stderrOffset: 0 });
      return;
    }

    let cancelled = false;
    let stdoutOffset = 0;
    let stderrOffset = 0;
    setSelectedNodeLogs({ stdout: "", stderr: "", combined: "", stdoutOffset: 0, stderrOffset: 0 });

    async function loadLogs() {
      try {
        const query = stdoutOffset > 0 || stderrOffset > 0
          ? `?stdoutOffset=${stdoutOffset}&stderrOffset=${stderrOffset}`
          : "";
        const logs = await api<NodeLogs>(`/api/runs/${selectedRun!.id}/nodes/${selectedNodeId}/logs${query}`);
        if (!cancelled) {
          setSelectedNodeLogs((prev) => {
            const stdoutReset = logs.stdoutOffset < stdoutOffset;
            const stderrReset = logs.stderrOffset < stderrOffset;
            const stdout = stdoutReset ? logs.stdout : prev.stdout + logs.stdout;
            const stderr = stderrReset ? logs.stderr : prev.stderr + logs.stderr;
            const combined = stdoutReset || stderrReset ? logs.combined.trim() : appendLogText(prev.combined, logs.combined);
            return {
              stdout,
              stderr,
              combined,
              stdoutOffset: logs.stdoutOffset,
              stderrOffset: logs.stderrOffset,
            };
          });
          stdoutOffset = logs.stdoutOffset;
          stderrOffset = logs.stderrOffset;
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
  }, [selectedNodeId, selectedRun?.id]);

  useEffect(() => {
    if (!selectedRun || !selectedNodeId) {
      setSelectedNodeProgress(null);
      setProgressError("");
      return;
    }

    let cancelled = false;

    async function loadProgress() {
      try {
        const progress = await api<NodeProgress>(`/api/runs/${selectedRun!.id}/nodes/${selectedNodeId}/progress`);
        if (!cancelled) {
          setSelectedNodeProgress(progress);
          setProgressError("");
        }
      } catch (err) {
        if (!cancelled) {
          setProgressError(err instanceof Error ? err.message : "进度读取失败");
        }
      }
    }

    void loadProgress();
    const timer = window.setInterval(loadProgress, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedNodeId, selectedRun?.id]);

  if (selectedRun) {
    const selectedWorkflowNode = selectedRun.workflow.nodes.find((node) => node.id === selectedNodeId) ?? selectedRun.workflow.nodes[0];
    const selectedStatus = selectedWorkflowNode ? selectedRun.nodeStatuses?.[selectedWorkflowNode.id] : undefined;
    const selectedNodeIndex = selectedWorkflowNode
      ? selectedRun.workflow.nodes.findIndex((node) => node.id === selectedWorkflowNode.id)
      : -1;
    const isLastWorkflowNode = selectedNodeIndex === selectedRun.workflow.nodes.length - 1;
    const selectedLogText = selectedNodeLogs.combined || "暂无运行日志。";
    const selectedNodeStatus = selectedStatus?.status ?? "pending";
    const selectedNodeSupportsParams = Boolean(selectedStatus?.supportsParams);
    const selectedProgress = selectedNodeProgress?.nodeId === selectedWorkflowNode?.id
      ? selectedNodeProgress
      : selectedStatus;
    const selectedProgressValue = Math.max(0, Math.min(100, Math.round(Number(selectedProgress?.progress ?? 0))));
    const selectedNodeUiVersion = [
      selectedWorkflowNode?.id,
      selectedNodeStatus,
      selectedStatus?.startedAt,
      selectedStatus?.endedAt,
    ].filter(Boolean).join(":");
    const canStopSelectedNode = selectedNodeStatus === "waiting-confirmation" || (selectedNodeSupportsParams && ["running", "stopping"].includes(selectedNodeStatus));
    const canRetrySelectedNode = ["failed", "stopped"].includes(selectedNodeStatus);

    return (
      <section className="run-detail-page">
        <DataPreviewModal dialog={dataPreviewDialog} onClose={() => setDataPreviewDialog(null)} />
        <ImagePreviewModal dialog={imagePreviewDialog} onClose={() => setImagePreviewDialog(null)} />
        <div className="section-header">
          <div>
            <p className="eyebrow">Run Detail</p>
            <h2>{selectedRun.workflowLabel}</h2>
            <p className="muted">{selectedRun.id}</p>
          </div>
          <div className="actions">
            <button className="secondary-button" onClick={onViewRunList} disabled={busy}>返回运行记录</button>
            <button onClick={() => onViewWorkflow(selectedRun.workflowName)} disabled={busy}>工作流定义</button>
            <button className="danger-button" onClick={onStopRun} disabled={busy || ["stopped", "terminated"].includes(selectedRun.status)}>停止工作流</button>
            <button className="danger-button" onClick={onDeleteRun} disabled={busy}>删除</button>
          </div>
        </div>

        <div className="run-detail-meta">
          <span>{selectedRun.mode}</span>
          <span>开始：{formatDateTime(selectedRun.startedAt)}</span>
          {selectedRun.endedAt && <span>结束：{formatDateTime(selectedRun.endedAt)}</span>}
        </div>

        <div className="run-workspace">
          <aside className="run-node-rail" aria-label="运行节点">
            {selectedRun.workflow.nodes.map((node, index) => {
              const status = selectedRun.nodeStatuses?.[node.id];
              const previousNode = selectedRun.workflow.nodes[index - 1];
              return (
                <React.Fragment key={node.id}>
                  {previousNode && (
                    <div className="run-data-transfer">
                      <button
                        type="button"
                        className="run-data-transfer-button"
                        onClick={() => openDataPreview(previousNode)}
                        disabled={busy}
                        aria-label={`查看 ${previousNode.id} 返回数据`}
                        title={`查看 ${previousNode.id} 返回数据`}
                      >
                        <DataTransferIcon />
                      </button>
                    </div>
                  )}
                  <button
                    className={`run-step ${selectedNodeId === node.id ? "active" : ""}`}
                    onClick={() => setSelectedNodeId(node.id)}
                    disabled={busy}
                  >
                    <span>
                      Step {index + 1} {node.id}
                      <em>{nodeStatusLabel(status?.status ?? "pending")}</em>
                    </span>
                    <small>{node.node}</small>
                  </button>
                </React.Fragment>
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
                    <div className="node-progress" aria-label={`节点进度 ${selectedProgressValue}%`}>
                      <div className="node-progress-meta">
                        <span>{nodeStatusLabel(selectedProgress?.status ?? selectedNodeStatus)}</span>
                        <strong>{selectedProgressValue}%</strong>
                      </div>
                      <div className="node-progress-track" aria-hidden>
                        <span style={{ width: `${selectedProgressValue}%` }} />
                      </div>
                      {progressError && <p className="error-text">{progressError}</p>}
                    </div>
                  </div>
                  <div className="node-actions">
                    {selectedStatus?.status === "waiting-confirmation" && (
                      <button className="primary-button" onClick={() => onConfirmNode(selectedWorkflowNode.id)} disabled={busy}>
                        {isLastWorkflowNode ? "确认完成" : "确认继续"}
                      </button>
                    )}
                    {canStopSelectedNode && (
                      <button className="danger-button" onClick={() => onStopNode(selectedWorkflowNode.id)} disabled={busy}>
                        停止节点
                      </button>
                    )}
                    {canRetrySelectedNode && (
                      <button className="primary-button" onClick={() => onRetryNode(selectedWorkflowNode.id)} disabled={busy}>
                        重新运行
                      </button>
                    )}
                  </div>
                </div>
                <div className="node-runtime-stack">
                  {selectedStatus?.hasUi && (
                    <iframe
                      key={selectedNodeUiVersion}
                      className="node-ui-frame"
                      title={`${selectedWorkflowNode.id} UI`}
                      src={`${API_BASE}${selectedStatus.uiUrl}?v=${encodeURIComponent(selectedNodeUiVersion)}`}
                    />
                  )}
                  <div className="node-console-wrap">
                    <div className="console-title">运行日志</div>
                    {logError && <p className="error-text">{logError}</p>}
                    <pre className="node-console">{selectedLogText}</pre>
                  </div>
                </div>
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
                <span className={`status ${run.status}`}>{runStatusLabel(run.status)}</span>
                <span>
                  <strong>{run.workflowLabel}</strong>
                  <small>{run.id}</small>
                </span>
                <span className="run-time">{formatDateTime(run.startedAt)}</span>
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
