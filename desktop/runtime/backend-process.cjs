'use strict'

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')
const { redactText } = require('./ak.cjs')

function reservePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

function requestJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Accept: 'application/json' } }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if ((response.statusCode || 500) >= 400) throw new Error(payload?.message || `HTTP ${response.statusCode}`)
          resolve(payload)
        } catch (error) {
          reject(error)
        }
      })
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('请求超时')))
    request.on('error', reject)
  })
}

async function waitForHealth(origin, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`本地后端意外退出（代码 ${child.exitCode}）`)
    try {
      return await requestJson(`${origin}/api/health`, 1200)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  throw new Error(`本地后端启动超时：${lastError?.message || '未知错误'}`)
}

class BackendProcess {
  constructor({ executablePath, logger = () => {}, spawnImpl = spawn }) {
    this.executablePath = executablePath
    this.logger = logger
    this.spawnImpl = spawnImpl
    this.child = null
    this.origin = ''
    this.serviceAk = ''
    this.stopping = false
  }

  async start(serviceAk) {
    await this.stop()
    if (!fs.existsSync(this.executablePath)) {
      throw new Error(`未找到桌面后端程序：${this.executablePath}`)
    }

    const port = await reservePort()
    this.origin = `http://127.0.0.1:${port}`
    this.serviceAk = serviceAk
    this.stopping = false
    this.child = this.spawnImpl(this.executablePath, ['--host', '127.0.0.1', '--port', String(port)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BAIDU_SERVICE_AK: serviceAk,
        CORS_ALLOW_ORIGINS: 'http://localhost:4173',
        PYTHONUTF8: '1',
      },
    })

    const logStream = (level) => (chunk) => {
      const message = redactText(chunk.toString('utf8').trim(), [this.serviceAk])
      if (message) this.logger(level, message)
    }
    this.child.stdout?.on('data', logStream('info'))
    this.child.stderr?.on('data', logStream('info'))
    this.child.once('exit', (code, signal) => {
      if (!this.stopping) this.logger('error', `Desktop backend exited unexpectedly: code=${code} signal=${signal || ''}`)
    })

    try {
      await waitForHealth(this.origin, this.child)
    } catch (error) {
      await this.stop()
      throw error
    }
    return this.origin
  }

  async verify() {
    if (!this.origin) throw new Error('本地后端尚未启动')
    return requestJson(`${this.origin}/api/health?verify=true`, 20000)
  }

  async stop() {
    const child = this.child
    this.child = null
    this.origin = ''
    if (!child || child.exitCode !== null) return
    this.stopping = true
    child.kill()
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
    this.stopping = false
  }
}

module.exports = { BackendProcess, requestJson, reservePort, waitForHealth }

