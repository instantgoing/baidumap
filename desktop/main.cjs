'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
} = require('electron')
const { BackendProcess } = require('./runtime/backend-process.cjs')
const { DesktopConfigStore } = require('./runtime/config-store.cjs')
const { rewriteBaiduMapUrl, redactText } = require('./runtime/ak.cjs')
const { LocalAppServer } = require('./runtime/static-server.cjs')
const {
  FRONTEND_BIND_HOST,
  FRONTEND_ORIGIN,
  FRONTEND_PORT,
} = require('./runtime/constants.cjs')

let backend
let configStore
let configWindow
let currentBrowserAk = ''
let localServer
let mainWindow
let cleanupStarted = false
let startupMessage = ''
const smokeTest = process.argv.includes('--smoke-test')

function resourcePath(...parts) {
  return app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, '..', ...parts)
}

function backendExecutablePath() {
  if (process.env.BAIDUMAP_BACKEND_EXE) return path.resolve(process.env.BAIDUMAP_BACKEND_EXE)
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend', 'baidumap-backend.exe')
    : path.join(__dirname, 'out', 'backend', 'baidumap-backend', 'baidumap-backend.exe')
}

function log(level, message) {
  const sanitized = redactText(message, [backend?.serviceAk])
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${sanitized}\n`
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), line, 'utf8')
  } catch {
    // Logging must never prevent the desktop application from starting.
  }
  if (!app.isPackaged) process.stderr.write(line)
}

function assertConfigSender(event) {
  if (!configWindow || event.sender !== configWindow.webContents) {
    throw new Error('拒绝未经授权的桌面配置请求')
  }
}

function installBaiduAkInterceptor() {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['https://api.map.baidu.com/*'] },
    (details, callback) => {
      try {
        const redirectURL = rewriteBaiduMapUrl(details.url, currentBrowserAk)
        callback(redirectURL ? { redirectURL } : {})
      } catch (error) {
        log('error', `Browser AK injection failed: ${error.message}`)
        callback({ cancel: true })
      }
    },
  )
}

function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, targetUrl) => {
    const isConfigFile = targetUrl.startsWith('file://') && window === configWindow
    if (!targetUrl.startsWith(FRONTEND_ORIGIN) && !isConfigFile) event.preventDefault()
  })
}

async function ensureBackend({ restart = false } = {}) {
  const runtime = configStore.getRuntimeConfig()
  currentBrowserAk = runtime.browserAk
  if (!runtime.serviceAk) throw new Error('尚未配置服务端 AK')
  if (restart || !backend.child || backend.child.exitCode !== null) {
    await backend.start(runtime.serviceAk)
  }
  return runtime
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    mainWindow.webContents.reloadIgnoringCache()
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#f3f6fb',
    autoHideMenuBar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  })
  secureWindow(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.loadURL(FRONTEND_ORIGIN).catch((error) => {
    log('error', `Failed to load frontend: ${error.message}`)
    dialog.showErrorBox('页面加载失败', error.message)
  })
  return mainWindow
}

function createConfigWindow() {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.show()
    configWindow.focus()
    return configWindow
  }

  configWindow = new BrowserWindow({
    width: 760,
    height: 760,
    minWidth: 680,
    minHeight: 680,
    resizable: true,
    show: false,
    backgroundColor: '#f5f7fb',
    parent: mainWindow || undefined,
    modal: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  })
  secureWindow(configWindow)
  configWindow.once('ready-to-show', () => {
    if (!smokeTest) configWindow?.show()
  })
  configWindow.on('closed', () => {
    configWindow = null
    if (!mainWindow && !cleanupStarted) app.quit()
  })
  configWindow.loadFile(path.join(__dirname, 'config', 'index.html')).catch((error) => {
    log('error', `Failed to load config window: ${error.message}`)
    dialog.showErrorBox('配置窗口加载失败', error.message)
  })
  return configWindow
}

function createApplicationMenu() {
  const template = [
    {
      label: '应用',
      submenu: [
        { label: '配置百度地图 AK…', accelerator: 'CmdOrCtrl+,', click: () => createConfigWindow() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpcHandlers() {
  ipcMain.handle('desktop:get-config', (event) => {
    assertConfigSender(event)
    return { ...configStore.getSummary(), startupMessage }
  })

  ipcMain.handle('desktop:save-and-test', async (event, input) => {
    assertConfigSender(event)
    configStore.save({
      browserAk: input?.browserAk,
      serviceAk: input?.serviceAk,
    })
    startupMessage = ''
    await ensureBackend({ restart: true })
    const health = await backend.verify()
    return {
      ok: true,
      health: {
        status: health?.data?.status || 'unknown',
        message: health?.data?.message || '后端已启动',
        baiduConfigured: Boolean(health?.data?.baiduConfigured),
        baiduReachable: health?.data?.baiduReachable ?? null,
      },
    }
  })

  ipcMain.handle('desktop:open-app', async (event) => {
    assertConfigSender(event)
    await ensureBackend()
    createMainWindow()
    configWindow?.close()
    return { ok: true }
  })
}

async function bootstrap() {
  configStore = new DesktopConfigStore({
    filePath: path.join(app.getPath('userData'), 'desktop-config.json'),
    safeStorage,
  })
  backend = new BackendProcess({ executablePath: backendExecutablePath(), logger: log })
  localServer = new LocalAppServer({
    rootDir: resourcePath('dist'),
    backendOrigin: () => backend.origin,
    logger: log,
  })

  if (app.isPackaged) localServer.rootDir = resourcePath('web')
  await localServer.start({ host: FRONTEND_BIND_HOST, port: FRONTEND_PORT })
  installBaiduAkInterceptor()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  registerIpcHandlers()
  createApplicationMenu()

  if (smokeTest) {
    const window = createConfigWindow()
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Electron smoke test timed out')), 10000)
      window.webContents.once('did-finish-load', () => {
        clearTimeout(timeout)
        resolve()
      })
      window.webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timeout)
        reject(new Error(`Electron smoke page failed: ${code} ${description}`))
      })
    })
    log('info', 'Electron smoke test passed')
    setTimeout(() => app.quit(), 100)
    return
  }

  if (!configStore.getSummary().configured) {
    createConfigWindow()
    return
  }

  try {
    await ensureBackend()
    createMainWindow()
  } catch (error) {
    startupMessage = `自动启动失败：${error.message}`
    log('error', startupMessage)
    createConfigWindow()
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const target = mainWindow || configWindow
    if (target) {
      if (target.isMinimized()) target.restore()
      target.show()
      target.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((error) => {
    log('error', `Desktop bootstrap failed: ${error.stack || error.message}`)
    dialog.showErrorBox('邻里半径启动失败', error.message)
    app.quit()
  })
}

app.on('before-quit', (event) => {
  if (cleanupStarted) return
  cleanupStarted = true
  event.preventDefault()
  Promise.allSettled([backend?.stop(), localServer?.close()]).finally(() => app.quit())
})

app.on('window-all-closed', () => app.quit())

process.on('uncaughtException', (error) => log('error', `Uncaught exception: ${error.stack || error.message}`))
process.on('unhandledRejection', (error) => log('error', `Unhandled rejection: ${error?.stack || error}`))
