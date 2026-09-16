from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import math
import platform
from statistics import mean, median
from time import perf_counter
from typing import Any

import httpx

from app.schemas import Coordinate
from app.services.baidu_client import BaiduMapClient


def destinations_around(origin: Coordinate, count: int, *, offset: float = 0) -> list[Coordinate]:
    return [
        Coordinate(
            lng=origin.lng + offset + math.cos(index * math.tau / count) * 0.01,
            lat=origin.lat + offset + math.sin(index * math.tau / count) * 0.008,
        )
        for index in range(count)
    ]


def environment_record(mode: str) -> dict[str, Any]:
    return {
        "mode": mode,
        "source": "offline-simulated" if mode == "simulated" else "online-live",
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor() or "not-reported",
    }


async def _simulated_client(latency_ms: float) -> tuple[BaiduMapClient, httpx.AsyncClient]:
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(latency_ms / 1000)
        raw_destinations = request.url.params.get("destinations", "")
        count = len(raw_destinations.split("|")) if raw_destinations else 0
        result = [
            {"distance": {"value": 700 + index}, "duration": {"value": 850 + index}}
            for index in range(count)
        ]
        return httpx.Response(200, json={"status": 0, "result": result})

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = BaiduMapClient(
        service_ak="simulation-not-a-real-ak",
        retry_count=0,
        max_qps=0,
        cache_ttl_seconds=300,
        http_client=http_client,
    )
    return client, http_client


async def _call_simulated(client: BaiduMapClient, strategy: str, origin: Coordinate, destinations: list[Coordinate]) -> tuple[int, int]:
    records: list[dict[str, Any]] = []
    if strategy == "point":
        for destination in destinations:
            records.extend(await client.route_matrix(origin, [destination]))
        logical_requests = len(destinations)
    else:
        records = await client.route_matrix(origin, destinations)
        logical_requests = 1
    return logical_requests, sum(record["status"] == "ok" for record in records)


async def simulated_scenario(
    *, strategy: str, cache_state: str, run_index: int, destination_count: int, latency_ms: float
) -> dict[str, Any]:
    origin = Coordinate(lng=116.284206 + run_index * 0.000001, lat=40.051819)
    destinations = destinations_around(origin, destination_count)
    client, http_client = await _simulated_client(latency_ms)
    try:
        warmup_calls = 0
        if cache_state == "cache-hit":
            before = client.metrics_snapshot()
            await _call_simulated(client, strategy, origin, destinations)
            warmup_calls = client.metrics_snapshot()["upstreamCalls"] - before["upstreamCalls"]
        before = client.metrics_snapshot()
        started = perf_counter()
        logical_requests, successful = await _call_simulated(client, strategy, origin, destinations)
        elapsed_ms = (perf_counter() - started) * 1000
        after = client.metrics_snapshot()
        return {
            "run": run_index + 1,
            "strategy": strategy,
            "cacheState": cache_state,
            "source": "offline-simulated",
            "logicalRequests": logical_requests,
            "upstreamCalls": after["upstreamCalls"] - before["upstreamCalls"],
            "quotaConsumption": after["upstreamCalls"] - before["upstreamCalls"],
            "cacheHits": after["cacheHits"] - before["cacheHits"],
            "warmupUpstreamCalls": warmup_calls,
            "elapsedMs": round(elapsed_ms, 3),
            "successfulDestinations": successful,
            "destinationCount": destination_count,
            "successRate": round(successful / destination_count, 6),
        }
    finally:
        await http_client.aclose()


def _quota(payload: dict[str, Any]) -> int:
    value = payload.get("meta", {}).get("quota", {}).get("upstreamCalls", 0)
    return int(value) if isinstance(value, (int, float)) else 0


async def _online_quota(client: httpx.AsyncClient) -> int:
    response = await client.get("/health")
    payload = response.json()
    return _quota(payload)


async def _call_online(client: httpx.AsyncClient, strategy: str, origin: Coordinate, destinations: list[Coordinate]) -> tuple[int, int, list[str]]:
    groups = [[destination] for destination in destinations] if strategy == "point" else [destinations]
    successful = 0
    errors: list[str] = []
    for group in groups:
        response = await client.post("/v1/map/route-matrix", json={
            "origin": origin.model_dump(),
            "destinations": [destination.model_dump() for destination in group],
            "mode": "walking",
        })
        payload = response.json()
        if not response.is_success or payload.get("ok") is not True:
            errors.append(str(payload.get("error", {}).get("kind") or f"http_{response.status_code}"))
            continue
        successful += sum(item.get("status") == "ok" for item in payload.get("data", {}).get("destinations", []))
    return len(groups), successful, errors


async def online_scenario(
    client: httpx.AsyncClient, *, strategy: str, cache_state: str, run_index: int, destination_count: int, scenario_index: int
) -> dict[str, Any]:
    unique_offset = (run_index * 10 + scenario_index + 1) * 0.000001
    origin = Coordinate(lng=116.284206 + unique_offset, lat=40.051819)
    destinations = destinations_around(origin, destination_count, offset=unique_offset / 10)
    warmup_calls = 0
    if cache_state == "cache-hit":
        before_warmup = await _online_quota(client)
        await _call_online(client, strategy, origin, destinations)
        warmup_calls = await _online_quota(client) - before_warmup
    before = await _online_quota(client)
    started = perf_counter()
    logical_requests, successful, errors = await _call_online(client, strategy, origin, destinations)
    elapsed_ms = (perf_counter() - started) * 1000
    upstream_calls = await _online_quota(client) - before
    return {
        "run": run_index + 1,
        "strategy": strategy,
        "cacheState": cache_state,
        "source": "online-live",
        "logicalRequests": logical_requests,
        "upstreamCalls": upstream_calls,
        "quotaConsumption": upstream_calls,
        "cacheHits": logical_requests if cache_state == "cache-hit" and upstream_calls == 0 else None,
        "warmupUpstreamCalls": warmup_calls,
        "elapsedMs": round(elapsed_ms, 3),
        "successfulDestinations": successful,
        "destinationCount": destination_count,
        "successRate": round(successful / destination_count, 6),
        "errors": errors,
    }


def summarize(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    summaries = []
    keys = sorted({(record["strategy"], record["cacheState"]) for record in records})
    for strategy, cache_state in keys:
        group = [record for record in records if record["strategy"] == strategy and record["cacheState"] == cache_state]
        elapsed = [record["elapsedMs"] for record in group]
        summaries.append({
            "strategy": strategy,
            "cacheState": cache_state,
            "runs": len(group),
            "elapsedMs": {
                "mean": round(mean(elapsed), 3),
                "median": round(median(elapsed), 3),
                "min": round(min(elapsed), 3),
                "max": round(max(elapsed), 3),
                "allRuns": elapsed,
            },
            "meanLogicalRequests": round(mean(record["logicalRequests"] for record in group), 3),
            "meanUpstreamCalls": round(mean(record["upstreamCalls"] for record in group), 3),
            "meanQuotaConsumption": round(mean(record["quotaConsumption"] for record in group), 3),
            "meanSuccessRate": round(mean(record["successRate"] for record in group), 6),
        })
    return summaries


def comparison(summaries: list[dict[str, Any]], cache_state: str) -> dict[str, Any]:
    point = next(item for item in summaries if item["strategy"] == "point" and item["cacheState"] == cache_state)
    batch = next(item for item in summaries if item["strategy"] == "batch" and item["cacheState"] == cache_state)
    point_calls = point["meanUpstreamCalls"]
    batch_calls = batch["meanUpstreamCalls"]
    point_time = point["elapsedMs"]["mean"]
    batch_time = batch["elapsedMs"]["mean"]
    return {
        "cacheState": cache_state,
        "upstreamCallReduction": round(1 - batch_calls / point_calls, 6) if point_calls else None,
        "elapsedReduction": round(1 - batch_time / point_time, 6) if point_time else None,
        "note": "离线模拟只证明实现与调用形态；在线结果受配额、网络和服务端缓存影响。",
    }


async def run_benchmark(
    *, mode: str, runs: int, destination_count: int, simulated_latency_ms: float, api_base_url: str
) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    scenarios = [("point", "cold"), ("batch", "cold"), ("point", "cache-hit"), ("batch", "cache-hit")]
    if mode == "simulated":
        for run_index in range(runs):
            for strategy, cache_state in scenarios:
                records.append(await simulated_scenario(
                    strategy=strategy,
                    cache_state=cache_state,
                    run_index=run_index,
                    destination_count=destination_count,
                    latency_ms=simulated_latency_ms,
                ))
    else:
        async with httpx.AsyncClient(base_url=api_base_url.rstrip("/"), timeout=180) as client:
            for run_index in range(runs):
                for scenario_index, (strategy, cache_state) in enumerate(scenarios):
                    records.append(await online_scenario(
                        client,
                        strategy=strategy,
                        cache_state=cache_state,
                        run_index=run_index,
                        destination_count=destination_count,
                        scenario_index=scenario_index,
                    ))
    summaries = summarize(records)
    return {
        "schemaVersion": "route-matrix-benchmark-v1",
        "evidenceConfigVersion": "competition-evidence-v1",
        "environment": environment_record(mode),
        "sampleSize": {"runsPerScenario": runs, "scenarioCount": 4, "totalRunRecords": len(records)},
        "confidence": {
            "level": "simulation-only" if mode == "simulated" else "observed-online-sample",
            "basis": "all configured runs retained; no best-run selection",
        },
        "parameters": {
            "runs": runs,
            "destinationCount": destination_count,
            "batchSize": 50,
            "simulatedLatencyMs": simulated_latency_ms if mode == "simulated" else None,
            "apiBaseUrl": api_base_url if mode == "online" else None,
            "cachePolicy": "cold uses unique inputs; cache-hit warms identical inputs before measurement",
        },
        "summaries": summaries,
        "comparisons": [comparison(summaries, "cold"), comparison(summaries, "cache-hit")],
        "runs": records,
        "limitations": [
            "offline-simulated results are deterministic transport fixtures, not Baidu service latency",
            "online-live mode calls the local FastAPI API and never reads or prints BAIDU_SERVICE_AK",
            "quotaConsumption is measured as upstreamCalls delta; cache hits consume zero measured upstream calls",
            "all run values are retained; summaries do not report only the best run",
        ],
    }


def dumps(result: dict[str, Any]) -> str:
    return json.dumps(result, ensure_ascii=False, indent=2) + "\n"
