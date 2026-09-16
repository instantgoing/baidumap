from dataclasses import dataclass
import re


@dataclass(frozen=True, slots=True)
class PoiCategory:
    key: str
    label: str
    keywords: tuple[str, ...]
    exclusions: tuple[str, ...] = ()


POI_CATEGORIES: tuple[PoiCategory, ...] = (
    PoiCategory("market", "菜市场/生鲜超市", ("菜市场", "农贸市场", "生鲜超市", "生鲜市场", "果蔬店", "菜店"), ("培训", "批发", "餐饮")),
    PoiCategory("pharmacy", "药店", ("药店", "大药房", "药房", "医药"), ("医院", "诊所", "保健品", "美容", "兽药")),
    PoiCategory("community_healthcare", "社区医疗", ("社区卫生服务中心", "社区卫生服务站", "社区医院", "卫生院"), ("宠物",)),
    PoiCategory("hospital", "综合医院", ("医院", "医疗中心", "专科医院"), ("宠物医院", "兽医")),
    PoiCategory("primary_school", "小学", ("小学", "实验小学", "中心小学"), ("培训", "辅导", "职业", "成人", "大学", "中学")),
    PoiCategory("kindergarten", "幼儿园", ("幼儿园", "幼稚园"), ("培训", "托管")),
    PoiCategory("eldercare", "养老服务", ("养老院", "敬老院", "养老服务中心", "老年公寓"), ("培训",)),
    PoiCategory("convenience_store", "便利店/超市", ("便利店", "超市", "生活超市"), ("培训", "批发", "家具")),
)

REVIEW_TERMS = ("疑似", "待定", "旧址", "筹建", "停车场", "写字楼")
DICTIONARY_VERSION = "民生设施词典-v1"


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"[\s·•\-—（）()【】\[\]、,，.。/]+", "", value).casefold()


def classify_poi(name: str, category_text: str = "") -> dict[str, object]:
    text = f"{name} {category_text}".strip()
    normalized = normalize_text(text)
    normalized_name = normalize_text(name)
    for category in POI_CATEGORIES:
        matched = next((term for term in category.keywords if normalize_text(term) in normalized), None)
        if not matched:
            continue
        # Baidu's classified_poi_tag may legitimately contain a broad parent
        # label such as "教育培训;小学". Exclusions describe false-positive
        # names, so applying them to the entire upstream tag would discard the
        # valid primary-school POI.
        excluded = next((term for term in category.exclusions if normalize_text(term) in normalized_name), None)
        if excluded:
            continue
        confidence = 0.96 if normalize_text(matched) in normalized_name else 0.82
        needs_review = any(normalize_text(term) in normalized for term in REVIEW_TERMS)
        return {"category": category.key, "categoryLabel": category.label, "confidence": confidence, "rule": matched, "needsReview": needs_review}
    return {"category": "other", "categoryLabel": "其他", "confidence": 0.0, "rule": None, "needsReview": True}


def category_by_key(key: str) -> PoiCategory | None:
    return next((item for item in POI_CATEGORIES if item.key == key), None)
