from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

DATASET = "urls"
VALID_LABELS = frozenset({"小猫", "小狗"})

COLUMNS: list[dict[str, str]] = [
    {"key": "id", "label": "ID", "type": "string"},
    {"key": "url", "label": "URL", "type": "string"},
    {"key": "label", "label": "标注", "type": "string"},
]

DEFAULT_ITEMS: list[dict[str, str]] = [
    {"url": "https://placekitten.com/200/200"},
    {"url": "https://place.dog/300/200"},
]


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def node_step_id(node_run_dir: Path) -> str:
    return node_run_dir.name


def workflow_step(run_dir: Path, step_id: str) -> dict[str, Any] | None:
    run_data = read_json(run_dir / "run.json", {})
    for n in run_data.get("workflow", {}).get("nodes", []):
        if isinstance(n, dict) and n.get("id") == step_id:
            return n
    return None


def load_upstream_items(run_dir: Path, step_id: str) -> list[dict[str, str]]:
    step = workflow_step(run_dir, step_id)
    deps = list((step or {}).get("depends_on") or [])
    items: list[dict[str, str]] = []
    if deps:
        prev_id = deps[0]
        path = run_dir / "nodes" / prev_id / "data" / "items.json"
        if path.exists():
            raw = read_json(path, [])
            if isinstance(raw, list):
                for x in raw:
                    if isinstance(x, dict) and str(x.get("url", "")).strip():
                        items.append({"url": str(x["url"]).strip()})
    if not items:
        inp = read_json(run_dir / "run.json", {}).get("input") or {}
        alt = inp.get("items")
        if isinstance(alt, list):
            for x in alt:
                if isinstance(x, dict) and str(x.get("url", "")).strip():
                    items.append({"url": str(x["url"]).strip()})
    if not items:
        items = list(DEFAULT_ITEMS)
    return items


def rows_path(node_run_dir: Path) -> Path:
    return node_run_dir / "data" / "url_rows.json"


def export_path(node_run_dir: Path) -> Path:
    return node_run_dir / "data" / "labeled_items.json"


def load_rows(node_run_dir: Path) -> list[dict[str, Any]]:
    path = rows_path(node_run_dir)
    if not path.exists():
        return []
    data = read_json(path, [])
    return data if isinstance(data, list) else []


def save_rows(node_run_dir: Path, rows: list[dict[str, Any]]) -> None:
    path = rows_path(node_run_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    export = [{"url": r["url"], "label": r.get("label", "")} for r in rows]
    export_path(node_run_dir).write_text(json.dumps(export, ensure_ascii=False, indent=2), encoding="utf-8")


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def paginate(rows: list[dict[str, Any]], page: int, page_size: int) -> list[dict[str, Any]]:
    start = max(page - 1, 0) * page_size
    return rows[start : start + page_size]


def run_cmd(args: argparse.Namespace) -> None:
    run_dir = Path(args.run_dir)
    node_run_dir = Path(args.node_run_dir)
    step_id = node_step_id(node_run_dir)
    raw_items = load_upstream_items(run_dir, step_id)
    rows: list[dict[str, Any]] = []
    for i, it in enumerate(raw_items, start=1):
        rows.append({"id": str(i), "url": it["url"], "label": ""})
    save_rows(node_run_dir, rows)
    labeled = sum(1 for r in rows if r.get("label") in VALID_LABELS)
    (node_run_dir / "result.json").write_text(
        json.dumps(
            {
                "status": "success",
                "summary": f"已加载 {len(rows)} 条 URL，已标注 {labeled} 条。输出文件 data/labeled_items.json 供下一节点使用。",
                "datasets": [
                    {
                        "name": DATASET,
                        "label": "URL 标注",
                        "type": "table",
                        "queryable": True,
                        "searchable": True,
                        "editable": True,
                        "total": len(rows),
                    }
                ],
                "ui": {"entry": "ui/index.html"},
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def query_cmd(args: argparse.Namespace) -> None:
    rows = load_rows(Path(args.node_run_dir))
    if args.dataset != DATASET:
        print_json({"ok": False, "error": {"code": "UNKNOWN_DATASET", "message": args.dataset}})
        return
    print_json(
        {
            "ok": True,
            "dataset": args.dataset,
            "page": args.page,
            "pageSize": args.page_size,
            "total": len(rows),
            "columns": COLUMNS,
            "rows": paginate(rows, args.page, args.page_size),
        }
    )


def search_cmd(args: argparse.Namespace) -> None:
    rows = load_rows(Path(args.node_run_dir))
    if args.dataset != DATASET:
        print_json({"ok": False, "error": {"code": "UNKNOWN_DATASET", "message": args.dataset}})
        return
    q = args.q.lower()
    matched = [row for row in rows if q in json.dumps(row, ensure_ascii=False).lower()]
    print_json(
        {
            "ok": True,
            "dataset": args.dataset,
            "page": args.page,
            "pageSize": args.page_size,
            "total": len(matched),
            "columns": COLUMNS,
            "rows": paginate(matched, args.page, args.page_size),
        }
    )


def get_cmd(args: argparse.Namespace) -> None:
    rows = load_rows(Path(args.node_run_dir))
    if args.dataset != DATASET:
        print_json({"ok": False, "error": {"code": "UNKNOWN_DATASET", "message": args.dataset}})
        return
    for row in rows:
        if row.get("id") == args.id:
            print_json({"ok": True, "dataset": args.dataset, "id": args.id, "record": row})
            return
    print_json({"ok": False, "error": {"code": "RECORD_NOT_FOUND", "message": f"Record {args.id} not found"}})


def update_cmd(args: argparse.Namespace) -> None:
    node_run_dir = Path(args.node_run_dir)
    rows = load_rows(node_run_dir)
    if args.dataset != DATASET:
        print_json({"ok": False, "error": {"code": "UNKNOWN_DATASET", "message": args.dataset}})
        return
    patch = json.loads(args.patch)
    if not isinstance(patch, dict):
        print_json({"ok": False, "error": {"code": "INVALID_PATCH", "message": "patch must be an object"}})
        return
    patch.pop("id", None)
    patch.pop("url", None)
    if "label" in patch and patch["label"] not in VALID_LABELS:
        print_json(
            {
                "ok": False,
                "error": {"code": "INVALID_LABEL", "message": 'label 必须为 "小猫" 或 "小狗"'},
            }
        )
        return
    for row in rows:
        if row.get("id") == args.id:
            row.update(patch)
            save_rows(node_run_dir, rows)
            print_json({"ok": True, "dataset": args.dataset, "id": args.id, "record": row})
            return
    print_json({"ok": False, "error": {"code": "RECORD_NOT_FOUND", "message": f"Record {args.id} not found"}})


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="action", required=True)
    for action in ["run", "query", "search", "get", "update"]:
        command = sub.add_parser(action)
        command.add_argument("--run-dir", required=True)
        command.add_argument("--node-run-dir", required=True)
        command.add_argument("--node-dir", required=True)
        if action == "run":
            command.add_argument("--workflow-file", required=True)
        if action in {"query", "search", "get", "update"}:
            command.add_argument("--dataset", required=True)
        if action in {"query", "search"}:
            command.add_argument("--page", type=int, default=1)
            command.add_argument("--page-size", type=int, default=100)
        if action == "query":
            command.add_argument("--filters", default="{}")
            command.add_argument("--sort", default="{}")
        if action == "search":
            command.add_argument("--q", required=True)
        if action in {"get", "update"}:
            command.add_argument("--id", required=True)
        if action == "update":
            command.add_argument("--patch", required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    if args.action == "run":
        run_cmd(args)
    elif args.action == "query":
        query_cmd(args)
    elif args.action == "search":
        search_cmd(args)
    elif args.action == "get":
        get_cmd(args)
    elif args.action == "update":
        update_cmd(args)


if __name__ == "__main__":
    main()
