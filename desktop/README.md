# 邻里半径 Windows 桌面版

桌面层不会修改 `src/` 或 `backend/app/`。它把现有 Vite 构建产物、FastAPI 后端和运行时配置包装成一个 Windows x64 安装包。

## 用户运行要求

- Windows 10/11 x64。
- 能访问百度地图开放平台。
- 一个浏览器端 AK：启用 JavaScript API 4.0，Referer 白名单允许桌面应用固定来源 `http://localhost:4173`。
- 一个服务端 AK：启用项目使用的 Web Service API，并使用 IP 校验。当前后端只发送 `ak`，不支持 SN 校验。

用户不需要安装 Node.js、Python、Docker 或 Nginx。

## 开发构建

在仓库根目录执行：

```powershell
.\desktop\build\build-windows.ps1
```

如果构建机访问 GitHub Release 较慢，可在当前 PowerShell 会话先设置 Electron 下载镜像：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
.\desktop\build\build-windows.ps1
```

脚本会：

1. 安装桌面层 Node 依赖并下载锁定版本的 Electron 运行时。
2. 按锁定版本在 `desktop/.venv` 安装后端和 PyInstaller 构建依赖。
3. 以在线模式和浏览器 AK 占位符构建现有前端。
4. 用 PyInstaller `onedir` 模式生成回环地址后端。
5. 运行桌面层单元测试。
6. 用 electron-builder/NSIS 生成安装包。
7. 对打包后的 Electron 程序执行隐藏冒烟测试，并生成 `SHA256SUMS.txt`。

安装包输出到 `desktop/release/`。

如果依赖已经就绪，可以按需跳过步骤：

```powershell
.\desktop\build\build-windows.ps1 -SkipDependencies
.\desktop\build\build-windows.ps1 -SkipDependencies -SkipFrontend
.\desktop\build\build-windows.ps1 -SkipDependencies -SkipFrontend -SkipBackend -SkipSmoke
```

## 本地调试

先构建前端和后端，再启动 Electron：

```powershell
cd desktop
npm run build:web
npm start
```

默认从 `desktop/out/backend/baidumap-backend/baidumap-backend.exe` 启动后端。也可以通过当前进程的 `BAIDUMAP_BACKEND_EXE` 环境变量指定另一个已构建的桌面后端路径。

## 密钥边界

- 浏览器端 AK 以明文保存，因为它最终必须出现在浏览器 JSAPI 请求中；桌面主进程只在请求发出前替换构建占位符。
- 服务端 AK 使用 Electron `safeStorage`，在 Windows 下由 DPAPI 加密后写入用户配置目录。
- 服务端 AK 只通过子进程环境变量传给 FastAPI，不进入参数、前端包或日志。
- `.env`、`.env.local` 和 `backend/.env` 不会进入安装包。
