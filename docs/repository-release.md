# 独立比赛仓库发布基线

检查日期：2026-09-14
源目录：`D:\cursor的项目\baidumap`
当前只读结论：源目录位于多项目父仓库 `D:\cursor的项目` 中，且父仓库包含大量与本项目无关的改动。因此不得把父仓库直接作为比赛仓库发布。

## 1. 独立仓库根目录清单

发布后的仓库根目录必须直接包含：

- `README.md`、`LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`；
- `Dockerfile`、`docker-compose.yml`、`.dockerignore`；
- `.env.example`、`backend/.env.example`，但不得包含任何真实 `.env`；
- `package.json`、`package-lock.json`、前端 `src/` 与 `tests/`；
- 后端 `backend/app/`、`backend/tests/`、`backend/Dockerfile`；
- `.github/workflows/ci.yml`；
- `docs/`、`e2e/` 与 `scripts/`。

运行 `npm run check:repository` 可检查文件布局并报告 Git 根目录；在独立副本中使用 `npm run check:repository -- --require-independent-root` 将根目录不匹配视为失败。

## 2. 安全发布步骤

1. 保留当前父仓库原状，在父仓库之外建立一个全新的空目录；只复制本 `baidumap` 目录的内容，不复制父仓库 `.git`、其他项目、`.env`、缓存或构建产物。
2. 在副本中先运行 `npm run check:repository -- --require-independent-root`。若副本尚未初始化 Git，此命令会提示未检测到仓库；初始化后必须显示 Git 根与当前目录一致。
3. 仅在副本中执行 `git init`、添加独立远程和创建提交。创建远程仓库、推送、打标签、创建 Release 均需发布者明确授权，本项目脚本不会自动执行。
4. 依次运行 README 中的完整门禁；使用 Gitleaks 扫描独立仓库的完整历史。不要根据当前父仓库的 CI 或历史推断比赛仓库状态。
5. 在一台没有项目缓存、没有 AK 的干净环境按 `npm ci && npm run demo` 验证固定演示，然后填写 `docs/submission-metadata.md`。
6. CI、容器构建、密钥扫描和干净环境运行均真实通过后，才填写状态、提交哈希、URL 和最终版本标签。

## 3. 发布前禁止项

- 不从父仓库执行 `git add .`、提交、推送、重置、清理或改写历史。
- 不把 `BAIDU_SERVICE_AK` 放入任何 `VITE_` 变量、Docker 前端构建参数、日志、报告或样例。
- 不提交 `.env`、测试报告、Playwright 产物、`node_modules` 或 `dist`。
- 不把固定快照描述为刚刚在线计算的真实数据。
- 不填写未经核实的比赛平台、截止时间、URL、团队信息、CI 状态或发布状态。

## 4. 需要人工完成

- 新建独立远程仓库并决定可见性与组织归属；
- 配置分支保护、仓库描述、开源许可证识别和比赛平台字段；
- 确认 GitHub Actions 实际执行成功并保存 URL/截图；
- 生成正式 SBOM，复核容器基础镜像和 OS 包许可；
- 填写 `docs/submission-metadata.md` 中所有“待填写”项。
