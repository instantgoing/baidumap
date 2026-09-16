from dataclasses import dataclass
import os
from pathlib import Path

from dotenv import load_dotenv


# Local development keeps the server AK in backend/.env. Existing process
# environment variables always win, so deployments can continue to inject
# secrets without relying on a file.
load_dotenv(Path(__file__).resolve().parents[1] / ".env", override=False)


def _as_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Settings:
    app_name: str = "邻里半径 API"
    app_version: str = "0.6.0-stage6"
    baidu_service_ak: str = ""
    baidu_base_url: str = "https://api.map.baidu.com"
    baidu_timeout_seconds: float = 12.0
    baidu_retry_count: int = 1
    baidu_max_concurrency: int = 2
    baidu_max_qps: int = 1
    baidu_qps_window_seconds: float = 3.2
    baidu_cache_ttl_seconds: float = 300.0
    baidu_cache_max_entries: int = 256
    baidu_circuit_failure_threshold: int = 4
    baidu_circuit_cooldown_seconds: float = 20.0
    max_route_destinations: int = 50
    cors_allow_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
    trust_proxy_headers: bool = False

    @property
    def baidu_configured(self) -> bool:
        return bool(self.baidu_service_ak)


def load_settings() -> Settings:
    origins = tuple(item.strip() for item in os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if item.strip())
    return Settings(
        baidu_service_ak=os.getenv("BAIDU_SERVICE_AK", "").strip(),
        baidu_base_url=os.getenv("BAIDU_BASE_URL", "https://api.map.baidu.com").rstrip("/"),
        baidu_timeout_seconds=float(os.getenv("BAIDU_TIMEOUT_SECONDS", "12")),
        baidu_retry_count=max(0, int(os.getenv("BAIDU_RETRY_COUNT", "1"))),
        baidu_max_concurrency=max(1, int(os.getenv("BAIDU_MAX_CONCURRENCY", "2"))),
        baidu_max_qps=max(1, int(os.getenv("BAIDU_MAX_QPS", "1"))),
        baidu_qps_window_seconds=max(0.1, float(os.getenv("BAIDU_QPS_WINDOW_SECONDS", "3.2"))),
        baidu_cache_ttl_seconds=max(0, float(os.getenv("BAIDU_CACHE_TTL_SECONDS", "300"))),
        baidu_cache_max_entries=max(1, int(os.getenv("BAIDU_CACHE_MAX_ENTRIES", "256"))),
        baidu_circuit_failure_threshold=max(1, int(os.getenv("BAIDU_CIRCUIT_FAILURE_THRESHOLD", "4"))),
        baidu_circuit_cooldown_seconds=max(1, float(os.getenv("BAIDU_CIRCUIT_COOLDOWN_SECONDS", "20"))),
        max_route_destinations=min(50, max(1, int(os.getenv("MAX_ROUTE_DESTINATIONS", "50")))),
        cors_allow_origins=origins,
        trust_proxy_headers=_as_bool(os.getenv("TRUST_PROXY_HEADERS")),
    )
