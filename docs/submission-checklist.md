# 最终提交清单

检查日期：2026-09-14
目标版本：`0.6.0-stage6`

> 当前源目录位于多项目父仓库。独立发布步骤与授权边界见 `docs/repository-release.md`，未知比赛信息集中在 `docs/submission-metadata.md` 并保持“待填写”。
> 2026-09-14 本地完整门禁的通过项、环境失败和人工待办见 `docs/acceptance-competition-final.md`。

## P7 交付物

- [x] T7.1 README 包含产品截图位、快速开始、环境变量、AK 类型/白名单、Docker、测试和常见问题。
- [x] T7.2 `docs/technical-design.md` 记录 API、等时圈、POI、灰区、缓存/并发/失败语义和安全边界。
- [x] T7.3 `docs/real-community-report.md` 记录真实中心点、采集时间、算法结果、人工核验方法、误差案例、限制以及真实分析/报告截图；首次超时与缓存重试成功也均已记录。
- [x] T7.4 `src/api/mockData.js` + `npm run demo` 提供无 AK、无后端的固定演示。
- [x] T7.5 `.github/workflows/ci.yml` 包含前端检查/测试/构建、后端语法检查/测试、两个 Docker 镜像构建和 Gitleaks Git 历史扫描。
- [x] T7.6 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、依赖生成器与本提交清单齐全。
- [x] T7.7 `docs/demo-script.md` 提供可排练的 3 分钟时间轴，并如实说明 P5 仅提供情景估算、尚非真实选址结论。

## 自动化门禁

提交前从项目根目录执行：

```bash
npm ci
npm run licenses
npm run check:repository
npm run check:submission
npm run lint
npm test
npm run test:e2e
npm run build
```

```powershell
cd backend
python -m pip install -r requirements.txt
python -m compileall -q app
python -m unittest discover -s tests -p "test_*.py"
cd ..
docker compose config --quiet
```

CI 另外构建前端和后端镜像，并使用锁定镜像摘要的 Gitleaks 8.30.1 扫描完整 Git 历史。

## 安全与开源合规

- [x] Apache-2.0 项目许可证与 `NOTICE` 存在。
- [x] 171 个 npm 锁定包均有许可证元数据；Python 直接依赖和容器基础镜像已列出。
- [x] `.env`、`.env.local`、`.env.*.local`、日志、构建物和测试产物已忽略。
- [x] 服务端 AK 不是 Vite 变量，不进入浏览器包。
- [ ] 发布主体在每次正式镜像发布前生成 SBOM 并复核镜像内 OS 包许可证。

## 数据与演示

- [x] 固定样例显式标记 `sample-snapshot`，不冒充真实社区。
- [x] 真实报告包含中心点、采集时间、请求 ID、算法参数、复核结果和限制。
- [x] 报告导出包含算法版本和数据时间。
- [ ] 参赛团队按报告方法补录至少 30 条独立/实地 POI 核验和灰区准确率/召回率。
- [ ] 填入比赛平台、截止时间、仓库 URL、线上演示 URL 和团队信息。
- [ ] 将 `baidumap` 目录内容作为独立 GitHub 仓库根目录发布，确认 `.github/workflows/ci.yml` 被 GitHub Actions 识别。
- [x] 已提供独立仓库布局检查、Docker 构建上下文排除规则和安全发布说明；未创建远程仓库、提交、标签或 Release。
- [x] 已生成逐点/批量 RouteMatrix 五轮离线模拟基准并保留全部轮次；在线对比产物仍待授权环境运行。
- [x] 无 POI、429、5xx、超时、部分方向失败、无路线、无效 AK 均有故障注入或确定性夹具；页面保留错误类型与明确降级状态。
- [x] 多源 POI 名称/地址归一、类别映射、UID/空间去重、冲突保留、来源追踪和许可边界已文档化并有典型案例测试。

## 范围边界与未完成项

- [x] P5.1 基于灰区面积、人口代理值和缺失类别的确定性规划优先级（`planning-scenario-v1`）。
- [x] P5.2 候选设施类别建议与有边界的覆盖改善情景估算；不等同于真实选址结论。
- [x] P5.3 规划前/规划后覆盖指标情景对比；不等同于真实新增设施后的实测改善率。
- [x] P5.4 确定性模板化报告摘要；不使用 LLM 决定评分、选址或达标结论。
- [x] 比赛收口所需的 P6 性能基线、故障注入、错误映射、缓存/QPS/熔断/插值证据。
- [ ] 在线逐点与批量同环境多轮实测（需已授权 AK 与可用配额）。

P5.1–P5.4 的确定性情景与模板化摘要已补齐，但真实道路/用地/入口约束和独立人工核验仍未完成；P6 的比赛收口证据已补齐离线多轮基准和故障矩阵，但在线同环境对照仍明确待办。两者不混写。
