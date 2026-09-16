const rawEnv = import.meta.env || {}
const normalizedMode = String(rawEnv.VITE_DATA_MODE || 'mock').toLowerCase() === 'online' ? 'online' : 'mock'

export const appConfig = Object.freeze({
  version: '0.6.0-stage6',
  mode: normalizedMode,
  apiBaseUrl: String(rawEnv.VITE_API_BASE_URL || '/api').replace(/\/$/, ''),
  browserMapAk: String(rawEnv.VITE_BAIDU_BROWSER_AK || '').trim(),
  timeoutMs: Number(rawEnv.VITE_API_TIMEOUT_MS) || 180000,
  isochrone: Object.freeze({
    algorithmVersion: 'isochrone-v1',
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
  }),
  report: Object.freeze({
    version: 'coverage-report-v1',
    targetPoiCount: 24,
    weights: Object.freeze({
      requiredCoverage: 0.3,
      categoryCompleteness: 0.2,
      facilityCount: 0.15,
      spatialBalance: 0.15,
      blindFree: 0.15,
      dataConfidence: 0.05,
    }),
  }),
})

export function getRuntimeSummary(config) {
  return { mode: config.mode, modeLabel: config.mode === 'mock' ? '离线样例模式' : '在线 API 模式', apiBaseUrl: config.apiBaseUrl, hasBrowserAk: Boolean(config.browserMapAk) }
}
