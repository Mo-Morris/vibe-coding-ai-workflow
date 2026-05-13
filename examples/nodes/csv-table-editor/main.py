from __future__ import annotations

import argparse
import csv
import io
import json
from pathlib import Path
from typing import Any

DATASET_NAME = "csv"

DEFAULT_CSV = """姓名,城市,备注
张三,北京,首轮联系
李四,上海,
王五,深圳,待跟进"""


def run_input_csv(run_dir: Path) -> str:
    run_json = run_dir / "run.json"
    if not run_json.exists():
        return DEFAULT_CSV
    run_data = json.loads(run_json.read_text(encoding="utf-8"))
    inp = run_data.get("input") or {}
    raw = inp.get("csv")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return DEFAULT_CSV


def unique_header_keys(headers: list[str]) -> list[str]:
    counts: dict[str, int] = {}
    keys: list[str] = []
    for h in headers:
        base = (h or "").strip() or "column"
        n = counts.get(base, 0)
        counts[base] = n + 1
        keys.append(base if n == 0 else f"{base}_{n}")
    return keys


def parse_csv_text(text: str) -> tuple[list[str], list[dict[str, Any]]]:
    stream = io.StringIO(text.lstrip("\ufeff"))
    reader = csv.reader(stream)
    rows_raw = list(reader)
    if not rows_raw:
        return [], []
    header_keys = unique_header_keys(rows_raw[0])
    data_rows: list[dict[str, Any]] = []
    for i, cells in enumerate(rows_raw[1:], start=1):
        padded = list(cells) + [""] * max(0, len(header_keys) - len(cells))
        row = {k: padded[j] if j < len(padded) else "" for j, k in enumerate(header_keys)}
        row["id"] = str(i)
        data_rows.append(row)
    return header_keys, data_rows


def columns_from_keys(keys: list[str]) -> list[dict[str, str]]:
    cols: list[dict[str, str]] = [{"key": "id", "label": "id", "type": "string"}]
    for k in keys:
        cols.append({"key": k, "label": k, "type": "string"})
    return cols


def state_path(node_run_dir: Path) -> Path:
    return node_run_dir / "data" / "state.json"


def load_state(node_run_dir: Path) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    path = state_path(node_run_dir)
    if not path.exists():
        return [], []
    data = json.loads(path.read_text(encoding="utf-8"))
    cols = data.get("columns") or []
    rows = data.get("rows") or []
    return cols, rows


def save_state(node_run_dir: Path, columns: list[dict[str, str]], rows: list[dict[str, Any]]) -> None:
    path = state_path(node_run_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"columns": columns, "rows": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_result(node_run_dir: Path, summary: str, total: int) -> None:
    (node_run_dir / "result.json").write_text(
        json.dumps(
            {
                "status": "success",
                "summary": summary,
                "datasets": [
                    {
                        "name": DATASET_NAME,
                        "label": "CSV 数据",
                        "type": "table",
                        "queryable": True,
                        "searchable": True,
                        "editable": True,
                        "total": total,
                    }
                ],
                "ui": {"entry": "ui/index.html"},
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def paginate(rows: list[dict[str, Any]], page: int, page_size: int) -> list[dict[str, Any]]:
    start = max(page - 1, 0) * page_size
    return rows[start : start + page_size]


def run_cmd(args: argparse.Namespace) -> None:
    node_run_dir = Path(args.node_run_dir)
    run_dir = Path(args.run_dir)
    text = run_input_csv(run_dir)
    keys, rows = parse_csv_text(text)
    columns = columns_from_keys(keys)
    save_state(node_run_dir, columns, rows)
    summary = f"已从 CSV 加载 {len(rows)} 行，{len(keys)} 列。"
    if not keys:
        summary = "CSV 无表头或为空，已创建空表。"
    write_result(node_run_dir, summary, len(rows))


def upload_cmd(args: argparse.Namespace) -> None:
    node_run_dir = Path(args.node_run_dir)
    file_path = Path(args.file_path)
    if not file_path.exists() or not file_path.is_file():
        print_json({"ok": False, "error": {"code": "FILE_NOT_FOUND", "message": str(file_path)}})
        return
    text = file_path.read_text(encoding="utf-8-sig")
    keys, rows = parse_csv_text(text)
    columns = columns_from_keys(keys)
    save_state(node_run_dir, columns, rows)
    summary = f"已上传 {args.filename}，加载 {len(rows)} 行，{len(keys)} 列。"
    if not keys:
        summary = f"已上传 {args.filename}，但 CSV 无表头或为空，已创建空表。"
    write_result(node_run_dir, summary, len(rows))
    print_json({"ok": True, "summary": summary, "rows": len(rows), "columns": len(keys)})


def query_cmd(args: argparse.Namespace) -> None:
    columns, rows = load_state(Path(args.node_run_dir))
    if args.dataset != DATASET_NAME:
        print_json({"ok": False, "error": {"code": "UNKNOWN_DATASET", "message": args.dataset}})
        return
    print_json(
        {
            "ok": True,
            "dataset": args.dataset,
            "page": args.page,
            "pageSize": args.page_size,
            "total": len(rows),
            "columns": columns,
            "rows": paginate(rows, args.page, args.page_size),
        }
    )


def search_cmd(args: argparse.Namespace) -> None:
    columns, rows = load_state(Path(args.node_run_dir))
    if args.dataset != DATASET_NAME:
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
            "columns": columns,
            "rows": paginate(matched, args.page, args.page_size),
        }
    )


def get_cmd(args: argparse.Namespace) -> None:
    _, rows = load_state(Path(args.node_run_dir))
    if args.dataset != DATASET_NAME:
        print_json({"ok": False, "error": {"code": "UNKNOWN_DATASET", "message": args.dataset}})
        return
    for row in rows:
        if row.get("id") == args.id:
            print_json({"ok": True, "dataset": args.dataset, "id": args.id, "record": row})
            return
    print_json({"ok": False, "error": {"code": "RECORD_NOT_FOUND", "message": f"Record {args.id} not found"}})


def update_cmd(args: argparse.Namespace) -> None:
    node_run_dir = Path(args.node_run_dir)
    columns, rows = load_state(node_run_dir)
    if args.dataset != DATASET_NAME:
        print_json({"ok": False, "error": {"code": "UNKNOWN_DATASET", "message": args.dataset}})
        return
    patch = json.loads(args.patch)
    if isinstance(patch, dict):
        patch.pop("id", None)
    for row in rows:
        if row.get("id") == args.id:
            if isinstance(patch, dict):
                row.update(patch)
            save_state(node_run_dir, columns, rows)
            print_json({"ok": True, "dataset": args.dataset, "id": args.id, "record": row})
            return
    print_json({"ok": False, "error": {"code": "RECORD_NOT_FOUND", "message": f"Record {args.id} not found"}})


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="action", required=True)
    for action in ["run", "upload", "query", "search", "get", "update"]:
        command = sub.add_parser(action)
        command.add_argument("--run-dir", required=True)
        command.add_argument("--node-run-dir", required=True)
        command.add_argument("--node-dir", required=True)
        if action == "run":
            command.add_argument("--workflow-file", required=True)
        if action == "upload":
            command.add_argument("--file-path", required=True)
            command.add_argument("--field", default="file")
            command.add_argument("--filename", required=True)
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
    elif args.action == "upload":
        upload_cmd(args)
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
