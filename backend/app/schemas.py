from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Coordinate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lng: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)


class RouteMatrixRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    origin: Coordinate
    destinations: list[Coordinate] = Field(min_length=1, max_length=50)
    mode: Literal["walking"] = "walking"


class RouteMatrixDestination(BaseModel):
    location: Coordinate
    duration: float | None = None
    distance: float | None = None
    status: Literal["ok", "no_route", "api_error"]
    message: str | None = None


class RouteMatrixData(BaseModel):
    origin: Coordinate
    destinations: list[RouteMatrixDestination]
    mode: Literal["walking"]


class ApiMeta(BaseModel):
    requestId: str
    durationMs: int
    source: str
    apiVersion: str = "stage2"
    quota: dict[str, int | bool] | None = None


class RouteMatrixResponse(BaseModel):
    ok: Literal[True] = True
    data: RouteMatrixData
    meta: ApiMeta


class WalkingRouteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    origin: Coordinate
    destination: Coordinate


class WalkingRouteData(BaseModel):
    origin: Coordinate
    destination: Coordinate
    duration: float
    distance: float
    path: list[Coordinate]
    steps: list[dict[str, Any]]
    mode: Literal["walking"] = "walking"


class WalkingRouteResponse(BaseModel):
    ok: Literal[True] = True
    data: WalkingRouteData
    meta: ApiMeta


class GeocodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    address: str = Field(min_length=1, max_length=200)


class GeocodeData(BaseModel):
    address: str
    location: Coordinate
    coordinateSystem: str = "BD-09"
    precise: int | None = None
    confidence: int | None = None
    level: str | None = None


class GeocodeResponse(BaseModel):
    ok: Literal[True] = True
    data: GeocodeData
    meta: ApiMeta


class ReverseGeocodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    location: Coordinate


class ReverseGeocodeData(BaseModel):
    location: Coordinate
    formattedAddress: str
    addressComponent: dict[str, Any] = Field(default_factory=dict)


class ReverseGeocodeResponse(BaseModel):
    ok: Literal[True] = True
    data: ReverseGeocodeData
    meta: ApiMeta


class CoordinateConvertRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    points: list[Coordinate] = Field(min_length=1, max_length=100)
    fromSystem: str = Field(default="WGS84", alias="from")
    toSystem: str = Field(default="BD-09", alias="to")


class CoordinateConvertData(BaseModel):
    points: list[Coordinate]
    fromSystem: str = "WGS84"
    toSystem: str = "BD-09"


class CoordinateConvertResponse(BaseModel):
    ok: Literal[True] = True
    data: CoordinateConvertData
    meta: ApiMeta


class PoiSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=80)
    center: Coordinate
    radius: float = Field(default=2000, gt=0, le=50000)
    page: int = Field(default=0, ge=0, le=7)
    pageSize: int = Field(default=20, ge=1, le=20)
    maxPages: int = Field(default=3, ge=1, le=8)
    areaPolygon: list[Coordinate] | None = Field(default=None, min_length=3, max_length=500)


class PoiRecord(BaseModel):
    model_config = ConfigDict(extra="allow")

    uid: str | None = None
    name: str
    address: str = ""
    location: Coordinate
    category: str
    categoryLabel: str = ""
    confidence: float = 0
    needsReview: bool = False
    distance: float | None = None
    sourceKeyword: str = ""
    source: str = "baidu-place"
    capturedAt: str = ""


class PoiSearchData(BaseModel):
    items: list[PoiRecord]
    pagination: dict[str, int]
    radius: float
    quality: dict[str, Any]


class PoiSearchResponse(BaseModel):
    ok: Literal[True] = True
    data: PoiSearchData
    meta: ApiMeta


class BlindSpotAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    center: Coordinate
    pois: list[PoiRecord] = Field(default_factory=list, max_length=5000)
    analysisRadiusMeters: float = Field(default=1000, gt=200, le=5000)
    gridSpacingMeters: float = Field(default=100, ge=100, le=500)
    populationDensityPerKm2: float = Field(default=8000, ge=0, le=100000)
    boundaryRecheck: bool = True


class BlindSpotAnalysisData(BaseModel):
    zones: list[dict[str, Any]]
    coverage: dict[str, Any]
    evidence: dict[str, Any]
    cells: list[dict[str, Any]]


class BlindSpotAnalysisResponse(BaseModel):
    ok: Literal[True] = True
    data: BlindSpotAnalysisData
    meta: ApiMeta


class PoiAnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    center: Coordinate
    areaPolygon: list[Coordinate] | None = Field(default=None, min_length=3, max_length=100)
    searchRadiusMeters: float = Field(default=2000, ge=1000, le=50000)
    analysisRadiusMeters: float = Field(default=1000, gt=200, le=5000)
    gridSpacingMeters: float = Field(default=150, ge=100, le=500)
    populationDensityPerKm2: float = Field(default=8000, ge=0, le=100000)
    boundaryRecheck: bool = True
    pageSize: int = Field(default=20, ge=1, le=20)
    maxPages: int = Field(default=8, ge=1, le=8)


class PoiAnalysisData(BaseModel):
    center: Coordinate
    pois: list[PoiRecord]
    serviceAreaPois: list[PoiRecord]
    quality: dict[str, Any]
    blindSpots: BlindSpotAnalysisData
    search: dict[str, Any]


class PoiAnalysisResponse(BaseModel):
    ok: Literal[True] = True
    data: PoiAnalysisData
    meta: ApiMeta


class HealthData(BaseModel):
    status: Literal["ok", "degraded"]
    message: str
    baiduConfigured: bool
    baiduReachable: bool | None = None
    serviceCheck: str = "configuration"


class HealthResponse(BaseModel):
    ok: Literal[True] = True
    data: HealthData
    meta: ApiMeta
