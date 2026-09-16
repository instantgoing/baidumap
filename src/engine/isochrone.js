import { distanceMeters, normalizeBearing, polarPoint } from './geo.js'

export const ISOCHRONE_ALGORITHM_VERSION = 'isochrone-v1'

export const DEFAULT_ISOCHRONE_CONFIG = Object.freeze({
  algorithmVersion: ISOCHRONE_ALGORITHM_VERSION,
  targetDurationSeconds: 900,
  directions: 36,
  maxDirections: 72,
  candidateDistancesMeters: [300, 600, 900, 1200, 1500],
  batchSize: 50,
  boundaryToleranceSeconds: 60,
  spatialToleranceMeters: 50,
  adaptiveGapRatio: 1.3,
  maxRefinementRounds: 6,
  maxSearchDistanceMeters: 4000,
  verificationDirections: 12,
  singleRouteRecheckRounds: 3,
  walkingMode: 'walking',
})

function mergeConfig(config = {}) {
  return { ...DEFAULT_ISOCHRONE_CONFIG, ...config, candidateDistancesMeters: [...(config.candidateDistancesMeters || DEFAULT_ISOCHRONE_CONFIG.candidateDistancesMeters)] }
}

function assertCenter(center) {
  if (!center || !Number.isFinite(center.lng) || !Number.isFinite(center.lat)) throw new Error('等时圈中心点必须包含有效的 lng 和 lat')
}

export function generatePolarCandidates(center, { directions = 36, candidateDistancesMeters = DEFAULT_ISOCHRONE_CONFIG.candidateDistancesMeters, startBearing = 0 } = {}) {
  assertCenter(center)
  if (!Number.isInteger(directions) || directions < 4) throw new Error('方向数量至少为 4')
  const candidates = []
  const step = 360 / directions
  for (let directionIndex = 0; directionIndex < directions; directionIndex += 1) {
    const bearing = normalizeBearing(startBearing + directionIndex * step)
    candidateDistancesMeters.forEach((distance, candidateIndex) => {
      candidates.push({ id: `d${directionIndex}-r${candidateIndex}`, directionIndex, bearing, distance, point: polarPoint(center, bearing, distance).point })
    })
  }
  return candidates
}

function chunk(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

function responseRecords(response) {
  if (Array.isArray(response)) return response
  if (Array.isArray(response?.data?.destinations)) return response.data.destinations
  if (Array.isArray(response?.destinations)) return response.destinations
  throw new Error('RouteMatrix 响应缺少 destinations 数组')
}

function normalizeMeasurement(raw, candidate, origin) {
  const durationSeconds = Number(raw?.durationSeconds ?? raw?.duration ?? raw?.time)
  const measuredDistance = Number(raw?.distanceMeters ?? raw?.distance)
  const status = raw?.status === undefined || raw?.status === 'ok' || raw?.status === 0 ? 'ok' : 'api_error'
  return {
    ...candidate,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    distanceMeters: Number.isFinite(measuredDistance) ? measuredDistance : distanceMeters(origin, candidate.point),
    status,
    rawStatus: raw?.status,
    error: raw?.message,
  }
}

async function measureCandidates({ center, candidates, routeMatrix, mode, batchSize }) {
  const measurements = []
  const batches = chunk(candidates, batchSize)
  for (const batch of batches) {
    try {
      const response = await routeMatrix({ origin: center, destinations: batch.map((candidate) => candidate.point), mode })
      const records = responseRecords(response)
      batch.forEach((candidate, index) => measurements.push(normalizeMeasurement(records[index] || { status: 'api_error', message: '缺少对应结果' }, candidate, center)))
    } catch (error) {
      batch.forEach((candidate) => measurements.push({ ...candidate, durationSeconds: null, distanceMeters: distanceMeters(center, candidate.point), status: 'api_error', error: error.message }))
    }
  }
  return { measurements, batchCount: batches.length }
}

function usableSamples(samples) {
  return samples
    .filter((sample) => sample.status === 'ok' && Number.isFinite(sample.durationSeconds) && Number.isFinite(sample.distance))
    .sort((a, b) => a.distance - b.distance)
}

function closestDurationSample(samples, targetDurationSeconds) {
  return samples.reduce((best, sample) => !best || Math.abs(sample.durationSeconds - targetDurationSeconds) < Math.abs(best.durationSeconds - targetDurationSeconds) ? sample : best, null)
}

function findDurationBracket(center, samples, targetDurationSeconds, bearing) {
  const usable = usableSamples(samples)
  if (!usable.length) return { usable, bracket: null }
  const origin = { bearing, distance: 0, point: center, durationSeconds: 0, distanceMeters: 0, status: 'origin' }
  const candidates = [origin, ...usable]
  const brackets = []
  for (let index = 0; index < candidates.length - 1; index += 1) {
    const first = candidates[index]
    const second = candidates[index + 1]
    const firstDelta = first.durationSeconds - targetDurationSeconds
    const secondDelta = second.durationSeconds - targetDurationSeconds
    if (firstDelta === 0 || secondDelta === 0 || firstDelta * secondDelta < 0) brackets.push([first, second])
  }
  brackets.sort((left, right) => Math.abs(left[1].distance - left[0].distance) - Math.abs(right[1].distance - right[0].distance))
  return { usable, bracket: brackets[0] || null }
}

function interpolationPoint(center, bearing, first, second, targetDurationSeconds) {
  const durationGap = second.durationSeconds - first.durationSeconds
  const rawRatio = durationGap === 0 ? 0.5 : (targetDurationSeconds - first.durationSeconds) / durationGap
  const ratio = Math.max(0, Math.min(1, rawRatio))
  const distance = first.distance + (second.distance - first.distance) * ratio
  return { distance, point: polarPoint(center, bearing, distance).point }
}

function boundaryFromSamples(center, bearing, samples, options) {
  const { usable, bracket } = findDurationBracket(center, samples, options.targetDurationSeconds, bearing)
  if (!usable.length) return { bearing, status: 'unavailable', valid: false, warning: '该方向没有有效路线耗时' }
  const closest = closestDurationSample(usable, options.targetDurationSeconds)
  const timeErrorSeconds = Math.abs(closest.durationSeconds - options.targetDurationSeconds)
  if (timeErrorSeconds <= options.boundaryToleranceSeconds) {
    return { ...closest, bearing, status: 'time_converged', valid: true, convergence: 'time', timeErrorSeconds }
  }
  if (bracket) {
    const spatialGapMeters = Math.abs(bracket[1].distance - bracket[0].distance)
    const interpolated = interpolationPoint(center, bearing, bracket[0], bracket[1], options.targetDurationSeconds)
    if (spatialGapMeters <= options.spatialToleranceMeters) {
      return {
        bearing,
        ...interpolated,
        durationSeconds: options.targetDurationSeconds,
        distanceMeters: interpolated.distance,
        status: 'space_converged',
        valid: true,
        convergence: 'space',
        spatialGapMeters,
        source: { firstDuration: bracket[0].durationSeconds, secondDuration: bracket[1].durationSeconds },
      }
    }
    return {
      bearing,
      ...interpolated,
      durationSeconds: options.targetDurationSeconds,
      distanceMeters: interpolated.distance,
      status: 'unconverged',
      valid: false,
      spatialGapMeters,
      warning: `该方向迭代后仍未收敛（时间误差 ${Math.round(timeErrorSeconds)} 秒，空间区间 ${Math.round(spatialGapMeters)} 米）`,
    }
  }
  const last = usable.at(-1)
  return { ...last, bearing, status: 'censored', valid: false, warning: '搜索距离上限内仍未达到目标耗时' }
}

function nextRefinementCandidate(center, bearing, samples, options, round, prefix) {
  const { usable, bracket } = findDurationBracket(center, samples, options.targetDurationSeconds, bearing)
  const closest = closestDurationSample(usable, options.targetDurationSeconds)
  if (closest && Math.abs(closest.durationSeconds - options.targetDurationSeconds) <= options.boundaryToleranceSeconds) return null

  let distance
  if (!usable.length) {
    const distances = options.candidateDistancesMeters
    distance = distances[Math.floor(distances.length / 2)]
  } else if (bracket) {
    const gap = Math.abs(bracket[1].distance - bracket[0].distance)
    if (gap <= options.spatialToleranceMeters) return null
    const durationGap = bracket[1].durationSeconds - bracket[0].durationSeconds
    const estimate = durationGap === 0 ? 0.5 : (options.targetDurationSeconds - bracket[0].durationSeconds) / durationGap
    const boundedRatio = Math.max(0.35, Math.min(0.65, estimate))
    distance = bracket[0].distance + (bracket[1].distance - bracket[0].distance) * boundedRatio
  } else {
    const farthest = usable.at(-1)
    if (farthest.distance >= options.maxSearchDistanceMeters - 1) return null
    distance = Math.min(options.maxSearchDistanceMeters, Math.max(farthest.distance + 300, farthest.distance * 1.4))
  }

  if (!Number.isFinite(distance) || distance <= 0) return null
  return { id: `${prefix}-${round}-${bearing.toFixed(3)}`, directionIndex: -1, bearing, distance, point: polarPoint(center, bearing, distance).point }
}

async function refineDirections({ center, bearings, groups, routeMatrix, options, prefix }) {
  const measurements = []
  let batchCount = 0
  let rounds = 0
  for (let round = 1; round <= options.maxRefinementRounds; round += 1) {
    const candidates = bearings.map((bearing) => nextRefinementCandidate(center, bearing, groups.get(normalizeBearing(bearing).toFixed(6)) || [], options, round, prefix)).filter(Boolean)
    if (!candidates.length) break
    const result = await measureCandidates({ center, candidates, routeMatrix, mode: options.walkingMode, batchSize: options.batchSize })
    rounds = round
    batchCount += result.batchCount
    measurements.push(...result.measurements)
    result.measurements.forEach((measurement) => {
      const key = normalizeBearing(measurement.bearing).toFixed(6)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(measurement)
    })
  }
  return { measurements, batchCount, rounds }
}

function boundariesForBearings(center, bearings, groups, options) {
  return bearings.map((bearing) => ({ bearing, ...boundaryFromSamples(center, bearing, groups.get(normalizeBearing(bearing).toFixed(6)) || [], options) }))
}

function groupByDirection(measurements) {
  const groups = new Map()
  measurements.forEach((measurement) => {
    const key = normalizeBearing(measurement.bearing).toFixed(6)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(measurement)
  })
  return groups
}

function nearestValid(records, index, step) {
  for (let offset = 1; offset <= records.length; offset += 1) {
    const record = records[(index + step * offset + records.length) % records.length]
    if (record?.valid) return record
  }
  return null
}

function fillMissingBoundaries(records, center) {
  return records.map((record, index) => {
    if (record.valid) return record
    const before = nearestValid(records, index, -1)
    const after = nearestValid(records, index, 1)
    if (!before && !after) return record
    const source = before && after ? (before.distance + after.distance) / 2 : (before || after).distance
    return { ...record, ...polarPoint(center, record.bearing, source), status: 'direction_interpolated', valid: false, interpolated: true, warning: record.warning || '方向接口失败，使用相邻方向插值' }
  })
}

function markOutliers(records, center) {
  if (records.length < 5) return records
  return records.map((record, index) => {
    if (!record.valid || record.status === 'censored' || record.interpolated) return record
    const previous = records[(index - 1 + records.length) % records.length]
    const next = records[(index + 1) % records.length]
    if (!previous?.valid || !next?.valid) return record
    const neighborMean = (previous.distance + next.distance) / 2
    const ratio = record.distance / Math.max(neighborMean, 1)
    if (ratio < 0.35 || ratio > 2.6) {
      const distance = neighborMean
      return { ...record, ...polarPoint(center, record.bearing, distance), status: 'outlier_interpolated', valid: false, interpolated: true, warning: '检测到离群边界点，使用相邻方向修复' }
    }
    return record
  })
}

function orientation(a, b, c) { return (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng) }
function onSegment(a, b, c) { return Math.min(a.lng, b.lng) <= c.lng && c.lng <= Math.max(a.lng, b.lng) && Math.min(a.lat, b.lat) <= c.lat && c.lat <= Math.max(a.lat, b.lat) }
function segmentsIntersect(a, b, c, d) {
  const first = orientation(a, b, c); const second = orientation(a, b, d); const third = orientation(c, d, a); const fourth = orientation(c, d, b)
  if (first === 0 && onSegment(a, b, c)) return true
  if (second === 0 && onSegment(a, b, d)) return true
  if (third === 0 && onSegment(c, d, a)) return true
  if (fourth === 0 && onSegment(c, d, b)) return true
  return ((first > 0 && second < 0) || (first < 0 && second > 0)) && ((third > 0 && fourth < 0) || (third < 0 && fourth > 0))
}

export function hasSelfIntersection(points) {
  const normalizedPoints = points.map((point) => Array.isArray(point)
    ? { lng: Number(point[0]), lat: Number(point[1]) }
    : { lng: Number(point?.lng), lat: Number(point?.lat) })
  const ring = normalizedPoints.at(-1) && normalizedPoints[0] && normalizedPoints.at(-1).lng === normalizedPoints[0].lng && normalizedPoints.at(-1).lat === normalizedPoints[0].lat ? normalizedPoints.slice(0, -1) : normalizedPoints
  for (let first = 0; first < ring.length; first += 1) {
    const firstNext = (first + 1) % ring.length
    for (let second = first + 1; second < ring.length; second += 1) {
      const secondNext = (second + 1) % ring.length
      if (first === second || firstNext === second || secondNext === first) continue
      if (first === 0 && secondNext === ring.length - 1) continue
      if (segmentsIntersect(ring[first], ring[firstNext], ring[second], ring[secondNext])) return true
    }
  }
  return false
}

function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.lng - b.lng || a.lat - b.lat)
  if (sorted.length <= 3) return sorted
  const lower = []
  sorted.forEach((point) => { while (lower.length >= 2 && orientation(lower.at(-2), lower.at(-1), point) <= 0) lower.pop(); lower.push(point) })
  const upper = []
  sorted.slice().reverse().forEach((point) => { while (upper.length >= 2 && orientation(upper.at(-2), upper.at(-1), point) <= 0) upper.pop(); upper.push(point) })
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

function repairRing(records) {
  const points = records.filter((record) => record.point).map((record) => record.point)
  if (points.length < 3) return { points: [], repaired: false }
  const ring = hasSelfIntersection(points) ? convexHull(points) : points
  return { points: ring, repaired: ring.length !== points.length }
}

function buildConfidence(records, measurements, baseDirections, verification) {
  const validDirections = records.filter((record) => record.valid).length
  const successfulSamples = measurements.filter((sample) => sample.status === 'ok').length
  const totalDirections = records.length || baseDirections
  const validDirectionRatio = validDirections / totalDirections
  const sampleSuccessRatio = measurements.length ? successfulSamples / measurements.length : 0
  const interpolatedDirectionRatio = records.filter((record) => record.interpolated).length / totalDirections
  const verificationPassRatio = verification?.passRatio || 0
  const level = validDirectionRatio >= 0.9 && sampleSuccessRatio >= 0.9 && verificationPassRatio >= 0.9 ? 'high' : validDirectionRatio >= 0.7 && sampleSuccessRatio >= 0.7 && verificationPassRatio >= 0.7 ? 'medium' : 'low'
  return { level, validDirectionRatio, sampleSuccessRatio, verificationPassRatio, interpolatedDirectionRatio, validDirections, successfulSamples, totalDirections, totalSamples: measurements.length }
}

function heatmapSamples(measurements, targetDurationSeconds) {
  return measurements.map((sample) => ({ lng: sample.point.lng, lat: sample.point.lat, duration: sample.durationSeconds, distance: sample.distanceMeters, bearing: sample.bearing, status: sample.status, weight: sample.status === 'ok' && Number.isFinite(sample.durationSeconds) ? Math.max(0, 1 - sample.durationSeconds / targetDurationSeconds) : 0 }))
}

function selectVerificationBoundaries(records, count) {
  const available = records.filter((record) => record.point)
  if (!available.length || count <= 0) return []
  const selected = []
  const seen = new Set()
  const add = (record) => {
    if (!record) return
    const key = normalizeBearing(record.bearing).toFixed(6)
    if (!seen.has(key)) { seen.add(key); selected.push(record) }
  }
  ;[0, 90, 180, 270].forEach((bearing) => add(available.reduce((best, record) => !best || Math.abs(normalizeBearing(record.bearing - bearing + 180) - 180) < Math.abs(normalizeBearing(best.bearing - bearing + 180) - 180) ? record : best, null)))
  available
    .filter((record, index) => record.distance < (available[(index - 1 + available.length) % available.length]?.distance || Infinity) && record.distance < (available[(index + 1) % available.length]?.distance || Infinity))
    .sort((left, right) => left.distance - right.distance)
    .forEach(add)
  for (let index = 0; selected.length < Math.min(count, available.length) && index < count * 2; index += 1) add(available[Math.floor(index * available.length / count) % available.length])
  return selected.slice(0, count)
}

function pointAlongPath(path, ratio) {
  const points = (path || []).filter((point) => Number.isFinite(point?.lng) && Number.isFinite(point?.lat))
  if (!points.length) return null
  if (points.length === 1 || ratio <= 0) return points[0]
  if (ratio >= 1) return points.at(-1)
  const segments = points.slice(1).map((point, index) => distanceMeters(points[index], point))
  const target = segments.reduce((sum, value) => sum + value, 0) * ratio
  let traversed = 0
  for (let index = 0; index < segments.length; index += 1) {
    if (traversed + segments[index] >= target) {
      const localRatio = segments[index] ? (target - traversed) / segments[index] : 0
      return { lng: points[index].lng + (points[index + 1].lng - points[index].lng) * localRatio, lat: points[index].lat + (points[index + 1].lat - points[index].lat) * localRatio }
    }
    traversed += segments[index]
  }
  return points.at(-1)
}

function pointAtRouteDuration(route, targetDurationSeconds) {
  const steps = Array.isArray(route?.steps) ? route.steps : []
  let elapsed = 0
  for (const step of steps) {
    const duration = Number(step?.duration || 0)
    if (duration > 0 && elapsed + duration >= targetDurationSeconds) return pointAlongPath(step.path, (targetDurationSeconds - elapsed) / duration)
    elapsed += duration
  }
  const totalDuration = Number(route?.duration || 0)
  return totalDuration > 0 ? pointAlongPath(route.path, Math.min(1, targetDurationSeconds / totalDuration)) : null
}

async function snapBoundariesToSingleRoutes({ center, records, walkingRoute, routeMatrix, options }) {
  const selected = selectVerificationBoundaries(records, options.verificationDirections)
  if (typeof walkingRoute !== 'function' || !selected.length) return { records, selectedBearings: selected.map((record) => record.bearing), requestCount: 0, snappedCount: 0, recheckBatchCount: 0, recheckRounds: 0, warnings: [] }
  const replacements = new Map()
  const routeStates = []
  const warnings = []
  let requestCount = 0
  for (const record of selected) {
    const destinationDistance = Math.max(options.maxSearchDistanceMeters, record.distance + 1000)
    try {
      requestCount += 1
      const response = await walkingRoute({ origin: center, destination: polarPoint(center, record.bearing, destinationDistance).point })
      const route = response?.data || response
      const point = pointAtRouteDuration(route, options.targetDurationSeconds)
      if (!point || Number(route?.duration || 0) < options.targetDurationSeconds) throw new Error('路线长度不足以截取目标时间点')
      replacements.set(normalizeBearing(record.bearing).toFixed(6), {
        ...record,
        point,
        distance: distanceMeters(center, point),
        distanceMeters: Number(route.distance || 0) * options.targetDurationSeconds / Number(route.duration || options.targetDurationSeconds),
        durationSeconds: options.targetDurationSeconds,
        status: 'single_route_snapped',
        valid: true,
        convergence: 'single_route',
        timeErrorSeconds: 0,
      })
      routeStates.push({ bearing: record.bearing, route, routeTimeSeconds: options.targetDurationSeconds, complete: false })
    } catch (error) {
      warnings.push(`方向 ${Math.round(record.bearing)}° 单路线复核失败：${error.message}`)
    }
  }

  let recheckBatchCount = 0
  let recheckRounds = 0
  for (let round = 1; round <= options.singleRouteRecheckRounds; round += 1) {
    const pending = routeStates.filter((state) => !state.complete)
    if (!pending.length) break
    const candidates = pending.map((state, index) => {
      const replacement = replacements.get(normalizeBearing(state.bearing).toFixed(6))
      return { id: `single-route-recheck-${round}-${index}`, directionIndex: index, bearing: state.bearing, distance: replacement.distance, point: replacement.point }
    })
    const result = await measureCandidates({ center, candidates, routeMatrix, mode: options.walkingMode, batchSize: options.batchSize })
    recheckBatchCount += result.batchCount
    recheckRounds = round
    result.measurements.forEach((measurement, index) => {
      const state = pending[index]
      const key = normalizeBearing(state.bearing).toFixed(6)
      const current = replacements.get(key)
      if (measurement.status !== 'ok' || !Number.isFinite(measurement.durationSeconds) || measurement.durationSeconds <= 0) return
      const timeErrorSeconds = Math.abs(measurement.durationSeconds - options.targetDurationSeconds)
      replacements.set(key, { ...current, durationSeconds: measurement.durationSeconds, distanceMeters: measurement.distanceMeters, timeErrorSeconds, status: round === 1 ? 'single_route_snapped' : 'single_route_rechecked' })
      if (timeErrorSeconds <= options.boundaryToleranceSeconds) {
        state.complete = true
        return
      }
      if (round === options.singleRouteRecheckRounds) return
      const proposedRouteTime = state.routeTimeSeconds * options.targetDurationSeconds / measurement.durationSeconds
      const nextRouteTime = Math.max(1, Math.min(Number(state.route.duration || proposedRouteTime), proposedRouteTime))
      const point = pointAtRouteDuration(state.route, nextRouteTime)
      if (!point) return
      state.routeTimeSeconds = nextRouteTime
      replacements.set(key, { ...replacements.get(key), point, distance: distanceMeters(center, point), status: 'single_route_rechecking' })
    })
  }
  return {
    records: records.map((record) => replacements.get(normalizeBearing(record.bearing).toFixed(6)) || record),
    selectedBearings: selected.map((record) => record.bearing),
    requestCount,
    snappedCount: replacements.size,
    recheckBatchCount,
    recheckRounds,
    warnings,
  }
}

async function verifyBoundaries({ center, records, routeMatrix, options, selectedRecords }) {
  const selected = selectedRecords || selectVerificationBoundaries(records, options.verificationDirections)
  if (!selected.length) return { requestedDirections: 0, checkedDirections: 0, withinToleranceCount: 0, passRatio: 0, samples: [], batchCount: 0 }
  const candidates = selected.map((record, index) => ({ id: `verify-${index}`, directionIndex: index, bearing: record.bearing, distance: record.distance, point: record.point }))
  const result = await measureCandidates({ center, candidates, routeMatrix, mode: options.walkingMode, batchSize: options.batchSize })
  const samples = result.measurements.map((sample) => {
    const timeErrorSeconds = sample.status === 'ok' && Number.isFinite(sample.durationSeconds) ? Math.abs(sample.durationSeconds - options.targetDurationSeconds) : null
    return { bearing: sample.bearing, durationSeconds: sample.durationSeconds, distanceMeters: sample.distanceMeters, status: sample.status, timeErrorSeconds, withinTolerance: timeErrorSeconds !== null && timeErrorSeconds <= options.boundaryToleranceSeconds }
  })
  const withinToleranceCount = samples.filter((sample) => sample.withinTolerance).length
  return {
    requestedDirections: selected.length,
    checkedDirections: samples.filter((sample) => sample.status === 'ok').length,
    withinToleranceCount,
    passRatio: selected.length ? withinToleranceCount / selected.length : 0,
    samples,
    batchCount: result.batchCount,
  }
}

export async function calculateIsochrone({ center, routeMatrix, walkingRoute, config = {} }) {
  assertCenter(center)
  if (typeof routeMatrix !== 'function') throw new Error('等时圈计算需要 routeMatrix 函数')
  const options = mergeConfig(config)
  const baseCandidates = generatePolarCandidates(center, options)
  const initial = await measureCandidates({ center, candidates: baseCandidates, routeMatrix, mode: options.walkingMode, batchSize: options.batchSize })
  if (!initial.measurements.some((sample) => sample.status === 'ok' && Number.isFinite(sample.durationSeconds))) {
    throw new Error('步行 RouteMatrix 未返回任何有效路线样本，无法生成真实等时圈')
  }
  const groups = groupByDirection(initial.measurements)
  const baseBearings = Array.from({ length: options.directions }, (_, index) => index * 360 / options.directions)
  const baseRefinement = await refineDirections({ center, bearings: baseBearings, groups, routeMatrix, options, prefix: 'base-refine' })
  let boundaries = boundariesForBearings(center, baseBearings, groups, options)

  const extraBearings = []
  for (let index = 0; index < boundaries.length; index += 1) {
    const current = boundaries[index]
    const next = boundaries[(index + 1) % boundaries.length]
    if (current.valid && next.valid && Math.max(current.distance, next.distance) / Math.max(Math.min(current.distance, next.distance), 1) > options.adaptiveGapRatio && extraBearings.length + options.directions < options.maxDirections) extraBearings.push(normalizeBearing(current.bearing + (next.bearing - current.bearing + 360) % 360 / 2))
  }
  let extraMeasurements = []
  let extraBatchCount = 0
  let extraRefinement = { measurements: [], batchCount: 0, rounds: 0 }
  if (extraBearings.length) {
    const extraCandidates = extraBearings.flatMap((bearing, index) => options.candidateDistancesMeters.map((distance, candidateIndex) => ({ id: `extra-${index}-${candidateIndex}`, directionIndex: options.directions + index, bearing, distance, point: polarPoint(center, bearing, distance).point })))
    const extra = await measureCandidates({ center, candidates: extraCandidates, routeMatrix, mode: options.walkingMode, batchSize: options.batchSize })
    extraMeasurements = extra.measurements
    extraBatchCount = extra.batchCount
    extraMeasurements.forEach((measurement) => {
      const key = normalizeBearing(measurement.bearing).toFixed(6)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(measurement)
    })
    extraRefinement = await refineDirections({ center, bearings: extraBearings, groups, routeMatrix, options, prefix: 'extra-refine' })
    boundaries = boundaries.concat(boundariesForBearings(center, extraBearings, groups, options))
  }

  boundaries.sort((a, b) => a.bearing - b.bearing)
  const repairedBoundaries = markOutliers(boundaries, center)
  const filledBoundaries = fillMissingBoundaries(repairedBoundaries, center)
  const routeSnapping = await snapBoundariesToSingleRoutes({ center, records: filledBoundaries, walkingRoute, routeMatrix, options })
  const finalBoundaries = routeSnapping.records
  const ring = repairRing(finalBoundaries)
  const measurements = initial.measurements.concat(baseRefinement.measurements, extraMeasurements, extraRefinement.measurements)
  const verificationRecords = routeSnapping.selectedBearings.map((bearing) => finalBoundaries.find((record) => normalizeBearing(record.bearing).toFixed(6) === normalizeBearing(bearing).toFixed(6))).filter(Boolean)
  const verification = await verifyBoundaries({ center, records: finalBoundaries, routeMatrix, options, selectedRecords: verificationRecords })
  const confidence = buildConfidence(finalBoundaries, measurements, options.directions, verification)
  const warnings = measurements.filter((sample) => sample.status !== 'ok' && sample.error).map((sample) => sample.error).filter((message, index, all) => all.indexOf(message) === index).slice(0, 5)
  finalBoundaries.forEach((boundary) => { if (boundary.warning && !warnings.includes(boundary.warning)) warnings.push(boundary.warning) })
  warnings.push(...routeSnapping.warnings.filter((warning) => !warnings.includes(warning)))
  if (verification.passRatio < 0.7) warnings.push(`内部边界交叉复核仅 ${verification.withinToleranceCount}/${verification.requestedDirections} 个点落在目标时间容差内`)
  const geojsonCoordinates = ring.points.length >= 3
    ? [...ring.points, ring.points[0]].map((point) => [point.lng, point.lat])
    : null
  const geojson = geojsonCoordinates ? { type: 'Feature', properties: { algorithmVersion: options.algorithmVersion, targetDurationSeconds: options.targetDurationSeconds, confidence: confidence.level, sampleCount: measurements.length, verificationPassRatio: verification.passRatio }, geometry: { type: 'Polygon', coordinates: [geojsonCoordinates] } } : null
  return {
    algorithmVersion: options.algorithmVersion,
    center,
    targetDurationSeconds: options.targetDurationSeconds,
    geojson,
    boundary: finalBoundaries,
    heatmap: heatmapSamples(measurements, options.targetDurationSeconds),
    confidence,
    verification,
    metrics: { routeBatchCount: initial.batchCount + baseRefinement.batchCount + extraBatchCount + extraRefinement.batchCount + routeSnapping.recheckBatchCount + verification.batchCount, singleRouteRequestCount: routeSnapping.requestCount, singleRouteSnappedCount: routeSnapping.snappedCount, singleRouteRecheckRounds: routeSnapping.recheckRounds, singleRouteRecheckBatchCount: routeSnapping.recheckBatchCount, boundaryPointCount: ring.points.length, selfIntersectionRepaired: ring.repaired, adaptiveDirectionCount: extraBearings.length, refinementRoundCount: baseRefinement.rounds + extraRefinement.rounds, refinementSampleCount: baseRefinement.measurements.length + extraRefinement.measurements.length, verificationDirectionCount: verification.requestedDirections, boundaryToleranceSeconds: options.boundaryToleranceSeconds, spatialToleranceMeters: options.spatialToleranceMeters },
    warnings,
  }
}

export function createIsochroneEngine({ routeMatrix, walkingRoute, config } = {}) { return { calculate: (options) => calculateIsochrone({ ...options, routeMatrix, walkingRoute, config }) } }
