import unittest

import httpx

from app.config import Settings
from app.errors import BackendServiceError
from app.main import create_app
from app.services.baidu_client import BaiduMapClient
from app.schemas import Coordinate


class BaiduClientTests(unittest.IsolatedAsyncioTestCase):
    async def _invoke_api(self, api: str, client: BaiduMapClient):
        if api == "geocode":
            return await client.geocode("北京市")
        if api == "poi":
            payload = await client.search_poi(query="药店", center=Coordinate(lng=116.3, lat=40.0), radius=2000)
            return client.parse_poi_results(payload)
        return await client.route_matrix(Coordinate(lng=116.3, lat=40.0), [Coordinate(lng=116.31, lat=40.01)])

    async def test_formats_baidu_coordinate_order_and_parses_values(self) -> None:
        captured = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            return httpx.Response(200, json={"status": 0, "result": [{"distance": {"value": 721}, "duration": {"value": 844}}]})

        client = BaiduMapClient(service_ak="server-ak", http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        result = await client.route_matrix(Coordinate(lng=116.3, lat=40.0), [Coordinate(lng=116.31, lat=40.01)])
        self.assertEqual(result[0]["duration"], 844.0)
        self.assertEqual(result[0]["distance"], 721.0)
        self.assertIn("origins=40.000000%2C116.300000", captured["url"])
        self.assertIn("ak=server-ak", captured["url"])

    async def test_walking_route_returns_step_geometry_for_boundary_snapping(self) -> None:
        captured = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["params"] = dict(request.url.params)
            return httpx.Response(200, json={"status": 0, "result": {"routes": [{"distance": 1400, "duration": 1200, "steps": [{"distance": 700, "duration": 600, "path": "116.300000,40.000000;116.305000,40.005000"}, {"distance": 700, "duration": 600, "path": "116.305000,40.005000;116.310000,40.010000"}]}]}})

        client = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        result = await client.walking_route(Coordinate(lng=116.3, lat=40.0), Coordinate(lng=116.31, lat=40.01))

        self.assertEqual(result["duration"], 1200)
        self.assertEqual(result["distance"], 1400)
        self.assertEqual(len(result["steps"]), 2)
        self.assertEqual(len(result["path"]), 3)
        self.assertEqual(captured["params"]["steps_info"], "1")
        self.assertEqual(captured["params"]["ret_coordtype"], "bd09ll")

    async def test_missing_service_ak_is_a_configuration_error(self) -> None:
        client = BaiduMapClient(service_ak="")
        with self.assertRaisesRegex(BackendServiceError, "BAIDU_SERVICE_AK") as context:
            await client.route_matrix(Coordinate(lng=116.3, lat=40.0), [Coordinate(lng=116.31, lat=40.01)])
        self.assertEqual(context.exception.status_code, 503)

    async def test_baidu_rate_limit_is_mapped(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"status": 302, "message": "quota"})

        client = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        with self.assertRaises(BackendServiceError) as context:
            await client.route_matrix(Coordinate(lng=116.3, lat=40.0), [Coordinate(lng=116.31, lat=40.01)])
        self.assertEqual(context.exception.kind, "rate_limit")
        self.assertEqual(context.exception.status_code, 429)
        self.assertEqual(client.metrics_snapshot()["upstreamRateLimits"], 1)

    async def test_poi_empty_result_is_a_valid_response(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"status": 0, "total": 0, "results": []})

        client = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        payload = await client.search_poi(query="小学", center=Coordinate(lng=116.3, lat=40.0), radius=2000)
        items, total = client.parse_poi_results(payload)
        self.assertEqual(items, [])
        self.assertEqual(total, 0)

    async def test_polygon_poi_search_uses_closed_baidu_bounds(self) -> None:
        captured = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            captured["params"] = dict(request.url.params)
            return httpx.Response(200, json={"status": 0, "total": 0, "results": []})

        polygon = [Coordinate(lng=116.3, lat=40.0), Coordinate(lng=116.31, lat=40.0), Coordinate(lng=116.31, lat=40.01)]
        client = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        await client.search_poi(query="药店", center=polygon[0], radius=2000, polygon=polygon)
        self.assertNotIn("location", captured["params"])
        self.assertEqual(captured["params"]["bounds"].split(",")[:2], ["40.000000", "116.300000"])
        self.assertTrue(captured["params"]["bounds"].endswith("40.000000,116.300000"))

    async def test_timeout_retries_then_maps_to_timeout(self) -> None:
        calls = 0
        delays = []

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            raise httpx.ReadTimeout("slow", request=request)

        async def sleep(delay: float) -> None:
            delays.append(delay)

        client = BaiduMapClient(service_ak="server-ak", retry_count=1, sleep=sleep, random_value=lambda: 0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        with self.assertRaises(BackendServiceError) as context:
            await client.geocode("北京市")
        self.assertEqual(context.exception.kind, "timeout")
        self.assertEqual(calls, 2)
        self.assertEqual(delays, [0.25])

    async def test_server_error_retries_and_recovers(self) -> None:
        calls = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(503, json={"message": "temporary"})
            return httpx.Response(200, json={"status": 0, "result": {"location": {"lng": 116.3, "lat": 40.0}}})

        async def sleep(delay: float) -> None:
            return None

        client = BaiduMapClient(service_ak="server-ak", retry_count=1, sleep=sleep, random_value=lambda: 0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        result = await client.geocode("北京市")
        self.assertEqual(result["location"], {"lng": 116.3, "lat": 40.0})
        self.assertEqual(calls, 2)
        self.assertEqual(client.metrics_snapshot()["retries"], 1)

    async def test_successful_requests_are_cached_without_ak_in_cache_key(self) -> None:
        calls = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"status": 0, "result": {"location": {"lng": 116.3, "lat": 40.0}}})

        client = BaiduMapClient(service_ak="super-secret-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        await client.geocode("北京市")
        await client.geocode("北京市")
        self.assertEqual(calls, 1)
        self.assertEqual(client.metrics_snapshot()["cacheHits"], 1)
        self.assertNotIn("super-secret-ak", repr(client._cache))

    async def test_sliding_window_qps_limiter_delays_the_next_upstream_call(self) -> None:
        now = [0.0]
        starts = []
        delays = []

        async def handler(request: httpx.Request) -> httpx.Response:
            starts.append(now[0])
            return httpx.Response(200, json={"status": 0, "result": {"location": {"lng": 116.3, "lat": 40.0}}})

        async def sleep(delay: float) -> None:
            delays.append(delay)
            now[0] += delay

        client = BaiduMapClient(
            service_ak="server-ak",
            retry_count=0,
            max_qps=2,
            qps_window_seconds=1,
            cache_ttl_seconds=0,
            clock=lambda: now[0],
            sleep=sleep,
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        await client.geocode("北京市")
        await client.geocode("上海市")
        await client.geocode("广州市")

        self.assertEqual(starts, [0.0, 0.0, 1.0])
        self.assertEqual(delays, [1.0])
        self.assertEqual(client.metrics_snapshot()["rateLimitWaits"], 1)
        self.assertEqual(client.metrics_snapshot()["rateLimitWaitMs"], 1000)

    async def test_malformed_response_is_rejected(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="not-json")

        client = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        with self.assertRaises(BackendServiceError) as context:
            await client.geocode("北京市")
        self.assertEqual(context.exception.kind, "malformed_response")

    async def test_circuit_opens_after_configured_failure_threshold(self) -> None:
        calls = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(503, json={"message": "down"})

        client = BaiduMapClient(service_ak="server-ak", retry_count=0, circuit_failure_threshold=1, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        with self.assertRaises(BackendServiceError):
            await client.geocode("北京市")
        with self.assertRaises(BackendServiceError) as context:
            await client.geocode("上海市")
        self.assertEqual(context.exception.kind, "circuit_open")
        self.assertEqual(calls, 1)

    async def test_three_api_families_map_timeout_limit_service_and_malformed_responses(self) -> None:
        for api in ("geocode", "poi", "route"):
            scenarios = (
                ("timeout", lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("slow", request=request)), "timeout"),
                ("rate_limit", lambda request: httpx.Response(200, json={"status": 302, "message": "quota"}), "rate_limit"),
                ("service_error", lambda request: httpx.Response(503, json={"message": "down"}), "upstream_error"),
                ("malformed", lambda request: httpx.Response(200, text="not-json"), "malformed_response"),
            )
            for scenario, response_factory, expected_kind in scenarios:
                with self.subTest(api=api, scenario=scenario):
                    async def handler(request: httpx.Request, factory=response_factory) -> httpx.Response:
                        return factory(request)

                    client = BaiduMapClient(service_ak="server-ak", retry_count=0, cache_ttl_seconds=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
                    with self.assertRaises(BackendServiceError) as context:
                        await self._invoke_api(api, client)
                    self.assertEqual(context.exception.kind, expected_kind)

    async def test_three_api_families_handle_empty_success_payloads(self) -> None:
        payloads = {
            "geocode": {"status": 0, "result": {}},
            "poi": {"status": 0, "total": 0, "results": []},
            "route": {"status": 0, "result": []},
        }
        for api, payload in payloads.items():
            with self.subTest(api=api):
                async def handler(request: httpx.Request, value=payload) -> httpx.Response:
                    return httpx.Response(200, json=value)

                client = BaiduMapClient(service_ak="server-ak", retry_count=0, cache_ttl_seconds=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
                if api == "geocode":
                    with self.assertRaises(BackendServiceError) as context:
                        await self._invoke_api(api, client)
                    self.assertEqual(context.exception.kind, "empty_result")
                elif api == "poi":
                    self.assertEqual(await self._invoke_api(api, client), ([], 0))
                else:
                    result = await self._invoke_api(api, client)
                    self.assertEqual(result[0]["status"], "no_route")


class SettingsTests(unittest.TestCase):
    def test_stage2_limits_route_batch_to_fifty(self) -> None:
        settings = Settings(max_route_destinations=50)
        self.assertEqual(settings.max_route_destinations, 50)


class AppTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_reports_missing_service_configuration_without_calling_baidu(self) -> None:
        app = create_app(Settings(baidu_service_ak=""))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["status"], "degraded")
        self.assertFalse(response.json()["data"]["baiduConfigured"])

    async def test_route_matrix_endpoint_is_present_and_returns_configuration_error(self) -> None:
        app = create_app(Settings(baidu_service_ak=""))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/map/route-matrix", json={"origin": {"lng": 116.3, "lat": 40.0}, "destinations": [{"lng": 116.31, "lat": 40.01}], "mode": "walking"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["kind"], "configuration_error")

    async def test_verified_health_performs_an_uncached_baidu_probe(self) -> None:
        calls = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"status": 0, "result": {"location": {"lng": 116.3, "lat": 40.0}}})

        baidu = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        app = create_app(Settings(baidu_service_ak="server-ak"), baidu_client=baidu)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            first = await client.get("/api/health?verify=true")
            second = await client.get("/api/health?verify=true")
        self.assertEqual(first.json()["data"]["baiduReachable"], True)
        self.assertEqual(second.json()["data"]["serviceCheck"], "live-geocoding")
        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
