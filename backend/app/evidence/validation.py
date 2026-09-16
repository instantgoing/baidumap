from __future__ import annotations

import csv
from datetime import datetime, timezone
import json
from pathlib import Path
from statistics import mean, median
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG_PATH = ROOT / "config" / "evidence-parameters.v1.json"
FILE_NAMES = {
    "metadata": "metadata.json",
    "ground_truth": "poi-ground-truth.csv",
    "system_reviews": "system-poi-review.csv",
    "boundary": "boundary-samples.csv",
    "gray_area": "gray-area-samples.csv",
}


class EvidenceValidationError(ValueError):
    def __init__(self, issues: list[str]):
        super().__init__("; ".join(issues))
        self.issues = issues


def load_config(path: Path = DEFAULT_CONFIG_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def load_dataset(directory: Path, *, template: bool = False) -> dict[str, Any]:
    suffix = ".template" if template else ""
    paths = {
        key: directory / name.replace(".", f"{suffix}.", 1)
        for key, name in FILE_NAMES.items()
    }
    missing = [str(path) for path in paths.values() if not path.exists()]
    if missing:
        raise EvidenceValidationError([f"缺少数据文件：{path}" for path in missing])
    return {
        "metadata": json.loads(paths["metadata"].read_text(encoding="utf-8")),
        "ground_truth": _read_csv(paths["ground_truth"]),
        "system_reviews": _read_csv(paths["system_reviews"]),
        "boundary": _read_csv(paths["boundary"]),
        "gray_area": _read_csv(paths["gray_area"]),
    }


def _is_missing(value: Any) -> bool:
    return value is None or str(value).strip() in {"", "待填写"}


def _parse_bool(value: Any, field: str, issues: list[str]) -> bool | None:
    normalized = str(value).strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    issues.append(f"{field} 必须为 true 或 false")
    return None


def _parse_float(value: Any, field: str, issues: list[str], *, minimum: float | None = None, maximum: float | None = None) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        issues.append(f"{field} 必须是数字")
        return None
    if minimum is not None and result < minimum:
        issues.append(f"{field} 不得小于 {minimum}")
    if maximum is not None and result > maximum:
        issues.append(f"{field} 不得大于 {maximum}")
    return result


def _check_unique(rows: list[dict[str, str]], field: str, label: str, issues: list[str]) -> None:
    values = [row.get(field, "").strip() for row in rows]
    if any(not value for value in values):
        issues.append(f"{label} 存在空 {field}")
    duplicates = sorted({value for value in values if value and values.count(value) > 1})
    if duplicates:
        issues.append(f"{label} 存在重复 {field}：{', '.join(duplicates)}")


def _validate_source(row: dict[str, str], row_id: str, allowed: set[str], issues: list[str]) -> None:
    source_type = row.get("source_type", "").strip()
    if source_type not in allowed:
        issues.append(f"{row_id} source_type 必须是独立来源，当前为 {source_type or '空'}")
    for field in ("source_title", "source_reference", "verified_at", "verifier"):
        if _is_missing(row.get(field)):
            issues.append(f"{row_id} 缺少 {field}")


def validate_dataset(dataset: dict[str, Any], config: dict[str, Any], *, template: bool = False) -> list[str]:
    issues: list[str] = []
    rules = config["validation"]
    required_categories = set(rules["requiredCategories"])
    metadata = dataset["metadata"]
    ground_truth = dataset["ground_truth"]
    system_reviews = dataset["system_reviews"]
    boundary = dataset["boundary"]
    gray_area = dataset["gray_area"]

    if metadata.get("schema_version") != "community-validation-v1":
        issues.append("metadata.schema_version 必须为 community-validation-v1")
    if metadata.get("coordinate_system") != "BD-09":
        issues.append("coordinate_system 必须为 BD-09")
    if len(ground_truth) < rules["minimumGroundTruthPoi"]:
        issues.append(f"独立 POI 真值少于 {rules['minimumGroundTruthPoi']} 条")
    counts = {category: sum(row.get("ground_truth_category") == category for row in ground_truth) for category in required_categories}
    for category, count in counts.items():
        if count < rules["minimumPerRequiredCategory"]:
            issues.append(f"{category} 真值少于 {rules['minimumPerRequiredCategory']} 条")
    unknown = sorted({row.get("ground_truth_category", "") for row in ground_truth} - required_categories)
    if unknown:
        issues.append(f"POI 真值包含未知类别：{', '.join(unknown)}")
    _check_unique(ground_truth, "record_id", "POI 真值", issues)
    _check_unique(system_reviews, "review_id", "系统 POI 核验", issues)
    _check_unique(boundary, "sample_id", "边界样本", issues)
    _check_unique(gray_area, "sample_id", "灰区样本", issues)

    if template:
        if metadata.get("dataset_status") not in {"template", "collected"}:
            issues.append("模板 dataset_status 必须为 template 或 collected")
        return issues

    if metadata.get("dataset_status") != "collected":
        issues.append("完整数据的 dataset_status 必须为 collected")
    for field in ("dataset_id", "community", "data_time", "collected_by"):
        if _is_missing(metadata.get(field)):
            issues.append(f"metadata 缺少 {field}")
    if not metadata.get("limitations"):
        issues.append("metadata.limitations 至少记录一项限制")

    allowed_sources = set(rules["allowedIndependentSourceTypes"])
    for row in ground_truth:
        row_id = row.get("record_id", "未知 POI")
        if row.get("verification_status") != "verified":
            issues.append(f"{row_id} 尚未 verified")
            continue
        for field in ("ground_truth_name", "address", "operating_status"):
            if _is_missing(row.get(field)):
                issues.append(f"{row_id} 缺少 {field}")
        if row.get("operating_status") not in {"operating", "closed", "unknown"}:
            issues.append(f"{row_id}.operating_status 必须为 operating、closed 或 unknown")
        _parse_float(row.get("lng"), f"{row_id}.lng", issues, minimum=-180, maximum=180)
        _parse_float(row.get("lat"), f"{row_id}.lat", issues, minimum=-90, maximum=90)
        detected = _parse_bool(row.get("system_detected"), f"{row_id}.system_detected", issues)
        if detected and _is_missing(row.get("system_category")):
            issues.append(f"{row_id} 已检出但缺少 system_category")
        _validate_source(row, row_id, allowed_sources, issues)

    verified_reviews = [row for row in system_reviews if row.get("verification_status") == "verified"]
    if not verified_reviews:
        issues.append("至少需要 1 条已完成人工核验的系统 POI 记录来计算分类准确率")
    for row in verified_reviews:
        row_id = row.get("review_id", "未知系统 POI")
        for field in ("system_name", "system_category"):
            if _is_missing(row.get(field)):
                issues.append(f"{row_id} 缺少 {field}")
        _parse_bool(row.get("ground_truth_exists"), f"{row_id}.ground_truth_exists", issues)
        _parse_bool(row.get("category_correct"), f"{row_id}.category_correct", issues)
        _validate_source(row, row_id, allowed_sources, issues)

    verified_boundary = [row for row in boundary if row.get("verification_status") == "verified"]
    if len(verified_boundary) < rules["minimumBoundarySamples"]:
        issues.append(f"已核验边界样本少于 {rules['minimumBoundarySamples']} 条")
    for row in verified_boundary:
        row_id = row.get("sample_id", "未知边界样本")
        _parse_float(row.get("system_predicted_seconds"), f"{row_id}.system_predicted_seconds", issues, minimum=0)
        _parse_float(row.get("independent_seconds"), f"{row_id}.independent_seconds", issues, minimum=0)
        _validate_source(row, row_id, allowed_sources, issues)

    verified_gray = [row for row in gray_area if row.get("verification_status") == "verified"]
    if len(verified_gray) < rules["minimumGrayAreaSamples"]:
        issues.append(f"已核验灰区样本少于 {rules['minimumGrayAreaSamples']} 条")
    for row in verified_gray:
        row_id = row.get("sample_id", "未知灰区样本")
        if row.get("category") not in required_categories:
            issues.append(f"{row_id} 灰区类别无效")
        if row.get("stratum") not in {"interior", "edge", "non_gray"}:
            issues.append(f"{row_id} stratum 必须为 interior、edge 或 non_gray")
        _parse_bool(row.get("system_predicts_gray"), f"{row_id}.system_predicts_gray", issues)
        _parse_bool(row.get("ground_truth_is_gray"), f"{row_id}.ground_truth_is_gray", issues)
        _validate_source(row, row_id, allowed_sources, issues)
    return issues


def _ratio_metric(numerator: int, denominator: int, formula: str, sample_target: int) -> dict[str, Any]:
    return {
        "status": "calculated" if denominator else "insufficient-data",
        "value": round(numerator / denominator, 6) if denominator else None,
        "numerator": numerator,
        "denominator": denominator,
        "sampleSize": denominator,
        "formula": formula,
        "confidence": "sample-level" if denominator >= sample_target else ("limited-sample" if denominator else "not-assessed"),
    }


def calculate_metrics(dataset: dict[str, Any], config: dict[str, Any], *, calculated_at: str | None = None) -> dict[str, Any]:
    rules = config["validation"]
    verified_ground_truth = [row for row in dataset["ground_truth"] if row.get("verification_status") == "verified"]
    ground_truth = [row for row in verified_ground_truth if row.get("operating_status") == "operating"]
    reviews = [row for row in dataset["system_reviews"] if row.get("verification_status") == "verified"]
    boundary = [row for row in dataset["boundary"] if row.get("verification_status") == "verified"]
    gray = [row for row in dataset["gray_area"] if row.get("verification_status") == "verified"]

    detected = sum(str(row.get("system_detected", "")).lower() == "true" for row in ground_truth)
    correct_categories = sum(str(row.get("category_correct", "")).lower() == "true" for row in reviews)
    errors = [abs(float(row["system_predicted_seconds"]) - float(row["independent_seconds"])) for row in boundary]
    predicted_gray = [row for row in gray if str(row.get("system_predicts_gray", "")).lower() == "true"]
    actual_gray = [row for row in gray if str(row.get("ground_truth_is_gray", "")).lower() == "true"]
    true_positive = sum(
        str(row.get("system_predicts_gray", "")).lower() == "true"
        and str(row.get("ground_truth_is_gray", "")).lower() == "true"
        for row in gray
    )
    tolerance = rules["boundaryToleranceSeconds"]
    source_types = sorted({row.get("source_type") for rows in (ground_truth, reviews, boundary, gray) for row in rows if row.get("source_type")})
    metadata = dataset["metadata"]

    return {
        "schemaVersion": "community-validation-metrics-v1",
        "evidenceConfigVersion": config["version"],
        "calculatedAt": calculated_at or datetime.now(timezone.utc).isoformat(),
        "dataset": {
            "id": metadata.get("dataset_id"),
            "community": metadata.get("community"),
            "dataTime": metadata.get("data_time"),
            "coordinateSystem": metadata.get("coordinate_system"),
            "sourceTypes": source_types,
            "scope": "single-community-sample",
        },
        "sampleSizes": {
            "verifiedGroundTruthRows": len(verified_ground_truth),
            "groundTruthPoi": len(ground_truth),
            "reviewedSystemPoi": len(reviews),
            "boundary": len(boundary),
            "grayArea": len(gray),
        },
        "metrics": {
            "poiRecall": _ratio_metric(detected, len(ground_truth), "正确检出的独立真值 POI / 独立真值 POI", rules["minimumGroundTruthPoi"]),
            "classificationAccuracy": _ratio_metric(correct_categories, len(reviews), "分类正确的已核验系统 POI / 已核验系统 POI", rules["minimumGroundTruthPoi"]),
            "boundaryTimeError": {
                "status": "calculated" if errors else "insufficient-data",
                "sampleSize": len(errors),
                "meanAbsoluteSeconds": round(mean(errors), 3) if errors else None,
                "medianAbsoluteSeconds": round(median(errors), 3) if errors else None,
                "maxAbsoluteSeconds": round(max(errors), 3) if errors else None,
                "withinToleranceCount": sum(error <= tolerance for error in errors),
                "toleranceSeconds": tolerance,
                "formula": "abs(系统预测步行秒数 - 独立复核步行秒数)",
                "confidence": "sample-level" if len(errors) >= rules["minimumBoundarySamples"] else ("limited-sample" if errors else "not-assessed"),
            },
            "grayAreaAccuracy": _ratio_metric(true_positive, len(predicted_gray), "实际为灰区的预测灰区样本 / 预测灰区样本", rules["minimumGrayAreaSamples"]),
            "grayAreaRecall": _ratio_metric(true_positive, len(actual_gray), "被系统识别的真实灰区样本 / 真实灰区样本", rules["minimumGrayAreaSamples"]),
        },
        "limitations": [
            "指标仅代表已核验的单社区分层样本，不可外推为城市总体准确率。",
            *metadata.get("limitations", []),
        ],
    }


def load_validate(directory: Path, *, template: bool = False, config_path: Path = DEFAULT_CONFIG_PATH) -> tuple[dict[str, Any], dict[str, Any]]:
    config = load_config(config_path)
    dataset = load_dataset(directory, template=template)
    issues = validate_dataset(dataset, config, template=template)
    if issues:
        raise EvidenceValidationError(issues)
    return dataset, config
