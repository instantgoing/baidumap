'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { BROWSER_AK_PLACEHOLDER } = require('../runtime/constants.cjs')
const { normalizeAk, redactText, rewriteBaiduMapUrl } = require('../runtime/ak.cjs')

test('normalizes safe AK values', () => {
  assert.equal(normalizeAk('  abcDEF_123456  '), 'abcDEF_123456')
  assert.throws(() => normalizeAk('short'), /格式不正确/)
  assert.throws(() => normalizeAk('abc def 123'), /格式不正确/)
})

test('rewrites only the Baidu JSAPI placeholder URL', () => {
  const source = `https://api.map.baidu.com/api?v=4.0&ak=${BROWSER_AK_PLACEHOLDER}&callback=ready`
  const rewritten = rewriteBaiduMapUrl(source, 'realBrowserAk_123456')
  assert.equal(new URL(rewritten).searchParams.get('ak'), 'realBrowserAk_123456')
  assert.equal(rewriteBaiduMapUrl('https://example.com/api?ak=x', 'realBrowserAk_123456'), null)
  assert.equal(rewriteBaiduMapUrl('https://api.map.baidu.com/api?ak=already-set', 'realBrowserAk_123456'), null)
})

test('redacts secrets and AK query parameters from logs', () => {
  const output = redactText('failed https://x.test/?ak=secretValue serviceSecret', ['serviceSecret'])
  assert.doesNotMatch(output, /secretValue|serviceSecret/)
  assert.match(output, /REDACTED/)
})

