import unittest

import httpx

from app.errors import BackendServiceError
from app.schemas import Coordinate
from app.services.baidu_client import BaiduMapClient


ORIGIN = Coordinate(lng=116.3, lat=40.0)
DESTINATION = Coordinate(lng=116.31, lat=40.01)


class FaultInjectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_no_poi_is_an_explicit_empty_domain_result(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"status": 0, "total": 0, "results": []})
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = BaiduMapClient(service_ak="fixture-ak", retry_count=0, http_client=http_client)
        payload = await client.search_poi(query="小学", center=ORIGIN, radius=2000)
        items, total = client.parse_poi_results(payload)
        self.assertEqual((items, total), ([], 0))
        self.assertEqual(client.metrics_snapshot()["upstreamCalls"], 1)

    async def test_http_429_uses_only_the_configured_retry_then_fails(self) -> None:
        calls = 0
        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(429, json={"message": "quota"})
        async def no_sleep(delay: float) -> None:
            return None
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = BaiduMapClient(service_ak="fixture-ak", retry_count=1, sleep=no_sleep, random_value=lambda: 0, http_client=http_client)
        with self.assertRaises(BackendServiceError) as context:
            await client.route_matrix(ORIGIN, [DESTINATION])
        self.assertEqual(context.exception.kind, "rate_limit")
        self.assertEqual(calls, 2)
        self.assertEqual(client.metrics_snapshot()["retries"], 1)

    async def test_5xx_exhaustion_opens_circuit_and_never_returns_success(self) -> None:
        calls = 0
        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(503, json={"message": "down"})
        async def no_sleep(delay: float) -> None:
            return None
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = BaiduMapClient(service_ak="fixture-ak", retry_count=1, circuit_failure_threshold=1, sleep=no_sleep, random_value=lambda: 0, http_client=http_client)
        with self.assertRaises(BackendServiceError) as first:
            await client.route_matrix(ORIGIN, [DESTINATION])
        with self.assertRaises(BackendServiceError) as second:
            await client.route_matrix(ORIGIN, [DESTINATION])
        self.assertEqual(first.exception.kind, "upstream_error")
        self.assertEqual(second.exception.kind, "circuit_open")
        self.assertEqual(calls, 2)

    async def test_timeout_is_bounded_and_preserved(self) -> None:
        calls = 0
        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            raise httpx.ReadTimeout("fixture timeout", request=request)
        async def no_sleep(delay: float) -> None:
            return None
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = BaiduMapClient(service_ak="fixture-ak", retry_count=1, sleep=no_sleep, random_value=lambda: 0, http_client=http_client)
        with self.assertRaises(BackendServiceError) as context:
            await client.route_matrix(ORIGIN, [DESTINATION])
        self.assertEqual(context.exception.kind, "timeout")
        self.assertEqual(calls, 2)

    async def test_no_route_is_preserved_per_destination(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"status": 0, "result": [{"status": 1, "message": "no walking route"}]})
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = BaiduMapClient(service_ak="fixture-ak", retry_count=0, http_client=http_client)
        records = await client.route_matrix(ORIGIN, [DESTINATION])
        self.assertEqual(records[0]["status"], "no_route")
        self.assertIsNone(records[0]["duration"])

    async def test_invalid_ak_is_not_retried_or_remapped_as_success(self) -> None:
        calls = 0
        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"status": 101, "message": "AK invalid"})
        http_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        client = BaiduMapClient(service_ak="fixture-ak", retry_count=2, http_client=http_client)
        with self.assertRaises(BackendServiceError) as context:
            await client.route_matrix(ORIGIN, [DESTINATION])
        self.assertEqual(context.exception.kind, "upstream_auth_error")
        self.assertEqual(calls, 1)
        self.assertEqual(client.metrics_snapshot()["retries"], 0)


if __name__ == "__main__":
    unittest.main()
