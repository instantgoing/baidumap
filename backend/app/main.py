from time import perf_counter
from uuid import uuid4

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import Settings, load_settings
from app.errors import BackendServiceError
from app.routers.map import router as map_router
from app.routers.poi import router as poi_router
from app.schemas import ApiMeta, HealthData, HealthResponse
from app.services.baidu_client import BaiduMapClient


def create_app(settings: Settings | None = None, baidu_client: BaiduMapClient | None = None) -> FastAPI:
    runtime = settings or load_settings()
    app = FastAPI(title=runtime.app_name, version=runtime.app_version)
    app.state.settings = runtime
    app.state.baidu_client = baidu_client or BaiduMapClient(
        service_ak=runtime.baidu_service_ak,
        base_url=runtime.baidu_base_url,
        timeout_seconds=runtime.baidu_timeout_seconds,
        retry_count=runtime.baidu_retry_count,
        max_concurrency=runtime.baidu_max_concurrency,
        max_qps=runtime.baidu_max_qps,
        qps_window_seconds=runtime.baidu_qps_window_seconds,
        cache_ttl_seconds=runtime.baidu_cache_ttl_seconds,
        cache_max_entries=runtime.baidu_cache_max_entries,
        circuit_failure_threshold=runtime.baidu_circuit_failure_threshold,
        circuit_cooldown_seconds=runtime.baidu_circuit_cooldown_seconds,
    )
    app.add_middleware(CORSMiddleware, allow_origins=list(runtime.cors_allow_origins), allow_credentials=True, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"])
    app.include_router(map_router)
    app.include_router(poi_router)

    @app.exception_handler(BackendServiceError)
    async def backend_error_handler(request: Request, error: BackendServiceError) -> JSONResponse:
        request_id = request.headers.get("X-Request-ID") or str(uuid4())
        return JSONResponse(status_code=error.status_code, content={"ok": False, "message": str(error), "error": {"kind": error.kind}, "meta": {"requestId": request_id, "apiVersion": runtime.app_version}})

    @app.exception_handler(Exception)
    async def unexpected_error_handler(request: Request, error: Exception) -> JSONResponse:
        request_id = request.headers.get("X-Request-ID") or str(uuid4())
        return JSONResponse(status_code=500, content={"ok": False, "message": "服务内部错误", "error": {"kind": "internal_error"}, "meta": {"requestId": request_id, "apiVersion": runtime.app_version}})

    @app.get("/api/health", response_model=HealthResponse, tags=["health"])
    async def health(verify: bool = Query(default=False)) -> HealthResponse:
        started = perf_counter()
        reachable: bool | None = None
        check = "configuration"
        if verify and runtime.baidu_configured:
            check = "live-geocoding"
            try:
                await app.state.baidu_client.health_probe()
                reachable = True
            except BackendServiceError:
                reachable = False
        status = "ok" if runtime.baidu_configured and reachable is not False else "degraded"
        if not runtime.baidu_configured:
            message = "后端已启动，但未配置 BAIDU_SERVICE_AK"
        elif reachable is True:
            message = "后端已连接真实百度地图 Web Service API"
        elif reachable is False:
            message = "服务端 AK 已配置，但百度 Web Service API 实时验证失败"
        else:
            message = "后端和百度服务配置已就绪"
        return HealthResponse(
            data=HealthData(status=status, message=message, baiduConfigured=runtime.baidu_configured, baiduReachable=reachable, serviceCheck=check),
            meta=ApiMeta(requestId=str(uuid4()), durationMs=round((perf_counter() - started) * 1000), source="backend", apiVersion=runtime.app_version, quota=app.state.baidu_client.metrics_snapshot()),
        )

    return app


app = create_app()
