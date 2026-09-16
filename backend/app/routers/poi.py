from math import cos, radians
from time import perf_counter
from uuid import uuid4

from fastapi import APIRouter, Header, Request

from app.config import Settings
from app.errors import BackendServiceError
from app.schemas import ApiMeta, BlindSpotAnalysisData, BlindSpotAnalysisRequest, BlindSpotAnalysisResponse, Coordinate, PoiAnalysisData, PoiAnalysisRequest, PoiAnalysisResponse, PoiSearchData, PoiSearchRequest, PoiSearchResponse
from app.services.baidu_client import BaiduMapClient
from app.services.blindspot import analyze_blind_spots
from app.services.poi_pipeline import filter_pois_in_area, standardize_pois

router = APIRouter(prefix="/api/v1/map", tags=["poi"])
MAX_BOUNDARY_RECHECK_CELLS = 20
P3_SEARCH_TERMS = ("菜市场", "农贸市场", "生鲜超市", "药店", "社区卫生服务中心", "综合医院", "小学", "幼儿园", "养老院", "便利店")
P3_SEARCH_QUERY = "$".join(P3_SEARCH_TERMS)


def request_id_from_header(value: str | None) -> str:
    return value.strip() if value and value.strip() else str(uuid4())


@router.post("/poi/search", response_model=PoiSearchResponse)
async def search_poi(payload: PoiSearchRequest, request: Request, x_request_id: str | None = Header(default=None)) -> PoiSearchResponse:
    started = perf_counter()
    settings: Settings = request.app.state.settings
    client: BaiduMapClient = request.app.state.baidu_client
    raw_items: list[dict] = []
    total = 0
    for page in range(payload.page, min(payload.page + payload.maxPages, 8)):
        response = await client.search_poi(query=payload.query, center=payload.center, radius=payload.radius, page=page, page_size=payload.pageSize, polygon=payload.areaPolygon)
        page_items, page_total = client.parse_poi_results(response)
        raw_items.extend(page_items)
        total = max(total, page_total)
        if not page_items or len(raw_items) >= total:
            break
    items, quality = standardize_pois(raw_items, source_keyword=payload.query)
    polygon = [point.model_dump() for point in payload.areaPolygon] if payload.areaPolygon else None
    items, outside_count = filter_pois_in_area(items, center=payload.center.model_dump(), radius_m=None if polygon else payload.radius, polygon=polygon)
    quality["outsideAreaCount"] = outside_count
    quality["inAreaCount"] = len(items)
    quality["areaFilter"] = "polygon" if polygon else "radius"
    duration_ms = round((perf_counter() - started) * 1000)
    return PoiSearchResponse(data=PoiSearchData(items=items, pagination={"page": payload.page, "pageSize": payload.pageSize, "total": total, "fetched": len(raw_items)}, radius=payload.radius, quality=quality), meta=ApiMeta(requestId=request_id_from_header(x_request_id), durationMs=duration_ms, source="baidu-place-v2", apiVersion=settings.app_version, quota=_metrics(client)))


@router.post("/blind-spots", response_model=BlindSpotAnalysisResponse)
async def blind_spots(payload: BlindSpotAnalysisRequest, request: Request, x_request_id: str | None = Header(default=None)) -> BlindSpotAnalysisResponse:
    started = perf_counter()
    settings: Settings = request.app.state.settings
    client: BaiduMapClient = request.app.state.baidu_client
    center = payload.center.model_dump()
    pois = [item.model_dump() for item in payload.pois]
    result = await _analyze_with_recheck(
        client=client,
        settings=settings,
        center=center,
        pois=pois,
        analysis_radius_m=payload.analysisRadiusMeters,
        grid_spacing_m=payload.gridSpacingMeters,
        population_density_per_km2=payload.populationDensityPerKm2,
        boundary_recheck=payload.boundaryRecheck,
    )
    duration_ms = round((perf_counter() - started) * 1000)
    return BlindSpotAnalysisResponse(data=BlindSpotAnalysisData(**result), meta=ApiMeta(requestId=request_id_from_header(x_request_id), durationMs=duration_ms, source="local-poi-analysis", apiVersion=settings.app_version, quota=_metrics(client)))


@router.post("/poi/analyze", response_model=PoiAnalysisResponse)
async def analyze_poi(payload: PoiAnalysisRequest, request: Request, x_request_id: str | None = Header(default=None)) -> PoiAnalysisResponse:
    """Fetch real civic POIs and execute the complete P3 blind-spot pipeline."""
    started = perf_counter()
    settings: Settings = request.app.state.settings
    client: BaiduMapClient = request.app.state.baidu_client
    raw_items: list[dict] = []
    total = 0
    fetched_pages = 0
    for page in range(payload.maxPages):
        response = await client.search_poi(
            query=P3_SEARCH_QUERY,
            center=payload.center,
            radius=payload.searchRadiusMeters,
            page=page,
            page_size=payload.pageSize,
        )
        page_items, page_total = client.parse_poi_results(response)
        fetched_pages += 1
        raw_items.extend(page_items)
        total = max(total, page_total)
        if not page_items or len(raw_items) >= total:
            break

    standardized, quality = standardize_pois(raw_items, source_keyword=P3_SEARCH_QUERY)
    center = payload.center.model_dump()
    pois, outside_count = filter_pois_in_area(standardized, center=center, radius_m=payload.searchRadiusMeters)
    polygon = [point.model_dump() for point in payload.areaPolygon] if payload.areaPolygon else None
    service_area_pois, _ = filter_pois_in_area(
        pois,
        center=center,
        radius_m=None if polygon else payload.analysisRadiusMeters,
        polygon=polygon,
    )
    quality.update({
        "outsideSearchAreaCount": outside_count,
        "inSearchAreaCount": len(pois),
        "serviceAreaCount": len(service_area_pois),
        "serviceAreaFilter": "polygon" if polygon else "analysis-radius",
    })
    blind_result = await _analyze_with_recheck(
        client=client,
        settings=settings,
        center=center,
        pois=pois,
        analysis_radius_m=payload.analysisRadiusMeters,
        grid_spacing_m=payload.gridSpacingMeters,
        population_density_per_km2=payload.populationDensityPerKm2,
        boundary_recheck=payload.boundaryRecheck,
    )
    duration_ms = round((perf_counter() - started) * 1000)
    data = PoiAnalysisData(
        center=payload.center,
        pois=pois,
        serviceAreaPois=service_area_pois,
        quality=quality,
        blindSpots=BlindSpotAnalysisData(**blind_result),
        search={
            "queryTerms": list(P3_SEARCH_TERMS),
            "radiusMeters": payload.searchRadiusMeters,
            "reportedTotal": total,
            "fetchedRawCount": len(raw_items),
            "fetchedPages": fetched_pages,
            "pageSize": payload.pageSize,
            "coordinateSystem": "BD-09",
        },
    )
    return PoiAnalysisResponse(data=data, meta=ApiMeta(requestId=request_id_from_header(x_request_id), durationMs=duration_ms, source="baidu-place-v2+p3-analysis", apiVersion=settings.app_version, quota=_metrics(client)))


async def _analyze_with_recheck(
    *,
    client: BaiduMapClient,
    settings: Settings,
    center: dict[str, float],
    pois: list[dict],
    analysis_radius_m: float,
    grid_spacing_m: float,
    population_density_per_km2: float,
    boundary_recheck: bool,
) -> dict:
    result = analyze_blind_spots(center=center, pois=pois, analysis_radius_m=analysis_radius_m, grid_spacing_m=grid_spacing_m, population_density_per_km2=population_density_per_km2, boundary_recheck=boundary_recheck)
    route_overrides: dict[str, dict[str, float]] = {}
    route_checked = 0
    route_failed = 0
    if boundary_recheck and settings.baidu_configured:
        candidates = [cell for cell in result["cells"] if cell["boundaryCandidate"]][:MAX_BOUNDARY_RECHECK_CELLS]
        for cell in candidates:
            selected: dict[str, dict] = {}
            for poi in pois:
                category = poi.get("category")
                if category not in ("market", "pharmacy", "primary_school"):
                    continue
                current = selected.get(category)
                if current is None or _distance_for_router(cell["center"], poi["location"]) < _distance_for_router(cell["center"], current["location"]):
                    selected[category] = poi
            destinations = [Coordinate(**poi["location"]) for poi in selected.values()]
            if not destinations:
                continue
            try:
                routes = await client.route_matrix(Coordinate(**cell["center"]), destinations)
                route_overrides[f"{cell['key'][0]}:{cell['key'][1]}"] = {category: route["distance"] for category, route in zip(selected, routes) if route.get("status") == "ok" and route.get("distance") is not None}
                route_checked += 1
            except BackendServiceError:
                route_failed += 1
        if route_overrides:
            result = analyze_blind_spots(center=center, pois=pois, analysis_radius_m=analysis_radius_m, grid_spacing_m=grid_spacing_m, population_density_per_km2=population_density_per_km2, boundary_recheck=True, route_distance_overrides=route_overrides)
        result["evidence"]["boundaryRecheck"].update({"status": "completed" if route_checked and not route_failed else "partial" if route_checked else "failed", "method": "spherical-prefilter-plus-routematrix", "checkedCellCount": route_checked, "failedCellCount": route_failed, "maxCheckedCells": MAX_BOUNDARY_RECHECK_CELLS})
    elif boundary_recheck:
        result["evidence"]["boundaryRecheck"].update({"status": "skipped_no_service_ak", "method": "spherical-distance-prefilter", "note": "未配置服务端 AK，未调用 RouteMatrix"})
    return result


def _metrics(client: object) -> dict[str, int | bool] | None:
    snapshot = getattr(client, "metrics_snapshot", None)
    return snapshot() if callable(snapshot) else None


def _distance_for_router(a: dict[str, float], b: dict[str, float]) -> float:
    latitude = (a["lat"] + b["lat"]) / 2
    east = (b["lng"] - a["lng"]) * 111320 * max(0.2, cos(radians(latitude)))
    north = (b["lat"] - a["lat"]) * 110540
    return (east * east + north * north) ** 0.5
