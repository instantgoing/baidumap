import asyncio
from collections import OrderedDict, deque
from collections.abc import Callable
from copy import deepcopy
import random
from time import monotonic
from typing import Any

import httpx

from app.errors import BackendServiceError
from app.schemas import Coordinate


RATE_LIMIT_STATUSES = {4, 301, 302, 401, 402}
RETRYABLE_API_STATUSES = {1, 401, 402}
AUTH_STATUSES = {3, 5, 101, 102, 200, 201, 202, 210, 211, 240, 260, 261}


class BaiduMapClient:
    """Server-only adapter for Baidu Web Service APIs.

    The adapter owns the service AK boundary and adds bounded concurrency,
    retries with exponential backoff and jitter, a small TTL cache, a circuit
    breaker, and aggregate request counters. Cache keys and exceptions never
    contain the AK.
    """

    def __init__(
        self,
        *,
        service_ak: str,
        base_url: str = "https://api.map.baidu.com",
        timeout_seconds: float = 12.0,
        retry_count: int = 1,
        max_concurrency: int = 2,
        max_qps: int = 0,
        qps_window_seconds: float = 1.0,
        cache_ttl_seconds: float = 300.0,
        cache_max_entries: int = 256,
        circuit_failure_threshold: int = 4,
        circuit_cooldown_seconds: float = 20.0,
        http_client: httpx.AsyncClient | None = None,
        sleep: Callable[[float], Any] = asyncio.sleep,
        random_value: Callable[[], float] = random.random,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._service_ak = service_ak.strip()
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds
        self._retry_count = max(0, retry_count)
        self._http_client = http_client
        self._sleep = sleep
        self._random = random_value
        self._clock = clock
        self._gate = asyncio.Semaphore(max(1, max_concurrency))
        self._max_qps = max(0, max_qps)
        self._qps_window = max(0.1, qps_window_seconds)
        self._rate_lock = asyncio.Lock()
        self._rate_timestamps: deque[float] = deque()
        self._cache_ttl = max(0.0, cache_ttl_seconds)
        self._cache_max_entries = max(1, cache_max_entries)
        self._cache: OrderedDict[tuple[str, tuple[tuple[str, str], ...]], tuple[float, dict[str, Any]]] = OrderedDict()
        self._circuit_threshold = max(1, circuit_failure_threshold)
        self._circuit_cooldown = max(1.0, circuit_cooldown_seconds)
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0
        self._metrics = {"requests": 0, "upstreamCalls": 0, "cacheHits": 0, "retries": 0, "errors": 0, "rateLimitWaits": 0, "rateLimitWaitMs": 0, "upstreamRateLimits": 0}

    def metrics_snapshot(self) -> dict[str, int | bool]:
        return {**self._metrics, "circuitOpen": self._circuit_open_until > self._clock()}

    async def health_probe(self) -> None:
        """Perform a small uncached call so health never reports a stale hit."""
        self._require_ak()
        payload = await self._request(
            f"{self._base_url}/geocoding/v3/",
            {"address": "北京市", "output": "json", "ak": self._service_ak},
            "Geocoding",
            use_cache=False,
        )
        if not isinstance(payload.get("result", {}).get("location"), dict):
            raise BackendServiceError("百度地理编码健康探测响应异常", kind="malformed_response", status_code=502)

    async def route_matrix(self, origin: Coordinate, destinations: list[Coordinate], *, mode: str = "walking") -> list[dict[str, Any]]:
        if mode != "walking":
            raise BackendServiceError("当前仅支持 walking RouteMatrix", kind="invalid_mode", status_code=422)
        self._require_ak()
        if not destinations:
            raise BackendServiceError("destinations 不能为空", kind="validation_error", status_code=422)
        if len(destinations) > 50:
            raise BackendServiceError("单批 RouteMatrix 最多支持 50 个终点", kind="validation_error", status_code=422)

        params = {
            "output": "json",
            "origins": self._format_coordinate(origin),
            "destinations": "|".join(self._format_coordinate(point) for point in destinations),
            "coord_type": "bd09ll",
            "ak": self._service_ak,
        }
        payload = await self._request(f"{self._base_url}/routematrix/v2/walking", params, "RouteMatrix")
        return self._parse_route_matrix(payload, destinations)

    async def walking_route(self, origin: Coordinate, destination: Coordinate) -> dict[str, Any]:
        self._require_ak()
        params = {
            "origin": self._format_coordinate(origin),
            "destination": self._format_coordinate(destination),
            "coord_type": "bd09ll",
            "ret_coordtype": "bd09ll",
            "steps_info": "1",
            "ak": self._service_ak,
        }
        payload = await self._request(f"{self._base_url}/directionlite/v1/walking", params, "WalkingDirection")
        result = payload.get("result")
        routes = result.get("routes") if isinstance(result, dict) else None
        if not isinstance(routes, list) or not routes or not isinstance(routes[0], dict):
            raise BackendServiceError("百度步行路线规划未返回路线", kind="empty_result", status_code=404)
        route = routes[0]
        try:
            duration = float(route["duration"])
            distance = float(route["distance"])
        except (KeyError, TypeError, ValueError) as error:
            raise BackendServiceError("百度步行路线规划缺少有效耗时或距离", kind="malformed_response", status_code=502) from error
        normalized_steps = []
        full_path = []
        for raw_step in route.get("steps") if isinstance(route.get("steps"), list) else []:
            if not isinstance(raw_step, dict):
                continue
            path = self._parse_path(raw_step.get("path"))
            if path:
                if full_path and full_path[-1] == path[0]:
                    full_path.extend(path[1:])
                else:
                    full_path.extend(path)
            normalized_steps.append({
                "duration": self._number_or_zero(raw_step.get("duration")),
                "distance": self._number_or_zero(raw_step.get("distance")),
                "path": path,
                "instruction": str(raw_step.get("instruction") or ""),
            })
        if not full_path:
            full_path = [origin.model_dump(), destination.model_dump()]
        return {"origin": origin, "destination": destination, "duration": duration, "distance": distance, "path": full_path, "steps": normalized_steps, "mode": "walking"}

    async def geocode(self, address: str) -> dict[str, Any]:
        self._require_ak()
        payload = await self._request(f"{self._base_url}/geocoding/v3/", {"address": address.strip(), "output": "json", "ak": self._service_ak}, "Geocoding")
        result = payload.get("result")
        if not isinstance(result, dict) or not isinstance(result.get("location"), dict):
            raise BackendServiceError("百度地理编码未返回匹配地址", kind="empty_result", status_code=404)
        location = result["location"]
        try:
            normalized = {"lng": float(location["lng"]), "lat": float(location["lat"])}
        except (KeyError, TypeError, ValueError) as error:
            raise BackendServiceError("百度地理编码坐标格式异常", kind="malformed_response", status_code=502) from error
        return {
            "address": address,
            "location": normalized,
            "coordinateSystem": "BD-09",
            "precise": result.get("precise"),
            "confidence": result.get("confidence"),
            "level": result.get("level"),
        }

    async def reverse_geocode(self, location: Coordinate) -> dict[str, Any]:
        self._require_ak()
        params = {"location": self._format_coordinate(location), "coordtype": "bd09ll", "output": "json", "ak": self._service_ak}
        payload = await self._request(f"{self._base_url}/reverse_geocoding/v3/", params, "ReverseGeocoding")
        result = payload.get("result")
        if not isinstance(result, dict):
            raise BackendServiceError("百度逆地理编码未返回地址", kind="empty_result", status_code=404)
        return {
            "location": location,
            "formattedAddress": str(result.get("formatted_address") or ""),
            "addressComponent": result.get("addressComponent") if isinstance(result.get("addressComponent"), dict) else {},
        }

    async def convert_coordinates(self, points: list[Coordinate], *, source: str = "WGS84", target: str = "BD-09") -> list[dict[str, float]]:
        self._require_ak()
        source_code = {"WGS84": "1", "GCJ-02": "3", "BD-09": "5", "BD09LL": "5"}.get(source.upper())
        target_code = {"WGS84": "1", "GCJ-02": "3", "BD-09": "5", "BD09LL": "5"}.get(target.upper())
        if source_code is None or target_code is None:
            raise BackendServiceError("不支持的坐标系转换", kind="validation_error", status_code=422)
        coords = ";".join(f"{point.lng:.8f},{point.lat:.8f}" for point in points)
        payload = await self._request(f"{self._base_url}/geoconv/v1/", {"coords": coords, "from": source_code, "to": target_code, "ak": self._service_ak}, "CoordinateConvert")
        values = payload.get("result")
        if not isinstance(values, list):
            raise BackendServiceError("百度坐标转换响应缺少 result 数组", kind="malformed_response", status_code=502)
        result: list[dict[str, float]] = []
        for item in values:
            try:
                result.append({"lng": float(item["x"]), "lat": float(item["y"])})
            except (KeyError, TypeError, ValueError) as error:
                raise BackendServiceError("百度坐标转换结果格式异常", kind="malformed_response", status_code=502) from error
        if len(result) != len(points):
            raise BackendServiceError("百度坐标转换返回数量不一致", kind="malformed_response", status_code=502)
        return result

    async def search_poi(
        self,
        *,
        query: str,
        center: Coordinate,
        radius: float,
        page: int = 0,
        page_size: int = 20,
        polygon: list[Coordinate] | None = None,
    ) -> dict[str, Any]:
        self._require_ak()
        if not query.strip():
            raise BackendServiceError("POI query 不能为空", kind="validation_error", status_code=422)
        if not 0 <= page <= 7 or not 1 <= page_size <= 20:
            raise BackendServiceError("POI 分页参数超出范围", kind="validation_error", status_code=422)
        params = {
            "query": query.strip(),
            "output": "json",
            "page_num": str(page),
            "page_size": str(page_size),
            "scope": "2",
            "coord_type": "3",
            "ak": self._service_ak,
        }
        if polygon:
            if len(polygon) > 100:
                raise BackendServiceError("POI 多边形最多支持 100 个坐标点", kind="validation_error", status_code=422)
            closed = list(polygon)
            if closed[0].model_dump() != closed[-1].model_dump():
                closed.append(closed[0])
            params["bounds"] = ",".join(self._format_coordinate(point) for point in closed)
        else:
            params.update({"location": self._format_coordinate(center), "radius": str(int(radius)), "radius_limit": "true"})
        return await self._request(f"{self._base_url}/place/v2/search", params, "POI")

    async def _request(self, url: str, params: dict[str, str], service_name: str, *, use_cache: bool = True) -> dict[str, Any]:
        self._metrics["requests"] += 1
        cache_key = self._cache_key(url, params)
        cached = self._cache_get(cache_key) if use_cache else None
        if cached is not None:
            self._metrics["cacheHits"] += 1
            return cached
        if self._circuit_open_until > self._clock():
            self._metrics["errors"] += 1
            raise BackendServiceError(f"百度 {service_name} 熔断器暂未恢复", kind="circuit_open", status_code=503)

        owns_client = self._http_client is None
        client = self._http_client or httpx.AsyncClient(timeout=self._timeout)
        last_error: BackendServiceError | None = None
        try:
            for attempt in range(self._retry_count + 1):
                try:
                    async with self._gate:
                        await self._acquire_rate_slot()
                        self._metrics["upstreamCalls"] += 1
                        response = await client.get(url, params=params)
                    if response.status_code == 429 or response.status_code >= 500:
                        kind = "rate_limit" if response.status_code == 429 else "upstream_error"
                        status_code = 429 if response.status_code == 429 else 502
                        raise BackendServiceError(f"百度 {service_name} 服务暂不可用", kind=kind, status_code=status_code, details="retryable")
                    try:
                        payload = response.json()
                    except ValueError as error:
                        raise BackendServiceError(f"百度 {service_name} 返回了无法解析的响应", kind="malformed_response", status_code=502) from error
                    if response.status_code >= 400:
                        raise BackendServiceError(f"百度 {service_name} 请求被拒绝", kind="upstream_error", status_code=502)
                    if not isinstance(payload, dict):
                        raise BackendServiceError(f"百度 {service_name} 响应不是 JSON 对象", kind="malformed_response", status_code=502)
                    api_status = self._status_number(payload.get("status"))
                    if api_status not in (None, 0):
                        message = str(payload.get("message") or f"百度 {service_name} 返回错误")
                        if api_status in RATE_LIMIT_STATUSES:
                            error = BackendServiceError(message, kind="rate_limit", status_code=429, details="retryable" if api_status in {401, 402} else None)
                        elif api_status in AUTH_STATUSES or 200 <= api_status < 300:
                            error = BackendServiceError(message, kind="upstream_auth_error", status_code=502)
                        else:
                            error = BackendServiceError(message, kind="upstream_error", status_code=502, details="retryable" if api_status in RETRYABLE_API_STATUSES else None)
                        raise error
                    self._record_success()
                    if use_cache:
                        self._cache_put(cache_key, payload)
                    return deepcopy(payload)
                except httpx.TimeoutException as error:
                    last_error = BackendServiceError(f"百度 {service_name} 请求超时", kind="timeout", status_code=504, details="retryable")
                    last_error.__cause__ = error
                except httpx.RequestError as error:
                    last_error = BackendServiceError(f"无法连接百度 {service_name} 服务", kind="network_error", status_code=502, details="retryable")
                    last_error.__cause__ = error
                except BackendServiceError as error:
                    last_error = error

                if last_error.kind == "rate_limit":
                    self._metrics["upstreamRateLimits"] += 1
                if attempt < self._retry_count and last_error.details == "retryable":
                    self._metrics["retries"] += 1
                    await self._sleep(0.25 * (2**attempt) + 0.1 * self._random())
                    continue
                self._record_failure(last_error)
                raise last_error
        finally:
            if owns_client:
                await client.aclose()
        raise last_error or BackendServiceError(f"百度 {service_name} 请求失败", kind="upstream_error", status_code=502)

    async def _acquire_rate_slot(self) -> None:
        """Enforce an actual sliding-window upstream QPS limit.

        The semaphore limits simultaneous calls; this limiter separately bounds
        how many calls may start inside a time window. Cache hits never consume
        a slot because this method is reached only immediately before I/O.
        """
        if self._max_qps <= 0:
            return
        while True:
            async with self._rate_lock:
                now = self._clock()
                cutoff = now - self._qps_window
                while self._rate_timestamps and self._rate_timestamps[0] <= cutoff:
                    self._rate_timestamps.popleft()
                if len(self._rate_timestamps) < self._max_qps:
                    self._rate_timestamps.append(now)
                    return
                delay = max(0.001, self._rate_timestamps[0] + self._qps_window - now)
                self._metrics["rateLimitWaits"] += 1
                self._metrics["rateLimitWaitMs"] += round(delay * 1000)
            await self._sleep(delay)

    def _require_ak(self) -> None:
        if not self._service_ak:
            raise BackendServiceError("后端未配置 BAIDU_SERVICE_AK", kind="configuration_error", status_code=503)

    def _cache_key(self, url: str, params: dict[str, str]) -> tuple[str, tuple[tuple[str, str], ...]]:
        return url, tuple(sorted((key, str(value)) for key, value in params.items() if key != "ak"))

    def _cache_get(self, key: tuple[str, tuple[tuple[str, str], ...]]) -> dict[str, Any] | None:
        cached = self._cache.get(key)
        if cached is None:
            return None
        expires_at, payload = cached
        if expires_at <= self._clock():
            self._cache.pop(key, None)
            return None
        self._cache.move_to_end(key)
        return deepcopy(payload)

    def _cache_put(self, key: tuple[str, tuple[tuple[str, str], ...]], payload: dict[str, Any]) -> None:
        if self._cache_ttl <= 0:
            return
        self._cache[key] = (self._clock() + self._cache_ttl, deepcopy(payload))
        self._cache.move_to_end(key)
        while len(self._cache) > self._cache_max_entries:
            self._cache.popitem(last=False)

    def _record_success(self) -> None:
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0

    def _record_failure(self, error: BackendServiceError) -> None:
        self._metrics["errors"] += 1
        if error.kind not in {"timeout", "network_error", "upstream_error", "malformed_response"}:
            return
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._circuit_threshold:
            self._circuit_open_until = self._clock() + self._circuit_cooldown

    @staticmethod
    def _status_number(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _format_coordinate(point: Coordinate) -> str:
        return f"{point.lat:.6f},{point.lng:.6f}"

    @staticmethod
    def _number_or_zero(value: Any) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _parse_path(value: Any) -> list[dict[str, float]]:
        if not isinstance(value, str):
            return []
        points = []
        for pair in value.split(";"):
            values = pair.split(",")
            if len(values) != 2:
                continue
            try:
                points.append({"lng": float(values[0]), "lat": float(values[1])})
            except ValueError:
                continue
        return points

    @staticmethod
    def _parse_route_matrix(payload: dict[str, Any], destinations: list[Coordinate]) -> list[dict[str, Any]]:
        records = payload.get("result")
        if not isinstance(records, list):
            raise BackendServiceError("百度 RouteMatrix 响应缺少 result 数组", kind="malformed_response", status_code=502)
        parsed: list[dict[str, Any]] = []
        for index, destination in enumerate(destinations):
            record = records[index] if index < len(records) and isinstance(records[index], dict) else {}
            if record.get("status") not in (None, 0, "0"):
                parsed.append({"location": destination, "duration": None, "distance": None, "status": "no_route", "message": str(record.get("message") or "该终点没有可用路线")})
                continue
            duration = record.get("duration", {}).get("value") if isinstance(record.get("duration"), dict) else record.get("duration")
            distance = record.get("distance", {}).get("value") if isinstance(record.get("distance"), dict) else record.get("distance")
            if not isinstance(duration, (int, float)) or not isinstance(distance, (int, float)):
                parsed.append({"location": destination, "duration": None, "distance": None, "status": "no_route", "message": "百度未返回有效距离或耗时"})
                continue
            parsed.append({"location": destination, "duration": float(duration), "distance": float(distance), "status": "ok", "message": None})
        return parsed

    @staticmethod
    def parse_poi_results(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
        results = payload.get("results")
        if not isinstance(results, list):
            raise BackendServiceError("百度 POI 响应缺少 results 数组", kind="malformed_response", status_code=502)
        total = payload.get("total", len(results))
        return [item for item in results if isinstance(item, dict)], int(total) if isinstance(total, (int, float)) else len(results)
