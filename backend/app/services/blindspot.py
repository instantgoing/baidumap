from collections import defaultdict
from math import cos, radians
from typing import Any

from app.services.poi_pipeline import distance_m


REQUIRED_CATEGORIES = ("market", "pharmacy", "primary_school")


def _offset_point(center: dict[str, float], east_m: float, north_m: float) -> dict[str, float]:
    return {"lng": center["lng"] + east_m / (111320 * max(0.2, cos(radians(center["lat"])))), "lat": center["lat"] + north_m / 110540}


def _cell_polygon(center: dict[str, float], size_m: float) -> list[dict[str, float]]:
    half = size_m / 2
    return [_offset_point(center, -half, -half), _offset_point(center, half, -half), _offset_point(center, half, half), _offset_point(center, -half, half), _offset_point(center, -half, -half)]


def _convex_hull(points: list[dict[str, float]]) -> list[dict[str, float]]:
    ordered = sorted({(round(point["lng"], 10), round(point["lat"], 10)) for point in points})
    if len(ordered) <= 2:
        return [{"lng": point[0], "lat": point[1]} for point in ordered]

    def cross(o: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[float, float]] = []
    for point in ordered:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper: list[tuple[float, float]] = []
    for point in reversed(ordered):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    hull = lower[:-1] + upper[:-1]
    return [{"lng": point[0], "lat": point[1]} for point in hull]


def _grid(center: dict[str, float], radius_m: float, spacing_m: float) -> list[dict[str, Any]]:
    cells: list[dict[str, Any]] = []
    steps = int(radius_m // spacing_m)
    for row in range(-steps, steps + 1):
        for column in range(-steps, steps + 1):
            east, north = column * spacing_m, row * spacing_m
            point = _offset_point(center, east, north)
            if distance_m(center, point) <= radius_m:
                cells.append({"key": (row, column), "center": point, "polygon": _cell_polygon(point, spacing_m), "areaM2": spacing_m * spacing_m})
    return cells


def _components(cells: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    by_key = {cell["key"]: cell for cell in cells}
    remaining = set(by_key)
    components: list[list[dict[str, Any]]] = []
    while remaining:
        start = remaining.pop()
        queue = [start]
        component = [by_key[start]]
        while queue:
            row, column = queue.pop()
            for delta_row in (-1, 0, 1):
                for delta_column in (-1, 0, 1):
                    neighbor = (row + delta_row, column + delta_column)
                    if neighbor in remaining:
                        remaining.remove(neighbor)
                        queue.append(neighbor)
                        component.append(by_key[neighbor])
        components.append(component)
    return components


def analyze_blind_spots(*, center: dict[str, float], pois: list[dict[str, Any]], analysis_radius_m: float = 1000, grid_spacing_m: float = 100, population_density_per_km2: float = 8000, boundary_recheck: bool = True, route_distance_overrides: dict[str, dict[str, float]] | None = None) -> dict[str, Any]:
    if not 100 <= grid_spacing_m <= 500:
        raise ValueError("grid_spacing_m must be between 100 and 500 meters")
    cells = _grid(center, analysis_radius_m, grid_spacing_m)
    enriched: list[dict[str, Any]] = []
    coverage_counts = {category: 0 for category in REQUIRED_CATEGORIES}
    for cell in cells:
        nearest: dict[str, float] = {category: float("inf") for category in REQUIRED_CATEGORIES}
        nearest_uid: dict[str, str | None] = {category: None for category in REQUIRED_CATEGORIES}
        for poi in pois:
            category = poi.get("category")
            if category not in REQUIRED_CATEGORIES:
                continue
            current = distance_m(cell["center"], poi["location"])
            if current < nearest[category]:
                nearest[category] = current
                nearest_uid[category] = poi.get("uid")
        override = (route_distance_overrides or {}).get(f"{cell['key'][0]}:{cell['key'][1]}", {})
        for category, route_distance in override.items():
            if category in nearest and isinstance(route_distance, (int, float)):
                nearest[category] = float(route_distance)
        missing = [category for category in REQUIRED_CATEGORIES if nearest[category] > 1000]
        for category in REQUIRED_CATEGORIES:
            if category not in missing:
                coverage_counts[category] += 1
        boundary_candidate = any(value != float("inf") and abs(value - 1000) <= grid_spacing_m * 1.5 for value in nearest.values())
        cell.update({"missingCategories": missing, "isBlindSpot": bool(missing), "nearestMeters": {key: (None if value == float("inf") else round(value, 1)) for key, value in nearest.items()}, "nearestPoiUid": nearest_uid, "boundaryCandidate": boundary_candidate})
        enriched.append(cell)

    blind_cells = [cell for cell in enriched if cell["isBlindSpot"]]
    grouped: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    for cell in blind_cells:
        grouped[tuple(cell["missingCategories"])].append(cell)
    zones: list[dict[str, Any]] = []
    for missing_categories, group in grouped.items():
        for component in _components(group):
            boundary_points = [point for cell in component for point in cell["polygon"][:-1]]
            polygon = _convex_hull(boundary_points)
            area = sum(cell["areaM2"] for cell in component)
            centroid = {"lng": sum(cell["center"]["lng"] for cell in component) / len(component), "lat": sum(cell["center"]["lat"] for cell in component) / len(component)}
            zones.append({"id": f"blind-{len(zones) + 1:03d}", "missingCategories": list(missing_categories), "areaM2": round(area, 1), "populationProxy": round(area / 1_000_000 * population_density_per_km2, 1), "centroid": centroid, "polygon": polygon, "evidence": {"cellCount": len(component), "facilityCounts": {category: sum(1 for poi in pois if poi.get("category") == category) for category in REQUIRED_CATEGORIES}, "boundaryCandidateCellCount": sum(1 for cell in component if cell["boundaryCandidate"])}})

    total = len(cells)
    coverage = {category: {"totalCells": total, "coveredCells": coverage_counts[category], "missingCellCount": total - coverage_counts[category], "coverageRatio": round(coverage_counts[category] / total, 4) if total else 0} for category in REQUIRED_CATEGORIES}
    boundary_cells = sum(1 for cell in cells if cell["boundaryCandidate"])
    return {"zones": zones, "coverage": coverage, "evidence": {"gridCellCount": total, "blindCellCount": len(blind_cells), "boundaryRecheck": {"requested": boundary_recheck, "candidateCellCount": boundary_cells, "method": "spherical-distance-prefilter", "status": "candidate-ready", "note": "候选边界点可由 RouteMatrix 步行距离覆盖"}, "populationDensityPerKm2": population_density_per_km2}, "cells": enriched}
