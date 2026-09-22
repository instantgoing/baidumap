'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopBridge', Object.freeze({
  getConfig: () => ipcRenderer.invoke('desktop:get-config'),
  saveAndTest: (config) => ipcRenderer.invoke('desktop:save-and-test', config),
  openApp: () => ipcRenderer.invoke('desktop:open-app'),
}))

