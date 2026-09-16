import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const host = process.env.DEMO_HOST || '127.0.0.1'
const port = process.env.DEMO_PORT || '4173'

const demo = spawn(process.execPath, [viteCli, '--host', host, '--port', port], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    VITE_DATA_MODE: 'mock',
    VITE_API_BASE_URL: '/api',
    VITE_BAIDU_BROWSER_AK: '',
  },
})

console.log(`\n离线演示正在启动：http://${host}:${port}`)
console.log('演示进程已强制使用固定样例，不读取本地 AK；按 Ctrl+C 停止。\n')

function stop(signal) {
  if (demo.exitCode === null) demo.kill(signal)
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
demo.on('exit', (code, signal) => {
  if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
    console.error(`演示进程因信号 ${signal} 退出。`)
  }
  process.exitCode = code ?? (signal ? 0 : 1)
})
