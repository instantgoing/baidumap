import { createMockApiClient } from './mockData.js'

export const API_PATHS = Object.freeze({ health: '/health', geocode: '/v1/map/geocode', reverseGeocode: '/v1/map/reverse-geocode', convertCoordinates: '/v1/map/coordinate-convert', searchPoi: '/v1/map/poi/search', analyzePois: '/v1/map/poi/analyze', blindSpots: '/v1/map/blind-spots', routeMatrix: '/v1/map/route-matrix', walkingRoute: '/v1/map/walking-route' })

export class ApiError extends Error {
  constructor(message, { kind = 'unknown', status = 0, requestId = '', cause } = {}) { super(message); this.name = 'ApiError'; this.kind = kind; this.status = status; this.requestId = requestId; this.cause = cause }
}

function createRequestId() { if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID(); return `req-${Date.now()}-${Math.random().toString(16).slice(2)}` }
function joinUrl(baseUrl, path) { return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}` }

async function readJson(response, requestId) {
  try { return await response.json() } catch (error) { throw new ApiError('服务返回了无法解析的响应', { kind: 'malformed_response', status: response.status, requestId, cause: error }) }
}

export function createApiClient({ baseUrl = '/api', timeoutMs = 60000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境没有可用的 fetch 实现')
  async function request(path, { method = 'GET', body } = {}) {
    const requestId = createRequestId()
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(joinUrl(baseUrl, path), { method, signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Request-ID': requestId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const payload = await readJson(response, requestId)
      if (!response.ok) { const kind = payload?.error?.kind || (response.status === 429 ? 'rate_limit' : response.status >= 500 ? 'service_error' : 'http_error'); throw new ApiError(payload?.message || `地图服务请求失败（${response.status}）`, { kind, status: response.status, requestId: payload?.meta?.requestId || requestId }) }
      if (!payload || payload.ok !== true || !('data' in payload)) throw new ApiError('服务响应缺少统一 data 字段', { kind: 'malformed_response', status: response.status, requestId })
      return { ...payload, meta: { ...payload.meta, requestId } }
    } catch (error) {
      if (error instanceof ApiError) throw error
      if (error?.name === 'AbortError') throw new ApiError('地图服务请求超时', { kind: 'timeout', requestId, cause: error })
      throw new ApiError('无法连接地图服务，请检查网络或 API 地址', { kind: 'network', requestId, cause: error })
    } finally { clearTimeout(timeoutId) }
  }
  return {
    health: ({ verify = false } = {}) => request(`${API_PATHS.health}${verify ? '?verify=true' : ''}`),
    geocode: ({ address }) => request(API_PATHS.geocode, { method: 'POST', body: { address } }),
    reverseGeocode: ({ location }) => request(API_PATHS.reverseGeocode, { method: 'POST', body: { location } }),
    convertCoordinates: ({ points, from = 'WGS84', to = 'BD-09' }) => request(API_PATHS.convertCoordinates, { method: 'POST', body: { points, from, to } }),
    searchPoi: ({ query, center, radius = 2000, page = 0, pageSize = 20, maxPages = 8, areaPolygon }) => request(API_PATHS.searchPoi, { method: 'POST', body: { query, center, radius, page, pageSize, maxPages, ...(areaPolygon?.length ? { areaPolygon } : {}) } }),
    analyzePois: ({ center, areaPolygon, searchRadiusMeters = 2000, analysisRadiusMeters = 1000, gridSpacingMeters = 150, populationDensityPerKm2 = 8000, boundaryRecheck = true, pageSize = 20, maxPages = 8 }) => request(API_PATHS.analyzePois, { method: 'POST', body: { center, ...(areaPolygon?.length ? { areaPolygon } : {}), searchRadiusMeters, analysisRadiusMeters, gridSpacingMeters, populationDensityPerKm2, boundaryRecheck, pageSize, maxPages } }),
    blindSpots: ({ center, pois, analysisRadiusMeters = 1000, gridSpacingMeters = 100, populationDensityPerKm2 = 8000, boundaryRecheck = true }) => request(API_PATHS.blindSpots, { method: 'POST', body: { center, pois, analysisRadiusMeters, gridSpacingMeters, populationDensityPerKm2, boundaryRecheck } }),
    routeMatrix: ({ origin, destinations, mode = 'walking' }) => request(API_PATHS.routeMatrix, { method: 'POST', body: { origin, destinations, mode } }),
    walkingRoute: ({ origin, destination }) => request(API_PATHS.walkingRoute, { method: 'POST', body: { origin, destination } }),
  }
}

export function createAppClient(config) { return config.mode === 'mock' ? createMockApiClient() : createApiClient(config) }
