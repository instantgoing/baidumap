'use strict'

const bridge = window.desktopBridge
const form = document.querySelector('#config-form')
const browserInput = document.querySelector('#browser-ak')
const serviceInput = document.querySelector('#service-ak')
const browserCurrent = document.querySelector('#browser-current')
const serviceCurrent = document.querySelector('#service-current')
const statusBox = document.querySelector('#status')
const startupNotice = document.querySelector('#startup-notice')
const submitButton = document.querySelector('#submit')
const continueButton = document.querySelector('#continue')
const toggleServiceButton = document.querySelector('#toggle-service')

function setStatus(kind, message) {
  statusBox.hidden = false
  statusBox.className = `status status--${kind}`
  statusBox.textContent = message
}

function setBusy(busy) {
  submitButton.disabled = busy
  continueButton.disabled = busy
  browserInput.disabled = busy
  serviceInput.disabled = busy
}

async function openApp() {
  setBusy(true)
  setStatus('working', '正在打开应用…')
  try {
    await bridge.openApp()
  } catch (error) {
    setBusy(false)
    setStatus('error', error?.message || '无法打开应用')
  }
}

async function loadConfig() {
  try {
    const summary = await bridge.getConfig()
    browserInput.value = summary.browserAk || ''
    browserCurrent.textContent = summary.browserAkMasked ? `当前：${summary.browserAkMasked}` : '尚未保存浏览器端 AK'
    serviceCurrent.textContent = summary.hasServiceAk ? '已安全保存服务端 AK；留空表示继续使用' : '尚未保存服务端 AK'
    serviceInput.required = !summary.hasServiceAk
    if (summary.startupMessage) {
      startupNotice.hidden = false
      startupNotice.textContent = summary.startupMessage
    }
  } catch (error) {
    setStatus('error', error?.message || '读取配置失败')
  }
}

toggleServiceButton.addEventListener('click', () => {
  const reveal = serviceInput.type === 'password'
  serviceInput.type = reveal ? 'text' : 'password'
  toggleServiceButton.textContent = reveal ? '隐藏' : '显示'
})

continueButton.addEventListener('click', openApp)

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  continueButton.hidden = true
  setBusy(true)
  setStatus('working', '正在保存配置、启动本地后端并验证服务端 AK…')
  try {
    const result = await bridge.saveAndTest({
      browserAk: browserInput.value,
      serviceAk: serviceInput.value,
    })
    const health = result.health || {}
    if (health.baiduReachable === true) {
      setStatus('success', `${health.message}。浏览器端 AK 将在地图加载时继续验证。`)
      await openApp()
      return
    }
    setBusy(false)
    setStatus('warning', `${health.message || '服务端 AK 实时验证未通过'}。请检查 AK、服务权限和公网 IP 白名单；也可以先进入应用查看详细错误。`)
    continueButton.hidden = false
  } catch (error) {
    setBusy(false)
    setStatus('error', error?.message || '配置或验证失败')
  }
})

loadConfig()

