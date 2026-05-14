from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from re import fullmatch
from typing import Any

import yaml
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

REPO_DIR = Path(__file__).resolve().parents[2]

NODES_DIR = Path(os.getenv("VCAW_NODES_DIR", REPO_DIR / "examples" / "nodes")).resolve()
WORKFLOWS_DIR = Path(os.getenv("VCAW_WORKFLOWS_DIR", REPO_DIR / "examples" / "workflows")).resolve()
RUNS_DIR = Path(os.getenv("VCAW_RUNS_DIR", REPO_DIR / "data" / "runs")).resolve()

TERMINAL_NODE_STATES = {"success", "confirmed", "failed", "skipped", "stopped"}
ACTIVE_NODE_STATES = {"pending", "running", "stopping", "waiting-confirmation"}

app = FastAPI(title="Vibe Coding AI Workflow", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

processes: dict[tuple[str, str], subprocess.Popen[Any]] = {}
process_lock = threading.Lock()
NO_CACHE_HEADERS = {"Cache-Control": "no-store, max-age=0", "Pragma": "no-cache", "Expires": "0"}


class RunWorkflowRequest(BaseModel):
    input: dict[str, Any] = {}


class WorkflowNodeRequest(BaseModel):
    id: str
    node: str
    depends_on: list[str] = []


class CreateWorkflowRequest(BaseModel):
    name: str
    label: str = ""
    description: str = ""
    mode: str = "manual-confirm"
    nodes: list[WorkflowNodeRequest]


class ConfirmRequest(BaseModel):
    note: str = ""


class QueryRequest(BaseModel):
    dataset: str
    page: int = 1
    pageSize: int = 100
    filters: dict[str, Any] = {}
    sort: dict[str, Any] = {}


class SearchRequest(BaseModel):
    dataset: str
    q: str
    page: int = 1
    pageSize: int = 100


DATA_PREVIEW_LIMIT = 5


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail=f"Invalid YAML object: {path}")
    return data


def validate_slug(value: str, field_name: str) -> str:
    if not fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}", value):
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} must use 1-64 letters, numbers, hyphens, or underscores, and start with a letter or number",
        )
    return value


def safe_filename(filename: str) -> str:
    name = Path(filename or "upload").name.strip() or "upload"
    safe = "".join(ch if ch.isalnum() or ch in {".", "-", "_"} else "_" for ch in name)
    safe = safe.strip("._") or "upload"
    return safe[:160]


def node_definition(node_name: str) -> tuple[Path, dict[str, Any]]:
    node_dir = NODES_DIR / node_name
    node_file = node_dir / "node.md"
    if not node_file.exists():
        raise HTTPException(status_code=404, detail=f"Node not found: {node_name}")
    return node_dir, read_yaml(node_file)


def workflow_definition(workflow_name: str) -> tuple[Path, dict[str, Any]]:
    candidates = [
        WORKFLOWS_DIR / workflow_name / "workflow.md",
        WORKFLOWS_DIR / f"{workflow_name}.md",
        WORKFLOWS_DIR / "workflow.md",
    ]
    for path in candidates:
        if path.exists():
            workflow = read_yaml(path)
            if workflow.get("name") == workflow_name or path.stem == workflow_name or path.parent.name == workflow_name:
                return path, workflow
    for path in WORKFLOWS_DIR.rglob("workflow.md"):
        workflow = read_yaml(path)
        if workflow.get("name") == workflow_name:
            return path, workflow
    raise HTTPException(status_code=404, detail=f"Workflow not found: {workflow_name}")


def run_dir(run_id: str) -> Path:
    path = (RUNS_DIR / run_id).resolve()
    if RUNS_DIR not in path.parents and path != RUNS_DIR:
        raise HTTPException(status_code=400, detail="Invalid run id")
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return path


def node_run_dir(run_id: str, node_id: str) -> Path:
    return run_dir(run_id) / "nodes" / node_id


def load_run(run_id: str) -> dict[str, Any]:
    return read_json(run_dir(run_id) / "run.json", {})


def save_run(run_id: str, data: dict[str, Any]) -> None:
    write_json(run_dir(run_id) / "run.json", data)


def load_node_status(run_id: str, node_id: str) -> dict[str, Any]:
    return read_json(node_run_dir(run_id, node_id) / "status.json", {})


def normalized_progress(value: Any) -> int:
    try:
        progress = int(value)
    except (TypeError, ValueError):
        progress = 0
    return max(0, min(100, progress))


def normalize_node_status_progress(status: dict[str, Any]) -> dict[str, Any]:
    if "progress" not in status:
        return status
    return {**status, "progress": normalized_progress(status.get("progress"))}


def save_node_status(run_id: str, node_id: str, data: dict[str, Any]) -> None:
    write_json(node_run_dir(run_id, node_id) / "status.json", normalize_node_status_progress(data))


def node_was_stopped(status: dict[str, Any]) -> bool:
    return status.get("status") in {"stopping", "stopped"} or bool(status.get("stopRequestedAt"))


def looks_like_stop_log_failure(status: dict[str, Any]) -> bool:
    if status.get("status") != "failed":
        return False
    error = str(status.get("error") or "").lstrip()
    return error.startswith(("执行参数:", "开始阅卷数据检查:"))


def complete_stopped_node(run_id: str, node_id: str, ended_at: str | None = None, run_status: str = "terminated") -> dict[str, Any]:
    stopped_at = ended_at or now_iso()
    stopped = {**load_node_status(run_id, node_id), "status": "stopped", "endedAt": stopped_at, "error": None}
    save_node_status(run_id, node_id, stopped)
    save_run(run_id, {**load_run(run_id), "status": run_status, "currentNodeId": node_id, "endedAt": stopped_at})
    return stopped


def workflow_nodes(run: dict[str, Any]) -> list[dict[str, Any]]:
    return run.get("workflow", {}).get("nodes", [])


def load_run_node_statuses(run_id: str, run: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {node["id"]: load_node_status(run_id, node["id"]) for node in workflow_nodes(run)}


def node_needs_manual_confirmation(run: dict[str, Any], node_id: str, status: dict[str, Any]) -> bool:
    if run.get("mode") != "manual-confirm" or status.get("status") != "success":
        return False
    return not (node_run_dir(run["id"], node_id) / "confirm.json").exists()


def effective_node_status(run: dict[str, Any], node_id: str, status: dict[str, Any]) -> dict[str, Any]:
    if looks_like_stop_log_failure(status):
        return {**status, "status": "stopped", "error": None}
    if node_needs_manual_confirmation(run, node_id, status):
        return {**status, "status": "waiting-confirmation"}
    return status


def aggregate_run_status(run: dict[str, Any], statuses: dict[str, dict[str, Any]]) -> str:
    stored_status = run.get("status", "pending")
    if stored_status in {"stopping", "stopped", "terminated"}:
        return stored_status
    status_values = [status.get("status", "pending") for status in statuses.values()]
    if any(status == "failed" for status in status_values):
        return "failed"
    if any(status == "stopping" for status in status_values):
        return "stopping"
    if any(status == "running" for status in status_values):
        return "running"
    if any(status == "waiting-confirmation" for status in status_values):
        return "running"
    if any(status == "pending" for status in status_values):
        return "running"
    if any(node_needs_manual_confirmation(run, node_id, status) for node_id, status in statuses.items()):
        return "running"
    if stored_status == "failed" and any(status == "stopped" for status in status_values):
        return "terminated"
    if any(status == "stopped" for status in status_values):
        return "stopped"
    if statuses and all(status in TERMINAL_NODE_STATES for status in status_values):
        return "success"
    return stored_status


def run_with_aggregate_status(run_id: str, run: dict[str, Any]) -> dict[str, Any]:
    statuses = {node_id: effective_node_status(run, node_id, status) for node_id, status in load_run_node_statuses(run_id, run).items()}
    return {**run, "status": aggregate_run_status(run, statuses)}


def data_preview_response(node_id: str, data: Any) -> dict[str, Any]:
    if data is None or data == "" or data == []:
        return {"nodeId": node_id, "kind": "empty", "total": 0, "preview": None}
    if isinstance(data, list):
        return {
            "nodeId": node_id,
            "kind": "array",
            "total": len(data),
            "preview": data[:DATA_PREVIEW_LIMIT],
        }
    if isinstance(data, dict):
        return {"nodeId": node_id, "kind": "object", "total": 1, "preview": data}
    return {"nodeId": node_id, "kind": "primitive", "total": 1, "preview": data}


def find_workflow_node(run: dict[str, Any], node_id: str) -> dict[str, Any]:
    for node in workflow_nodes(run):
        if node.get("id") == node_id:
            return node
    raise HTTPException(status_code=404, detail=f"Node run not found: {node_id}")


def current_node_definition(run_id: str, node_id: str) -> tuple[dict[str, Any], Path, dict[str, Any]]:
    run = load_run(run_id)
    workflow_node = find_workflow_node(run, node_id)
    node_dir, node_def = node_definition(workflow_node["node"])
    return workflow_node, node_dir, node_def


def node_has_ui(node_name: str) -> bool:
    node_dir, node_def = node_definition(node_name)
    entry = node_def.get("ui", {}).get("entry")
    if not entry:
        return False
    entry_path = (node_dir / entry).resolve()
    return (node_dir in entry_path.parents or entry_path == node_dir) and entry_path.exists()


def next_node_id(run: dict[str, Any], node_id: str) -> str | None:
    nodes = workflow_nodes(run)
    for index, node in enumerate(nodes):
        if node.get("id") == node_id:
            if index + 1 < len(nodes):
                return nodes[index + 1]["id"]
            return None
    return None


def make_run_id(workflow_name: str) -> str:
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    base = f"{stamp}-{workflow_name}"
    candidate = base
    suffix = 2
    while (RUNS_DIR / candidate).exists():
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def build_node_command(command: str, action: str, args: list[str]) -> list[str]:
    return [*shlex.split(command), action, *args]


def run_node_command(
    run_id: str,
    node_id: str,
    action: str,
    extra_args: list[str],
    capture_json: bool = False,
) -> Any:
    run = load_run(run_id)
    workflow_node = find_workflow_node(run, node_id)
    source_node_dir, node_def = node_definition(workflow_node["node"])
    current_run_dir = run_dir(run_id)
    current_node_dir = node_run_dir(run_id, node_id)
    command = build_node_command(
        node_def["command"],
        action,
        [
            "--run-dir",
            str(current_run_dir),
            "--node-run-dir",
            str(current_node_dir),
            "--node-dir",
            str(source_node_dir),
            *extra_args,
        ],
    )

    if capture_json:
        completed = subprocess.run(command, cwd=source_node_dir, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            raise HTTPException(status_code=500, detail=completed.stderr or completed.stdout or "Node command failed")
        try:
            return json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=502, detail=f"Node returned invalid JSON: {exc}") from exc

    logs_dir = current_node_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = logs_dir / "stdout.log"
    stderr_path = logs_dir / "stderr.log"
    with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(command, cwd=source_node_dir, stdout=stdout, stderr=stderr, text=True)
        with process_lock:
            processes[(run_id, node_id)] = process
        return_code = process.wait()
        with process_lock:
            processes.pop((run_id, node_id), None)
    return return_code


def parse_last_json_line(text: str) -> Any:
    for line in reversed(text.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    raise HTTPException(status_code=502, detail="Node returned no JSON response")


def run_node_command_logged_json(
    run_id: str,
    node_id: str,
    action: str,
    extra_args: list[str],
) -> Any:
    run = load_run(run_id)
    workflow_node = find_workflow_node(run, node_id)
    source_node_dir, node_def = node_definition(workflow_node["node"])
    current_run_dir = run_dir(run_id)
    current_node_dir = node_run_dir(run_id, node_id)
    command = build_node_command(
        node_def["command"],
        action,
        [
            "--run-dir",
            str(current_run_dir),
            "--node-run-dir",
            str(current_node_dir),
            "--node-dir",
            str(source_node_dir),
            *extra_args,
        ],
    )

    logs_dir = current_node_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = logs_dir / "stdout.log"
    stderr_path = logs_dir / "stderr.log"
    with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(command, cwd=source_node_dir, stdout=stdout, stderr=stderr, text=True)
        with process_lock:
            processes[(run_id, node_id)] = process
        return_code = process.wait()
        with process_lock:
            processes.pop((run_id, node_id), None)

    stdout_text = stdout_path.read_text(encoding="utf-8", errors="replace") if stdout_path.exists() else ""
    stderr_text = stderr_path.read_text(encoding="utf-8", errors="replace") if stderr_path.exists() else ""
    if return_code != 0:
        detail = stderr_text.strip() or stdout_text.strip() or "Node command failed"
        raise HTTPException(status_code=500, detail=detail)
    return parse_last_json_line(stdout_text)


def schedule_from(run_id: str, node_id: str, background_tasks: BackgroundTasks | None = None) -> None:
    if background_tasks:
        background_tasks.add_task(execute_from_node, run_id, node_id)
    else:
        thread = threading.Thread(target=execute_from_node, args=(run_id, node_id), daemon=True)
        thread.start()


def execute_from_node(run_id: str, start_node_id: str) -> None:
    run = load_run(run_id)
    node_id: str | None = start_node_id
    while node_id:
        run = load_run(run_id)
        if run.get("status") in {"stopping", "stopped"}:
            return
        status = load_node_status(run_id, node_id)
        if status.get("status") == "stopped":
            return

        save_run(run_id, {**run, "status": "running", "currentNodeId": node_id})
        save_node_status(
            run_id,
            node_id,
            {**status, "status": "running", "startedAt": now_iso(), "endedAt": None, "error": None, "progress": 0},
        )
        return_code = run_node_command(
            run_id,
            node_id,
            "run",
            ["--workflow-file", str(run_dir(run_id) / "workflow.md")],
        )

        status = load_node_status(run_id, node_id)
        if status.get("status") == "stopped":
            return
        if return_code != 0:
            save_node_status(
                run_id,
                node_id,
                {**status, "status": "failed", "endedAt": now_iso(), "error": f"Process exited with {return_code}"},
            )
            save_run(run_id, {**load_run(run_id), "status": "failed", "endedAt": now_iso()})
            return

        current_run = load_run(run_id)
        following_node_id = next_node_id(current_run, node_id)
        if current_run.get("mode") == "manual-confirm":
            workflow_node = find_workflow_node(current_run, node_id)
            _, node_def = node_definition(workflow_node["node"])
            init_progress = 0 if node_def.get("capabilities", {}).get("params") else 100
            save_node_status(run_id, node_id, {**status, "status": "waiting-confirmation", "endedAt": now_iso(), "progress": init_progress})
            save_run(run_id, {**load_run(run_id), "status": "waiting-confirmation", "currentNodeId": node_id})
            return

        save_node_status(run_id, node_id, {**status, "status": "success", "endedAt": now_iso(), "progress": 100})
        node_id = following_node_id

    save_run(run_id, {**load_run(run_id), "status": "success", "currentNodeId": None, "endedAt": now_iso()})


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "nodesDir": str(NODES_DIR), "workflowsDir": str(WORKFLOWS_DIR), "runsDir": str(RUNS_DIR)}


@app.get("/api/nodes")
def list_nodes() -> dict[str, Any]:
    nodes = []
    for node_file in NODES_DIR.glob("*/node.md"):
        node_dir = node_file.parent
        definition = read_yaml(node_file)
        nodes.append({**definition, "path": str(node_dir)})
    return {"nodes": nodes}


@app.get("/api/nodes/{node_name}")
def get_node_definition(node_name: str) -> dict[str, Any]:
    node_name = validate_slug(node_name, "node name")
    node_dir, definition = node_definition(node_name)
    node_file = node_dir / "node.md"
    return {**definition, "path": str(node_dir), "definitionPath": str(node_file), "rawDefinition": node_file.read_text(encoding="utf-8")}


@app.get("/api/workflows")
def list_workflows() -> dict[str, Any]:
    workflows = []
    for workflow_file in WORKFLOWS_DIR.rglob("workflow.md"):
        definition = read_yaml(workflow_file)
        workflows.append({**definition, "path": str(workflow_file)})
    return {"workflows": workflows}


@app.post("/api/workflows")
def create_workflow(request: CreateWorkflowRequest) -> dict[str, Any]:
    workflow_name = validate_slug(request.name.strip(), "workflow name")
    if request.mode not in {"auto", "manual-confirm"}:
        raise HTTPException(status_code=400, detail="mode must be auto or manual-confirm")
    if not request.nodes:
        raise HTTPException(status_code=400, detail="workflow must contain at least one node")

    seen_node_ids: set[str] = set()
    workflow_nodes_payload = []
    for index, node in enumerate(request.nodes):
        node_id = validate_slug(node.id.strip(), "node id")
        if node_id in seen_node_ids:
            raise HTTPException(status_code=400, detail=f"duplicate node id: {node_id}")
        seen_node_ids.add(node_id)
        node_definition(node.node)
        workflow_nodes_payload.append(
            {
                "id": node_id,
                "node": node.node,
                "depends_on": node.depends_on if index > 0 else [],
            }
        )

    workflow_dir = (WORKFLOWS_DIR / workflow_name).resolve()
    workflow_file = workflow_dir / "workflow.md"
    if WORKFLOWS_DIR not in workflow_dir.parents and workflow_dir != WORKFLOWS_DIR:
        raise HTTPException(status_code=400, detail="Invalid workflow path")
    if workflow_file.exists():
        raise HTTPException(status_code=409, detail=f"workflow already exists: {workflow_name}")

    workflow = {
        "name": workflow_name,
        "label": request.label.strip() or workflow_name,
        "description": request.description.strip(),
        "mode": request.mode,
        "nodes": workflow_nodes_payload,
    }
    workflow_dir.mkdir(parents=True, exist_ok=False)
    workflow_file.write_text(yaml.safe_dump(workflow, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return {"ok": True, "workflow": {**workflow, "path": str(workflow_file)}}


@app.delete("/api/workflows/{workflow_name}")
def delete_workflow(workflow_name: str) -> JSONResponse:
    workflow_file, workflow = workflow_definition(workflow_name)
    workflow_root = workflow_file.parent.resolve()
    if WORKFLOWS_DIR not in workflow_file.resolve().parents:
        raise HTTPException(status_code=400, detail="Invalid workflow path")

    workflow_file.unlink()
    if workflow_file.name == "workflow.md" and workflow_root != WORKFLOWS_DIR:
        try:
            workflow_root.rmdir()
        except OSError:
            pass
    return JSONResponse({"ok": True, "workflowName": workflow.get("name", workflow_name)})


@app.post("/api/workflows/{workflow_name}/runs")
def create_run(workflow_name: str, request: RunWorkflowRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    workflow_file, workflow = workflow_definition(workflow_name)
    run_id = make_run_id(workflow["name"])
    current_run_dir = RUNS_DIR / run_id
    current_run_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(workflow_file, current_run_dir / "workflow.md")

    started_at = now_iso()
    run = {
        "id": run_id,
        "workflowName": workflow["name"],
        "workflowLabel": workflow.get("label", workflow["name"]),
        "mode": workflow.get("mode", "auto"),
        "status": "pending",
        "currentNodeId": None,
        "startedAt": started_at,
        "endedAt": None,
        "input": request.input,
        "workflow": workflow,
    }
    write_json(current_run_dir / "run.json", run)
    for node in workflow.get("nodes", []):
        current_node_dir = current_run_dir / "nodes" / node["id"]
        (current_node_dir / "data").mkdir(parents=True, exist_ok=True)
        (current_node_dir / "logs").mkdir(parents=True, exist_ok=True)
        write_json(
            current_node_dir / "status.json",
            {"id": node["id"], "node": node["node"], "status": "pending", "startedAt": None, "endedAt": None, "error": None, "progress": 0},
        )

    first_node = workflow.get("nodes", [{}])[0].get("id")
    if first_node:
        schedule_from(run_id, first_node, background_tasks)
    return {"runId": run_id, "run": load_run(run_id)}


@app.get("/api/runs")
def list_runs() -> dict[str, Any]:
    runs = []
    for run_json in sorted(RUNS_DIR.glob("*/run.json"), reverse=True):
        run = read_json(run_json, {})
        if run.get("id"):
            run = run_with_aggregate_status(run["id"], run)
        runs.append(run)
    return {"runs": runs}


@app.get("/api/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    run = load_run(run_id)
    statuses = {}
    for node in workflow_nodes(run):
        status = effective_node_status(run, node["id"], load_node_status(run_id, node["id"]))
        node_dir, node_def = node_definition(node["node"])
        capabilities = node_def.get("capabilities", {})
        entry = node_def.get("ui", {}).get("entry")
        has_ui = False
        if entry:
            entry_path = (node_dir / entry).resolve()
            has_ui = (node_dir in entry_path.parents or entry_path == node_dir) and entry_path.exists()
        statuses[node["id"]] = {
            **status,
            "hasUi": has_ui,
            "supportsParams": bool(capabilities.get("params")),
            "uiUrl": f"/ui/runs/{run_id}/nodes/{node['id']}/" if has_ui else None,
        }
    return {**run, "status": aggregate_run_status(run, statuses), "nodeStatuses": statuses}


@app.get("/api/runs/{run_id}/nodes/{node_id}")
def get_node_run(run_id: str, node_id: str) -> dict[str, Any]:
    run = load_run(run_id)
    find_workflow_node(run, node_id)
    return effective_node_status(run, node_id, load_node_status(run_id, node_id))


@app.get("/api/runs/{run_id}/nodes/{node_id}/progress")
def get_node_progress(run_id: str, node_id: str) -> dict[str, Any]:
    run = load_run(run_id)
    find_workflow_node(run, node_id)
    status = effective_node_status(run, node_id, load_node_status(run_id, node_id))
    return {
        "runId": run_id,
        "nodeId": node_id,
        "status": status.get("status", "pending"),
        "progress": normalized_progress(status.get("progress", 0)),
        "startedAt": status.get("startedAt"),
        "endedAt": status.get("endedAt"),
        "error": status.get("error"),
    }


@app.get("/api/runs/{run_id}/nodes/{node_id}/result")
def get_node_result(run_id: str, node_id: str) -> dict[str, Any]:
    return read_json(node_run_dir(run_id, node_id) / "result.json", {})


@app.get("/api/runs/{run_id}/nodes/{node_id}/data-preview")
def get_node_data_preview(run_id: str, node_id: str) -> dict[str, Any]:
    find_workflow_node(load_run(run_id), node_id)
    data = read_json(node_run_dir(run_id, node_id) / "data" / "data.json", None)
    return data_preview_response(node_id, data)


@app.get("/api/runs/{run_id}/nodes/{node_id}/context")
def get_node_context(run_id: str, node_id: str) -> dict[str, Any]:
    run = load_run(run_id)
    workflow_node = find_workflow_node(run, node_id)
    _, node_def = node_definition(workflow_node["node"])
    status = effective_node_status(run, node_id, load_node_status(run_id, node_id))
    return {
        "runId": run_id,
        "nodeId": node_id,
        "nodeName": workflow_node["node"],
        "mode": run.get("mode"),
        "status": status.get("status"),
        "capabilities": node_def.get("capabilities", {}),
        "resultUrl": f"/api/runs/{run_id}/nodes/{node_id}/result",
        "uploadUrl": f"/api/runs/{run_id}/nodes/{node_id}/upload",
        "uploads": read_json(node_run_dir(run_id, node_id) / "data" / "uploads.json", []),
    }


def read_log_increment(path: Path, offset: int | None) -> tuple[str, int]:
    if not path.exists():
        return "", 0
    size = path.stat().st_size
    start = offset if offset is not None and 0 <= offset <= size else 0
    with path.open("rb") as handle:
        handle.seek(start)
        data = handle.read()
    return data.decode("utf-8", errors="replace"), start + len(data)


@app.get("/api/runs/{run_id}/nodes/{node_id}/logs")
def get_node_logs(
    run_id: str,
    node_id: str,
    stdoutOffset: int | None = None,
    stderrOffset: int | None = None,
) -> dict[str, Any]:
    find_workflow_node(load_run(run_id), node_id)
    logs_dir = node_run_dir(run_id, node_id) / "logs"
    stdout_path = logs_dir / "stdout.log"
    stderr_path = logs_dir / "stderr.log"
    stdout, stdout_offset = read_log_increment(stdout_path, stdoutOffset)
    stderr, stderr_offset = read_log_increment(stderr_path, stderrOffset)
    return {
        "stdout": stdout,
        "stderr": stderr,
        "combined": "\n".join(part for part in [stdout.strip(), stderr.strip()] if part),
        "stdoutOffset": stdout_offset,
        "stderrOffset": stderr_offset,
    }


@app.post("/api/runs/{run_id}/nodes/{node_id}/query")
def query_node(run_id: str, node_id: str, request: QueryRequest) -> Any:
    return run_node_command(
        run_id,
        node_id,
        "query",
        ["--dataset", request.dataset, "--page", str(request.page), "--page-size", str(request.pageSize), "--filters", json.dumps(request.filters), "--sort", json.dumps(request.sort)],
        capture_json=True,
    )


@app.post("/api/runs/{run_id}/nodes/{node_id}/search")
def search_node(run_id: str, node_id: str, request: SearchRequest) -> Any:
    return run_node_command(
        run_id,
        node_id,
        "search",
        ["--dataset", request.dataset, "--q", request.q, "--page", str(request.page), "--page-size", str(request.pageSize)],
        capture_json=True,
    )


@app.post("/api/runs/{run_id}/nodes/{node_id}/params")
def params_node(run_id: str, node_id: str, payload: dict[str, Any]) -> Any:
    _, _, node_def = current_node_definition(run_id, node_id)
    if not node_def.get("capabilities", {}).get("params"):
        raise HTTPException(status_code=409, detail="Node does not support params")
    started_at = now_iso()
    status = load_node_status(run_id, node_id)
    save_run(run_id, {**load_run(run_id), "status": "running", "currentNodeId": node_id, "endedAt": None})
    save_node_status(
        run_id,
        node_id,
        {**status, "status": "running", "startedAt": status.get("startedAt") or started_at, "endedAt": None, "error": None, "progress": 0},
    )
    try:
        result = run_node_command_logged_json(
            run_id,
            node_id,
            "params",
            ["--payload", json.dumps(payload, ensure_ascii=False)],
        )
    except HTTPException as exc:
        ended_at = now_iso()
        if node_was_stopped(load_node_status(run_id, node_id)):
            run_status = "stopped" if load_run(run_id).get("status") in {"stopping", "stopped"} else "terminated"
            complete_stopped_node(run_id, node_id, ended_at, run_status=run_status)
            return {"ok": False, "error": {"code": "NODE_STOPPED", "message": "节点已停止"}}
        save_node_status(run_id, node_id, {**load_node_status(run_id, node_id), "status": "failed", "endedAt": ended_at, "error": str(exc.detail)})
        save_run(run_id, {**load_run(run_id), "status": "failed", "endedAt": ended_at})
        raise

    ended_at = now_iso()
    if node_was_stopped(load_node_status(run_id, node_id)):
        run_status = "stopped" if load_run(run_id).get("status") in {"stopping", "stopped"} else "terminated"
        complete_stopped_node(run_id, node_id, ended_at, run_status=run_status)
        return {"ok": False, "error": {"code": "NODE_STOPPED", "message": "节点已停止"}}

    if isinstance(result, dict) and result.get("ok") is False:
        error = result.get("error", {})
        message = error.get("message") if isinstance(error, dict) else None
        save_node_status(run_id, node_id, {**load_node_status(run_id, node_id), "status": "failed", "endedAt": ended_at, "error": message or "Node command failed"})
        save_run(run_id, {**load_run(run_id), "status": "failed", "endedAt": ended_at})
        return result

    next_status = "waiting-confirmation" if load_run(run_id).get("mode") == "manual-confirm" else "success"
    save_node_status(run_id, node_id, {**load_node_status(run_id, node_id), "status": next_status, "endedAt": ended_at, "progress": 100})
    if next_status == "success":
        save_run(run_id, {**load_run(run_id), "status": "success", "currentNodeId": None, "endedAt": ended_at})
    else:
        save_run(run_id, {**load_run(run_id), "status": next_status, "currentNodeId": node_id})
    return result


@app.post("/api/runs/{run_id}/nodes/{node_id}/upload")
def upload_node_file(
    run_id: str,
    node_id: str,
    file: UploadFile = File(...),
    field: str = Form("file"),
) -> Any:
    _, _, node_def = current_node_definition(run_id, node_id)
    if not node_def.get("capabilities", {}).get("upload"):
        raise HTTPException(status_code=409, detail="Node does not support file upload")

    safe_name = safe_filename(file.filename or "upload")
    upload_dir = node_run_dir(run_id, node_id) / "data" / "uploads"
    upload_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d%H%M%S%f")
    target_path = (upload_dir / f"{stamp}-{safe_name}").resolve()
    if upload_dir.resolve() not in target_path.parents:
        raise HTTPException(status_code=400, detail="Invalid upload path")

    with target_path.open("wb") as output:
        shutil.copyfileobj(file.file, output)

    upload_record = {
        "field": field,
        "filename": file.filename or safe_name,
        "path": str(target_path),
        "size": target_path.stat().st_size,
        "uploadedAt": now_iso(),
    }
    uploads_path = node_run_dir(run_id, node_id) / "data" / "uploads.json"
    uploads = read_json(uploads_path, [])
    if not isinstance(uploads, list):
        uploads = []
    uploads.append(upload_record)
    write_json(uploads_path, uploads)

    node_result = run_node_command(
        run_id,
        node_id,
        "upload",
        [
            "--file-path",
            str(target_path),
            "--field",
            field,
            "--filename",
            file.filename or safe_name,
        ],
        capture_json=True,
    )
    return {"ok": True, "upload": upload_record, "node": node_result}


@app.get("/api/runs/{run_id}/nodes/{node_id}/records/{dataset}/{record_id}")
def get_record(run_id: str, node_id: str, dataset: str, record_id: str) -> Any:
    return run_node_command(run_id, node_id, "get", ["--dataset", dataset, "--id", record_id], capture_json=True)


@app.patch("/api/runs/{run_id}/nodes/{node_id}/records/{dataset}/{record_id}")
def update_record(run_id: str, node_id: str, dataset: str, record_id: str, patch: dict[str, Any]) -> Any:
    return run_node_command(run_id, node_id, "update", ["--dataset", dataset, "--id", record_id, "--patch", json.dumps(patch)], capture_json=True)


@app.post("/api/runs/{run_id}/nodes/{node_id}/confirm")
def confirm_node(run_id: str, node_id: str, request: ConfirmRequest, background_tasks: BackgroundTasks) -> dict[str, Any]:
    run = load_run(run_id)
    raw_status = load_node_status(run_id, node_id)
    status = effective_node_status(run, node_id, raw_status)
    if status.get("status") != "waiting-confirmation":
        raise HTTPException(status_code=409, detail="Node is not waiting for confirmation")
    write_json(node_run_dir(run_id, node_id) / "confirm.json", {"confirmed": True, "confirmedAt": now_iso(), "note": request.note})
    save_node_status(run_id, node_id, {**status, "status": "confirmed"})
    following_node = next_node_id(run, node_id)
    if following_node:
        schedule_from(run_id, following_node, background_tasks)
    else:
        save_run(run_id, {**load_run(run_id), "status": "success", "currentNodeId": None, "endedAt": now_iso()})
    return {"ok": True, "run": load_run(run_id)}


@app.post("/api/runs/{run_id}/nodes/{node_id}/retry")
def retry_node(run_id: str, node_id: str, background_tasks: BackgroundTasks) -> dict[str, Any]:
    _, _, node_def = current_node_definition(run_id, node_id)
    status = load_node_status(run_id, node_id)
    if status.get("status") not in {"failed", "stopped"}:
        raise HTTPException(status_code=409, detail="Only failed or stopped nodes can be retried")
    supports_params = bool(node_def.get("capabilities", {}).get("params"))
    retry_status = {
        **status,
        "status": "pending",
        "error": None,
        "endedAt": None,
        "stopRequestedAt": None,
        "progress": 0,
    }
    save_node_status(run_id, node_id, retry_status)
    save_run(run_id, {**load_run(run_id), "status": "running", "currentNodeId": node_id, "endedAt": None})
    if supports_params:
        started_at = now_iso()
        return_code = run_node_command(run_id, node_id, "run", ["--workflow-file", str(run_dir(run_id) / "workflow.md")])
        ended_at = now_iso()
        if return_code != 0:
            save_node_status(run_id, node_id, {**load_node_status(run_id, node_id), "status": "failed", "endedAt": ended_at, "error": f"Process exited with {return_code}"})
            save_run(run_id, {**load_run(run_id), "status": "failed", "endedAt": ended_at})
            return {"ok": False, "error": {"code": "NODE_INIT_FAILED", "message": "Node initialization failed"}}
        save_node_status(
            run_id,
            node_id,
            {**load_node_status(run_id, node_id), "status": "waiting-confirmation", "startedAt": started_at, "endedAt": ended_at, "error": None, "stopRequestedAt": None, "progress": 0},
        )
        save_run(run_id, {**load_run(run_id), "status": "waiting-confirmation", "currentNodeId": node_id, "endedAt": None})
        return {"ok": True}
    schedule_from(run_id, node_id, background_tasks)
    return {"ok": True}


@app.post("/api/runs/{run_id}/nodes/{node_id}/stop")
def stop_node(run_id: str, node_id: str) -> dict[str, Any]:
    status = load_node_status(run_id, node_id)
    if status.get("status") == "stopped" and status.get("error"):
        return {"ok": True, "status": complete_stopped_node(run_id, node_id, status.get("endedAt"))}
    if status.get("status") in TERMINAL_NODE_STATES:
        return {"ok": True, "status": status}
    with process_lock:
        process = processes.get((run_id, node_id))
    if process and process.poll() is None:
        save_node_status(run_id, node_id, {**status, "status": "stopping", "stopRequestedAt": now_iso()})
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
    stopped = complete_stopped_node(run_id, node_id)
    return {"ok": True, "status": stopped}


@app.post("/api/runs/{run_id}/stop")
def stop_run(run_id: str) -> dict[str, Any]:
    run = load_run(run_id)
    if run.get("status") in {"stopped", "terminated"}:
        return {"ok": True, "run": run}
    save_run(run_id, {**run, "status": "stopping"})
    for node in workflow_nodes(run):
        node_id = node["id"]
        status = load_node_status(run_id, node_id)
        if status.get("status") in ACTIVE_NODE_STATES:
            stop_node(run_id, node_id)
    save_run(run_id, {**load_run(run_id), "status": "stopped", "endedAt": now_iso()})
    return {"ok": True, "run": load_run(run_id)}


@app.delete("/api/runs/{run_id}")
def delete_run(run_id: str) -> JSONResponse:
    run = load_run(run_id)
    blockers = []
    for node in workflow_nodes(run):
        status = load_node_status(run_id, node["id"]).get("status")
        if status not in TERMINAL_NODE_STATES:
            blockers.append({"nodeId": node["id"], "status": status})
    if blockers:
        raise HTTPException(status_code=409, detail={"message": "Stop the run before deleting it", "blockers": blockers})
    shutil.rmtree(run_dir(run_id))
    return JSONResponse({"ok": True})


@app.get("/ui/runs/{run_id}/nodes/{node_id}/")
def node_ui_entry(run_id: str, node_id: str) -> FileResponse:
    run = load_run(run_id)
    workflow_node = find_workflow_node(run, node_id)
    node_dir, node_def = node_definition(workflow_node["node"])
    entry = node_def.get("ui", {}).get("entry", "ui/index.html")
    entry_path = (node_dir / entry).resolve()
    if node_dir not in entry_path.parents:
        raise HTTPException(status_code=400, detail="Invalid UI entry")
    if not entry_path.exists():
        raise HTTPException(status_code=404, detail="Node UI entry not found")
    return FileResponse(entry_path, headers=NO_CACHE_HEADERS)


@app.get("/ui/runs/{run_id}/nodes/{node_id}/assets/{asset_path:path}")
def node_ui_asset(run_id: str, node_id: str, asset_path: str) -> FileResponse:
    run = load_run(run_id)
    workflow_node = find_workflow_node(run, node_id)
    node_dir, node_def = node_definition(workflow_node["node"])
    entry = Path(node_def.get("ui", {}).get("entry", "ui/index.html"))
    asset_root = (node_dir / entry.parent).resolve()
    path = (asset_root / asset_path).resolve()
    if asset_root not in path.parents and path != asset_root:
        raise HTTPException(status_code=400, detail="Invalid asset path")
    if not path.exists():
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(path, headers=NO_CACHE_HEADERS)


frontend_dist = REPO_DIR / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
