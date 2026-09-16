from time import perf_counter
from uuid import uuid4

from fastapi import APIRouter, Header, Request

from app.config import Settings
from app.errors import BackendServiceError
from app.schemas import ApiMeta, CoordinateConvertData, CoordinateConvertRequest, CoordinateConvertResponse, GeocodeData, GeocodeRequest, GeocodeResponse, ReverseGeocodeData, ReverseGeocodeRequest, ReverseGeocodeResponse, RouteMatrixData, RouteMatrixRequest, RouteMatrixResponse, WalkingRouteData, WalkingRouteRequest, WalkingRouteResponse
from app.services.baidu_client import BaiduMapClient

router = APIRouter(prefix="/api/v1/map", tags=["map"])


def request_id_from_header(value: str | None) -> str:
    return value.strip() if value and value.strip() else str(uuid4())


@router.post("/walking-route", response_model=WalkingRouteResponse)
async def walking_route(payload: WalkingRouteRequest, request: Request, x_request_id: str | None = Header(default=None)) -> WalkingRouteResponse:
    started = perf_counter()
    settings: Settings = request.app.state.settings
    data = await request.app.state.baidu_client.walking_route(payload.origin, payload.destination)
    return WalkingRouteResponse(data=WalkingRouteData(**data), meta=ApiMeta(requestId=request_id_from_header(x_request_id), durationMs=round((perf_counter() - started) * 1000), source="baidu-directionlite-walking-v1", apiVersion=settings.app_version, quota=request.app.state.baidu_client.metrics_snapshot()))


@router.post("/geocode", response_model=GeocodeResponse)
async def geocode(payload: GeocodeRequest, request: Request, x_request_id: str | None = Header(default=None)) -> GeocodeResponse:
    started = perf_counter()
    settings: Settings = request.app.state.settings
    data = await request.app.state.baidu_client.geocode(payload.address)
    return GeocodeResponse(data=GeocodeData(**data), meta=ApiMeta(requestId=request_id_from_header(x_request_id), durationMs=round((perf_counter() - started) * 1000), source="baidu-geocoding-v3", apiVersion=settings.app_version, quota=request.app.state.baidu_client.metrics_snapshot()))


@router.post("/reverse-geocode", response_model=ReverseGeocodeResponse)
async def reverse_geocode(payload: ReverseGeocodeRequest, request: Request, x_request_id: str | None = Header(default=None)) -> ReverseGeocodeResponse:
    started = perf_counter()
    settings: Settings = request.app.state.settings
    data = await request.app.state.baidu_client.reverse_geocode(payload.location)
    return ReverseGeocodeResponse(data=ReverseGeocodeData(**data), meta=ApiMeta(requestId=request_id_from_header(x_request_id), durationMs=round((perf_counter() - started) * 1000), source="baidu-reverse-geocoding-v3", apiVersion=settings.app_version, quota=request.app.state.baidu_client.metrics_snapshot()))


@router.post("/coordinate-convert", response_model=CoordinateConvertResponse)
async def coordinate_convert(payload: CoordinateConvertRequest, request: Request, x_request_id: str | None = Header(default=None)) -> CoordinateConvertResponse:
    started = perf_counter()
    settings: Settings = request.app.state.settings
    points = await request.app.state.baidu_client.convert_coordinates(payload.points, source=payload.fromSystem, target=payload.toSystem)
    return CoordinateConvertResponse(data=CoordinateConvertData(points=points, fromSystem=payload.fromSystem, toSystem=payload.toSystem), meta=ApiMeta(requestId=request_id_from_header(x_request_id), durationMs=round((perf_counter() - started) * 1000), source="baidu-geoconv-v1", apiVersion=settings.app_version, quota=request.app.state.baidu_client.metrics_snapshot()))


@router.post("/route-matrix", response_model=RouteMatrixResponse)
async def route_matrix(
    payload: RouteMatrixRequest,
    request: Request,
    x_request_id: str | None = Header(default=None),
) -> RouteMatrixResponse:
    started = perf_counter()
    request_id = request_id_from_header(x_request_id)
    settings: Settings = request.app.state.settings
    client: BaiduMapClient = request.app.state.baidu_client
    destinations = await client.route_matrix(payload.origin, payload.destinations, mode=payload.mode)
    duration_ms = round((perf_counter() - started) * 1000)
    return RouteMatrixResponse(
        data=RouteMatrixData(origin=payload.origin, destinations=destinations, mode=payload.mode),
        meta=ApiMeta(requestId=request_id, durationMs=duration_ms, source="baidu-routematrix", apiVersion=settings.app_version, quota=client.metrics_snapshot()),
    )
