from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.evidence.validation import EvidenceValidationError, calculate_metrics, load_validate  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="校验真实社区独立核验数据并计算比赛指标")
    subparsers = parser.add_subparsers(dest="command", required=True)
    validate = subparsers.add_parser("validate", help="校验模板或已采集数据")
    validate.add_argument("--input", type=Path, required=True)
    validate.add_argument("--template", action="store_true")
    calculate = subparsers.add_parser("calculate", help="严格校验后计算指标 JSON")
    calculate.add_argument("--input", type=Path, required=True)
    calculate.add_argument("--output", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        dataset, config = load_validate(args.input, template=getattr(args, "template", False))
        if args.command == "validate":
            mode = "模板结构" if args.template else "完整数据"
            print(f"{mode}校验通过：{len(dataset['ground_truth'])} 条 POI 槽位。")
            return 0
        result = calculate_metrics(dataset, config)
        payload = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(payload, encoding="utf-8")
            print(f"指标已写入 {args.output}")
        else:
            print(payload, end="")
        return 0
    except EvidenceValidationError as error:
        print("核验数据不完整，未生成准确率：", file=sys.stderr)
        for issue in error.issues:
            print(f"- {issue}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
