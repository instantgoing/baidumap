from __future__ import annotations

from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any
import re
import unicodedata

from app.services.poi_pipeline import distance_m


SCHEMA_VERSION = "poi-provenance-v1"
STANDARD_CATEGORIES = {
    "market", "pharmacy", "primary_school", "community_healthcare",
    "hospital", "kindergarten", "eldercare", "convenience_store", "other",
}
CATEGORY_ALIASES = {
    "菜市场": "market", "农贸市场": "market", "生鲜超市": "market",
    "药店": "pharmacy", "药房": "pharmacy", "大药房": "pharmacy",
    "小学": "primary_school", "普通小学": "primary_school", "九年一贯制小学部": "primary_school",
    "社区卫生服务中心": "community_healthcare", "医院": "hospital",
    "幼儿园": "kindergarten", "养老机构": "eldercare", "便利店": "convenience_store",
}
SOURCE_PRIORITY = {
    "baidu_place": 0,
    "government_registry": 1,
    "institution_official_page": 2,
    "official_phone_log": 3,
    "field_observation": 4,
    "sample_snapshot": 5,
}


def normalize_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").casefold().strip()
    normalized = re.sub(r"^(北京市|上海市|天津市|重庆市)", "", normalized)
    normalized = re.sub(r"^(海淀区|朝阳区|东城区|西城区)", "", normalized)
    normalized = re.sub(r"(?:旗舰店|分店|门店)$", "", normalized)
    return "".join(char for char in normalized if char.isalnum() or "\u4e00" <= char <= "\u9fff")


def normalize_address(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value or "").casefold()
    replacements = {"号院": "号", "道路": "路", "大街": "街"}
    for source, target in replacements.items():
        normalized = normalized.replace(source, target)
    return "".join(char for char in normalized if char.isalnum() or "\u4e00" <= char <= "\u9fff")


def map_category(raw_category: str, name: str = "") -> tuple[str, str]:
    value = unicodedata.normalize("NFKC", raw_category or "").strip()
    if value in STANDARD_CATEGORIES:
        return value, "standard-key"
    if value in CATEGORY_ALIASES:
        return CATEGORY_ALIASES[value], "category-alias"
    combined = f"{name} {value}"
    for alias in sorted(CATEGORY_ALIASES, key=len, reverse=True):
        if alias in combined:
            return CATEGORY_ALIASES[alias], f"text:{alias}"
    return "other", "unmapped-review"


def _validate_record(record: dict[str, Any]) -> None:
    required = ("sourceRecordId", "sourceType", "name", "address", "location", "capturedAt", "licenseBoundary")
    missing = [field for field in required if record.get(field) in (None, "")]
    if missing:
        raise ValueError(f"多源 POI 缺少字段：{', '.join(missing)}")
    if record["sourceType"] not in SOURCE_PRIORITY:
        raise ValueError(f"未知 sourceType：{record['sourceType']}")
    location = record["location"]
    if not isinstance(location, dict) or not isinstance(location.get("lng"), (int, float)) or not isinstance(location.get("lat"), (int, float)):
        raise ValueError("多源 POI location 必须包含数字 lng/lat")


def _prepared(record: dict[str, Any]) -> dict[str, Any]:
    _validate_record(record)
    category, mapping_rule = map_category(str(record.get("category") or record.get("rawCategory") or ""), str(record["name"]))
    return {
        **record,
        "category": category,
        "categoryMappingRule": mapping_rule,
        "normalizedName": normalize_name(str(record["name"])),
        "normalizedAddress": normalize_address(str(record["address"])),
        "baiduUid": str(record.get("baiduUid") or "").strip() or None,
        "operatingStatus": str(record.get("operatingStatus") or "unknown"),
        "redistributionAllowed": bool(record.get("redistributionAllowed", False)),
    }


def _pair_decision(left: dict[str, Any], right: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    distance = distance_m(left["location"], right["location"])
    name_similarity = SequenceMatcher(None, left["normalizedName"], right["normalizedName"]).ratio()
    same_name = bool(left["normalizedName"]) and left["normalizedName"] == right["normalizedName"]
    same_address = bool(left["normalizedAddress"]) and left["normalizedAddress"] == right["normalizedAddress"]
    if left["baiduUid"] and left["baiduUid"] == right["baiduUid"]:
        return {"action": "merge", "method": "baidu_uid", "distanceMeters": round(distance, 1), "nameSimilarity": round(name_similarity, 4)}
    if same_name and distance <= config["nameAndDistanceMatchMeters"]:
        return {"action": "merge", "method": "normalized_name+distance", "distanceMeters": round(distance, 1), "nameSimilarity": round(name_similarity, 4)}
    if same_address and distance <= config["nameAndDistanceMatchMeters"] and name_similarity >= config["nameSimilarityReviewThreshold"]:
        return {"action": "merge", "method": "address+name_similarity+distance", "distanceMeters": round(distance, 1), "nameSimilarity": round(name_similarity, 4)}
    if same_name and distance > config["entranceOffsetReviewMeters"]:
        return {"action": "separate", "method": "same_name_different_address", "distanceMeters": round(distance, 1), "nameSimilarity": round(name_similarity, 4)}
    if name_similarity >= config["nameSimilarityReviewThreshold"] and distance <= config["entranceOffsetReviewMeters"]:
        return {"action": "review", "method": "entrance_offset_review", "distanceMeters": round(distance, 1), "nameSimilarity": round(name_similarity, 4)}
    return {"action": "separate", "method": "no_match", "distanceMeters": round(distance, 1), "nameSimilarity": round(name_similarity, 4)}


def _conflicts(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    fields = ("name", "address", "category", "operatingStatus")
    for field in fields:
        values: dict[str, list[str]] = {}
        for record in records:
            value = str(record.get(field) or "")
            values.setdefault(value, []).append(record["sourceRecordId"])
        if len(values) > 1:
            result.append({
                "field": field,
                "kind": f"{field}_conflict",
                "values": [{"value": value, "sourceRecordIds": ids} for value, ids in sorted(values.items())],
                "resolution": "manual-review-required",
            })
    return result


def reconcile_records(records: list[dict[str, Any]], config: dict[str, Any], *, generated_at: str | None = None) -> dict[str, Any]:
    prepared = sorted((_prepared(record) for record in records), key=lambda item: (SOURCE_PRIORITY[item["sourceType"]], item["sourceRecordId"]))
    clusters: list[dict[str, Any]] = []
    review_queue: list[dict[str, Any]] = []
    audit_pairs: list[dict[str, Any]] = []
    for record in prepared:
        merged = False
        for cluster in clusters:
            decisions = [_pair_decision(record, existing, config) for existing in cluster["records"]]
            merge_decision = next((decision for decision in decisions if decision["action"] == "merge"), None)
            if merge_decision:
                cluster["records"].append(record)
                cluster["matchMethods"].append(merge_decision["method"])
                audit_pairs.append({"left": cluster["records"][0]["sourceRecordId"], "right": record["sourceRecordId"], **merge_decision})
                merged = True
                break
            review_decision = next((decision for decision in decisions if decision["action"] == "review"), None)
            if review_decision:
                review_queue.append({
                    "kind": review_decision["method"],
                    "recordIds": [cluster["records"][0]["sourceRecordId"], record["sourceRecordId"]],
                    "distanceMeters": review_decision["distanceMeters"],
                    "reason": "名称相似且位于入口偏移复核阈值内，未自动合并",
                })
                audit_pairs.append({"left": cluster["records"][0]["sourceRecordId"], "right": record["sourceRecordId"], **review_decision})
        if not merged:
            clusters.append({"records": [record], "matchMethods": ["new_cluster"]})

    same_name_groups: dict[str, list[dict[str, Any]]] = {}
    for record in prepared:
        same_name_groups.setdefault(record["normalizedName"], []).append(record)
    for group in same_name_groups.values():
        if len(group) < 2:
            continue
        for index, left in enumerate(group):
            for right in group[index + 1:]:
                decision = _pair_decision(left, right, config)
                if decision["method"] == "same_name_different_address":
                    review_queue.append({
                        "kind": "same_name_different_address",
                        "recordIds": [left["sourceRecordId"], right["sourceRecordId"]],
                        "distanceMeters": decision["distanceMeters"],
                        "reason": "同名但距离超过入口偏移阈值，保持为不同设施",
                    })

    output_clusters = []
    for index, cluster in enumerate(clusters, start=1):
        ordered = sorted(cluster["records"], key=lambda item: (SOURCE_PRIORITY[item["sourceType"]], item["sourceRecordId"]))
        canonical_source = ordered[0]
        conflicts = _conflicts(ordered)
        output_clusters.append({
            "clusterId": f"poi-{index:04d}",
            "canonical": {
                "name": canonical_source["name"],
                "address": canonical_source["address"],
                "location": canonical_source["location"],
                "category": canonical_source["category"],
                "selectedFrom": canonical_source["sourceRecordId"],
                "selectionRule": "runtime-source-priority; conflicts remain unresolved",
            },
            "sourceRecords": ordered,
            "matchMethods": sorted(set(cluster["matchMethods"])),
            "conflicts": conflicts,
            "reviewRequired": bool(conflicts),
            "matchConfidence": "manual-review" if conflicts else ("single-source" if len(ordered) == 1 else "rule-based-match"),
        })

    deduped_reviews = []
    seen_reviews = set()
    for item in review_queue:
        key = (item["kind"], tuple(sorted(item["recordIds"])))
        if key not in seen_reviews:
            seen_reviews.add(key)
            deduped_reviews.append(item)
    source_types = sorted({record["sourceType"] for record in prepared})
    captured_values = sorted(str(record["capturedAt"]) for record in prepared)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "configVersion": config.get("schemaVersion", SCHEMA_VERSION),
        "generatedAt": generated_at or datetime.now(timezone.utc).isoformat(),
        "dataTimeRange": {"first": captured_values[0] if captured_values else None, "last": captured_values[-1] if captured_values else None},
        "sourceTypes": source_types,
        "sampleSize": len(records),
        "confidence": "manual-review-required" if deduped_reviews or any(cluster["conflicts"] for cluster in output_clusters) else "rule-based-only",
        "clusters": output_clusters,
        "reviewQueue": deduped_reviews,
        "audit": {
            "inputCount": len(records),
            "clusterCount": len(output_clusters),
            "mergedCount": len(records) - len(output_clusters),
            "conflictCount": sum(len(cluster["conflicts"]) for cluster in output_clusters),
            "pairDecisions": audit_pairs,
        },
        "limitations": [
            "automatic matching never resolves source conflicts",
            "records with redistributionAllowed=false must not be republished as Apache-2.0 data",
        ],
    }
