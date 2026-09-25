import { useEffect, useMemo, useRef, useState } from 'react'
import { loadBaiduMap } from './loadBaiduMap.js'
import {
  getBlindZoneVisual,
  getDurationBand,
  getPoiVisual,
  getZoneCode,
  MAP_LAYER_DEFAULTS,
  POI_CATEGORY_COLORS,
  selectAccessibleHeatSamples,
} from './mapLayers.js'

function coordinate(value) {
  if (Array.isArray(value)) return { lng: Number(value[0]), lat: Number(value[1]) }
  return { lng: Number(value?.lng), lat: Number(value?.lat) }
}

function validPoint(value) {
  const point = coordinate(value)
  return Number.isFinite(point.lng) && Number.isFinite(point.lat) ? point : null
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}

function mapErrorMessage(error, fallback) {
  const message = String(error?.message || '')
  if (/coordType|Cannot read properties of null/i.test(message)) return `${fallback}：百度地图 SDK 状态异常，请刷新页面后重试`
  return message || fallback
}

function durationColor(duration, targetDuration) {
  const progress = Math.max(0, Math.min(1, Number(duration || targetDuration) / Math.max(1, targetDuration)))
  if (progress <= 1 / 3) return '#2e9b74'
  if (progress <= 2 / 3) return '#d49a38'
  return '#cf5d54'
}

function shapeMarkup(shape, fillColor, symbol = '') {
  const common = `fill="${escapeHtml(fillColor)}" stroke="#263238" stroke-width="2.4"`
  const shapes = {
    circle: `<circle cx="18" cy="18" r="13" ${common}/>` ,
    square: `<rect x="5" y="5" width="26" height="26" rx="3" ${common}/>` ,
    round: `<rect x="4" y="7" width="28" height="22" rx="9" ${common}/>` ,
    diamond: `<path d="M18 3 33 18 18 33 3 18Z" ${common}/>` ,
    triangle: `<path d="M18 3 33 31H3Z" ${common}/>` ,
    hexagon: `<path d="M10 4H26L34 18 26 32H10L2 18Z" ${common}/>` ,
    cross: `<path d="M12 3H24V12H33V24H24V33H12V24H3V12H12Z" ${common}/>` ,
    star: `<path d="m18 2 4.6 10.2 11.1 1.2-8.3 7.5 2.3 11-9.7-5.6-9.7 5.6 2.3-11-8.3-7.5 11.1-1.2Z" ${common}/>` ,
  }
  const text = symbol ? `<text x="18" y="22" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="800" fill="#fff" stroke="#263238" stroke-width=".8" paint-order="stroke">${escapeHtml(symbol)}</text>` : ''
  return `${shapes[shape] || shapes.circle}${text}`
}

function svgDataUrl(shape, fillColor, symbol = '') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">${shapeMarkup(shape, fillColor, symbol)}</svg>`
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

function makeIcon(BMapGL, shape, fillColor, symbol, size = 36) {
  if (typeof BMapGL.Icon !== 'function' || typeof BMapGL.Size !== 'function') return null
  return new BMapGL.Icon(svgDataUrl(shape, fillColor, symbol), new BMapGL.Size(size, size), {
    anchor: new BMapGL.Size(size / 2, size / 2),
    imageSize: new BMapGL.Size(size, size),
  })
}

function addShapeMarker({ BMapGL, map, point, shape, color, symbol, size = 36, title, onClick }) {
  const icon = makeIcon(BMapGL, shape, color, symbol, size)
  const marker = icon && typeof BMapGL.Marker === 'function'
    ? new BMapGL.Marker(point, { icon })
    : new BMapGL.Circle(point, Math.max(10, size / 2), { strokeColor: '#263238', strokeWeight: 2, strokeOpacity: 1, fillColor: color, fillOpacity: 1 })
  marker.setTitle?.(title)
  if (onClick) marker.addEventListener?.('click', onClick)
  map.addOverlay(marker)
  return marker
}

function zonePoint(zone) {
  const centroid = validPoint(zone?.centroid)
  if (centroid) return centroid
  const points = (zone?.polygon || []).map(validPoint).filter(Boolean)
  if (!points.length) return null
  return {
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
  }
}

function zoneLabelOffset(index) {
  const offsets = [[0, -32], [34, -16], [34, 18], [0, 34], [-34, 18], [-34, -16], [0, 0]]
  return offsets[index % offsets.length]
}

function blindSurfaces(blindZones, blindCells) {
  const cells = blindCells.filter((cell) => cell?.isBlindSpot && Array.isArray(cell.polygon) && cell.polygon.length >= 3)
  return cells.length ? { exactCells: true, items: cells } : { exactCells: false, items: blindZones }
}

function collectPoints({ center, pois, blindZones, blindCells, isochrone, heatmap }) {
  const points = [validPoint(center)]
  ;(isochrone?.geometry?.coordinates?.[0] || []).forEach((point) => points.push(validPoint(point)))
  pois.forEach((poi) => points.push(validPoint(poi.location)))
  const blindGeometry = blindCells.some((cell) => cell?.isBlindSpot) ? blindCells.filter((cell) => cell?.isBlindSpot) : blindZones
  blindGeometry.forEach((item) => (item.polygon || []).forEach((point) => points.push(validPoint(point))))
  heatmap.forEach((sample) => points.push(validPoint(sample)))
  return points.filter(Boolean)
}

function OfflineShape({ shape, color, symbol }) {
  const common = { fill: color, stroke: '#263238', strokeWidth: 2.5 }
  return <>
    {shape === 'circle' && <circle cx="0" cy="0" r="13" {...common} />}
    {shape === 'square' && <rect x="-13" y="-13" width="26" height="26" rx="3" {...common} />}
    {shape === 'round' && <rect x="-15" y="-11" width="30" height="22" rx="9" {...common} />}
    {shape === 'diamond' && <path d="M0 -15 15 0 0 15-15 0Z" {...common} />}
    {shape === 'triangle' && <path d="M0 -15 15 13H-15Z" {...common} />}
    {shape === 'hexagon' && <path d="M-9 -14H9L17 0 9 14H-9L-17 0Z" {...common} />}
    {shape === 'cross' && <path d="M-6 -15H6V-6H15V6H6V15H-6V6H-15V-6H-6Z" {...common} />}
    {shape === 'star' && <path d="M0-16 4-6 15-5 7 2 9 13 0 7-9 13-7 2-15-5-4-6Z" {...common} />}
    {symbol && <text x="0" y="4" textAnchor="middle" fontSize="10" fontWeight="800" fill="#fff" stroke="#263238" strokeWidth=".8" paintOrder="stroke">{symbol}</text>}
  </>
}

function OfflineHeatSymbol({ point, band, color, label }) {
  return <g transform={`translate(${point.x} ${point.y})`} className={`map-time-sample map-time-sample--${band.id}`}>
    <OfflineShape shape={band.shape} color={color} />
    <title>{label}</title>
  </g>
}

function OfflineMap({ center, pois, blindZones, blindCells, isochrone, heatmap, layers, targetDurationSeconds, selectedZoneId, onSelectZone, onSelectPoint, fallbackMessage = '' }) {
  const allPoints = useMemo(() => collectPoints({ center, pois, blindZones, blindCells, isochrone, heatmap }), [center, pois, blindZones, blindCells, isochrone, heatmap])
  const bounds = useMemo(() => {
    const lngs = allPoints.map((point) => point.lng)
    const lats = allPoints.map((point) => point.lat)
    const fallbackLng = Number(center?.lng || 116.3)
    const fallbackLat = Number(center?.lat || 40)
    const minimumLng = Math.min(...lngs, fallbackLng - 0.012)
    const maximumLng = Math.max(...lngs, fallbackLng + 0.012)
    const minimumLat = Math.min(...lats, fallbackLat - 0.009)
    const maximumLat = Math.max(...lats, fallbackLat + 0.009)
    const lngPadding = Math.max((maximumLng - minimumLng) * 0.12, 0.001)
    const latPadding = Math.max((maximumLat - minimumLat) * 0.12, 0.001)
    return { minimumLng: minimumLng - lngPadding, maximumLng: maximumLng + lngPadding, minimumLat: minimumLat - latPadding, maximumLat: maximumLat + latPadding }
  }, [allPoints, center])
  const project = (value) => {
    const point = validPoint(value)
    if (!point) return null
    return {
      x: (point.lng - bounds.minimumLng) / (bounds.maximumLng - bounds.minimumLng) * 1000,
      y: 600 - (point.lat - bounds.minimumLat) / (bounds.maximumLat - bounds.minimumLat) * 600,
    }
  }
  const mapCenter = project(center)
  const boundary = (isochrone?.geometry?.coordinates?.[0] || []).map(project).filter(Boolean)
  const boundaryLabel = boundary.length ? boundary.reduce((top, point) => point.y < top.y ? point : top, boundary[0]) : null
  const surfaces = blindSurfaces(blindZones, blindCells)
  const visibleHeatmap = selectAccessibleHeatSamples(heatmap, targetDurationSeconds)
  const selectAtPointer = (event) => {
    if (!onSelectPoint) return
    const svg = event.currentTarget
    const transform = svg.getScreenCTM()
    if (!transform) return
    const pointer = svg.createSVGPoint()
    pointer.x = event.clientX
    pointer.y = event.clientY
    const point = pointer.matrixTransform(transform.inverse())
    const viewBox = svg.viewBox.baseVal
    const x = (point.x - viewBox.x) / viewBox.width
    const y = (point.y - viewBox.y) / viewBox.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    onSelectPoint({
      lng: bounds.minimumLng + x * (bounds.maximumLng - bounds.minimumLng),
      lat: bounds.maximumLat - y * (bounds.maximumLat - bounds.minimumLat),
    })
  }

  return (
    <div className="baidu-map-shell offline-map-shell baidu-map-shell--accessible">
      <svg className="offline-map" viewBox="0 0 1000 600" role="img" aria-label="离线样例地图，可点击重新选择中心点" onClick={selectAtPointer}>
        <defs>
          <pattern id="map-grid" width="55" height="55" patternUnits="userSpaceOnUse"><path d="M55 0H0V55" fill="none" stroke="#dce7e3" strokeWidth="1" /></pattern>
          <pattern id="blind-single" width="15" height="15" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="15" height="15" fill="#f4f4f1" fillOpacity=".76" /><line x1="0" y1="0" x2="0" y2="15" stroke="#4d5557" strokeWidth="3" /></pattern>
          <pattern id="blind-double" width="14" height="14" patternUnits="userSpaceOnUse"><rect width="14" height="14" fill="#ecece8" fillOpacity=".82" /><path d="M-2 2 2-2M0 14 14 0M12 16 16 12M-2 12 2 16M0 0 14 14M12-2 16 2" stroke="#3f4749" strokeWidth="2.2" /></pattern>
          <pattern id="blind-triple" width="11" height="11" patternUnits="userSpaceOnUse"><rect width="11" height="11" fill="#deded9" fillOpacity=".9" /><path d="M0 0H11M0 5.5H11M0 11H11M0 0V11M5.5 0V11M11 0V11" stroke="#303739" strokeWidth="1.5" /></pattern>
        </defs>
        <rect width="1000" height="600" fill="#edf3f0" />
        <rect width="1000" height="600" fill="url(#map-grid)" />
        <path d="M-40 455 C170 360 310 510 520 390 S840 290 1040 350" fill="none" stroke="#bdd9df" strokeWidth="34" opacity=".72" />
        <path d="M-30 168 C190 230 302 80 560 172 S790 315 1030 205" fill="none" stroke="#fff" strokeWidth="20" opacity=".9" />
        <path d="M90 -30 L475 630 M720 -30 L560 630" fill="none" stroke="#fff" strokeWidth="13" opacity=".84" />
        {layers.heatmap && visibleHeatmap.map((sample, index) => {
          const point = project(sample)
          if (!point) return null
          const band = getDurationBand(sample.duration, targetDurationSeconds)
          return <OfflineHeatSymbol key={`heat-${index}`} point={point} band={band} color={durationColor(sample.duration, targetDurationSeconds)} label={`步行耗时 ${Math.round(Number(sample.duration || 0) / 60)} 分钟，${band.label}`} />
        })}
        {layers.isochrone && boundary.length >= 3 && <polygon points={boundary.map((point) => `${point.x},${point.y}`).join(' ')} fill="rgba(255,255,255,.03)" stroke="#183c39" strokeWidth={7} strokeDasharray="18 9" />}
        {layers.isochrone && boundaryLabel && <g transform={`translate(${Math.min(850, Math.max(145, boundaryLabel.x))} ${Math.max(30, boundaryLabel.y - 14)})`} className="map-time-boundary-label"><rect x="-112" y="-18" width="224" height="34" rx="8" /><text x="0" y="5" textAnchor="middle">◷ {Math.round(targetDurationSeconds / 60)} 分钟步行边界</text></g>}
        {layers.blindZones && surfaces.items.map((item, index) => {
          const points = (item.polygon || []).map(project).filter(Boolean)
          if (points.length < 3) return null
          const visual = getBlindZoneVisual(item.missingCategories)
          return <polygon key={`blind-surface-${index}`} points={points.map((point) => `${point.x},${point.y}`).join(' ')} fill={`url(#blind-${visual.pattern})`} stroke={surfaces.exactCells ? '#777d7e' : '#343b3d'} strokeWidth={surfaces.exactCells ? .55 : 3} />
        })}
        {layers.blindZones && blindZones.map((zone, index) => {
          const point = project(zonePoint(zone))
          if (!point) return null
          const visual = getBlindZoneVisual(zone.missingCategories)
          const selected = zone.id === selectedZoneId
          const [offsetX, offsetY] = zoneLabelOffset(index)
          const selectZone = (event) => { event.stopPropagation(); onSelectZone?.(zone.id) }
          return <g key={`zone-label-${zone.id || index}`} className={`map-zone-tag map-zone-tag--${visual.pattern}${selected ? ' is-selected' : ''}`} transform={`translate(${point.x + offsetX} ${point.y + offsetY})`} role="button" tabIndex="0" aria-label={`${getZoneCode(index)}，缺少 ${visual.missingLabels.join('、')}`} onClick={selectZone} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectZone(event) } }}>
            <rect x="-31" y="-18" width="62" height="36" rx="7" />
            <text className="map-zone-tag__title" x="0" y="-3" textAnchor="middle">{getZoneCode(index)}</text>
            <text className="map-zone-tag__detail" x="0" y="11" textAnchor="middle">缺：{visual.missingLabels.join('、')}</text>
          </g>
        })}
        {layers.blindZones && selectedZoneId && blindZones.filter((zone) => zone.id === selectedZoneId).map((zone) => {
          const points = (zone.polygon || []).map(project).filter(Boolean)
          return points.length >= 3 && <polygon key={`selected-${zone.id}`} points={points.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#101719" strokeWidth="8" strokeDasharray="3 4" pointerEvents="none" />
        })}
        {layers.pois && pois.slice(0, 150).map((poi, index) => {
          const point = project(poi.location)
          if (!point) return null
          const visual = getPoiVisual(poi.category)
          return <g key={poi.uid || index} transform={`translate(${point.x} ${point.y})`}><OfflineShape shape={visual.shape} color={POI_CATEGORY_COLORS[poi.category] || '#647377'} symbol={visual.symbol} /><title>{`${poi.name} · ${poi.categoryLabel || visual.label}`}</title></g>
        })}
        {mapCenter && <g transform={`translate(${mapCenter.x} ${mapCenter.y})`}><circle r="22" fill="#fff" opacity=".9" /><circle r="13" fill="#0e837b" stroke="#152e2d" strokeWidth="4" /><circle r="34" fill="none" stroke="#152e2d" strokeWidth="3" /><path d="M-7 0H7M0-7V7" stroke="#fff" strokeWidth="3" /></g>}
        <text x="22" y="574" fill="#465552" fontSize="16">离线样例底图 · 点击地图可重新选点 · 坐标 BD-09</text>
      </svg>
      {fallbackMessage && <div className="map-sdk-state map-sdk-state--error" role="alert">{fallbackMessage}；已自动切换到可交互离线底图。</div>}
      <div className="map-sdk-badge map-sdk-badge--sample">OFFLINE SNAPSHOT · 可交互</div>
    </div>
  )
}

function createZoneTag(zone, index, selected, onSelect) {
  const visual = getBlindZoneVisual(zone.missingCategories)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `map-zone-dom-tag map-zone-dom-tag--${visual.pattern}${selected ? ' is-selected' : ''}`
  button.setAttribute('aria-label', `${getZoneCode(index)}，缺少 ${visual.missingLabels.join('、')}`)
  button.title = `${getZoneCode(index)}：缺少 ${visual.missingLabels.join('、')}`
  const title = document.createElement('strong')
  title.textContent = getZoneCode(index)
  const detail = document.createElement('span')
  detail.textContent = `缺：${visual.missingLabels.join('、')}`
  button.append(title, detail)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onSelect?.(zone.id)
  })
  return button
}

function addDomPointOverlay({ BMapGL, map, location, element, offsetX = 0, offsetY = 0 }) {
  const point = new BMapGL.Point(location.lng, location.lat)
  if (typeof BMapGL.CustomOverlay === 'function') {
    const overlay = new BMapGL.CustomOverlay(() => element, { point, offsetX, offsetY, enableDraggingMap: true })
    map.addOverlay(overlay)
    return overlay
  }
  if (typeof BMapGL.Label === 'function') {
    const label = new BMapGL.Label(element.textContent, { position: point })
    label.setStyle?.({ color: '#172124', backgroundColor: '#fff', border: '2px solid #172124', borderRadius: '5px', padding: '4px 7px', fontWeight: '700' })
    map.addOverlay(label)
    return label
  }
  return null
}

export default function BaiduMap({
  browserAk,
  center,
  pois = [],
  blindZones = [],
  blindCells = [],
  isochrone,
  heatmap = [],
  layers = MAP_LAYER_DEFAULTS,
  targetDurationSeconds = 900,
  selectedZoneId = null,
  onSelectZone,
  onSelectPoint,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const apiRef = useRef(null)
  const onSelectPointRef = useRef(onSelectPoint)
  const onSelectZoneRef = useRef(onSelectZone)
  const [status, setStatus] = useState({ state: browserAk ? 'loading' : 'sample', message: browserAk ? '正在加载百度地图…' : '离线样例地图已就绪' })

  useEffect(() => { onSelectPointRef.current = onSelectPoint }, [onSelectPoint])
  useEffect(() => { onSelectZoneRef.current = onSelectZone }, [onSelectZone])

  useEffect(() => {
    if (!browserAk) {
      setStatus({ state: 'sample', message: '离线样例地图已就绪' })
      return undefined
    }
    let active = true
    loadBaiduMap(browserAk).then((BMapGL) => {
      if (!active || !containerRef.current || mapRef.current) return
      try {
        const map = new BMapGL.Map(containerRef.current)
        const initial = validPoint(center) || { lng: 116.404, lat: 39.915 }
        map.centerAndZoom(new BMapGL.Point(initial.lng, initial.lat), 15)
        map.enableScrollWheelZoom(true)
        try {
          map.addControl(new BMapGL.NavigationControl3D())
          map.addControl(new BMapGL.ScaleControl())
        } catch { /* Controls are optional across JSAPI builds. */ }
        map.addEventListener('click', (event) => {
          const point = event.latlng || event.point
          if (point && onSelectPointRef.current) onSelectPointRef.current({ lng: Number(point.lng), lat: Number(point.lat) })
        })
        apiRef.current = BMapGL
        mapRef.current = map
        setStatus({ state: 'ready', message: '真实百度地图已加载，点击地图可重新选点' })
      } catch (error) {
        apiRef.current = null
        mapRef.current = null
        setStatus({ state: 'error', message: mapErrorMessage(error, '百度地图初始化失败') })
      }
    }).catch((error) => {
      if (active) setStatus({ state: 'error', message: error.message })
    })
    return () => { active = false }
  }, [browserAk, center])

  useEffect(() => {
    let errorTimer
    const BMapGL = apiRef.current
    const map = mapRef.current
    const mapCenter = validPoint(center)
    if (status.state !== 'ready' || !BMapGL || !map || !mapCenter) return undefined
    try {
      map.clearOverlays()
      const viewport = [new BMapGL.Point(mapCenter.lng, mapCenter.lat)]

      if (layers.heatmap) {
        const visibleHeatmap = selectAccessibleHeatSamples(heatmap, targetDurationSeconds)
        visibleHeatmap.forEach((sample) => {
          const location = validPoint(sample)
          if (!location) return
          const point = new BMapGL.Point(location.lng, location.lat)
          const band = getDurationBand(sample.duration, targetDurationSeconds)
          addShapeMarker({ BMapGL, map, point, shape: band.shape, color: durationColor(sample.duration, targetDurationSeconds), symbol: '', size: 22, title: `步行耗时 ${Math.round(Number(sample.duration || 0) / 60)} 分钟，${band.label}` })
        })
      }

      const boundary = isochrone?.geometry?.coordinates?.[0] || []
      const validBoundary = boundary.map(validPoint).filter(Boolean)
      const boundaryPoints = validBoundary.map((point) => new BMapGL.Point(point.lng, point.lat))
      if (layers.isochrone && boundaryPoints.length >= 3) {
        map.addOverlay(new BMapGL.Polygon(boundaryPoints, { strokeColor: '#183c39', strokeWeight: 4, strokeOpacity: 1, strokeStyle: 'dashed', fillColor: '#ffffff', fillOpacity: 0.03 }))
        viewport.push(...boundaryPoints)
        if (typeof document !== 'undefined') {
          const north = validBoundary.reduce((top, point) => point.lat > top.lat ? point : top, validBoundary[0])
          const label = document.createElement('div')
          label.className = 'map-time-dom-label'
          label.textContent = `◷ ${Math.round(targetDurationSeconds / 60)} 分钟步行边界`
          addDomPointOverlay({ BMapGL, map, location: north, element: label, offsetX: -76, offsetY: -34 })
        }
      }

      if (layers.blindZones) {
        const surfaces = blindSurfaces(blindZones, blindCells)
        surfaces.items.forEach((item) => {
          const points = (item.polygon || []).map(validPoint).filter(Boolean).map((point) => new BMapGL.Point(point.lng, point.lat))
          if (points.length < 3) return
          const visual = getBlindZoneVisual(item.missingCategories)
          const opacity = [0.13, 0.22, 0.31][visual.severity - 1]
          const polygon = new BMapGL.Polygon(points, {
            strokeColor: surfaces.exactCells ? '#6e7475' : '#343b3d',
            strokeWeight: surfaces.exactCells ? 1 : 3,
            strokeOpacity: surfaces.exactCells ? 0.45 : 1,
            strokeStyle: visual.severity === 1 ? 'dashed' : 'solid',
            fillColor: '#555c5e',
            fillOpacity: opacity,
          })
          polygon.setTitle?.(`服务灰区：缺少 ${visual.missingLabels.join('、')}`)
          map.addOverlay(polygon)
          viewport.push(...points)
        })

        if (typeof document !== 'undefined') blindZones.slice(0, 24).forEach((zone, index) => {
          const location = zonePoint(zone)
          if (!location) return
          const [labelOffsetX, labelOffsetY] = zoneLabelOffset(index)
          const tag = createZoneTag(zone, index, zone.id === selectedZoneId, (zoneId) => onSelectZoneRef.current?.(zoneId))
          addDomPointOverlay({ BMapGL, map, location, element: tag, offsetX: -31 + labelOffsetX, offsetY: -18 + labelOffsetY })
        })

        const selectedZone = blindZones.find((zone) => zone.id === selectedZoneId)
        if (selectedZone) {
          const points = (selectedZone.polygon || []).map(validPoint).filter(Boolean).map((point) => new BMapGL.Point(point.lng, point.lat))
          if (points.length >= 3) map.addOverlay(new BMapGL.Polygon(points, { strokeColor: '#101719', strokeWeight: 5, strokeOpacity: 1, strokeStyle: 'dashed', fillOpacity: 0 }))
        }
      }

      if (layers.pois) pois.slice(0, 150).forEach((poi) => {
        const location = validPoint(poi.location)
        if (!location) return
        const point = new BMapGL.Point(location.lng, location.lat)
        const visual = getPoiVisual(poi.category)
        addShapeMarker({
          BMapGL,
          map,
          point,
          shape: visual.shape,
          color: POI_CATEGORY_COLORS[poi.category] || '#657477',
          symbol: visual.symbol,
          title: `${poi.name} · ${poi.categoryLabel || visual.label}`,
          onClick: () => {
            const title = escapeHtml(poi.name)
            const address = escapeHtml(poi.address || '暂无地址')
            const category = escapeHtml(poi.categoryLabel || visual.label)
            map.openInfoWindow(new BMapGL.InfoWindow(`<strong>${title}</strong><br>${category}<br><small>${address}</small>`, { width: 230, title: '民生设施 POI' }), point)
          },
        })
        viewport.push(point)
      })

      const centerPoint = viewport[0]
      addShapeMarker({ BMapGL, map, point: centerPoint, shape: 'circle', color: '#0e837b', symbol: '中', size: 44, title: '分析中心点' })
      if (viewport.length > 1) map.setViewport(viewport, { margins: [45, 45, 45, 45] })
      else map.centerAndZoom(centerPoint, 15)
    } catch (error) {
      apiRef.current = null
      mapRef.current = null
      errorTimer = globalThis.setTimeout(() => setStatus({ state: 'error', message: mapErrorMessage(error, '百度地图覆盖物渲染失败') }), 0)
    }
    return () => globalThis.clearTimeout(errorTimer)
  }, [center, pois, blindZones, blindCells, isochrone, heatmap, layers, targetDurationSeconds, selectedZoneId, status.state])

  if (!browserAk || status.state === 'error') return <OfflineMap center={center} pois={pois} blindZones={blindZones} blindCells={blindCells} isochrone={isochrone} heatmap={heatmap} layers={layers} targetDurationSeconds={targetDurationSeconds} selectedZoneId={selectedZoneId} onSelectZone={onSelectZone} onSelectPoint={onSelectPoint} fallbackMessage={status.state === 'error' ? status.message : ''} />

  return (
    <div className="baidu-map-shell baidu-map-shell--accessible">
      <div ref={containerRef} className="baidu-map-canvas" aria-label="百度地图真实数据视图" />
      {status.state !== 'ready' && <div className={`map-sdk-state map-sdk-state--${status.state}`}>{status.message}</div>}
      {status.state === 'ready' && <div className="map-sdk-badge">Baidu JSAPI GL · BD-09</div>}
    </div>
  )
}
