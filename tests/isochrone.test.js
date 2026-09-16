import assert from 'node:assert/strict'
import test from 'node:test'
import { distanceMeters } from '../src/engine/geo.js'
import { calculateIsochrone, DEFAULT_ISOCHRONE_CONFIG, generatePolarCandidates, hasSelfIntersection } from '../src/engine/isochrone.js'

const center = { lng: 116.3074, lat: 40.0572 }

function bearingFrom(origin, point) {
  const east = point.lng - origin.lng
  const north = point.lat - origin.lat
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360
}

function fixtureRoute({ cost = () => 1, fail = () => false } = {}) {
  return async ({ origin, destinations }) => ({
    ok: true,
    data: {
      destinations: destinations.map((location) => {
        const distance = distanceMeters(origin, location)
        const bearing = bearingFrom(origin, location)
        if (fail(bearing, distance)) return { status: 'error', message: 'fixture route unavailable' }
        return { status: 'ok', duration: distance * cost(bearing, distance), distance }
      }),
    },
  })
}

test('polar candidates are generated in stable BD-09 direction order', () => {
  const candidates = generatePolarCandidates(center, { directions: 36, candidateDistancesMeters: [300, 600] })
  assert.equal(candidates.length, 72)
  assert.equal(candidates[0].bearing, 0)
  assert.equal(candidates[36].bearing, 180)
  assert.ok(candidates[0].point.lat > center.lat)
  assert.ok(candidates[9 * 2].point.lng > center.lng)
})

test('open circular network produces a stable high-confidence polygon', async () => {
  const result = await calculateIsochrone({ center, routeMatrix: fixtureRoute(), config: { directions: 36 } })
  assert.equal(result.algorithmVersion, DEFAULT_ISOCHRONE_CONFIG.algorithmVersion)
  assert.equal(result.confidence.level, 'high')
  assert.ok(result.geojson)
  assert.equal(result.geojson.geometry.type, 'Polygon')
  assert.equal(result.geojson.geometry.coordinates[0].length, 37)
  assert.ok(result.geojson.geometry.coordinates[0].every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)))
  assert.ok(result.boundary.every((item) => Math.abs(item.distance - 900) < 2))
  assert.equal(hasSelfIntersection(result.geojson.geometry.coordinates[0]), false)
})

test('river barrier shrinks the affected north sector', async () => {
  const result = await calculateIsochrone({ center, routeMatrix: fixtureRoute({ cost: (bearing) => (bearing < 35 || bearing > 325 ? 2.1 : 1) }) })
  const north = result.boundary.find((item) => item.bearing === 0)
  const east = result.boundary.find((item) => item.bearing === 90)
  assert.ok(north.distance < east.distance * 0.7)
})

test('road detour shrinks a side of the polygon without changing the target time', async () => {
  const result = await calculateIsochrone({ center, routeMatrix: fixtureRoute({ cost: (bearing) => (bearing > 75 && bearing < 125 ? 2.4 : 1) }) })
  const east = result.boundary.find((item) => item.bearing === 90)
  const west = result.boundary.find((item) => item.bearing === 270)
  assert.ok(east.distance < west.distance * 0.6)
  assert.ok(Math.abs(east.durationSeconds - 900) <= DEFAULT_ISOCHRONE_CONFIG.boundaryToleranceSeconds)
  assert.equal(east.convergence, 'time')
})

test('iterative refinement measures nonlinear routes until the time tolerance is met', async () => {
  const result = await calculateIsochrone({
    center,
    routeMatrix: fixtureRoute({ cost: (_bearing, distance) => distance / 900 }),
    config: { directions: 12, maxDirections: 12, candidateDistancesMeters: [300, 600, 1200, 1500], verificationDirections: 12 },
  })
  assert.ok(result.metrics.refinementSampleCount >= 12)
  assert.ok(result.boundary.every((item) => item.valid))
  assert.ok(result.boundary.every((item) => Math.abs(item.durationSeconds - 900) <= DEFAULT_ISOCHRONE_CONFIG.boundaryToleranceSeconds))
  assert.equal(result.verification.withinToleranceCount, 12)
  assert.equal(result.verification.passRatio, 1)
})

test('internal cross-check prevents an unverified discontinuous boundary from receiving high confidence', async () => {
  const result = await calculateIsochrone({
    center,
    routeMatrix: fixtureRoute({ cost: (_bearing, distance) => distance < 700 ? 1 : 1.8 }),
    config: { directions: 12, maxDirections: 12, candidateDistancesMeters: [300, 600, 900, 1200], verificationDirections: 12 },
  })
  assert.notEqual(result.confidence.level, 'high')
  assert.ok(result.verification.passRatio < 0.7)
  assert.ok(result.warnings.some((warning) => warning.includes('内部边界交叉复核')))
})

test('single-route geometry supplies cross-checkable target-time boundary points', async () => {
  let walkingRouteCalls = 0
  const walkingRoute = async ({ origin, destination }) => {
    walkingRouteCalls += 1
    const distance = distanceMeters(origin, destination)
    return { ok: true, data: { origin, destination, duration: distance, distance, path: [origin, destination], steps: [{ duration: distance, distance, path: [origin, destination] }] } }
  }
  const result = await calculateIsochrone({ center, routeMatrix: fixtureRoute(), walkingRoute, config: { directions: 12, maxDirections: 12, verificationDirections: 12 } })

  assert.equal(walkingRouteCalls, 12)
  assert.equal(result.metrics.singleRouteSnappedCount, 12)
  assert.ok(result.boundary.every((item) => item.status === 'single_route_snapped'))
  assert.equal(result.verification.passRatio, 1)
})

test('single-route boundary points are rechecked against RouteMatrix and adjusted along the route', async () => {
  const walkingRoute = async ({ origin, destination }) => {
    const distance = distanceMeters(origin, destination)
    return { ok: true, data: { origin, destination, duration: distance, distance, path: [origin, destination], steps: [{ duration: distance, distance, path: [origin, destination] }] } }
  }
  const result = await calculateIsochrone({ center, routeMatrix: fixtureRoute({ cost: () => 0.9 }), walkingRoute, config: { directions: 12, maxDirections: 12, verificationDirections: 12 } })

  assert.equal(result.metrics.singleRouteSnappedCount, 12)
  assert.ok(result.metrics.singleRouteRecheckRounds >= 2)
  assert.ok(result.boundary.every((item) => item.status === 'single_route_rechecked'))
  assert.equal(result.verification.withinToleranceCount, 12)
})

test('partial route failures return a polygon with reduced confidence and warnings', async () => {
  const result = await calculateIsochrone({ center, routeMatrix: fixtureRoute({ fail: (bearing) => bearing > 145 && bearing < 215 }) })
  assert.ok(result.geojson)
  assert.notEqual(result.confidence.level, 'high')
  assert.ok(result.confidence.sampleSuccessRatio < 1)
  assert.ok(result.warnings.length > 0)
  assert.ok(result.boundary.some((item) => item.interpolated))
})

test('complete route failure rejects instead of returning a false-success result', async () => {
  await assert.rejects(
    calculateIsochrone({ center, routeMatrix: fixtureRoute({ fail: () => true }) }),
    /未返回任何有效路线样本/,
  )
})
