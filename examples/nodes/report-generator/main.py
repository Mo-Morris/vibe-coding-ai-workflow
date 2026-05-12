from __future__ import annotations

import argparse
import json
from pathlib import Path


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
    source_data = run_dir / "nodes" / "clean" / "data" / "customers.json"
    rows = json.loads(source_data.read_text(encoding="utf-8")) if source_data.exists() else []
    clean_count = sum(1 for row in rows if row.get("status") == "clean")
    report = {
        "total": len(rows),
        "clean": clean_count,
        "needsReview": len(rows) - clean_count,
    }
    data_dir = node_run_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (node_run_dir / "result.json").write_text(
        json.dumps(
            {
                "status": "success",
                "summary": f"报告生成完成：共 {report['total']} 条，已清洗 {report['clean']} 条，仍需复查 {report['needsReview']} 条。",
                "datasets": [],
                "ui": {"entry": "ui/index.html"},
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
