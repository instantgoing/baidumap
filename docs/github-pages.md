# GitHub Pages 演示站

该站点使用同一套 React/Vite 前端：百度地图 JSAPI GL 负责真实底图与地图交互，生活圈分析、POI、灰区、规划情景和报告数据由内置 Mock 适配器提供。静态站不会请求 FastAPI，也不会包含服务端 AK。

## 首次启用

1. 在百度地图开放平台创建“浏览器端”应用，将下列 Referer 加入白名单：

   ```text
   *instantgoing.github.io*
   ```

2. 打开 GitHub 仓库的 `Settings → Secrets and variables → Actions → Variables`，新增仓库变量：

   ```text
   BAIDU_BROWSER_AK=你的浏览器端AK
   ```

3. 打开 `Settings → Pages → Build and deployment`，将 Source 设为 `GitHub Actions`。
4. 推送到 `main`，或在 Actions 页面手动运行 `Deploy demo to GitHub Pages`。

部署地址：

```text
https://instantgoing.github.io/baidumap/
```

若未配置 `BAIDU_BROWSER_AK`，部署仍会成功，但页面会使用项目自带的可交互离线底图。仓库变量在构建时会进入前端产物，这是浏览器端 JSAPI AK 的正常工作方式；请务必设置 Referer 白名单。服务端 `BAIDU_SERVICE_AK` 不得写入 GitHub Pages、仓库变量或任何 `VITE_` 变量。

## 本地检查 Pages 构建

```powershell
npm run build:pages
npm run preview -- --base /baidumap/
```

本地需要真实百度底图时，可临时设置环境变量后构建，不要把 AK 写入 `.env.pages` 或提交到 Git：

```powershell
$env:VITE_BAIDU_BROWSER_AK='你的浏览器端AK'
npm run build:pages
Remove-Item Env:VITE_BAIDU_BROWSER_AK
```
