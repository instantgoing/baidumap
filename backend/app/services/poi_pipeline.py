from collections import Counter
from datetime import datetime, timezone
from math import cos, radians, sin, sqrt
from typing import Any

from app.poi_dictionary import DICTIONARY_VERSION, classify_poi


EARTH_RADIUS_M = 6_371_000.0


def distance_m(a: dict[str, float], b: dict[str, float]) -> float:
    lat1, lat2 = radians(a["lat"]), radians(b["lat"])
    d_lat = lat2 - lat1
    d_lng = radians(b["lng"] - a["lng"])
    haversine = sin(d_lat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(d_lng / 2) ** 2
    return 2 * EARTH_RADIUS_M * sqrt(max(0.0, min(1.0, haversine)))


def _location(raw: Any) -> dict[str, float] | None:
    if not isinstance(raw, dict):
        return None
    try:
        lng = float(raw.get("lng"))
        lat = float(raw.get("lat"))
    except (TypeError, ValueError):
        return None
    if not -180 <= lng <= 180 or not -90 <= lat <= 90:
        return None
    return {"lng": lng, "lat": lat}


def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    by_uid: dict[str, int] = {}
    for item in items:
        uid = str(item.get("uid") or "").strip()
        if uid and uid in by_uid:
            continue
        duplicate = False
        for existing in result:
            same_name = item["normalizedName"] and item["normalizedName"] == existing["normalizedName"]
            if same_name and distance_m(item["location"], existing["location"]) <= 50:
                duplicate = True
                break
        if duplicate:
            continue
        if uid:
            by_uid[uid] = len(result)
        result.append(item)
    return result


def standardize_pois(raw_items: list[dict[str, Any]], *, source_keyword: str = "", captured_at: str | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    captured = captured_at or datetime.now(timezone.utc).isoformat()
    standardized: list[dict[str, Any]] = []
    excluded = 0
    for raw in raw_items:
        if not isinstance(raw, dict):
            excluded += 1
            continue
        name = str(raw.get("name") or "").strip()
        location = _location(raw.get("location"))
        if not name or not location:
            excluded += 1
            continue
        detail = raw.get("detail_info") if isinstance(raw.get("detail_info"), dict) else {}
        operating_status = str(raw.get("status") or "").strip()
        if operating_status in {"暂停营业", "可能已关闭", "已关闭"}:
            excluded += 1
            continue
        category_text = " ".join(
            str(value)
            for value in (raw.get("tag"), detail.get("tag"), detail.get("classified_poi_tag"))
            if value
        )
        classification = classify_poi(name, category_text)
        if classification["category"] == "other":
            excluded += 1
            continue
        needs_review = bool(classification["needsReview"])
        standardized.append({
            "uid": str(raw.get("uid") or "").strip() or None,
            "name": name,
            "address": str(raw.get("address") or "").strip(),
            "location": location,
            "category": classification["category"],
            "categoryLabel": classification["categoryLabel"],
            "confidence": classification["confidence"],
            "classificationRule": classification["rule"],
            "needsReview": needs_review,
            "operatingStatus": operating_status,
            "sourceKeyword": source_keyword,
            "source": "baidu-place",
            "capturedAt": captured,
            "normalizedName": _normalize_name(name),
        })
    deduped = _dedupe(standardized)
    for item in deduped:
        item.pop("normalizedName", None)
    categories = Counter(item["category"] for item in deduped)
    quality = {
        "rawCount": len(raw_items),
        "standardizedCount": len(standardized),
        "dedupedCount": len(deduped),
        "duplicateCount": len(standardized) - len(deduped),
        "excludedCount": excluded,
        "needsReviewCount": sum(1 for item in deduped if item["needsReview"]),
        "keywordDictionaryVersion": DICTIONARY_VERSION,
        "categoryCounts": dict(sorted(categories.items())),
    }
    return deduped, quality


def _normalize_name(name: str) -> str:
    return "".join(char for char in name.casefold() if char.isalnum() or "\u4e00" <= char <= "\u9fff")


def point_in_polygon(point: dict[str, float], polygon: list[dict[str, float]]) -> bool:
    if len(polygon) < 3:
        return False
    inside = False
    x, y = point["lng"], point["lat"]
    previous = polygon[-1]
    for current in polygon:
        x1, y1 = previous["lng"], previous["lat"]
        x2, y2 = current["lng"], current["lat"]
        intersects = ((y1 > y) != (y2 > y)) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1
        if intersects:
            inside = not inside
        previous = current
    return inside


def filter_pois_in_area(items: list[dict[str, Any]], *, center: dict[str, float], radius_m: float | None = None, polygon: list[dict[str, float]] | None = None) -> tuple[list[dict[str, Any]], int]:
    filtered: list[dict[str, Any]] = []
    for item in items:
        location = item["location"]
        in_area = point_in_polygon(location, polygon) if polygon else (radius_m is not None and distance_m(center, location) <= radius_m)
        if in_area:
            copy = dict(item)
            copy["distance"] = round(distance_m(center, location), 1)
            filtered.append(copy)
    return filtered, len(items) - len(filtered)
