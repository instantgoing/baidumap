'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { LocalAppServer } = require('../runtime/static-server.cjs')

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
  })
}

test('serves static files, supports SPA fallback, validates Host, and proxies API calls', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baidumap-desktop-web-'))
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>desktop app</h1>')

  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve))
  const backendPort = backend.address().port

  const server = new LocalAppServer({ rootDir: root, backendOrigin: `http://127.0.0.1:${backendPort}` })
  await server.start({ port: 0 })
  const port = server.address().port
  t.after(async () => {
    await server.close()
    await new Promise((resolve) => backend.close(resolve))
  })

  assert.equal((await request(port, '/')).status, 200)
  assert.match((await request(port, '/analysis', { Accept: 'text/html' })).body, /desktop app/)
  assert.deepEqual(JSON.parse((await request(port, '/api/health?verify=true')).body), { ok: true, path: '/api/health?verify=true' })

  const forbidden = await request(port, '/', { Host: `evil.example:${port}` })
  assert.equal(forbidden.status, 403)
})

