export const MAP_LAYER_DEFAULTS = Object.freeze({
  isochrone: true,
  heatmap: true,
  pois: true,
  blindZones: true,
  candidates: true,
})

export const POI_CATEGORY_COLORS = Object.freeze({
  market: '#167f76',
  pharmacy: '#d06457',
  primary_school: '#4979b8',
  community_healthcare: '#8c67ad',
  hospital: '#a94f63',
  kindergarten: '#d18b32',
  eldercare: '#81745d',
  convenience_store: '#4b9565',
})

export const POI_CATEGORY_VISUALS = Object.freeze({
  market: Object.freeze({ label: '菜市场', symbol: '菜', shape: 'square' }),
  pharmacy: Object.freeze({ label: '药店', symbol: '药', shape: 'cross' }),
  primary_school: Object.freeze({ label: '小学', symbol: '学', shape: 'triangle' }),
  community_healthcare: Object.freeze({ label: '社区医疗', symbol: '卫', shape: 'circle' }),
  hospital: Object.freeze({ label: '医院', symbol: '医', shape: 'diamond' }),
  kindergarten: Object.freeze({ label: '幼儿园', symbol: '幼', shape: 'hexagon' }),
  eldercare: Object.freeze({ label: '养老', symbol: '老', shape: 'round' }),
  convenience_store: Object.freeze({ label: '便利店', symbol: '便', shape: 'star' }),
})

export function getPoiVisual(category) {
  return POI_CATEGORY_VISUALS[category] || { label: String(category || '其他'), symbol: '点', shape: 'circle' }
}

export function getBlindZoneVisual(missingCategories = []) {
  const categories = [...new Set(missingCategories)].filter(Boolean)
  const severity = Math.max(1, Math.min(3, categories.length || 1))
  return {
    severity,
    pattern: ['single', 'double', 'triple'][severity - 1],
    missingLabels: categories.map((category) => getPoiVisual(category).label),
  }
}

export function getZoneCode(index) {
  return `G${String(Number(index) + 1).padStart(2, '0')}`
}

export function getDurationBand(durationSeconds, targetDurationSeconds) {
  const target = Math.max(1, Number(targetDurationSeconds) || 1)
  const progress = Math.max(0, Number(durationSeconds) || 0) / target
  if (progress <= 1 / 3) return { id: 'near', shape: 'circle', label: `不超过 ${Math.max(1, Math.round(target / 180))} 分钟` }
  if (progress <= 2 / 3) return { id: 'middle', shape: 'diamond', label: `约 ${Math.max(1, Math.round(target / 180))}–${Math.max(2, Math.round(target / 90))} 分钟` }
  return { id: 'edge', shape: 'triangle', label: `接近或超过 ${Math.max(2, Math.round(target / 90))} 分钟` }
}

export function selectAccessibleHeatSamples(samples = [], targetDurationSeconds, maximumPerBand = 8) {
  const groups = { near: [], middle: [], edge: [] }
  samples.filter((sample) => sample?.status === 'ok' && Number.isFinite(Number(sample.duration))).forEach((sample) => {
    groups[getDurationBand(sample.duration, targetDurationSeconds).id].push(sample)
  })
  return Object.values(groups).flatMap((group) => {
    if (group.length <= maximumPerBand) return group
    if (maximumPerBand <= 1) return group.slice(0, 1)
    const step = (group.length - 1) / (maximumPerBand - 1)
    return Array.from({ length: maximumPerBand }, (_, index) => group[Math.round(index * step)])
  })
}
