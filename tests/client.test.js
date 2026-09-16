import assert from 'node:assert/strict'
import test from 'node:test'
import { API_PATHS, ApiError, createApiClient } from '../src/api/client.js'

function response(body, { status = 200, ok = status >= 200 && status < 300 } = {}) { return { ok, status, json: async () => body } }

test('geocode uses the shared endpoint contract and request id', async () => {
  let call
  const client = createApiClient({ baseUrl: 'http://localhost:8000/api', fetchImpl: async (...args) => { call = args; return response({ ok: true, data: { location: { lng: 1, lat: 2 } }, meta: { durationMs: 5 } }) } })
  const result = await client.geocode({ address: '中关村' })
  assert.equal(call[0], `http://localhost:8000/api${API_PATHS.geocode}`); assert.equal(call[1].method, 'POST'); assert.deepEqual(JSON.parse(call[1].body), { address: '中关村' }); assert.match(result.meta.requestId, /^[0-9a-f-]+$/)
})

test('429 responses are exposed as rate_limit errors', async () => {
  const client = createApiClient({ fetchImpl: async () => response({ message: 'QPS exceeded' }, { status: 429, ok: false }) })
  await assert.rejects(() => client.routeMatrix({ origin: { lng: 1, lat: 2 }, destinations: [] }), (error) => { assert.ok(error instanceof ApiError); assert.equal(error.kind, 'rate_limit'); assert.equal(error.status, 429); return true })
})

test('malformed success responses never become false positives', async () => {
  const client = createApiClient({ fetchImpl: async () => response({ ok: true, result: [] }) })
  await assert.rejects(() => client.health(), (error) => { assert.equal(error.kind, 'malformed_response'); return true })
})

test('health verify and complete P3 analysis use their online contracts', async () => {
  const calls = []
  const client = createApiClient({ baseUrl: '/api', fetchImpl: async (url, options) => { calls.push([url, options]); return response({ ok: true, data: {}, meta: {} }) } })
  await client.health({ verify: true })
  await client.analyzePois({ center: { lng: 116.3, lat: 40 }, areaPolygon: [{ lng: 1, lat: 1 }, { lng: 2, lat: 1 }, { lng: 2, lat: 2 }], maxPages: 8 })
  assert.equal(calls[0][0], '/api/health?verify=true')
  assert.equal(calls[1][0], `/api${API_PATHS.analyzePois}`)
  const body = JSON.parse(calls[1][1].body)
  assert.equal(body.maxPages, 8)
  assert.equal(body.areaPolygon.length, 3)
})

test('walking route uses the DirectionLite adapter contract', async () => {
  let call
  const client = createApiClient({ baseUrl: '/api', fetchImpl: async (...args) => { call = args; return response({ ok: true, data: { duration: 900, distance: 1000, path: [], steps: [] }, meta: {} }) } })
  const origin = { lng: 116.3, lat: 40 }
  const destination = { lng: 116.31, lat: 40.01 }
  await client.walkingRoute({ origin, destination })
  assert.equal(call[0], `/api${API_PATHS.walkingRoute}`)
  assert.deepEqual(JSON.parse(call[1].body), { origin, destination })
})

test('backend error kind is preserved by the browser client', async () => {
  const client = createApiClient({ fetchImpl: async () => response({ ok: false, message: '熔断中', error: { kind: 'circuit_open' }, meta: { requestId: 'server-request' } }, { status: 503, ok: false }) })
  await assert.rejects(() => client.health(), (error) => { assert.equal(error.kind, 'circuit_open'); assert.equal(error.requestId, 'server-request'); return true })
})
