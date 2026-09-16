# API 深度调用与工程优化证据

证据版本：`engineering-evidence-v1`
算法/证据参数：`competition-evidence-v1`
更新日期：2026-09-14

## 1. 证据分层

| 层级 | 状态 | 用途 | 不可用于 |
| --- | --- | --- | --- |
| 离线模拟 `offline-simulated` | 已运行 | 验证逐点/批量调用形态、缓存计数、配额计数和重复统计 | 宣称百度线上延迟或稳定性 |
| 在线实测 `online-live` | 脚本已就绪，当前对比结果待运行 | 在本地 FastAPI 已配置 AK 时测真实网络、配额与缓存 | 与离线模拟混合求平均 |
| 2026-09-13 历史在线验收 | 已记录 | 证明真实 API 流程曾运行：P3 69,618 ms、累计上游 32 次、限速等待 25 次/22,302 ms | 充当逐点 vs 批量同条件对照 |
| 固定演示 `sample-snapshot` | 已运行 | 无网、无 AK 的确定性产品演示 | 任何在线性能或准确率结论 |

在线对比基准尚未在本轮运行，因为没有使用或请求真实服务端 AK。服务端 AK 仍只由 FastAPI 读取；在线基准仅调用本地 `/api`，不会读取或打印 AK。

## 2. 本轮离线模拟实测

原始结果：`artifacts/benchmarks/route-matrix-simulated.json`
运行环境：Windows 11 / AMD64 / Python 3.13.1
记录时间：2026-09-14T04:08:34Z
参数：36 个终点、批上限 50、每次模拟上游 I/O 30 ms、每场景 5 轮。所有轮次均保存在 JSON 中，不只保留最佳值。

| 策略 | 缓存 | 轮次 | 平均耗时 | 五轮范围 | 逻辑请求/轮 | 上游调用/配额/轮 | 成功率 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 逐点 | 冷启动 | 5 | 1,292.314 ms | 1,284.708–1,312.594 ms | 36 | 36 | 100% |
| 批量 | 冷启动 | 5 | 37.932 ms | 33.426–41.371 ms | 1 | 1 | 100% |
| 逐点 | 缓存命中 | 5 | 0.932 ms | 0.656–1.190 ms | 36 | 0 | 100% |
| 批量 | 缓存命中 | 5 | 0.386 ms | 0.371–0.410 ms | 1 | 0 | 100% |

在这个明确标注的模拟模型中，批量冷启动将上游调用从 36 次降到 1 次，即减少 97.22%；平均耗时减少 97.06%。这证明批处理和缓存的工程行为，不代表百度生产网络会获得相同比例。

复现离线结果：

```bash
npm run benchmark:route-matrix
```

复现在线结果（先单独启动已配置 AK 的 FastAPI；默认至少 3 轮，严格 QPS 下可能耗时较长）：

```powershell
python backend/scripts/route_matrix_benchmark.py --mode online --runs 3 --api-base-url http://127.0.0.1:8000/api --output artifacts/benchmarks/route-matrix-online.json
```

在线产物必须保留 `source=online-live`、机器环境、运行次数、全部轮次、失败类型与限制。运行前后不得关闭 QPS、篡改白名单或绕过配额；若失败就保留失败记录，不选择性重跑后只发布最好结果。

## 3. 故障注入矩阵

| 场景 | 注入层 | 预期语义 | 自动证据 | 页面状态 |
| --- | --- | --- | --- | --- |
| 无 POI | HTTP fixture | 合法空集合，样本量为 0，不伪造 POI | `test_fault_injection.py` | 可显示 0 个 POI/灰区证据 |
| HTTP 429 | HTTP fixture | `rate_limit`；只执行配置次数的重试 | `test_fault_injection.py` | “上游配额或 QPS 受限” |
| 5xx | HTTP fixture | `upstream_error`；有限重试后触发熔断 | `test_fault_injection.py` | “百度上游服务暂不可用” |
| 超时 | HTTP fixture | `timeout`；有限重试后失败 | `test_fault_injection.py` | “在线请求超时” |
| 部分方向失败 | RouteMatrix fixture | 邻向空间插值、降低置信度、保留 warning | `tests/isochrone.test.js` | 报告展示置信度与限制 |
| 全部方向失败 / 无路线 | Route fixture | 拒绝伪 Polygon；若继续 POI 流程则状态为“明确降级” | 前后端单测 | 不显示为完整成功 |
| 无效 AK / 未配置 AK | HTTP/config fixture | `upstream_auth_error` / `configuration_error`，不重试鉴权失败 | `test_fault_injection.py`、`test_baidu_client.py` | 明确鉴权或配置指引，不自动切样例 |

页面错误文案由 `src/api/errorPresentation.js` 统一映射，`tests/errorPresentation.test.js` 对每种状态断言。在线等时圈失败后若 1 公里 POI 分析仍可完成，页面使用 `degraded` 状态和“明确降级”警告；POI 分析本身失败则保持 `error`，不会输出报告结果。

## 4. 可靠性机制与量化字段

- 有限重试：`retries`；只重试超时、网络、HTTP 429/5xx 和明确可重试状态。
- QPS 滑动窗口：`rateLimitWaits`、`rateLimitWaitMs`；缓存命中不占上游槽位。
- TTL 缓存：`cacheHits`，缓存键排除 AK；基准以 `upstreamCalls` 差值计算配额。
- 熔断：`circuitOpen`；连续失败到阈值后冷却期内直接返回 `circuit_open`。
- 空间插值：部分方向失败可插值，但降低 `sampleSuccessRatio` 和置信度并记录警告；全部失败直接拒绝。
- 错误映射：后端保留 `rate_limit`、`timeout`、`upstream_auth_error`、`circuit_open`、`empty_result` 和 `no_route` 等语义；前端保留 `kind` 与 request ID。

## 5. 限制与待办

- `artifacts/benchmarks/route-matrix-online.json`：待在授权且配额允许的环境真实运行。
- 在线逐点 36 次在保守 QPS 配置下会很慢，这是配额保护的预期结果，不能为缩短比赛基准而绕过。
- 当前缓存为进程内 TTL 缓存，多实例部署不会共享；正式生产需按合规边界评估共享缓存。
- 故障注入证明分类与控制流，不证明第三方服务的实际故障概率。
