'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
])

function allowedHost(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().split(':')[0]
  return host === 'localhost' || host === '127.0.0.1'
}

function safeStaticPath(rootDir, requestPath) {
  let decoded
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  const normalized = decoded.replace(/^\/+/, '')
  const candidate = path.resolve(rootDir, normalized || 'index.html')
  const root = path.resolve(rootDir)
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null
  return candidate
}

class LocalAppServer {
  constructor({ rootDir, backendOrigin, logger = () => {} }) {
    this.rootDir = path.resolve(rootDir)
    this.backendOrigin = backendOrigin
    this.logger = logger
    this.server = null
  }

  async start({ host = '127.0.0.1', port = 4173 } = {}) {
    if (this.server) return this.address()
    if (!fs.existsSync(path.join(this.rootDir, 'index.html'))) {
      throw new Error(`未找到前端构建产物：${this.rootDir}`)
    }

    this.server = http.createServer((request, response) => this.handle(request, response))
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server = null
        reject(error.code === 'EADDRINUSE'
          ? new Error(`本地端口 ${port} 已被占用，请关闭占用该端口的程序后重试`)
          : error)
      }
      this.server.once('error', onError)
      this.server.listen(port, host, () => {
        this.server.off('error', onError)
        resolve()
      })
    })
    return this.address()
  }

  address() {
    const address = this.server?.address()
    return typeof address === 'object' && address ? address : null
  }

  handle(request, response) {
    if (!allowedHost(request.headers.host)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Forbidden')
      return
    }

    const requestUrl = new URL(request.url || '/', 'http://localhost')
    if (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) {
      this.proxyApi(request, response)
      return
    }
    this.serveStatic(request, response, requestUrl.pathname)
  }

  proxyApi(request, response) {
    const origin = typeof this.backendOrigin === 'function' ? this.backendOrigin() : this.backendOrigin
    if (!origin) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '本地后端尚未启动', error: { kind: 'desktop_backend_unavailable' } }))
      return
    }

    const target = new URL(request.url || '/api', origin)
    const headers = { ...request.headers, host: target.host }
    delete headers.connection
    delete headers['proxy-connection']

    const upstream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers,
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers }
      delete responseHeaders.connection
      delete responseHeaders['transfer-encoding']
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders)
      upstreamResponse.pipe(response)
    })

    upstream.setTimeout(190000, () => upstream.destroy(new Error('本地后端请求超时')))
    upstream.on('error', (error) => {
      this.logger('error', `API proxy failure: ${error.message}`)
      if (!response.headersSent) {
        response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
      }
      response.end(JSON.stringify({ ok: false, message: '无法连接本地后端', error: { kind: 'desktop_proxy_error' } }))
    })
    request.pipe(upstream)
  }

  serveStatic(request, response, pathname) {
    let candidate = safeStaticPath(this.rootDir, pathname)
    if (!candidate) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Bad request')
      return
    }

    let stat
    try {
      stat = fs.statSync(candidate)
      if (stat.isDirectory()) {
        candidate = path.join(candidate, 'index.html')
        stat = fs.statSync(candidate)
      }
    } catch {
      const acceptsHtml = String(request.headers.accept || '').includes('text/html')
      if (path.extname(pathname) || !acceptsHtml) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      candidate = path.join(this.rootDir, 'index.html')
      stat = fs.statSync(candidate)
    }

    if (!stat.isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }

    const extension = path.extname(candidate).toLowerCase()
    const headers = {
      'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    }
    response.writeHead(200, headers)
    if (request.method === 'HEAD') response.end()
    else fs.createReadStream(candidate).pipe(response)
  }

  async close() {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise((resolve) => server.close(() => resolve()))
  }
}

module.exports = { LocalAppServer, allowedHost, safeStaticPath }

