const SDK_VERSION = '4.0'
const LOADER_STATE_KEY = '__baiduMapJsApiLoaderState'

let loaderPromise

function authenticatedApi() {
  const state = globalThis[LOADER_STATE_KEY]
  const api = state?.api
  return state?.status === 'authenticated'
    && state.version === SDK_VERSION
    && typeof api?.Map === 'function'
    ? api
    : null
}

function authorizationError(result) {
  const code = Number(result?.error)
  const hints = {
    101: '当前 AK 不支持 JavaScript API 服务',
    200: 'AK 无效或对应应用不存在',
    203: 'AK 不是浏览器端应用类型',
    220: '当前页面域名不在 AK 的 Referer 白名单中',
    240: '当前 AK 对应的应用已被禁用',
    260: '当前 AK 未开通 JavaScript API 服务',
    302: '当前 AK 的日配额已用完',
    401: '当前 AK 的并发配额已超限',
  }
  const detail = String(result?.error_msg || hints[code] || '请检查浏览器端 AK、Referer 白名单和服务权限').trim()
  const codeText = Number.isFinite(code) ? `（错误码 ${code}）` : ''
  return `百度地图 JSAPI 4.0 鉴权失败${codeText}：${detail}`
}

export function loadBaiduMap(browserAk) {
  const readyApi = authenticatedApi()
  if (readyApi) return Promise.resolve(readyApi)
  if (!browserAk) return Promise.reject(new Error('未配置 VITE_BAIDU_BROWSER_AK'))
  if (loaderPromise) return loaderPromise

  loaderPromise = new Promise((resolve, reject) => {
    const callbackName = `__baiduMapReady_${Date.now()}_${Math.random().toString(16).slice(2)}`
    let settled = false
    let poll
    let verificationApi
    let originalVerificationCallback
    let verificationCallback

    const cleanup = () => {
      globalThis.clearTimeout(timeout)
      globalThis.clearInterval(poll)
      if (verificationApi?.bmapVerifyCbk === verificationCallback) {
        verificationApi.bmapVerifyCbk = originalVerificationCallback
      }
      try { delete globalThis[callbackName] } catch { globalThis[callbackName] = undefined }
    }
    const succeed = (api) => {
      if (settled || typeof api?.Map !== 'function') return
      settled = true
      globalThis[LOADER_STATE_KEY] = { status: 'authenticated', version: SDK_VERSION, api }
      cleanup()
      resolve(api)
    }
    const fail = (message) => {
      if (settled) return
      settled = true
      globalThis[LOADER_STATE_KEY] = { status: 'failed', version: SDK_VERSION, message }
      cleanup()
      reject(new Error(message))
    }
    const attachVerificationCallback = () => {
      const api = globalThis.BMapGL
      if (settled || verificationCallback || typeof api?.Map !== 'function' || typeof api?.bmapVerifyCbk !== 'function') return

      verificationApi = api
      originalVerificationCallback = api.bmapVerifyCbk
      verificationCallback = (result) => {
        if (Number(result?.error) !== 0) {
          // Do not call the SDK's failure branch: it clears BMapGL's internal
          // state before later map calls can stop, which causes coordType errors.
          fail(authorizationError(result))
          return
        }
        try {
          originalVerificationCallback.call(api, result)
        } catch (error) {
          fail(`百度地图 JSAPI 4.0 鉴权回调异常：${error?.message || '未知错误'}`)
          return
        }
        succeed(api)
      }
      api.bmapVerifyCbk = verificationCallback
    }
    const timeout = globalThis.setTimeout(
      () => fail('百度地图 JSAPI 4.0 鉴权超时，请检查浏览器端 AK、Referer 白名单和网络连接'),
      15000,
    )

    globalThis[callbackName] = () => {
      // apiLoad only means the SDK code is present. Authorization completes
      // later through bmapVerifyCbk, so Map must not be exposed before then.
      attachVerificationCallback()
      if (!verificationCallback && !poll) poll = globalThis.setInterval(attachVerificationCallback, 50)
    }
    const script = document.createElement('script')
    script.dataset.baiduMapSdk = 'true'
    script.dataset.baiduMapSdkVersion = SDK_VERSION
    script.src = `https://api.map.baidu.com/api?v=${SDK_VERSION}&ak=${encodeURIComponent(browserAk)}&callback=${encodeURIComponent(callbackName)}`
    script.addEventListener('load', () => {
      // This is the small bootstrap script; the SDK and its verify callback may
      // be attached shortly afterwards by the getscript request.
      attachVerificationCallback()
      if (!verificationCallback && !poll) poll = globalThis.setInterval(attachVerificationCallback, 50)
    }, { once: true })
    script.addEventListener('error', () => fail('百度地图 JavaScript API 4.0 加载失败，请检查网络连接'), { once: true })
    document.body.appendChild(script)
  })
  return loaderPromise
}
