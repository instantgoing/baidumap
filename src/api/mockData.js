const meta = (operation) => ({ requestId: `sample-${operation}-001`, durationMs: 18, source: 'sample-snapshot', capturedAt: '2026-09-10T09:00:00+08:00' })

function approximateDistance(origin, destination) {
  const latitude = ((origin.lat + destination.lat) / 2) * Math.PI / 180
  const east = (destination.lng - origin.lng) * 111320 * Math.cos(latitude)
  const north = (destination.lat - origin.lat) * 111320
  return Math.round(Math.hypot(east, north))
}

function offset(center, eastMeters, northMeters) {
  const latitude = center.lat * Math.PI / 180
  return {
    lng: center.lng + eastMeters / (111320 * Math.cos(latitude)),
    lat: center.lat + northMeters / 111320,
  }
}

function samplePoi(center, [uid, name, category, east, north, address]) {
  const location = offset(center, east, north)
  return {
    uid,
    name,
    category,
    categoryLabel: ({ market: '菜市场', pharmacy: '药店', primary_school: '小学', community_healthcare: '社区医疗', hospital: '综合医院', kindergarten: '幼儿园', eldercare: '养老服务', convenience_store: '便利店/超市' })[category],
    location,
    distance: approximateDistance(center, location),
    address,
    sourceKeyword: name,
    fetchedAt: '2026-09-10T09:00:00+08:00',
    qualityStatus: 'accepted',
  }
}

function zonePolygon(center, eastMeters, northMeters, widthMeters, heightMeters) {
  return [
    offset(center, eastMeters - widthMeters / 2, northMeters - heightMeters / 2),
    offset(center, eastMeters + widthMeters / 2, northMeters - heightMeters / 2),
    offset(center, eastMeters + widthMeters / 2, northMeters + heightMeters / 2),
    offset(center, eastMeters - widthMeters / 2, northMeters + heightMeters / 2),
    offset(center, eastMeters - widthMeters / 2, northMeters - heightMeters / 2),
  ]
}

function buildSampleAnalysis(center) {
  const pois = [
    ['market-1', '悦邻生鲜市集', 'market', -320, 180, '软件园一路 8 号'],
    ['market-2', '清河便民菜场', 'market', 460, -210, '清河中街 12 号'],
    ['market-3', '四季青农贸店', 'market', 90, 620, '友谊路 18 号'],
    ['pharmacy-1', '安心大药房', 'pharmacy', -180, -160, '软件园南街 6 号'],
    ['pharmacy-2', '同仁堂便民药店', 'pharmacy', 380, 260, '西二旗大街 21 号'],
    ['pharmacy-3', '百康药房', 'pharmacy', 40, -520, '清河路 9 号'],
    ['pharmacy-4', '邻里健康药房', 'pharmacy', -610, 30, '后厂村路 38 号'],
    ['school-1', '软件园实验小学', 'primary_school', -410, -390, '软件园二号路 3 号'],
    ['school-2', '清河第一小学', 'primary_school', 550, 420, '清河三街 15 号'],
    ['health-1', '社区卫生服务站', 'community_healthcare', 120, 180, '创业路 10 号'],
    ['health-2', '清河社区门诊', 'community_healthcare', -520, 410, '清河北街 5 号'],
    ['hospital-1', '海淀北部医疗中心', 'hospital', 720, -120, '上地十街 1 号'],
    ['kindergarten-1', '蒲公英幼儿园', 'kindergarten', -80, 370, '软件园西区 7 号'],
    ['kindergarten-2', '启航幼儿园', 'kindergarten', 330, -410, '安宁庄路 20 号'],
    ['eldercare-1', '和熹长者照护站', 'eldercare', -690, -250, '后厂村东路 16 号'],
    ['store-1', '便利蜂软件园店', 'convenience_store', 210, 60, '软件园一期'],
    ['store-2', '物美便利超市', 'convenience_store', -260, 510, '西二旗北路 2 号'],
    ['store-3', '京客隆社区店', 'convenience_store', 580, 40, '上地西路 19 号'],
  ].map((item) => samplePoi(center, item))
  const zones = [
    {
      id: 'gray-zone-northwest',
      polygon: zonePolygon(center, -720, 650, 360, 300),
      missingCategories: ['pharmacy', 'primary_school'],
      areaM2: 108000,
      populationProxy: 864,
      evidence: { cellCount: 12, facilityCounts: { market: 1, pharmacy: 0, primary_school: 0 }, boundaryCandidateCellCount: 4 },
    },
    {
      id: 'gray-zone-southeast',
      polygon: zonePolygon(center, 690, -610, 300, 330),
      missingCategories: ['market'],
      areaM2: 99000,
      populationProxy: 792,
      evidence: { cellCount: 11, facilityCounts: { market: 0, pharmacy: 1, primary_school: 1 }, boundaryCandidateCellCount: 3 },
    },
    {
      id: 'gray-zone-east',
      polygon: zonePolygon(center, 820, 170, 240, 250),
      missingCategories: ['primary_school'],
      areaM2: 60000,
      populationProxy: 480,
      evidence: { cellCount: 6, facilityCounts: { market: 1, pharmacy: 1, primary_school: 0 }, boundaryCandidateCellCount: 2 },
    },
  ]
  const categoryCounts = pois.reduce((counts, poi) => ({ ...counts, [poi.category]: (counts[poi.category] || 0) + 1 }), {})
  return {
    center,
    pois,
    serviceAreaPois: pois,
    quality: {
      rawCount: 26,
      dedupedCount: 21,
      duplicateCount: 5,
      excludedCount: 3,
      needsReviewCount: 1,
      inSearchAreaCount: pois.length,
      serviceAreaCount: pois.length,
      serviceAreaFilter: 'polygon',
      categoryCounts,
    },
    blindSpots: {
      zones,
      coverage: {
        market: { coverageRatio: 0.81, coveredCellCount: 92, missingCellCount: 21 },
        pharmacy: { coverageRatio: 0.86, coveredCellCount: 97, missingCellCount: 16 },
        primary_school: { coverageRatio: 0.72, coveredCellCount: 81, missingCellCount: 32 },
      },
      evidence: {
        gridCellCount: 113,
        blindCellCount: 32,
        populationDensityPerKm2: 8000,
        boundaryRecheck: { status: 'sample', method: 'recorded-snapshot', checkedCellCount: 9, failedCellCount: 0, candidateCellCount: 9 },
      },
      cells: [],
    },
    search: { queryTerms: ['菜市场', '药店', '小学'], radiusMeters: 2000, fetchedRawCount: 26, fetchedPages: 3, pageSize: 20, coordinateSystem: 'BD-09' },
  }
}

export function createMockApiClient() {
  return {
    async health() { return { ok: true, data: { status: 'ok', message: '样例适配器响应正常', baiduConfigured: false, baiduReachable: null }, meta: meta('health') } },
    async geocode({ address }) { return { ok: true, data: { address, location: { lng: 116.3074, lat: 40.0572 }, coordinateSystem: 'BD-09' }, meta: meta('geocode') } },
    async reverseGeocode({ location }) { return { ok: true, data: { location, formattedAddress: '北京市海淀区中关村软件园', addressComponent: { city: '北京市' } }, meta: meta('reverse-geocode') } },
    async convertCoordinates({ points, from = 'WGS84', to = 'BD-09' }) { return { ok: true, data: { points, from, to }, meta: meta('coordinate-convert') } },
    async searchPoi({ query, center, radius = 2000 }) { return { ok: true, data: { items: [{ uid: 'sample-poi-001', name: `样例${query}`, category: query, location: center, distance: 420 }], pagination: { page: 0, pageSize: 20, total: 1 }, radius }, meta: meta('poi-search') } },
    async analyzePois({ center }) { return { ok: true, data: buildSampleAnalysis(center), meta: meta('poi-analysis') } },
    async blindSpots({ center, pois = [] }) { const sample = buildSampleAnalysis(center); return { ok: true, data: { ...sample.blindSpots, evidence: { ...sample.blindSpots.evidence, source: 'sample-snapshot', center, poiCount: pois.length } }, meta: meta('blind-spots') } },
    async routeMatrix({ origin, destinations, mode = 'walking' }) { return { ok: true, data: { origin, destinations: destinations.map((location) => { const distance = approximateDistance(origin, location); return { location, duration: distance, distance, status: 'ok' } }), mode }, meta: meta('route-matrix') } },
    async walkingRoute({ origin, destination }) { const distance = approximateDistance(origin, destination); return { ok: true, data: { origin, destination, duration: distance, distance, path: [origin, destination], steps: [{ duration: distance, distance, path: [origin, destination], instruction: '离线直线路径' }], mode: 'walking' }, meta: meta('walking-route') } },
  }
}
