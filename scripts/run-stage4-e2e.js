import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
const playwrightCli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
const serverUrl = 'http://127.0.0.1:4174'

function start(command, args, options = {}) {
  return spawn(command, args, { cwd: root, windowsHide: true, ...options })
}

async function waitForServer(server, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite exited before E2E startup with code ${server.exitCode}`)
    try {
      const response = await fetch(serverUrl)
      if (response.ok) return
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out waiting for ${serverUrl}`)
}

async function stopServer(server) {
  if (server.exitCode !== null) return
  const exited = new Promise((resolve) => server.once('exit', resolve))
  server.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
  if (server.exitCode === null) server.kill('SIGKILL')
}

const server = start(process.execPath, [viteCli, '--mode', 'e2e', '--host', '127.0.0.1', '--port', '4174'], { stdio: 'ignore' })
let exitCode
try {
  await waitForServer(server)
  const tests = start(process.execPath, [playwrightCli, 'test'], { stdio: 'inherit' })
  exitCode = await new Promise((resolve) => tests.once('exit', (code) => resolve(code ?? 1)))
} finally {
  await stopServer(server)
}
process.exitCode = exitCode
