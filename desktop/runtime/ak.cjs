'use strict'

const { BROWSER_AK_PLACEHOLDER } = require('./constants.cjs')

const AK_PATTERN = /^[A-Za-z0-9._~-]{8,256}$/

function normalizeAk(value, label = 'AK') {
  const normalized = String(value || '').trim()
  if (!AK_PATTERN.test(normalized)) {
    throw new Error(`${label} 格式不正确：请输入 8 至 256 位字母、数字或 . _ ~ -`)
  }
  return normalized
}

function maskAk(value) {
  const normalized = String(value || '').trim()
  if (!normalized) return ''
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}••••${normalized.slice(-2)}`
  return `${normalized.slice(0, 4)}••••••${normalized.slice(-4)}`
}

function rewriteBaiduMapUrl(rawUrl, browserAk) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.map.baidu.com') return null
  if (parsed.searchParams.get('ak') !== BROWSER_AK_PLACEHOLDER) return null

  parsed.searchParams.set('ak', normalizeAk(browserAk, '浏览器端 AK'))
  return parsed.toString()
}

function redactText(value, secrets = []) {
  let text = String(value || '')
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[REDACTED]')
  }
  return text.replace(/([?&](?:ak|key)=)[^&\s]+/gi, '$1[REDACTED]')
}

module.exports = { normalizeAk, maskAk, rewriteBaiduMapUrl, redactText }

