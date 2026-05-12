from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


ROWS = [
    {"id": "1", "name": "张三", "phone": "13800138000", "issue": "ok", "status": "clean"},
    {"id": "2", "name": "李四", "phone": "12345", "issue": "手机号格式错误", "status": "needs-review"},
    {"id": "3", "name": "王五", "phone": "", "issue": "手机号缺失", "status": "needs-review"},
    {"id": "4", "name": "赵六", "phone": "13900139000", "issue": "ok", "status": "clean"},
]

COLUMNS = [
    {"key": "id", "label": "ID", "type": "string"},
    {"key": "name", "label": "姓名", "type": "string"},
    {"key": "phone", "label": "手机号", "type": "string"},
    {"key": "issue", "label": "问题", "type": "string"},
    {"key": "status", "label": "状态", "type": "string"},
]


def data_path(node_run_dir: Path) -> Path:
    return node_run_dir / "data" / "customers.json"


def load_rows(node_run_dir: Path) -> list[dict[str, Any]]:
    path = data_path(node_run_dir)
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_rows(node_run_dir: Path, rows: list[dict[str, Any]]) -> None:
    path = data_path(node_run_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def paginate(rows: list[dict[str, Any]], page: int, page_size: int) -> list[dict[str, Any]]:
    start = max(page - 1, 0) * page_size
    return rows[start : start + page_size]


def run(args: argparse.Namespace) -> None:
    node_run_dir = Path(args.node_run_dir)
    save_rows(node_run_dir, ROWS)
    (node_run_dir / "result.json").write_text(
        json.dumps(
            {
                "status": "success",
                "summary": "清洗完成，共处理 4 行，发现 2 条需要人工确认的数据。",
                "datasets": [
                    {
                        "name": "customers",
                        "label": "客户数据",
                        "type": "table",
                        "queryable": True,
                        "searchable": True,
                        "editable": True,
                        "total": len(ROWS),
                    }
                ],
                "ui": {"entry": "ui/index.html"},
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def query(args: argparse.Namespace) -> None:
    rows = load_rows(Path(args.node_run_dir))
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


def search(args: argparse.Namespace) -> None:
    rows = load_rows(Path(args.node_run_dir))
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


def get(args: argparse.Namespace) -> None:
    for row in load_rows(Path(args.node_run_dir)):
        if row["id"] == args.id:
            print_json({"ok": True, "dataset": args.dataset, "id": args.id, "record": row})
            return
    print_json({"ok": False, "error": {"code": "RECORD_NOT_FOUND", "message": f"Record {args.id} not found"}})


def update(args: argparse.Namespace) -> None:
    rows = load_rows(Path(args.node_run_dir))
    patch = json.loads(args.patch)
    for row in rows:
        if row["id"] == args.id:
            row.update(patch)
            save_rows(Path(args.node_run_dir), rows)
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
    globals()[args.action](args)


if __name__ == "__main__":
    main()
