from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

DEFAULT_ITEMS: list[dict[str, str]] = [
    {"url": "https://placekitten.com/200/200"},
    {"url": "https://place.dog/300/200"},
]


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="action", required=True)
    run = sub.add_parser("run")
    run.add_argument("--run-dir", required=True)
    run.add_argument("--node-run-dir", required=True)
    run.add_argument("--node-dir", required=True)
    run.add_argument("--workflow-file", required=True)
    args = parser.parse_args()

    if args.action != "run":
        print(json.dumps({"ok": False, "error": {"code": "UNSUPPORTED_ACTION", "message": "Only run is supported"}}))
        return

    run_dir = Path(args.run_dir)
    node_run_dir = Path(args.node_run_dir)
    run_data: dict[str, Any] = {}
    run_json = run_dir / "run.json"
    if run_json.exists():
        run_data = json.loads(run_json.read_text(encoding="utf-8"))

    inp = run_data.get("input") or {}
    raw_items = inp.get("items")
    items: list[dict[str, str]] = []
    if isinstance(raw_items, list):
        for x in raw_items:
            if isinstance(x, dict) and x.get("url"):
                items.append({"url": str(x["url"]).strip()})
    if not items:
        items = list(DEFAULT_ITEMS)

    data_dir = node_run_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "items.json").write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")

    (node_run_dir / "result.json").write_text(
        json.dumps(
            {
                "status": "success",
                "summary": f"已写入 {len(items)} 条 URL，供下游标注节点读取。",
                "datasets": [],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
