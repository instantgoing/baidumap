# 第六阶段验收记录

> 这是 2026-09-13 的历史基线，不代表 2026-09-14 参赛收口后的最终门禁。最新状态以 `docs/submission-checklist.md` 和最终门禁记录为准。

验收日期：2026-09-13
版本：`0.6.0-stage6`

## P7 交付物

- README：产品截图、离线/在线快速开始、环境变量、AK 类型与白名单、Docker、测试和 FAQ。
- 技术设计：API 契约、等时圈、POI、灰区、缓存/并发/错误语义和安全边界。
- 真实报告：同一北京海淀中心点的 12/12 路网边界复核、34 个 POI、137 个网格、6 个灰区和真实页面截图。
- 固定演示：`npm run demo` 强制样例模式，不读取 AK。
- CI：前端、后端、Docker 镜像和 Git 历史密钥扫描四个任务。
- 合规：Apache-2.0、NOTICE、171 个 npm 锁定包和 5 个 Python 直接依赖许可清单。
- 演示脚本：可排练的 3 分钟时间轴，显式说明不展示第五阶段功能。

## 本地回归

| 检查 | 结果 |
| --- | --- |
| `npm run check:submission` | 通过；10 份核心交付物，171 个 npm 包有许可证元数据，18 POI / 3 灰区样例契约通过 |
| `npm run lint` | 通过 |
| `npm test` | 通过，口径修复后 28 / 28 |
| `npm run test:e2e` | 通过，桌面 + Pixel 5，2 / 2，共 11.1 秒 |
| `npm run build` | 通过，Vite 8.2.2 |
| `python -m compileall -q app` | 通过 |
| 后端 `unittest discover` | 通过，27 / 27 |
| `docker compose config --quiet` | 通过；本机 Docker 守护进程未运行，因此未在本地重复镜像构建 |
| `npm run demo` 烟雾检查 | 通过；`http://127.0.0.1:4177` 显示“样例数据就绪” |
| `git diff --check -- .` | 通过；只有既有 Windows 换行预警 |

## 在线验收

- `GET /api/health?verify=true`：`baiduReachable=true`。
- 首次冷页面流程：约 105 秒完成等时圈，进入 P3 后触发旧的 60 秒前端超时；页面正确显示可重试失败。
- 修复：新环境的 `VITE_API_TIMEOUT_MS` 默认改为 180,000 ms，后端单次上游超时仍为 12 秒。
- 原参数缓存重试：4 秒完成，34 个有效 POI、6 个灰区、等时圈高置信、边界复核 12/12。
- 报告口径检查发现分类卡片错用 2 公里搜索区计数，已改为仅统计 `serviceAreaPois` 并增加单元回归。修复后报告分数为 34/100，Polygon 内 POI 为 4 条。

## 未在本阶段完成

- 在该历史阶段 P5+P6 尚未实现；后续参赛收口已补 P6 的离线多轮基准与故障证据，P5 仍未实现。
- 30 条 POI 的第三方/实地地面真值、比赛平台信息和发布镜像 SBOM 仍需提交者在正式发布时补齐。
- 当前本地 Git 顶层位于 `baidumap` 的上一级多项目目录。比赛发布时需将 `baidumap` 目录内容作为独立仓库根目录，否则嵌套的 `.github/workflows/ci.yml` 不会被上级仓库自动发现。
