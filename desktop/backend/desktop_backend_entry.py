from __future__ import annotations

import argparse
from pathlib import Path
import sys


if not getattr(sys, "frozen", False):
    backend_root = Path(__file__).resolve().parents[2] / "backend"
    sys.path.insert(0, str(backend_root))

import uvicorn  # noqa: E402

from app.main import create_app  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Neighborhood Radius desktop backend")
    parser.add_argument("--host", default="127.0.0.1", choices=("127.0.0.1", "localhost"))
    parser.add_argument("--port", type=int, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 1 <= args.port <= 65535:
        raise SystemExit("port must be between 1 and 65535")
    uvicorn.run(
        create_app(),
        host=args.host,
        port=args.port,
        loop="asyncio",
        http="h11",
        access_log=False,
        log_level="warning",
    )


if __name__ == "__main__":
    main()

