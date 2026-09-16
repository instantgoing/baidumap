import assert from 'node:assert/strict'
import test from 'node:test'

const LOADER_STATE_KEY = '__baiduMapJsApiLoaderState'

function installFakeDocument(verificationResult) {
  let appendedScript
  let originalCallbackCalls = 0
  const document = {
    createElement() {
      const listeners = {}
      return {
        dataset: {},
        addEventListener(type, callback) { listeners[type] = callback },
        dispatch(type) { listeners[type]?.() },
      }
    },
    body: {
      appendChild(script) {
        appendedScript = script
        const callbackName = new URL(script.src).searchParams.get('callback')
        globalThis.BMapGL = {
          Map() {},
          bmapVerifyCbk() { originalCallbackCalls += 1 },
        }
        globalThis[callbackName]()
        globalThis.BMapGL.bmapVerifyCbk(verificationResult)
      },
    },
  }
  return {
    document,
    getAppendedScript: () => appendedScript,
    getOriginalCallbackCalls: () => originalCallbackCalls,
  }
}

function resetGlobals(originalDocument) {
  if (originalDocument === undefined) delete globalThis.document
  else globalThis.document = originalDocument
  delete globalThis.BMapGL
  delete globalThis.BMap
  delete globalThis[LOADER_STATE_KEY]
}

test('loads JSAPI 4.0 and resolves only after authorization succeeds', async () => {
  const originalDocument = globalThis.document
  const fake = installFakeDocument({ error: 0, error_msg: '', popup: 0 })
  globalThis.document = fake.document
  try {
    const { loadBaiduMap } = await import(`../src/map/loadBaiduMap.js?success=${Date.now()}`)
    const api = await loadBaiduMap('browser-ak')
    const script = fake.getAppendedScript()
    assert.equal(api, globalThis.BMapGL)
    assert.equal(script.dataset.baiduMapSdkVersion, '4.0')
    assert.equal(new URL(script.src).searchParams.get('v'), '4.0')
    assert.equal(fake.getOriginalCallbackCalls(), 1)
  } finally {
    resetGlobals(originalDocument)
  }
})

test('rejects authorization errors without running the SDK state-clearing failure callback', async () => {
  const originalDocument = globalThis.document
  const fake = installFakeDocument({ error: 220, error_msg: 'APP Referer校验失败', popup: 0 })
  globalThis.document = fake.document
  try {
    const { loadBaiduMap } = await import(`../src/map/loadBaiduMap.js?failure=${Date.now()}`)
    await assert.rejects(
      () => loadBaiduMap('browser-ak'),
      (error) => {
        assert.match(error.message, /JSAPI 4\.0 鉴权失败/)
        assert.match(error.message, /错误码 220/)
        assert.match(error.message, /Referer/)
        return true
      },
    )
    assert.equal(fake.getOriginalCallbackCalls(), 0)
    assert.equal(typeof globalThis.BMapGL.Map, 'function')
  } finally {
    resetGlobals(originalDocument)
  }
})
