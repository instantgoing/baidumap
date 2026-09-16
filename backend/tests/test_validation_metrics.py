import unittest
from pathlib import Path

from app.evidence.validation import calculate_metrics, load_config, load_validate, validate_dataset


ROOT = Path(__file__).resolve().parents[2]


def source_fields() -> dict[str, str]:
    return {
        "source_type": "government_registry",
        "source_title": "synthetic test registry",
        "source_reference": "fixture://independent-source",
        "verified_at": "2026-09-14T00:00:00Z",
        "verifier": "automated-test",
    }


def complete_fixture() -> dict:
    categories = ["market"] * 10 + ["pharmacy"] * 10 + ["primary_school"] * 10
    ground_truth = []
    for index, category in enumerate(categories):
        detected = index < 24
        ground_truth.append({
            "record_id": f"GT-{index:03d}",
            "verification_status": "verified",
            "ground_truth_name": f"synthetic-{index}",
            "ground_truth_category": category,
            "address": "synthetic fixture only",
            "lng": "116.3",
            "lat": "40.0",
            "operating_status": "operating",
            "system_detected": str(detected).lower(),
            "system_category": category if detected else "",
            **source_fields(),
        })
    reviews = [{
        "review_id": f"SR-{index:03d}",
        "verification_status": "verified",
        "system_name": f"synthetic-system-{index}",
        "system_category": "market",
        "ground_truth_exists": "true",
        "category_correct": str(index < 8).lower(),
        **source_fields(),
    } for index in range(10)]
    boundary = [{
        "sample_id": f"BD-{index:03d}",
        "verification_status": "verified",
        "system_predicted_seconds": "900",
        "independent_seconds": str(900 + (index + 1) * 10),
        **source_fields(),
    } for index in range(12)]
    states = [(True, True)] * 4 + [(True, False)] * 2 + [(False, True)] * 2 + [(False, False)] * 4
    gray_area = [{
        "sample_id": f"GA-{index:03d}",
        "verification_status": "verified",
        "stratum": ("interior", "edge", "non_gray")[index % 3],
        "category": categories[index],
        "system_predicts_gray": str(predicted).lower(),
        "ground_truth_is_gray": str(actual).lower(),
        **source_fields(),
    } for index, (predicted, actual) in enumerate(states)]
    return {
        "metadata": {
            "schema_version": "community-validation-v1",
            "dataset_status": "collected",
            "dataset_id": "synthetic-unit-test",
            "community": "synthetic fixture",
            "coordinate_system": "BD-09",
            "data_time": "2026-09-14T00:00:00Z",
            "collected_by": "automated-test",
            "limitations": ["synthetic test data; not real-world evidence"],
        },
        "ground_truth": ground_truth,
        "system_reviews": reviews,
        "boundary": boundary,
        "gray_area": gray_area,
    }


class CommunityValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_config()

    def test_repository_template_has_required_slots_and_category_quotas(self) -> None:
        dataset, _ = load_validate(ROOT / "data" / "validation", template=True)
        self.assertEqual(len(dataset["ground_truth"]), 30)
        self.assertEqual(len(dataset["boundary"]), 12)
        self.assertEqual(len(dataset["gray_area"]), 12)

    def test_complete_synthetic_fixture_validates_and_recomputes_all_metrics(self) -> None:
        dataset = complete_fixture()
        self.assertEqual(validate_dataset(dataset, self.config), [])
        result = calculate_metrics(dataset, self.config, calculated_at="2026-09-14T00:00:00Z")

        self.assertEqual(result["metrics"]["poiRecall"]["value"], 0.8)
        self.assertEqual(result["metrics"]["classificationAccuracy"]["value"], 0.8)
        self.assertEqual(result["metrics"]["boundaryTimeError"]["meanAbsoluteSeconds"], 65)
        self.assertEqual(result["metrics"]["boundaryTimeError"]["withinToleranceCount"], 6)
        self.assertEqual(result["metrics"]["grayAreaAccuracy"]["value"], 0.666667)
        self.assertEqual(result["metrics"]["grayAreaRecall"]["value"], 0.666667)
        self.assertEqual(result["dataset"]["scope"], "single-community-sample")

    def test_baidu_place_search_is_rejected_as_independent_truth(self) -> None:
        dataset = complete_fixture()
        dataset["ground_truth"][0]["source_type"] = "baidu_place_search"
        issues = validate_dataset(dataset, self.config)
        self.assertTrue(any("必须是独立来源" in issue for issue in issues))

    def test_pending_records_prevent_strict_metric_claims(self) -> None:
        dataset = complete_fixture()
        dataset["ground_truth"][0]["verification_status"] = "pending"
        issues = validate_dataset(dataset, self.config)
        self.assertTrue(any("尚未 verified" in issue for issue in issues))


if __name__ == "__main__":
    unittest.main()
