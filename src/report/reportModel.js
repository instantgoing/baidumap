export const REPORT_CATEGORY_LABELS = Object.freeze({
  market: '菜市场',
  pharmacy: '药店',
  primary_school: '小学',
  community_healthcare: '社区医疗',
  hospital: '综合医院',
  kindergarten: '幼儿园',
  eldercare: '养老服务',
  convenience_store: '便利店/超市',
})

export const REPORT_CATEGORY_ORDER = Object.freeze(Object.keys(REPORT_CATEGORY_LABELS))
export const REQUIRED_CATEGORIES = Object.freeze(['market', 'pharmacy', 'primary_school'])
export const PLANNING_VERSION = 'planning-scenario-v1'

const PLANNING_CATEGORY_WEIGHTS = Object.freeze({ market: 1, pharmacy: 1, primary_school: 1.2 })

export const DEFAULT_REPORT_CONFIG = Object.freeze({
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
})

function clamp(value, minimum = 0, maximum = 100) {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))
}

function ratio(value) {
  return clamp(Number(value) * 100)
}

function scoreBand(score) {
  if (score >= 85) return { key: 'excellent', label: '设施覆盖优秀' }
  if (score >= 70) return { key: 'good', label: '设施覆盖良好' }
  if (score >= 55) return { key: 'attention', label: '局部仍需关注' }
  return { key: 'critical', label: '存在明显短板' }
}

function categoryCounts(data) {
  const source = Array.isArray(data?.serviceAreaPois) ? data.serviceAreaPois : (data?.pois || [])
  const counts = source.reduce((result, poi) => {
    if (poi?.category) result[poi.category] = (result[poi.category] || 0) + 1
    return result
  }, {})
  return Object.fromEntries(REPORT_CATEGORY_ORDER.map((category) => [category, Number(counts[category] || 0)]))
}

function polygonCentroid(points = []) {
  const valid = points.map((point) => Array.isArray(point)
    ? { lng: Number(point[0]), lat: Number(point[1]) }
    : { lng: Number(point?.lng), lat: Number(point?.lat) })
    .filter((point) => Number.isFinite(point.lng) && Number.isFinite(point.lat))
  if (!valid.length) return null
  return {
    lng: valid.reduce((sum, point) => sum + point.lng, 0) / valid.length,
    lat: valid.reduce((sum, point) => sum + point.lat, 0) / valid.length,
  }
}

function confidenceScore(level) {
  return ({ high: 100, medium: 75, low: 45 })[level] ?? 60
}

function timestampLabel(value) {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return String(value)
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

function planningPriorityBand(score) {
  if (score >= 75) return { key: 'high', label: '优先复核' }
  if (score >= 50) return { key: 'medium', label: '建议关注' }
  return { key: 'low', label: '低优先级' }
}

function planningCategories(missingCategories = []) {
  return [...new Set(missingCategories)].filter((category) => REQUIRED_CATEGORIES.includes(category))
}

function buildReportNarrative({ score, band, categories, planning, source, confidence, durationMinutes }) {
  const weakCategories = categories
    .filter((category) => category.state === 'critical' || category.state === 'missing')
    .slice(0, 3)
    .map((category) => category.label)
  const topCandidate = planning?.candidates?.[0]
  return {
    headline: `${durationMinutes} 分钟生活圈当前综合分 ${score} 分，${band.label}。`,
    finding: weakCategories.length
      ? `当前主要短板集中在${weakCategories.join('、')}，应先核对这些类别的覆盖和数据完整性。`
      : '当前八类设施均有记录，仍应结合覆盖率和空间均衡指标判断服务质量。',
    action: topCandidate
      ? `下一步建议优先复核 ${topCandidate.zoneId}，关注${topCandidate.recommendedCategories.map((category) => REPORT_CATEGORY_LABELS[category] || category).join('、') || '必测设施'}。`
      : '当前没有可排序的灰区候选，建议保留本次分析作为后续对照基线。',
    evidence: `结论基于${source || '当前数据源'}与${confidence || '未确认'}边界置信度生成；规划部分是确定性情景估算，不是正式选址结论。`,
  }
}

export function buildPlanningModel({
  blind,
  center,
  baselineScore = 0,
  baselineDimensions = {},
  config = DEFAULT_REPORT_CONFIG,
} = {}) {
  if (!blind) return null
  const zones = Array.isArray(blind.zones) ? blind.zones : []
  const gridCellCount = Math.max(0, Number(blind.evidence?.gridCellCount || 0))
  const baselineBlindCellCount = Math.max(0, Number(blind.evidence?.blindCellCount || 0))
  const coverageBefore = Object.fromEntries(REQUIRED_CATEGORIES.map((category) => [category, clamp(Number(blind.coverage?.[category]?.coverageRatio || 0), 0, 1)]))
  const maximumArea = Math.max(...zones.map((zone) => Number(zone.areaM2 || 0)), 1)
  const maximumPopulation = Math.max(...zones.map((zone) => Number(zone.populationProxy || 0)), 1)
  const maximumMissingWeight = Object.values(PLANNING_CATEGORY_WEIGHTS).reduce((sum, value) => sum + value, 0)
  const candidates = zones.map((zone, index) => {
    const missingCategories = planningCategories(zone.missingCategories)
    const zoneCellCount = Math.max(1, Number(zone.evidence?.cellCount || Math.round(Number(zone.areaM2 || 0) / 10000) || 1))
    const missingWeight = missingCategories.reduce((sum, category) => sum + (PLANNING_CATEGORY_WEIGHTS[category] || 0), 0)
    const areaScore = clamp(Number(zone.areaM2 || 0) / maximumArea * 100)
    const populationScore = clamp(Number(zone.populationProxy || 0) / maximumPopulation * 100)
    const missingScore = clamp(missingWeight / maximumMissingWeight * 100)
    const priorityScore = Math.round(areaScore * 0.45 + populationScore * 0.25 + missingScore * 0.3)
    const location = zone.centroid || polygonCentroid(zone.polygon) || center || null
    const coverageGain = Object.fromEntries(REQUIRED_CATEGORIES.map((category) => [category, missingCategories.includes(category) && gridCellCount ? clamp(zoneCellCount / gridCellCount, 0, 1) : 0]))
    return {
      id: `planning-${zone.id || index + 1}`,
      zoneId: zone.id || `zone-${index + 1}`,
      location,
      missingCategories,
      recommendedCategories: missingCategories,
      priorityScore,
      priorityBand: planningPriorityBand(priorityScore),
      areaM2: Number(zone.areaM2 || 0),
      populationProxy: Number(zone.populationProxy || 0),
      zoneCellCount,
      estimatedImpact: {
        blindCellReduction: zoneCellCount,
        coverageGain,
        assumption: '将候选设施视为覆盖所在灰区的缺失类别网格；不包含道路、用地、入口和真实步行阻隔。',
      },
    }
  }).sort((left, right) => right.priorityScore - left.priorityScore || left.zoneId.localeCompare(right.zoneId))
  const selectedCellReduction = Math.min(baselineBlindCellCount, candidates.reduce((sum, candidate) => sum + candidate.zoneCellCount, 0))
  const coverageAfter = Object.fromEntries(REQUIRED_CATEGORIES.map((category) => {
    const gain = candidates.reduce((sum, candidate) => sum + Number(candidate.estimatedImpact.coverageGain[category] || 0), 0)
    return [category, clamp(coverageBefore[category] + gain, 0, 1)]
  }))
  const averageCoverage = (coverage) => Object.values(coverage).reduce((sum, value) => sum + value, 0) / REQUIRED_CATEGORIES.length
  const maximumCoverage = Math.max(...Object.values(coverageAfter), 0)
  const minimumCoverage = Math.min(...Object.values(coverageAfter))
  const afterDimensions = {
    ...baselineDimensions,
    requiredCoverage: ratio(averageCoverage(coverageAfter)),
    spatialBalance: maximumCoverage > 0 ? clamp((1 - (maximumCoverage - minimumCoverage)) * 100) : 0,
    blindFree: gridCellCount ? clamp((1 - Math.max(0, baselineBlindCellCount - selectedCellReduction) / gridCellCount) * 100) : 100,
  }
  const scenarioScore = Math.round(Object.entries(config.weights).reduce((total, [key, weight]) => total + (afterDimensions[key] || 0) * weight, 0))
  const topCandidate = candidates[0]
  const summary = topCandidate
    ? `按灰区面积、人口代理和缺失类别排序，建议先复核 ${topCandidate.zoneId}，优先补齐 ${(topCandidate.recommendedCategories || []).map((category) => REPORT_CATEGORY_LABELS[category] || category).join('、') || '必测设施'}。`
    : '当前分析范围没有可排序的灰区候选。'
  return {
    version: PLANNING_VERSION,
    status: 'scenario',
    baseline: { score: Number(baselineScore || 0), blindCellCount: baselineBlindCellCount, coverage: coverageBefore },
    scenarioAfter: {
      score: scenarioScore,
      scoreDelta: scenarioScore - Number(baselineScore || 0),
      blindCellCount: Math.max(0, baselineBlindCellCount - selectedCellReduction),
      coverage: coverageAfter,
    },
    candidates,
    summary,
    assumptions: [
      '规划优先级是确定性排序，不是规划审批结论。',
      '改善量是覆盖网格的上限情景估算，不等于真实新增设施后的改善百分比。',
      '正式选址仍需道路、用地、入口、服务半径和独立人工核验。',
    ],
    limitations: ['P5 规划结果仅为情景估算，未进行道路、用地、入口和独立真值复核。'],
  }
}

export function buildReportModel({
  data,
  isochrone,
  meta,
  address = '',
  center,
  durationMinutes = 15,
  completedAt,
  warning = '',
  config = DEFAULT_REPORT_CONFIG,
} = {}) {
  if (!data) return null
  const counts = categoryCounts(data)
  const blind = data.blindSpots || { coverage: {}, zones: [], evidence: {} }
  const coverageRatios = REQUIRED_CATEGORIES.map((category) => Number(blind.coverage?.[category]?.coverageRatio || 0))
  const requiredCoverage = ratio(coverageRatios.reduce((sum, value) => sum + value, 0) / REQUIRED_CATEGORIES.length)
  const categoryCompleteness = ratio(REPORT_CATEGORY_ORDER.filter((category) => counts[category] > 0).length / REPORT_CATEGORY_ORDER.length)
  const serviceAreaCount = Number(data.quality?.serviceAreaCount ?? data.serviceAreaPois?.length ?? 0)
  const facilityCount = clamp(serviceAreaCount / Math.max(1, Number(config.targetPoiCount || 24)) * 100)
  const maximumCoverage = Math.max(...coverageRatios, 0)
  const minimumCoverage = Math.min(...coverageRatios)
  const spatialBalance = maximumCoverage > 0 ? clamp((1 - (maximumCoverage - minimumCoverage)) * 100) : 0
  const gridCellCount = Number(blind.evidence?.gridCellCount || 0)
  const blindCellCount = Number(blind.evidence?.blindCellCount || 0)
  const blindFree = gridCellCount ? clamp((1 - blindCellCount / gridCellCount) * 100) : 100
  const dataConfidence = confidenceScore(isochrone?.confidence?.level)
  const dimensions = {
    requiredCoverage,
    categoryCompleteness,
    facilityCount,
    spatialBalance,
    blindFree,
    dataConfidence,
  }
  const score = Math.round(Object.entries(config.weights).reduce((total, [key, weight]) => total + (dimensions[key] || 0) * weight, 0))
  const band = scoreBand(score)
  const categories = REPORT_CATEGORY_ORDER.map((category) => {
    const coverage = REQUIRED_CATEGORIES.includes(category) ? ratio(blind.coverage?.[category]?.coverageRatio || 0) : null
    const count = counts[category]
    const state = REQUIRED_CATEGORIES.includes(category) && coverage < 70 ? 'critical' : count === 0 ? 'missing' : count < 3 ? 'attention' : 'good'
    return { id: category, label: REPORT_CATEGORY_LABELS[category], count, coverage, state }
  })
  const planning = buildPlanningModel({ blind, center, baselineScore: score, baselineDimensions: dimensions, config })
  const narrative = buildReportNarrative({
    score,
    band,
    categories,
    planning,
    source: meta?.source || 'unknown',
    confidence: isochrone?.confidence?.level || 'unavailable',
    durationMinutes,
  })
  const planningByZoneId = new Map((planning?.candidates || []).map((candidate) => [candidate.zoneId, candidate]))
  const candidateSites = (blind.zones || []).map((zone, index) => ({
    id: `candidate-${zone.id || index + 1}`,
    zoneId: zone.id || `zone-${index + 1}`,
    location: polygonCentroid(zone.polygon) || center,
    missingCategories: zone.missingCategories || [],
    areaM2: Number(zone.areaM2 || 0),
    priorityScore: planningByZoneId.get(zone.id)?.priorityScore || 0,
    note: 'P5 情景候选，最终选址仍需道路、用地、入口和独立核验复核',
  })).filter((site) => site.location)
  const limitations = [
    warning,
    ...(isochrone?.warnings || []),
    ...(planning?.limitations || []),
    data.quality?.serviceAreaFilter !== 'polygon' ? '生活圈 POI 未按路网等时圈筛选，当前采用半径降级口径。' : '',
    isochrone?.confidence?.level === 'low' ? '等时圈置信度较低，边界只宜用于趋势判断。' : '',
  ].filter((item, index, items) => item && items.indexOf(item) === index)
  const dataTimestamp = meta?.capturedAt || completedAt || null
  const boundaryVerification = {
    requestedDirections: Number(isochrone?.verification?.requestedDirections || 0),
    checkedDirections: Number(isochrone?.verification?.checkedDirections || 0),
    withinToleranceCount: Number(isochrone?.verification?.withinToleranceCount || 0),
    passRatio: Number(isochrone?.verification?.passRatio || 0),
  }
  return {
    score,
    band,
    dimensions,
    categories,
    narrative,
    candidateSites,
    zones: blind.zones || [],
    planning,
    evidence: blind.evidence || {},
    quality: data.quality || {},
    address,
    center: center || data.center,
    durationMinutes,
    reportVersion: config.version,
    algorithmVersion: isochrone?.algorithmVersion || isochrone?.geojson?.properties?.algorithmVersion || '等时圈未生成',
    confidence: isochrone?.confidence?.level || 'unavailable',
    boundaryVerification,
    dataTimestamp,
    dataTimestampLabel: timestampLabel(dataTimestamp),
    source: meta?.source || 'unknown',
    formula: '总分 = 必测覆盖 30% + 种类完整 20% + 设施数量 15% + 空间均衡 15% + 非盲区 15% + 数据置信 5%',
    limitations,
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

export function buildReportHtml(report) {
  if (!report) throw new Error('导出报告前必须先完成一次分析')
  const categoryRows = report.categories.map((category) => `<tr><td>${escapeHtml(category.label)}</td><td>${category.count}</td><td>${category.coverage === null ? '—' : `${Math.round(category.coverage)}%`}</td></tr>`).join('')
  const zoneRows = report.zones.length
    ? report.zones.map((zone) => `<tr><td>${escapeHtml(zone.id)}</td><td>${escapeHtml((zone.missingCategories || []).map((category) => REPORT_CATEGORY_LABELS[category] || category).join('、'))}</td><td>${Math.round(Number(zone.areaM2 || 0)).toLocaleString('zh-CN')} m²</td><td>${Number(zone.populationProxy || 0).toFixed(1)}</td></tr>`).join('')
    : '<tr><td colspan="4">当前分析范围未识别到服务盲区</td></tr>'
  const limitations = report.limitations.length ? report.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('') : '<li>未记录额外限制。</li>'
  const planningRows = report.planning?.candidates?.length
    ? report.planning.candidates.map((candidate) => `<tr><td>${escapeHtml(candidate.zoneId)}</td><td>${candidate.priorityScore}</td><td>${escapeHtml((candidate.recommendedCategories || []).map((category) => REPORT_CATEGORY_LABELS[category] || category).join('、') || '—')}</td><td>${Math.round(Number(candidate.estimatedImpact?.blindCellReduction || 0))}</td></tr>`).join('')
    : '<tr><td colspan="4">当前没有规划候选。</td></tr>'
  const planningSection = report.planning ? `<h2>规划优先级与情景估算</h2><p>${escapeHtml(report.planning.summary)}</p><p class="formula">规划前综合分 ${report.planning.baseline.score} · 情景后综合分 ${report.planning.scenarioAfter.score} · 情景变化 ${report.planning.scenarioAfter.scoreDelta >= 0 ? '+' : ''}${report.planning.scenarioAfter.scoreDelta}</p><table><thead><tr><th>灰区</th><th>优先级</th><th>建议类别</th><th>情景减少盲区网格</th></tr></thead><tbody>${planningRows}</tbody></table><ul>${(report.planning.assumptions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''
  const narrativeSection = report.narrative ? `<h2>结论摘要</h2><p><strong>${escapeHtml(report.narrative.headline)}</strong></p><p>${escapeHtml(report.narrative.finding)}</p><p>${escapeHtml(report.narrative.action)}</p><p class="muted">${escapeHtml(report.narrative.evidence)}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>邻里半径体检报告</title>
<style>body{margin:0;color:#1f3034;font:14px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#edf3f1}main{max-width:900px;margin:28px auto;padding:42px;background:#fff}header{display:flex;justify-content:space-between;gap:30px;border-bottom:3px solid #167f76;padding-bottom:24px}.score{font-size:52px;font-weight:800;color:#167f76;line-height:1}.muted{color:#71817f}h1{margin:0 0 8px;font-size:28px}h2{margin-top:30px;font-size:18px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #dde6e3;text-align:left}th{background:#f2f7f5}.meta{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 24px;margin-top:22px}.formula{padding:14px;background:#edf7f4;border-left:4px solid #167f76}@media print{body{background:#fff}main{margin:0;max-width:none;padding:18mm;box-shadow:none}@page{size:A4;margin:0}}</style></head>
<body><main><header><div><div class="muted">${escapeHtml(report.durationMinutes)} 分钟生活圈 · 民生设施体检</div><h1>${escapeHtml(report.address || '自定义中心点')}</h1><div>${escapeHtml(report.band.label)}</div></div><div><div class="score">${report.score}</div><div class="muted">综合分 / 100</div></div></header>
<section class="meta"><div><b>中心点：</b>${escapeHtml(`${report.center?.lng ?? '—'}, ${report.center?.lat ?? '—'} BD-09`)}</div><div><b>数据时间：</b>${escapeHtml(report.dataTimestampLabel)}</div><div><b>算法版本：</b>${escapeHtml(report.algorithmVersion)}</div><div><b>报告版本：</b>${escapeHtml(report.reportVersion)}</div><div><b>数据来源：</b>${escapeHtml(report.source)}</div><div><b>边界置信度：</b>${escapeHtml(report.confidence)}</div><div><b>边界复核：</b>${escapeHtml(`${report.boundaryVerification.withinToleranceCount}/${report.boundaryVerification.requestedDirections} 点达标`)}</div></section>
<h2>评分依据</h2><p class="formula">${escapeHtml(report.formula)}</p>
${narrativeSection}
<h2>分类设施覆盖</h2><table><thead><tr><th>设施类别</th><th>生活圈内数量</th><th>1 公里网格覆盖</th></tr></thead><tbody>${categoryRows}</tbody></table>
<h2>灰区清单</h2><table><thead><tr><th>灰区</th><th>缺失类别</th><th>面积</th><th>人口代理</th></tr></thead><tbody>${zoneRows}</tbody></table>
${planningSection}
<h2>限制与说明</h2><ul>${limitations}</ul><p class="muted">本报告的事实判断由确定性地图数据和算法生成；候选补点仅为灰区质心预览，不构成最终规划选址结论。</p>
</main></body></html>`
}
