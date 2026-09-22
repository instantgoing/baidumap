'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DesktopConfigStore } = require('../runtime/config-store.cjs')

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
    decryptString: (value) => [...value.toString('utf8')].reverse().join(''),
  }
}

test('stores the service AK encrypted and preserves it when the edit field is blank', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'baidumap-desktop-config-'))
  const filePath = path.join(directory, 'config.json')
  const store = new DesktopConfigStore({ filePath, safeStorage: fakeSafeStorage() })

  store.save({ browserAk: 'browserAk_123456', serviceAk: 'serviceAk_123456' })
  const persisted = fs.readFileSync(filePath, 'utf8')
  assert.doesNotMatch(persisted, /serviceAk_123456/)
  assert.deepEqual(store.getRuntimeConfig(), {
    browserAk: 'browserAk_123456',
    serviceAk: 'serviceAk_123456',
  })

  store.save({ browserAk: 'browserAk_654321', serviceAk: '' })
  assert.deepEqual(store.getRuntimeConfig(), {
    browserAk: 'browserAk_654321',
    serviceAk: 'serviceAk_123456',
  })
})

