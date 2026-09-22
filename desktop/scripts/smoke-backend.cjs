'use strict'

const path = require('node:path')
const { BackendProcess } = require('../runtime/backend-process.cjs')

async function main() {
  const executablePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'out', 'backend', 'baidumap-backend', 'baidumap-backend.exe'))
  const backend = new BackendProcess({ executablePath })
  try {
    await backend.start('desktopSmokeServiceAk_123456')
    const response = await fetch(`${backend.origin}/api/health`).then((item) => item.json())
    if (response?.ok !== true || response?.data?.baiduConfigured !== true) {
      throw new Error('Packaged backend returned an unexpected health response')
    }
    process.stdout.write('Packaged backend smoke test passed\n')
  } finally {
    await backend.stop()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})

