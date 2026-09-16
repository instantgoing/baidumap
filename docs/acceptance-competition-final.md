# 参赛收口最终门禁记录

检查日期：2026-09-14
工作区：`D:\cursor的项目\baidumap`
应用版本：`0.6.0-stage6`
证据配置：`competition-evidence-v1`

## 1. 范围与安全结论

- 只读确认实际 Git 根目录是多项目父目录 `D:\cursor的项目`，不是 `baidumap`；父仓库存在大量与本项目无关的改动，本轮未删除、重置、暂存、提交或改写任何 Git 历史。
- 本轮没有创建远程仓库、推送、标签、Release 或部署，也没有填写未知比赛信息。
- 独立根目录门禁在临时干净副本中验证；该副本只有本地临时 `.git`，没有远程和提交。
- 服务端 AK 未由基准脚本读取。在线基准脚本只调用本地 FastAPI `/api`；本轮没有运行在线实测或输出 AK。

## 2. 已通过门禁

| 检查 | 环境 | 结果 |
| --- | --- | --- |
| `npm ci` | 临时干净独立副本 | 通过；安装 171 个锁定包，审计 172 个包，0 个已知漏洞 |
| `npm run licenses` | 临时干净独立副本 | 通过；171 个 npm 包、5 个 Python 直接依赖 |
| `npm run check:repository -- --require-independent-root` | 临时本地独立 Git 根 | 通过；随后检查器扩展为 25 项根目录证据，新增项均在当前布局自检通过 |
| `npm run evidence:validate-template` | 临时干净独立副本 | 通过；30 条 POI 槽位，三类各 10 条；另有 12 条边界和 12 条灰区槽位 |
| `npm run check:submission` | 临时干净独立副本 + 当前工作区复核 | 通过；当前为 27 份自动检查交付物，固定样例与基准结构通过 |
| `npm run lint` | 临时干净独立副本 | 通过 |
| `npm test` | 临时干净独立副本 | 通过；36 / 36 |
| `npm run test:e2e` | 临时干净独立副本 | 通过；桌面 Chromium + Pixel 5，2 / 2 |
| `npm run build` | 临时干净独立副本 | 通过；Vite 8.2.2，JS 326.29 kB（gzip 103.26 kB） |
| `npm run demo` 烟雾检查 | 临时干净独立副本，端口 4188 | 通过；HTTP 200、Vite root 正常；测试进程随后终止 |
| `python -m compileall -q app` | 干净副本源码、当前 Python 3.13 | 通过 |
| 后端 `unittest discover` | 干净副本源码、当前 Python 3.13 | 通过；43 / 43 |
| `docker compose config --quiet` | 临时干净独立副本 | 通过 |
| RouteMatrix 模拟基准 | 当前工作区 | 通过；5 轮 × 4 场景，20 条原始轮次全部保留 |

门禁中的固定演示来源为 `sample-snapshot`。它验证交互和可复现性，不计入真实社区准确率。

## 3. 未通过或未执行

| 项目 | 状态 | 原因 / 下一步 |
| --- | --- | --- |
| 工作区直接执行 `npm ci` | 未通过 | 两个自 2026-09-13 起运行的本项目 Node 进程占用 Rolldown 原生模块，Windows 返回 `EPERM`；为避免擅自终止用户服务，改在干净副本完成并通过 |
| 全新 Python venv 依赖安装 | 初始记录未完成，后续已补齐 | 2026-09-16 在 `D:\\baidumap-release-venv` 安装 `backend/requirements.txt`，编译和 43 个后端测试通过 |
| 全局 `pip check` | 未通过（非项目冲突） | 本机已有 `kokoro 0.7.16` 要求 `numpy 1.26.4`，当前为 `numpy 2.3.4`；不属于本项目五个直接依赖，但说明不能把全局环境当作干净依赖证据 |
| 前端/后端 Docker 镜像实际构建 | 未执行 | Docker Client 29.7.2 可用，但本机 Docker daemon 未运行；CI 中已有两个镜像构建任务，远程实际状态待确认 |
| Gitleaks 完整历史扫描 | 未执行 | 当前不是独立比赛仓库；必须在独立仓库历史形成后运行 CI 扫描 |
| GitHub Actions / 远程 CI | 未执行 | 尚未创建或授权远程比赛仓库，状态不得写成绿色 |
| 在线逐点 vs 批量 RouteMatrix 多轮基准 | 未执行 | 需要已授权的服务端 AK、可用配额和稳定网络；脚本已就绪且不直接读取 AK |
| 真实社区独立指标 | 不可计算 | 30 条 POI、12 条独立边界和灰区分层人工真值尚未采集 |

## 4. 需要人工完成

1. 按 `docs/repository-release.md` 在父仓库外创建独立比赛仓库，运行强制根目录检查、CI、Gitleaks 和两个 Docker 镜像构建。
2. 填写 `docs/submission-metadata.md` 的比赛平台、截止时间、仓库/Release/演示 URL、团队、最终标签/哈希与 CI 记录。
3. 按 `data/validation/README.md` 采集独立真值；严格校验后生成指标 JSON，更新真实报告，并至少展示一个真实误差案例。
4. 在授权 AK/配额下运行在线基准，保留全部成功与失败轮次，不用离线模拟替代线上结论。
5. 排练三分钟演示至少 5 次，录制主视频和备用视频，记录同一版本哈希。
6. 启动 Docker daemon 后实际构建前后端镜像，生成 SBOM 并复核基础镜像/OS 包许可。

## 5. 结论

不依赖人工真值、远程权限和比赛平台信息的五项收口工作均已形成文件、脚本或自动证据。当前可从 README 在无 AK 环境启动固定演示；但独立准确率、在线对比、远程 CI/历史扫描、Docker 实际构建和正式发布仍不能宣称完成。

## 6. 2026-09-16 后续执行记录

本轮已在父仓库外创建独立发布副本 `D:\\baidumap-release`，并通过：

- `npm ci`：安装 171 个锁定包，审计 172 个包，0 个已知漏洞。
- `npm run check:repository -- --require-independent-root`：通过，Git 根目录为独立副本。
- `npm run lint`：通过。
- `npm test`：通过，36 / 36。
- `npm run test:e2e`：通过，桌面 Chromium + 移动视口 2 / 2。
- `npm run build`：通过，Vite 8.2.2。
- `python -m compileall -q app`：通过。
- 后端 `unittest discover`：通过，43 / 43。
- 全新临时 Python venv：已安装 `backend/requirements.txt`，随后编译和 43 / 43 后端测试通过。
- `npm run check:submission`：通过。
- `npm run evidence:validate-template`：通过。
- `npm run demo`：成功启动固定样例服务，确认无 AK、无后端模式；随后已停止演示进程。

独立副本已形成本地提交（`chore: prepare competition release`，提交哈希以独立仓库 `git log -1` 为准），当前没有远程仓库或远程提交。

以下事项仍未完成：Docker daemon 未运行，Docker 镜像和 SBOM 未生成；本机未安装 Gitleaks，远程 CI 尚未创建；真实人工核验数据、在线 AK 基准、提交元数据和演示录像仍待外部权限或人工完成。

## 7. P5 情景规划执行记录

本轮已实现并验证 `planning-scenario-v1`：

- P5.1：依据灰区面积、人口代理值和缺失类别生成确定性优先级。
- P5.2：输出候选设施类别/灰区位置，并估算覆盖网格改善上限。
- P5.3：输出规划前后覆盖指标和分数情景对比。
- P5.4：已增加确定性模板化报告摘要，覆盖结论、主要短板、下一步建议和证据边界；不使用 LLM 决定评分或选址。

P5 结果明确标记为 `scenario`。估算不包含道路、用地、入口、服务半径和真实步行阻隔，也没有经过独立人工真值复核；因此不能当作正式选址或真实新增设施后的改善率。

P5 变更后的本地验证结果：`npm test` 36/36、`npm run lint`、`npm run build` 和桌面/移动端 E2E 2/2 均通过。
