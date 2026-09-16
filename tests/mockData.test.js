import assert from 'node:assert/strict'
import test from 'node:test'
import { createMockApiClient } from '../src/api/mockData.js'

test('mock health returns success', async () => {
  const client = createMockApiClient()
  const result = await client.health()

  assert.equal(result.ok, true)
  assert.equal(result.data.status, 'ok')
})

test('mock geocode returns location', async () => {
  const client = createMockApiClient()
  const result = await client.geocode({
    address: '中关村',
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.address, '中关村')
  assert.equal(result.data.location.lng, 116.3074)
})

test('mock route matrix returns destinations', async () => {
  const client = createMockApiClient()
  const result = await client.routeMatrix({
    origin: { lng: 116.3, lat: 40.0 },
    destinations: [{ lng: 116.31, lat: 40.01 }],
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.destinations.length, 1)
})

test('mock analysis provides a complete stage 4 demonstration snapshot', async () => {
  const client = createMockApiClient()
  const result = await client.analyzePois({ center: { lng: 116.3, lat: 40 } })

  assert.ok(result.data.pois.length >= 8)
  assert.ok(result.data.blindSpots.zones.length >= 1)
  assert.equal(Object.keys(result.data.quality.categoryCounts).length, 8)
  assert.equal(result.meta.source, 'sample-snapshot')
})
