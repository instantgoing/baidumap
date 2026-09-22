'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { maskAk, normalizeAk } = require('./ak.cjs')

class DesktopConfigStore {
  constructor({ filePath, safeStorage }) {
    this.filePath = filePath
    this.safeStorage = safeStorage
  }

  readRaw() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      return parsed && parsed.version === 1 ? parsed : {}
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw new Error(`无法读取桌面配置：${error.message}`)
    }
  }

  getSummary() {
    const raw = this.readRaw()
    return {
      browserAk: raw.browserAk || '',
      browserAkMasked: maskAk(raw.browserAk),
      hasServiceAk: Boolean(raw.serviceAkEncrypted),
      configured: Boolean(raw.browserAk && raw.serviceAkEncrypted),
    }
  }

  getRuntimeConfig() {
    const raw = this.readRaw()
    const browserAk = raw.browserAk ? normalizeAk(raw.browserAk, '浏览器端 AK') : ''
    let serviceAk = ''

    if (raw.serviceAkEncrypted) {
      if (!this.safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows 安全存储当前不可用，无法读取服务端 AK')
      }
      try {
        serviceAk = this.safeStorage.decryptString(Buffer.from(raw.serviceAkEncrypted, 'base64'))
      } catch (error) {
        throw new Error(`服务端 AK 解密失败：${error.message}`)
      }
      serviceAk = normalizeAk(serviceAk, '服务端 AK')
    }

    return { browserAk, serviceAk }
  }

  save({ browserAk, serviceAk }) {
    const previous = this.readRaw()
    const normalizedBrowserAk = normalizeAk(browserAk, '浏览器端 AK')
    let serviceAkEncrypted = previous.serviceAkEncrypted || ''

    if (String(serviceAk || '').trim()) {
      if (!this.safeStorage.isEncryptionAvailable()) {
        throw new Error('Windows 安全存储当前不可用，无法安全保存服务端 AK')
      }
      const normalizedServiceAk = normalizeAk(serviceAk, '服务端 AK')
      serviceAkEncrypted = this.safeStorage.encryptString(normalizedServiceAk).toString('base64')
    }

    if (!serviceAkEncrypted) throw new Error('请填写服务端 AK')

    const next = {
      version: 1,
      browserAk: normalizedBrowserAk,
      serviceAkEncrypted,
      updatedAt: new Date().toISOString(),
    }
    const directory = path.dirname(this.filePath)
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporaryPath, this.filePath)
    return this.getSummary()
  }
}

module.exports = { DesktopConfigStore }

