import unittest

import httpx

from app.config import Settings
from app.main import create_app
from app.services.blindspot import analyze_blind_spots
from app.services.poi_pipeline import standardize_pois
from app.services.baidu_client import BaiduMapClient
from app.schemas import Coordinate


class PoiPipelineTests(unittest.TestCase):
    def test_filters_false_positive_and_deduplicates_uid_and_nearby_name(self) -> None:
        raw = [
            {"uid": "market-1", "name": "幸福菜市场", "location": {"lng": 116.3, "lat": 40.0}},
            {"uid": "market-1", "name": "幸福菜市场", "location": {"lng": 116.3, "lat": 40.0}},
            {"name": "幸福菜市场", "location": {"lng": 116.3002, "lat": 40.0001}},
            {"name": "幸福菜市场培训中心", "location": {"lng": 116.31, "lat": 40.01}},
            {"name": "安心大药房", "location": {"lng": 116.31, "lat": 40.01}},
        ]
        items, quality = standardize_pois(raw, source_keyword="菜市场")
        self.assertEqual(len(items), 2)
        self.assertEqual(quality["duplicateCount"], 2)
        self.assertEqual(quality["excludedCount"], 1)
        self.assertEqual({item["category"] for item in items}, {"market", "pharmacy"})

    def test_reads_new_baidu_classified_poi_tag(self) -> None:
        raw = [{"uid": "school-1", "name": "软件园学校", "location": {"lng": 116.3, "lat": 40.0}, "detail_info": {"classified_poi_tag": "教育培训;小学"}}]
        items, quality = standardize_pois(raw, source_keyword="小学")
        self.assertEqual(items[0]["category"], "primary_school")
        self.assertEqual(quality["excludedCount"], 0)


class BlindSpotTests(unittest.TestCase):
    def test_constructed_missing_categories_are_reported(self) -> None:
        center = {"lng": 116.3, "lat": 40.0}
        pois = [
            {"uid": "m1", "category": "market", "location": {"lng": 116.3005, "lat": 40.0}},
            {"uid": "p1", "category": "pharmacy", "location": {"lng": 116.3, "lat": 40.0005}},
        ]
        result = analyze_blind_spots(center=center, pois=pois, analysis_radius_m=300, grid_spacing_m=100)
        missing = {category for zone in result["zones"] for category in zone["missingCategories"]}
        self.assertIn("primary_school", missing)
        self.assertEqual(result["evidence"]["boundaryRecheck"]["status"], "candidate-ready")
        self.assertGreater(result["coverage"]["market"]["coverageRatio"], 0)

    def test_each_required_category_can_form_an_independent_blind_spot(self) -> None:
        center = {"lng": 116.3, "lat": 40.0}
        fixtures = {
            "market": [{"uid": "p1", "category": "pharmacy", "location": center}, {"uid": "s1", "category": "primary_school", "location": center}],
            "pharmacy": [{"uid": "m1", "category": "market", "location": center}, {"uid": "s1", "category": "primary_school", "location": center}],
            "primary_school": [{"uid": "m1", "category": "market", "location": center}, {"uid": "p1", "category": "pharmacy", "location": center}],
        }
        for missing_category, pois in fixtures.items():
            with self.subTest(category=missing_category):
                result = analyze_blind_spots(center=center, pois=pois, analysis_radius_m=300, grid_spacing_m=100)
                missing = {category for zone in result["zones"] for category in zone["missingCategories"]}
                self.assertIn(missing_category, missing)


class Stage3ApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_geocode_endpoint_is_present_and_normalizes_baidu_location(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"status": 0, "result": {"location": {"lng": 116.3, "lat": 40.0}}})

        baidu = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        app = create_app(Settings(baidu_service_ak="server-ak"), baidu_client=baidu)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/map/geocode", json={"address": "北京市海淀区"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["location"], {"lng": 116.3, "lat": 40.0})

    async def test_online_poi_endpoint_paginates_and_returns_quality(self) -> None:
        calls = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            page = request.url.params.get("page_num")
            if page == "0":
                return httpx.Response(200, json={"status": 0, "total": 2, "results": [{"uid": "p1", "name": "安心大药房", "address": "A", "location": {"lng": 116.3, "lat": 40.0}}]})
            return httpx.Response(200, json={"status": 0, "total": 2, "results": [{"uid": "p2", "name": "社区卫生服务中心", "address": "B", "location": {"lng": 116.3001, "lat": 40.0001}}]})

        baidu = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        app = create_app(Settings(baidu_service_ak="server-ak"), baidu_client=baidu)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/map/poi/search", json={"query": "药店", "center": {"lng": 116.3, "lat": 40.0}, "radius": 2000, "pageSize": 1, "maxPages": 2})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["quality"]["inAreaCount"], 2)
        self.assertEqual(len(calls), 2)

    async def test_blind_spot_endpoint_returns_auditable_cells_without_baidu_call(self) -> None:
        app = create_app(Settings(baidu_service_ak=""))
        payload = {"center": {"lng": 116.3, "lat": 40.0}, "pois": [{"uid": "m1", "name": "中心菜市场", "location": {"lng": 116.3, "lat": 40.0}, "category": "market"}], "analysisRadiusMeters": 300, "gridSpacingMeters": 100}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/map/blind-spots", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertGreater(response.json()["data"]["evidence"]["gridCellCount"], 0)
        self.assertIn("pharmacy", response.json()["data"]["zones"][0]["missingCategories"])

    async def test_blind_spot_endpoint_rechecks_boundary_cells_with_configured_client(self) -> None:
        class RouteMatrixStub:
            def __init__(self) -> None:
                self.calls = 0

            async def route_matrix(self, origin, destinations, *, mode="walking"):
                self.calls += 1
                return [
                    {
                        "location": destination.model_dump(),
                        "duration": 600.0,
                        "distance": 900.0,
                        "status": "ok",
                        "message": None,
                    }
                    for destination in destinations
                ]

        baidu = RouteMatrixStub()
        app = create_app(Settings(baidu_service_ak="server-ak"), baidu_client=baidu)
        payload = {
            "center": {"lng": 116.3, "lat": 40.0},
            "pois": [
                {
                    "uid": "m1",
                    "name": "边界菜市场",
                    "location": {"lng": 116.3, "lat": 40.009},
                    "category": "market",
                }
            ],
            "analysisRadiusMeters": 300,
            "gridSpacingMeters": 100,
            "boundaryRecheck": True,
        }
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/map/blind-spots", json=payload)

        self.assertEqual(response.status_code, 200)
        evidence = response.json()["data"]["evidence"]["boundaryRecheck"]
        self.assertEqual(evidence["status"], "completed")
        self.assertGreater(evidence["checkedCellCount"], 0)
        self.assertEqual(baidu.calls, evidence["checkedCellCount"])

    async def test_integrated_p3_endpoint_fetches_real_contract_and_returns_evidence(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"status": 0, "total": 3, "results": [
                {"uid": "m1", "name": "幸福菜市场", "location": {"lng": 116.3, "lat": 40.0}},
                {"uid": "p1", "name": "安心大药房", "location": {"lng": 116.3005, "lat": 40.0}},
                {"uid": "s1", "name": "软件园学校", "location": {"lng": 116.3, "lat": 40.0005}, "detail_info": {"classified_poi_tag": "教育培训;小学"}},
            ]})

        baidu = BaiduMapClient(service_ak="server-ak", retry_count=0, http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        app = create_app(Settings(baidu_service_ak="server-ak"), baidu_client=baidu)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post("/api/v1/map/poi/analyze", json={"center": {"lng": 116.3, "lat": 40.0}, "analysisRadiusMeters": 300, "gridSpacingMeters": 100, "boundaryRecheck": False})
        self.assertEqual(response.status_code, 200)
        data = response.json()["data"]
        self.assertEqual(len(data["pois"]), 3)
        self.assertEqual(data["quality"]["categoryCounts"]["primary_school"], 1)
        self.assertIn("gridCellCount", data["blindSpots"]["evidence"])


if __name__ == "__main__":
    unittest.main()
