# 发布收口执行开发者提示词

下面的内容可以直接交给后续开发者或 Codex，作为本项目完成剩余工作的执行提示词。

---

## 可直接使用的开发者提示词

你正在继续开发“邻里半径 · 15 分钟生活圈”项目。项目目录为：

```text
D:\\cursor的项目\\baidumap
```

当前版本为 `0.6.0-stage6`。核心功能 P1–P4、P6、P7 已基本完成，你的任务不是重新设计核心产品，而是完成发布前收口、补齐真实证据、验证独立发布环境，并如实记录仍然存在的限制。

### 一、必须先阅读的文件

开始任何修改前，先阅读：

1. `README.md`
2. `docs/unfinished-tasks.md`
3. `docs/acceptance-competition-final.md`
4. `docs/repository-release.md`
5. `docs/submission-checklist.md`
6. `docs/submission-metadata.md`
7. `docs/real-community-report.md`
8. `docs/engineering-evidence.md`
9. `data/validation/README.md`

以 `docs/unfinished-tasks.md` 作为当前任务清单，以实际命令输出作为完成依据。不要把旧版 `开发提示词.md` 中仍为 `[ ]` 的历史任务直接当作当前真实状态。

### 二、不可违反的工作规则

1. 不要在 `D:\\cursor的项目` 这个多项目父仓库中执行无范围的 `git add .`、提交、推送、重置、清理或历史改写。
2. 不要执行 `git reset --hard`、`git checkout --`、递归删除或其他不可恢复操作。
3. 不要读取、打印、提交或写入任何真实 AK、密码、个人隐私或未授权第三方数据。
4. `BAIDU_SERVICE_AK` 只能存在于后端运行环境，不得写入 `VITE_` 变量、前端构建参数、日志、报告、样例数据或 Git 历史。
5. 不要伪造 POI 真值、人工步行耗时、灰区标签、准确率、召回率、在线性能或 CI 结果。
6. 百度 Place Search 的结果不能单独作为独立人工真值。
7. 离线模拟数据只能证明程序行为，不能被描述为百度线上性能或真实社区准确率。
8. 未获得用户明确授权时，不要创建远程仓库、推送代码、创建 Release、发布演示地址、联系第三方或使用真实 AK。
9. 发现需要用户、团队、比赛平台、远程权限、AK、实地核验或外部人工确认时，停止该分支并清楚记录阻塞原因，不要猜测或用假数据替代。
10. 每完成一个阶段，都要更新任务状态、保留命令输出或文件证据，并说明哪些内容仍然没有完成。

### 三、执行目标

按以下顺序完成工作：

```text
独立发布副本
→ 干净环境依赖与自动化门禁
→ Docker / SBOM
→ 远程 CI / Gitleaks
→ 独立人工核验数据
→ 在线 RouteMatrix 基准
→ 提交元数据
→ 演示排练与最终交付
```

P5 规划功能不是本轮发布收口的前置条件。除非核心发布门禁和真实证据已经完成，否则不要优先开发 P5。

### 四、阶段 0：建立安全工作边界

先执行只读检查：

```powershell
git rev-parse --show-toplevel
git status --short -- .
git log -5 --oneline -- .
```

如果 Git 根目录不是当前 `baidumap` 目录，不要在父仓库中提交。根据 `docs/repository-release.md` 创建一个父仓库之外的独立副本。

独立副本不得包含：

- 父仓库 `.git`
- 其他项目目录
- `.env`、`.env.local`、`backend/.env`
- `node_modules`
- `dist`
- `test-results`
- 任何真实密钥和本地日志

在独立副本中初始化 Git 后，先运行：

```powershell
npm run check:repository -- --require-independent-root
```

若失败，先修复仓库边界，不要继续进行正式发布操作。

### 五、阶段 1：干净环境验证

在独立副本或临时干净环境中运行：

```powershell
npm ci
npm run lint
npm test
npm run test:e2e
npm run build
npm run check:submission
npm run evidence:validate-template
docker compose config --quiet
```

后端运行：

```powershell
cd backend
python -m pip install -r requirements.txt
python -m compileall -q app
python -m unittest discover -s tests -p "test_*.py"
cd ..
```

固定演示运行：

```powershell
npm run demo
```

验收标准：

- 前端测试全部通过。
- 后端测试全部通过。
- lint、build、E2E 全部通过。
- 固定演示可以在无 AK、无后端、无外网条件下启动。
- `check:repository -- --require-independent-root` 通过。
- `check:submission` 通过。
- 记录 Node、npm、Python、Docker 和 Playwright 版本。

如果当前工作区因 `node_modules` 不完整而失败，不要直接修改源码掩盖问题。优先在干净副本重新安装依赖，并分别记录“当前工作区失败”和“干净副本结果”。

### 六、阶段 2：Docker、许可证和 SBOM

在 Docker daemon 可用后：

1. 构建前端镜像。
2. 构建后端镜像。
3. 启动 Compose，确认前端页面和 `/api/health` 可用。
4. 确认服务端 AK 没有进入前端镜像层、构建日志或页面资源。
5. 生成 SBOM。
6. 复核基础镜像和 OS 包许可证。
7. 保存构建日志、镜像标签、SBOM 和复核结论。

不要因为 Docker daemon 不可用就把“Compose 配置通过”写成“镜像构建通过”。

### 七、阶段 3：远程 CI 和历史密钥扫描

只有在用户授权并准备好独立远程仓库后，才能执行远程发布。

远程 CI 必须覆盖：

- Node 依赖安装、lint、单元测试、E2E、构建。
- Python 依赖安装、编译和后端测试。
- 前端和后端 Docker 镜像构建。
- 完整 Git 历史 Gitleaks 扫描。

所有 CI 任务通过后，记录：

- 远程仓库 URL。
- CI 运行 URL。
- Gitleaks 运行结果。
- Docker 构建结果。
- 最终提交哈希和版本标签。

如果远程仓库尚未建立或没有权限，状态写为“未执行”，不要写为“通过”。

### 八、阶段 4：补齐独立人工核验数据

数据目录为：

```text
data/validation/candidates/2026-09-15-malianwa-v1/
```

目标是完成：

- 30 条 POI 独立核验：菜市场、药店、小学各至少 5 条。
- 12 条独立边界耗时核验。
- 12 条灰区分层核验：灰区内部、灰区边缘、非灰区对照。

每条记录必须保留来源、日期、核验角色、坐标、限制说明和必要的人工记录编号。不得把私人电话号码写入仓库。

POI 独立来源优先级：

1. 政府公开名录。
2. 设施或机构官方页面。
3. 官方公开电话记录。
4. 实地观察记录。

不要使用同一次百度 Place Search 结果作为独立真值。

完成数据后：

```powershell
python backend/scripts/community_validation.py validate --input data/validation/candidates/2026-09-15-malianwa-v1
```

只有验证器通过后，才能：

- 将 `dataset_status` 改为 `collected`。
- 生成查全率、分类准确率、边界误差、灰区准确率和灰区召回率。
- 更新 `docs/real-community-report.md`。
- 增加至少一个真实误差案例。

如果人工核验无法完成，保留 `template` / `pending` 状态，并在报告中明确写“不可计算”。

### 九、阶段 5：在线 RouteMatrix 基准

只有在用户明确授权、服务端 AK 已配置、配额允许且网络稳定时，才能运行在线基准。

先启动已配置 AK 的 FastAPI，再运行：

```powershell
python backend/scripts/route_matrix_benchmark.py `
  --mode online `
  --runs 3 `
  --api-base-url http://127.0.0.1:8000/api `
  --output artifacts/benchmarks/route-matrix-online.json
```

必须保留：

- 逐点和批量场景。
- 全部轮次，而不是只保留最佳结果。
- 成功、失败、429、超时和重试记录。
- `source=online-live`。
- 机器环境、配置限制、QPS 和配额说明。

不得关闭限流、绕过白名单、修改配额或用离线模拟替代线上结论。

### 十、阶段 6：提交材料和演示

填写 `docs/submission-metadata.md` 中的真实信息：

- 比赛平台。
- 截止时间。
- 独立仓库 URL。
- Release URL。
- 在线演示 URL。
- 团队信息。
- 最终版本标签。
- 最终提交哈希。
- CI 运行链接或截图。
- 干净环境验收记录。
- 演示视频或 PPT。

未知信息必须保持“待填写”。

按照 `docs/demo-script.md`：

- 至少排练 5 次。
- 准备有网在线流程和无 AK 离线备用流程。
- 确认视频使用的代码版本、样例哈希和文档状态一致。
- 不把固定样例、内部复核或候选真值描述成独立真实准确率。

### 十一、什么时候可以宣称完成

只有以下条件全部满足，才能在 README、报告、提交说明或最终回复中写“正式提交完成”：

- 独立仓库检查通过。
- 干净环境前后端门禁全部通过。
- Docker 镜像实际构建通过。
- SBOM 和许可证复核完成。
- 远程 CI 全部通过。
- Gitleaks 完整历史扫描通过。
- 30 条 POI、12 条边界和 12 条灰区独立核验完成。
- 指标由原始核验数据重新计算得出。
- 在线基准产物已保存并如实记录限制。
- 提交元数据、Release、演示地址和最终哈希已填写。
- 演示视频与最终版本一致。

只完成代码测试、离线演示或模板校验时，状态应写为：

> 核心功能完成，发布收口中；正式提交尚未完成。

### 十二、每次工作结束时必须报告

用以下格式更新项目状态：

```text
本次完成：
- ...

验证结果：
- 命令：...
- 结果：通过 / 失败 / 未执行
- 证据文件：...

仍未完成：
- ...

阻塞与所需权限：
- ...

下一步：
- ...
```

不要只报告“已经完成”，必须同时说明证据、未完成项和阻塞条件。

---

## 关联文档

- [未完成任务与发布收口清单](unfinished-tasks.md)
- [独立比赛仓库发布基线](repository-release.md)
- [最终提交清单](submission-checklist.md)
- [参赛收口最终门禁记录](acceptance-competition-final.md)
- [真实社区体检报告](real-community-report.md)
- [工程优化基准与故障矩阵](engineering-evidence.md)
