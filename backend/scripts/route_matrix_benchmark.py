from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.evidence.benchmark import dumps, run_benchmark  # noqa: E402
from app.evidence.validation import load_config  # noqa: E402


def main() -> int:
    config = load_config()["benchmark"]
    parser = argparse.ArgumentParser(description="逐点与批量 Walking RouteMatrix 多轮基准")
    parser.add_argument("--mode", choices=("simulated", "online"), default="simulated")
    parser.add_argument("--runs", type=int, default=config["defaultRuns"])
    parser.add_argument("--destinations", type=int, default=config["routeDestinationCount"])
    parser.add_argument("--simulated-latency-ms", type=float, default=config["simulatedLatencyMs"])
    parser.add_argument("--api-base-url", default="http://127.0.0.1:8000/api")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.runs < config["minimumRuns"]:
        parser.error(f"比赛证据至少运行 {config['minimumRuns']} 次")
    if not 1 <= args.destinations <= config["batchSize"]:
        parser.error(f"destinations 必须在 1..{config['batchSize']} 之间")
    result = asyncio.run(run_benchmark(
        mode=args.mode,
        runs=args.runs,
        destination_count=args.destinations,
        simulated_latency_ms=args.simulated_latency_ms,
        api_base_url=args.api_base_url,
    ))
    payload = dumps(result)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
        print(json.dumps({"status": "written", "path": str(args.output), "runs": args.runs, "mode": args.mode}, ensure_ascii=False))
    else:
        print(payload, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
