import unittest

from app.evidence.validation import load_config
from app.services.multisource_poi import normalize_name, reconcile_records


def record(record_id: str, *, source: str = "baidu_place", name: str = "幸福菜市场", address: str = "测试路1号", lng: float = 116.3, lat: float = 40.0, category: str = "market", uid: str = "") -> dict:
    return {
        "sourceRecordId": record_id,
        "sourceType": source,
        "name": name,
        "address": address,
        "location": {"lng": lng, "lat": lat},
        "rawCategory": category,
        "category": category,
        "baiduUid": uid,
        "operatingStatus": "operating",
        "capturedAt": "2026-09-14T00:00:00Z",
        "licenseBoundary": "synthetic-test-only",
        "redistributionAllowed": False,
    }


class MultiSourcePoiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_config()["multiSource"]

    def test_name_normalization_handles_width_prefix_punctuation_and_branch_suffix(self) -> None:
        self.assertEqual(normalize_name("北京市海淀区 幸福（菜市场）旗舰店"), "幸福菜市场")

    def test_same_baidu_uid_is_deduplicated_with_provenance(self) -> None:
        result = reconcile_records([
            record("B-1", uid="uid-1"),
            record("B-2", name="幸福菜市场分店", uid="uid-1"),
        ], self.config, generated_at="2026-09-14T00:00:00Z")
        self.assertEqual(result["audit"]["clusterCount"], 1)
        self.assertEqual(result["audit"]["mergedCount"], 1)
        self.assertIn("baidu_uid", result["clusters"][0]["matchMethods"])
        self.assertEqual(len(result["clusters"][0]["sourceRecords"]), 2)
        self.assertEqual(result["sampleSize"], 2)
        self.assertEqual(result["sourceTypes"], ["baidu_place"])

    def test_category_conflict_is_preserved_instead_of_silently_overwritten(self) -> None:
        result = reconcile_records([
            record("B-1", category="pharmacy", name="幸福服务点"),
            record("G-1", source="government_registry", category="market", name="幸福服务点", lng=116.3001),
        ], self.config, generated_at="2026-09-14T00:00:00Z")
        cluster = result["clusters"][0]
        self.assertEqual(cluster["canonical"]["category"], "pharmacy")
        self.assertTrue(cluster["reviewRequired"])
        self.assertIn("category_conflict", {item["kind"] for item in cluster["conflicts"]})
        self.assertEqual({item["category"] for item in cluster["sourceRecords"]}, {"market", "pharmacy"})

    def test_same_name_at_different_addresses_remains_two_facilities(self) -> None:
        result = reconcile_records([
            record("B-1", address="测试路1号"),
            record("G-1", source="government_registry", address="测试路99号", lng=116.32),
        ], self.config, generated_at="2026-09-14T00:00:00Z")
        self.assertEqual(result["audit"]["clusterCount"], 2)
        self.assertIn("same_name_different_address", {item["kind"] for item in result["reviewQueue"]})

    def test_entrance_offset_is_queued_for_review_not_auto_merged(self) -> None:
        result = reconcile_records([
            record("B-1", name="希望小学"),
            record("O-1", source="institution_official_page", name="希望小学", address="测试路1号东门", lng=116.30075),
        ], self.config, generated_at="2026-09-14T00:00:00Z")
        self.assertEqual(result["audit"]["clusterCount"], 2)
        self.assertIn("entrance_offset_review", {item["kind"] for item in result["reviewQueue"]})


if __name__ == "__main__":
    unittest.main()
