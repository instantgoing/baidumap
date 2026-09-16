import assert from 'node:assert/strict'
import test from 'node:test'
import { presentApiError } from '../src/api/errorPresentation.js'

const cases = [
  ['configuration_error', '未配置服务端 AK'],
  ['upstream_auth_error', '百度服务鉴权失败'],
  ['rate_limit', '上游配额或 QPS 受限'],
  ['timeout', '在线请求超时'],
  ['upstream_error', '百度上游服务暂不可用'],
  ['circuit_open', '服务保护已启动'],
  ['empty_result', '没有可用结果'],
]

for (const [kind, title] of cases) {
  test(`page presentation keeps ${kind} as an explicit failure`, () => {
    const result = presentApiError({ kind, message: 'fixture failure', requestId: 'req-test' })
    assert.equal(result.kind, kind)
    assert.equal(result.title, title)
    assert.equal(result.requestId, 'req-test')
    assert.match(result.action, /重试|检查|等待|调整/)
    assert.doesNotMatch(result.summary, /成功|真实结果/)
  })
}
