# 真实社区独立核验数据

本目录只包含待填写模板，不包含实地事实或准确率结论。模板中的编号、类别配额和抽样层是采集计划，不是已经核验的 POI。

## 文件

- `metadata.template.json`：社区、数据时间、负责人、来源清单和限制。
- `poi-ground-truth.template.csv`：30 条独立真值槽位，三类各 10 条，满足每类至少 5 条的最低设计要求。
- `system-poi-review.template.csv`：从系统返回中抽样做分类核验，也用于记录误召回。
- `boundary-samples.template.csv`：12 个方向的独立步行耗时核验。
- `gray-area-samples.template.csv`：灰区内部、边缘和非灰区的分层样本。

## 填写规则

1. 复制模板到一个单独的数据目录，去掉文件名中的 `.template`；不要直接把待填模板改成“已核验”。
2. POI 真值只能来自政府公开名录、机构官方页面、官方电话核验记录或实地记录。`baidu_place_search` 不是独立真值来源，严格校验会拒绝。
3. 来源 URL 可直接填写；电话核验应填写不含私人电话号码的记录编号；实地记录应填写照片/笔记编号及授权说明。
4. `system_detected`、`category_correct`、`system_predicts_gray`、`ground_truth_is_gray` 只能填 `true` 或 `false`。
5. `operating_status` 只能填 `operating`、`closed` 或 `unknown`；查全率分母只统计经独立来源确认仍为 `operating` 的真值 POI，已关闭或未知记录仍保留用于误差审计。
6. 坐标统一为 BD-09，并尽量记录可步行入口；`entry_offset_m` 用于说明 POI 中心点与实际入口偏移。
7. 每条记录都要有核验时间、核验人/角色和来源。来源冲突写入 `notes`，不得静默覆盖。

模板结构检查：

```bash
npm run evidence:validate-template
```

填完后严格校验并计算指标：

```powershell
python backend/scripts/community_validation.py validate --input path\to\collected-data
python backend/scripts/community_validation.py calculate --input path\to\collected-data --output artifacts\validation-metrics.json
```

严格校验未通过时计算器不会输出准确率。生成 JSON 会记录配置版本、数据时间、来源、样本量、样本置信标签和限制；所有比率都是本社区样本内结果，不得外推为城市总体准确率。
