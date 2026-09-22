import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { appConfig, getRuntimeSummary } from './config/appConfig.js'
import { createAppClient } from './api/client.js'
import { presentApiError } from './api/errorPresentation.js'
import { createIsochroneEngine } from './engine/isochrone.js'
import BaiduMap from './map/BaiduMap.jsx'
import { getBlindZoneVisual, getDurationBand, getPoiVisual, getZoneCode, MAP_LAYER_DEFAULTS, POI_CATEGORY_COLORS } from './map/mapLayers.js'
import { buildReportHtml, buildReportModel, REPORT_CATEGORY_LABELS } from './report/reportModel.js'
import './App.css'

const DEFAULT_ADDRESS = '北京市海淀区中关村软件园'
const DEFAULT_CENTER = { lng: 116.284206, lat: 40.051819 }
const DURATION_OPTIONS = [5, 10, 15, 20]
const REQUIRED_CATEGORIES = ['market', 'pharmacy', 'primary_school']
const FAST_ANALYSIS_DIRECTIONS = 12
const FAST_ANALYSIS_MAX_PAGES = 3

const navItems = [
  { id: 'overview', label: '分析总览', icon: '⌂' },
  { id: 'analysis', label: '生活圈分析', icon: '◎' },
  { id: 'report', label: '体检报告', icon: '▥' },
  { id: 'diagnostics', label: 'API 诊断', icon: '⌁' },
  { id: 'settings', label: '运行配置', icon: '⚙' },
]

const diagnosticItems = [
  { id: 'geocode', label: '地理编码', description: '真实地址 → BD-09 坐标', icon: '⌖' },
  { id: 'reverseGeocode', label: '逆地理编码', description: 'BD-09 坐标 → 真实地址', icon: '◎' },
  { id: 'coordinateConvert', label: '坐标转换', description: 'WGS84 → BD-09', icon: '⇢' },
  { id: 'poi', label: '地点检索', description: '真实地点检索与分页清洗', icon: '⌘' },
  { id: 'routeMatrix', label: '步行 RouteMatrix', description: '真实路网距离与耗时', icon: '⇄' },
  { id: 'walkingRoute', label: '步行单路线', description: '路线分段几何与边界截点依据', icon: '↝' },
  { id: 'blindSpots', label: 'P3 聚合分析', description: '真实 POI → 三类设施盲区', icon: '▧' },
]

const layerOptions = [
  { id: 'isochrone', label: '步行范围', mark: 'ring' },
  { id: 'heatmap', label: '走路快慢', mark: 'heat' },
  { id: 'pois', label: '附近设施', mark: 'poi' },
  { id: 'blindZones', label: '缺东西的地方', mark: 'blind' },
]

function formatTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value)
}

function formatNumber(value, digits = 0) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—'
}

function polygonFromIsochrone(result) {
  const boundary = result?.geojson?.geometry?.coordinates?.[0] || []
  return boundary.map((point) => Array.isArray(point) ? { lng: Number(point[0]), lat: Number(point[1]) } : { lng: Number(point.lng), lat: Number(point.lat) })
    .filter((point) => Number.isFinite(point.lng) && Number.isFinite(point.lat))
}

function candidateDistancesForMinutes(minutes) {
  const maximum = Math.max(800, Math.round(minutes * 110))
  return [0.2, 0.4, 0.6, 0.8, 1].map((ratio) => Math.round(maximum * ratio / 50) * 50)
}

function fastCandidateDistancesForMinutes(minutes) {
  const maximum = Math.max(800, Math.round(minutes * 110))
  return [0.25, 0.5, 0.75, 1].map((ratio) => Math.round(maximum * ratio / 50) * 50)
}

function StatusPill({ tone = 'neutral', children }) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>
}

export default function App() {
  const [activeView, setActiveView] = useState('analysis')
  const [health, setHealth] = useState({ status: 'idle', checkedAt: null, message: '', data: null })
  const [diagnostics, setDiagnostics] = useState({})
  const [isChecking, setIsChecking] = useState(false)
  const [isRunning, setIsRunning] = useState(null)
  const [address, setAddress] = useState(DEFAULT_ADDRESS)
  const [center, setCenter] = useState(DEFAULT_CENTER)
  const [selectionSource, setSelectionSource] = useState('address')
  const [durationMinutes, setDurationMinutes] = useState(15)
  const [layers, setLayers] = useState({ ...MAP_LAYER_DEFAULTS })
  const [highDiscernibility, setHighDiscernibility] = useState(true)
  const [selectedZoneId, setSelectedZoneId] = useState(null)
  const [analysis, setAnalysis] = useState({ status: 'idle', result: null, message: '', warning: '', failure: null, completedAt: null })
  const [isochrone, setIsochrone] = useState({ status: 'idle', result: null, message: '' })
  const analysisControllerRef = useRef(null)
  const client = useMemo(() => createAppClient(appConfig), [])
  const runtime = useMemo(() => getRuntimeSummary(appConfig), [])

  const runHealthCheck = useCallback(async () => {
    setIsChecking(true)
    setHealth({ status: 'checking', checkedAt: null, message: runtime.mode === 'online' ? '正在实时验证百度 Web Service API…' : '正在验证离线样例适配器…', data: null })
    try {
      const result = await client.health({ verify: runtime.mode === 'online' })
      const healthy = result.data?.status === 'ok' && result.data?.baiduReachable !== false
      setHealth({ status: healthy ? 'healthy' : 'error', checkedAt: new Date(), message: result.data?.message || '服务响应正常', data: result.data })
    } catch (error) {
      setHealth({ status: 'error', checkedAt: new Date(), message: presentApiError(error).summary, data: null })
    } finally {
      setIsChecking(false)
    }
  }, [client, runtime.mode])

  useEffect(() => { runHealthCheck() }, [runHealthCheck])

  const calculateIsochrone = useCallback(async (analysisCenter, signal, mode = 'full') => {
    const fast = mode === 'fast'
    const background = mode === 'background'
    const targetDurationSeconds = durationMinutes * 60
    setIsochrone((current) => ({
      status: background ? 'refining' : 'running',
      result: background ? current.result : null,
      message: fast ? '正在快速估算步行范围…' : background ? '快速范围已显示，正在后台精细复核…' : `正在计算 ${durationMinutes} 分钟步行范围…`,
    }))
    const engine = createIsochroneEngine({
      routeMatrix: (options) => client.routeMatrix({ ...options, signal }),
      walkingRoute: fast ? undefined : (options) => client.walkingRoute({ ...options, signal }),
      config: fast ? {
        ...appConfig.isochrone,
        targetDurationSeconds,
        directions: FAST_ANALYSIS_DIRECTIONS,
        maxDirections: FAST_ANALYSIS_DIRECTIONS,
        candidateDistancesMeters: fastCandidateDistancesForMinutes(durationMinutes),
        boundaryToleranceSeconds: 120,
        spatialToleranceMeters: 500,
        maxRefinementRounds: 0,
        verificationDirections: 0,
        singleRouteRecheckRounds: 0,
      } : { ...appConfig.isochrone, targetDurationSeconds, candidateDistancesMeters: candidateDistancesForMinutes(durationMinutes) },
    })
    const result = await engine.calculate({ center: analysisCenter })
    setIsochrone({ status: 'success', result, message: fast ? '快速步行范围已生成' : '步行范围已完善' })
    return result
  }, [client, durationMinutes])

  const runIsochrone = useCallback(async () => {
    try {
      await calculateIsochrone(center)
    } catch (error) {
      setIsochrone({ status: 'error', result: null, message: presentApiError(error).summary })
    }
  }, [calculateIsochrone, center])

  const runAnalysis = useCallback(async () => {
    analysisControllerRef.current?.abort()
    const controller = new AbortController()
    analysisControllerRef.current = controller
    setSelectedZoneId(null)
    setAnalysis({ status: 'geocoding', result: null, message: '正在确认位置…', warning: '', failure: null, completedAt: null })
    let analysisCenter = center
    try {
      if (selectionSource === 'address') {
        const geocoded = await client.geocode({ address: address.trim(), signal: controller.signal })
        if (controller.signal.aborted) return
        analysisCenter = geocoded.data.location
        setCenter(analysisCenter)
        setSelectionSource('resolved')
      }

      let areaPolygon
      let fastIsochrone
      try {
        setAnalysis({ status: 'isochrone', result: null, message: `正在快速计算 ${durationMinutes} 分钟步行范围…`, warning: '', failure: null, completedAt: null })
        fastIsochrone = await calculateIsochrone(analysisCenter, controller.signal, 'fast')
        if (controller.signal.aborted) return
        areaPolygon = polygonFromIsochrone(fastIsochrone)
      } catch (error) {
        if (controller.signal.aborted || error?.kind === 'cancelled') throw error
        const failure = presentApiError(error)
        setIsochrone({ status: 'error', result: null, message: failure.summary })
        areaPolygon = undefined
      }

      setAnalysis({ status: 'poi', result: null, message: '正在快速查找附近设施…', warning: '', failure: null, completedAt: null })
      const fastResult = await client.analyzePois({ center: analysisCenter, areaPolygon, searchRadiusMeters: 2000, analysisRadiusMeters: 1000, gridSpacingMeters: 150, boundaryRecheck: false, maxPages: FAST_ANALYSIS_MAX_PAGES, signal: controller.signal })
      if (controller.signal.aborted) return
      setAnalysis({ status: 'refining', result: fastResult, message: `快速结果已显示：找到 ${fastResult.data.quality.inSearchAreaCount} 个设施。正在后台完善路线和边界复核…`, warning: '当前为快速结果，后台完善后会自动更新。', failure: null, completedAt: null })

      let refinedIsochrone
      let backgroundWarning = ''
      try {
        refinedIsochrone = await calculateIsochrone(analysisCenter, controller.signal, 'background')
        if (controller.signal.aborted) return
      } catch (error) {
        if (controller.signal.aborted || error?.kind === 'cancelled') throw error
        backgroundWarning = '精细步行范围复核未完成，已保留快速结果。'
        setIsochrone(fastIsochrone
          ? { status: 'success', result: fastIsochrone, message: '精细复核未完成，已保留快速步行范围' }
          : { status: 'error', result: null, message: '步行范围复核未完成' })
      }

      try {
        const refinedPolygon = polygonFromIsochrone(refinedIsochrone)
        const refinedResult = await client.analyzePois({ center: analysisCenter, areaPolygon: refinedPolygon.length ? refinedPolygon : areaPolygon, searchRadiusMeters: 2000, analysisRadiusMeters: 1000, gridSpacingMeters: 150, boundaryRecheck: true, maxPages: 8, signal: controller.signal })
        if (controller.signal.aborted) return
        setAnalysis({ status: backgroundWarning ? 'degraded' : 'success', result: refinedResult, message: `分析完成：找到 ${refinedResult.data.quality.inSearchAreaCount} 个设施，发现 ${refinedResult.data.blindSpots.zones.length} 个缺设施区域`, warning: backgroundWarning, failure: null, completedAt: new Date().toISOString() })
      } catch (error) {
        if (controller.signal.aborted || error?.kind === 'cancelled') throw error
        if (fastIsochrone) setIsochrone({ status: 'success', result: fastIsochrone, message: '边界复核未完成，已保留快速步行范围' })
        setAnalysis({ status: 'degraded', result: fastResult, message: '快速分析已完成，后台边界复核未完成。', warning: '当前保留快速结果，可稍后重新分析。', failure: null, completedAt: new Date().toISOString() })
      }
    } catch (error) {
      if (controller.signal.aborted || error?.kind === 'cancelled') return
      const failure = presentApiError(error)
      setAnalysis((current) => ({ ...current, status: 'error', result: null, message: failure.detail, failure }))
    } finally {
      if (analysisControllerRef.current === controller) analysisControllerRef.current = null
    }
  }, [address, calculateIsochrone, center, client, durationMinutes, selectionSource])

  const stopAnalysis = useCallback(() => {
    analysisControllerRef.current?.abort()
    analysisControllerRef.current = null
    setAnalysis({ status: 'idle', result: null, message: '已停止当前搜索，修改地址后可重新分析', warning: '', failure: null, completedAt: null })
    setIsochrone({ status: 'idle', result: null, message: '' })
  }, [])

  const selectPoint = useCallback(async (location, source = 'map') => {
    setSelectedZoneId(null)
    setCenter(location)
    setSelectionSource(source)
    setAnalysis({ status: 'idle', result: null, message: '中心点已更新，请重新运行分析', warning: '', failure: null, completedAt: null })
    setIsochrone({ status: 'idle', result: null, message: '' })
    try {
      const result = await client.reverseGeocode({ location })
      if (result.data.formattedAddress) setAddress(result.data.formattedAddress)
    } catch {
      // A valid BD-09 center remains usable when reverse geocoding is unavailable.
    }
  }, [client])

  const changeDuration = useCallback((minutes) => {
    setSelectedZoneId(null)
    setDurationMinutes(minutes)
    setAnalysis({ status: 'idle', result: null, message: `已切换为 ${minutes} 分钟，请重新运行分析`, warning: '', failure: null, completedAt: null })
    setIsochrone({ status: 'idle', result: null, message: '' })
  }, [])

  const toggleLayer = useCallback((layer) => setLayers((current) => ({ ...current, [layer]: !current[layer] })), [])

  const runDiagnostic = useCallback(async (item) => {
    setIsRunning(item.id)
    try {
      let result
      if (item.id === 'geocode') result = await client.geocode({ address: DEFAULT_ADDRESS })
      else if (item.id === 'reverseGeocode') result = await client.reverseGeocode({ location: center })
      else if (item.id === 'coordinateConvert') result = await client.convertCoordinates({ points: [{ lng: 116.397, lat: 39.908 }], from: 'WGS84', to: 'BD-09' })
      else if (item.id === 'poi') result = await client.searchPoi({ query: '菜市场$药店$小学', center, radius: 2000, maxPages: 8 })
      else if (item.id === 'blindSpots') result = await client.analyzePois({ center, gridSpacingMeters: 200, boundaryRecheck: false })
      else if (item.id === 'walkingRoute') result = await client.walkingRoute({ origin: center, destination: { lng: center.lng + 0.012, lat: center.lat + 0.009 } })
      else result = await client.routeMatrix({ origin: center, destinations: [{ lng: center.lng + 0.006, lat: center.lat + 0.004 }], mode: 'walking' })
      let message = '响应结构校验通过'
      if (item.id === 'poi') message = `${result.data.quality.inAreaCount} 个有效 POI，去重 ${result.data.quality.duplicateCount} 个`
      if (item.id === 'blindSpots') message = `${result.data.pois.length} 个 POI，${result.data.blindSpots.zones.length} 个灰区`
      setDiagnostics((current) => ({ ...current, [item.id]: { status: 'success', result, message } }))
    } catch (error) {
      setDiagnostics((current) => ({ ...current, [item.id]: { status: 'error', message: presentApiError(error).summary, error } }))
    } finally {
      setIsRunning(null)
    }
  }, [center, client])

  const analysisData = analysis.result?.data
  const report = useMemo(() => buildReportModel({
    data: analysisData,
    isochrone: isochrone.result,
    meta: analysis.result?.meta,
    address,
    center,
    durationMinutes,
    completedAt: analysis.completedAt,
    warning: analysis.warning,
    config: appConfig.report,
  }), [address, analysis.completedAt, analysis.result, analysis.warning, analysisData, center, durationMinutes, isochrone.result])

  const downloadReport = useCallback(() => {
    if (!report) return
    const blob = new Blob([buildReportHtml(report)], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `邻里半径-${durationMinutes}分钟生活圈体检报告.html`
    link.click()
    URL.revokeObjectURL(url)
  }, [durationMinutes, report])

  const serviceLabel = runtime.mode === 'mock' && health.status === 'healthy' ? '样例数据就绪' : health.status === 'healthy' ? '百度 API 在线' : health.status === 'error' ? '服务异常' : '正在验证'

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <main className="main-content" id="main-content">
        <header className="topbar"><div className="topbar-identity"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><div><strong>邻里半径</strong><span>民生设施体检工具</span></div></div><div className="breadcrumb"><span>邻里半径</span><b>/</b><strong>{navItems.find((item) => item.id === activeView)?.label}</strong></div><div className="topbar-actions"><StatusPill tone={health.status === 'healthy' ? 'green' : health.status === 'error' ? 'red' : 'amber'}><span className="pill-dot" />{serviceLabel}</StatusPill><div className="avatar" aria-label="邻里半径">邻</div></div></header>
        <div className="page-body">
          {activeView === 'overview' && <Overview health={health} analysis={analysis} report={report} onOpenAnalysis={() => setActiveView('analysis')} onOpenReport={() => setActiveView('report')} onHealthCheck={runHealthCheck} isChecking={isChecking} durationMinutes={durationMinutes} />}
          {activeView === 'analysis' && <AnalysisView address={address} onAddressChange={(value) => { setAddress(value); setSelectionSource('address') }} center={center} selectionSource={selectionSource} durationMinutes={durationMinutes} onDurationChange={changeDuration} analysis={analysis} isochrone={isochrone} onRun={runAnalysis} onStop={stopAnalysis} onRunIsochrone={runIsochrone} browserAk={appConfig.browserMapAk} onSelectPoint={(location) => selectPoint(location, 'map')} onCoordinateSubmit={(location) => selectPoint(location, 'coordinates')} layers={layers} onToggleLayer={toggleLayer} highDiscernibility={highDiscernibility} onToggleHighDiscernibility={() => setHighDiscernibility((current) => !current)} selectedZoneId={selectedZoneId} onSelectZone={setSelectedZoneId} onOpenReport={() => setActiveView('report')} />}
          {activeView === 'report' && <ReportView report={report} onOpenAnalysis={() => setActiveView('analysis')} onDownload={downloadReport} onPrint={() => globalThis.print()} />}
          {activeView === 'diagnostics' && <Diagnostics diagnostics={diagnostics} isRunning={isRunning} onRun={runDiagnostic} runtime={runtime} />}
          {activeView === 'settings' && <Settings runtime={runtime} health={health} durationMinutes={durationMinutes} />}
        </div>
      </main>
    </div>
  )
}

function Overview({ health, analysis, report, onOpenAnalysis, onOpenReport, onHealthCheck, isChecking, durationMinutes }) {
  const data = analysis.result?.data
  return <>
    <section className="page-heading"><div><div className="eyebrow">CIVIC INFRASTRUCTURE / STAGE 04</div><h1>{durationMinutes} 分钟生活圈体检</h1><p>从选点、路网分析、设施覆盖到可打印报告，一条主流程完成。</p></div><div className="heading-actions"><button className="button button--secondary" type="button" onClick={onHealthCheck} disabled={isChecking}>{isChecking ? '验证中…' : '验证数据服务'}</button>{report && <button className="button button--secondary" type="button" onClick={onOpenReport}>查看报告</button>}<button className="button button--primary" type="button" onClick={onOpenAnalysis}>开始分析 <span>→</span></button></div></section>
    <HealthBanner health={health} />
    <section className="metric-grid"><MetricCard label="综合体检分" value={report ? `${report.score} 分` : '待分析'} detail={report?.band.label || '完成分析后生成'} tone="blue" icon="▥" /><MetricCard label="生活圈内设施" value={data ? formatNumber(data.quality.serviceAreaCount) : '待分析'} detail={data?.quality.serviceAreaFilter === 'polygon' ? `真实 ${durationMinutes} 分钟等时圈` : '1 公里降级半径'} tone="green" icon="◌" /><MetricCard label="服务灰区" value={data ? `${data.blindSpots.zones.length} 个` : '待分析'} detail="菜市场、药店、小学" tone="amber" icon="▧" /><MetricCard label="报告导出" value="HTML / PDF" detail="包含算法版本与数据时间" tone="purple" icon="⇩" /></section>
    <section className="workflow-card"><div className="workflow-card__intro"><div className="section-kicker">END-TO-END WORKFLOW</div><h2>第四阶段主流程</h2><p>地址、坐标或地图选点后，系统给出持续进度反馈并生成完整可审计报告。</p></div><div className="workflow-steps"><WorkflowStep number="01" title="选择中心点" detail="地址 / 坐标 / 地图" state="active" /><span className="workflow-arrow">→</span><WorkflowStep number="02" title="分析路网设施" detail="等时圈 + POI + 灰区" state={data ? 'active' : 'pending'} /><span className="workflow-arrow">→</span><WorkflowStep number="03" title="查看并导出" detail="图表 + HTML / PDF" state={report ? 'active' : 'pending'} /></div></section>
  </>
}

function HealthBanner({ health }) {
  return <section className={`status-banner status-banner--${health.status}`} aria-live="polite"><div className={`status-banner__icon status-banner__icon--${health.status}`}>{health.status === 'error' ? '!' : health.status === 'checking' ? '…' : '✓'}</div><div className="status-banner__copy"><strong>{health.status === 'healthy' ? '数据服务已就绪' : health.status === 'checking' ? '正在验证数据服务' : health.status === 'error' ? '数据服务验证失败' : '等待服务检查'}</strong><span>{health.message || '等待检查'}{health.checkedAt && ` · ${formatTime(health.checkedAt)}`}</span></div><span className="status-banner__link">{health.data?.serviceCheck === 'live-geocoding' ? '已发起真实 Geocoding 请求' : '可随时重新验证'}</span></section>
}

function CoordinateInput({ center, disabled, onSubmit }) {
  const [longitude, setLongitude] = useState(String(center.lng))
  const [latitude, setLatitude] = useState(String(center.lat))
  const [error, setError] = useState('')
  const submit = (event) => {
    event.preventDefault()
    const lng = Number(longitude)
    const lat = Number(latitude)
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      setError('请输入有效经纬度范围')
      return
    }
    setError('')
    onSubmit({ lng, lat })
  }
  return <form className="coordinate-form" onSubmit={submit}><div><label htmlFor="longitude">经度 lng</label><input id="longitude" inputMode="decimal" value={longitude} onChange={(event) => setLongitude(event.target.value)} disabled={disabled} /></div><div><label htmlFor="latitude">纬度 lat</label><input id="latitude" inputMode="decimal" value={latitude} onChange={(event) => setLatitude(event.target.value)} disabled={disabled} /></div><button className="button button--secondary" type="submit" disabled={disabled}>应用坐标</button>{error && <span className="field-error" role="alert">{error}</span>}</form>
}

function AnalysisProgress({ analysis, onRetry }) {
  const stages = [
    { id: 'geocoding', label: '确认位置' },
    { id: 'isochrone', label: '计算步行范围' },
    { id: 'poi', label: '查找附近设施' },
    { id: 'success', label: '整理结果' },
  ]
  const completed = ['success', 'degraded'].includes(analysis.status)
  const currentIndex = analysis.status === 'idle' || analysis.status === 'error' ? -1 : completed || analysis.status === 'refining' ? stages.length - 1 : Math.max(0, stages.findIndex((stage) => stage.id === analysis.status))
  const percentage = completed ? 100 : analysis.status === 'refining' ? 90 : currentIndex < 0 ? 0 : [16, 48, 78][currentIndex] || 90
  const headline = analysis.status === 'success' ? '分析完成' : analysis.status === 'degraded' ? '分析完成' : analysis.status === 'refining' ? '快速结果已生成，正在后台完善' : analysis.status === 'error' ? '分析失败，可以重试' : analysis.status === 'idle' ? '等待开始' : '正在分析'
  return <section className={`analysis-progress analysis-progress--${analysis.status}`} aria-live="polite" data-error-kind={analysis.failure?.kind || ''}><div className="analysis-progress__headline"><span className="analysis-progress__dot" /><div><strong>{headline}</strong><p>{analysis.message || '点击上方按钮，开始查找附近设施和步行范围。'}</p>{analysis.failure && <div className="failure-guidance" role="alert"><strong>{analysis.failure.title}</strong><span>{analysis.failure.action}</span>{analysis.failure.requestId && <code>request-id: {analysis.failure.requestId}</code>}</div>}{analysis.warning && <small>{analysis.warning}</small>}</div>{analysis.status === 'error' && <button className="button button--secondary" type="button" onClick={onRetry}>重新分析</button>}</div><div className="progress-track" role="progressbar" aria-label="分析进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div><ol className="progress-stages">{stages.map((stage, index) => <li className={completed || index < currentIndex ? 'is-done' : index === currentIndex ? 'is-current' : ''} key={stage.id}><span>{completed || index < currentIndex ? '✓' : index + 1}</span>{stage.label}</li>)}</ol></section>
}

function AnalysisView({ address, onAddressChange, center, selectionSource, durationMinutes, onDurationChange, analysis, isochrone, onRun, onStop, onRunIsochrone, browserAk, onSelectPoint, onCoordinateSubmit, layers, onToggleLayer, highDiscernibility, onToggleHighDiscernibility, selectedZoneId, onSelectZone, onOpenReport }) {
  const data = analysis.result?.data
  const blind = data?.blindSpots
  const blindRatio = blind?.evidence?.gridCellCount ? blind.evidence.blindCellCount / blind.evidence.gridCellCount : null
  const selectedZoneIndex = blind?.zones?.findIndex((zone) => zone.id === selectedZoneId) ?? -1
  const selectedZone = selectedZoneIndex >= 0 ? blind.zones[selectedZoneIndex] : null
  const selectedZoneVisual = selectedZone ? getBlindZoneVisual(selectedZone.missingCategories) : null
  const running = !['idle', 'success', 'degraded', 'error'].includes(analysis.status)
  const isochroneRunning = running || ['running', 'refining'].includes(isochrone.status)
  const canRun = selectionSource !== 'address' || Boolean(address.trim())
  const selectPointFromMap = (location) => {
    if (data && !globalThis.confirm('更改中心点会清除当前分析结果，需要重新分析。\n\n确定要更改吗？')) return
    if (running) onStop()
    onSelectPoint(location)
  }
  return <>
    <section className="page-heading page-heading--compact"><div><div className="eyebrow">INTERACTIVE ANALYSIS / STAGE 04</div><h1>生活圈分析工作台</h1><p>支持地址、BD-09 坐标和地图点击选点；设施盲区始终采用独立的 1 公里服务口径。</p></div>{['success', 'degraded'].includes(analysis.status) && <button className="button button--primary" type="button" onClick={onOpenReport}>查看完整报告 <span>→</span></button>}</section>
    <section className="analysis-controls">
      <div className="control-heading"><div><div className="section-kicker">ANALYSIS INPUT</div><h2>选择中心点与步行时长</h2></div><StatusPill tone="neutral">当前来源：{({ address: '地址', resolved: '地址解析', map: '地图点击', coordinates: '坐标输入' })[selectionSource] || selectionSource}</StatusPill></div>
      <div className="duration-control"><span>步行时长</span><div role="group" aria-label="步行时长">{DURATION_OPTIONS.map((minutes) => <button key={minutes} className={durationMinutes === minutes ? 'is-active' : ''} aria-pressed={durationMinutes === minutes} onClick={() => onDurationChange(minutes)} type="button" disabled={running}>{minutes} 分钟</button>)}</div><small>选择你愿意步行的时间，系统会找出这个范围内的设施。</small></div>
      <form className="analysis-search" onSubmit={(event) => { event.preventDefault(); if (canRun && !running) onRun() }}><label className="sr-only" htmlFor="analysis-address">社区或地址</label><input id="analysis-address" value={address} onChange={(event) => { if (running) onStop(); onAddressChange(event.target.value) }} placeholder="输入社区、道路或详细地址" />{running ? <button className="button button--secondary" type="button" onClick={onStop}>停止当前搜索</button> : <button className="button button--primary" type="submit" disabled={!canRun}>分析 {durationMinutes} 分钟生活圈 <span>→</span></button>}</form>
      <CoordinateInput key={`${center.lng}:${center.lat}`} center={center} disabled={running} onSubmit={onCoordinateSubmit} />
      <div className="analysis-coordinate">中心点 <strong>{center.lng.toFixed(6)}, {center.lat.toFixed(6)}</strong> <em>BD-09</em><span>键盘用户可用上方坐标输入替代地图选点</span></div>
    </section>
    <AnalysisProgress analysis={analysis} onRetry={onRun} />
    <section className="map-card"><div className="map-card__header"><div><div className="section-kicker">地图</div><h2>你能走到哪里</h2></div><button className="button button--outline button--small" type="button" onClick={onRunIsochrone} disabled={isochroneRunning}>{analysis.status === 'refining' ? '后台完善中…' : isochroneRunning ? '正在计算…' : '重新算范围'}</button></div><LayerControls layers={layers} onToggle={onToggleLayer} highDiscernibility={highDiscernibility} onToggleHighDiscernibility={onToggleHighDiscernibility} /><BaiduMap browserAk={browserAk} center={center} pois={data?.pois || []} blindZones={blind?.zones || []} blindCells={blind?.cells || []} isochrone={isochrone.result?.geojson} heatmap={isochrone.result?.heatmap || []} layers={layers} targetDurationSeconds={durationMinutes * 60} highDiscernibility={highDiscernibility} selectedZoneId={selectedZoneId} onSelectZone={onSelectZone} onSelectPoint={selectPointFromMap} /><MapLegend targetDurationSeconds={durationMinutes * 60} highDiscernibility={highDiscernibility} />{highDiscernibility && <div className="map-reading-assist" aria-live="polite"><span aria-hidden="true">◎</span>{selectedZone ? <p><strong>{getZoneCode(selectedZoneIndex)}：少{selectedZoneVisual.severity}种</strong><span>少了：{selectedZoneVisual.missingLabels.join('、')}。点下面的列表看详情。</span></p> : <p><strong>清晰显示已打开</strong><span>{blind?.zones?.length ? '点地图上的灰区，查看少了什么。' : '边界和图案会帮你看懂地图。'}</span></p>}</div>}<div className="map-card__footer"><div className="coordinate-line"><span className="pin-mini">⌖</span><span>你的位置</span><strong>{center.lng.toFixed(6)}, {center.lat.toFixed(6)}</strong><em>BD-09</em></div><div className="map-footer-note">{data ? `${data.pois.length} 个附近设施 · ${blind.zones.length} 个缺口` : '还没有分析结果'}</div></div></section>
    <section className="metric-grid"><MetricCard label="附近找到的设施" value={data ? formatNumber(data.quality.inSearchAreaCount) : '—'} detail={data ? '已去掉重复和无效信息' : '还没开始查找'} tone="blue" icon="⌖" /><MetricCard label="能走到的设施" value={data ? formatNumber(data.quality.serviceAreaCount) : '—'} detail={data?.quality.serviceAreaFilter === 'polygon' ? `${durationMinutes} 分钟内可以走到` : '按 1 公里范围计算'} tone="green" icon="◌" /><MetricCard label="缺设施的区域" value={blindRatio === null ? '—' : `${Math.round(blindRatio * 100)}%`} detail={blind ? '缺菜市场、药店或小学' : '还没开始分析'} tone="amber" icon="▧" /><MetricCard label="步行范围准确度" value={analysis.status === 'refining' ? '快速结果' : ({ high: '高', medium: '一般', low: '低' })[isochrone.result?.confidence?.level] || '—'} detail={analysis.status === 'refining' ? '后台正在精细复核' : isochrone.result ? '已根据步行路线检查' : '还没计算步行范围'} tone="purple" icon="⇄" /></section>
    {data && <P3Evidence data={data} selectedZoneId={selectedZoneId} onSelectZone={onSelectZone} />}
  </>
}

function LayerControls({ layers, onToggle, highDiscernibility, onToggleHighDiscernibility }) {
  return <div className="layer-controls" aria-label="地图显示选项"><span>显示</span>{layerOptions.map((option) => <button type="button" key={option.id} className={layers[option.id] ? 'is-active' : ''} aria-pressed={layers[option.id]} onClick={() => onToggle(option.id)}><i className={`layer-mark layer-mark--${option.mark}`} aria-hidden="true" />{option.label}<b>{layers[option.id] ? '开' : '关'}</b></button>)}<button type="button" className={`discernibility-toggle${highDiscernibility ? ' is-active' : ''}`} aria-pressed={highDiscernibility} onClick={onToggleHighDiscernibility}><i aria-hidden="true">Aa</i>清晰显示<b>{highDiscernibility ? '开' : '关'}</b></button></div>
}

function MapLegend({ targetDurationSeconds, highDiscernibility }) {
  const durationBands = [getDurationBand(0, targetDurationSeconds), getDurationBand(targetDurationSeconds / 2, targetDurationSeconds), getDurationBand(targetDurationSeconds, targetDurationSeconds)]
  return <div className={`map-legend map-legend--expanded${highDiscernibility ? ' is-accessible' : ''}`} aria-label="怎么看地图"><span><i className="legend-shape legend-shape--center" aria-hidden="true">中</i>你的位置</span><span><i className="legend-shape legend-shape--boundary" aria-hidden="true" />{Math.round(targetDurationSeconds / 60)}分钟能走到</span>{durationBands.map((band, index) => <span key={band.id}><i className={`legend-time legend-time--${band.shape}`} aria-hidden="true" />{['5分钟内', '5到10分钟', '10分钟以上'][index]}</span>)}<span className="legend-explanation">设施 = 菜市场、药店、小学</span><span><i className="legend-pattern legend-pattern--single" aria-hidden="true" />少1类设施</span><span><i className="legend-pattern legend-pattern--double" aria-hidden="true" />少2类设施</span><span><i className="legend-pattern legend-pattern--triple" aria-hidden="true" />少3类设施</span>{REQUIRED_CATEGORIES.map((category) => { const visual = getPoiVisual(category); return <span key={category}><i className={`poi-symbol poi-symbol--${visual.shape}`} style={{ backgroundColor: POI_CATEGORY_COLORS[category] }} aria-hidden="true">{visual.symbol}</i>{REPORT_CATEGORY_LABELS[category]}</span> })}</div>
}

function P3Evidence({ data, selectedZoneId, onSelectZone }) {
  const blind = data.blindSpots
  return <div className="p3-grid">
    <section className="evidence-card"><div className="section-kicker">COVERAGE EVIDENCE</div><h2>三类必测设施覆盖</h2><div className="coverage-list">{REQUIRED_CATEGORIES.map((category) => { const value = blind.coverage[category] || {}; return <div className="coverage-row" key={category}><span>{REPORT_CATEGORY_LABELS[category]}</span><div><i style={{ width: `${Math.round((value.coverageRatio || 0) * 100)}%` }} /></div><strong>{Math.round((value.coverageRatio || 0) * 100)}%</strong><small>{value.missingCellCount || 0} 个缺失网格</small></div> })}</div><div className="quality-strip"><span>原始召回 <strong>{data.quality.rawCount}</strong></span><span>去重后 <strong>{data.quality.dedupedCount}</strong></span><span>排除误召回 <strong>{data.quality.excludedCount}</strong></span><span>待复核 <strong>{data.quality.needsReviewCount || 0}</strong></span></div></section>
    <section className="evidence-card"><div className="section-kicker">GRAY ZONE AUDIT</div><h2>灰区判定证据</h2><div className="zone-list">{blind.zones.length === 0 ? <div className="empty-state">分析范围内未发现三类设施服务盲区。</div> : blind.zones.slice(0, 12).map((zone, index) => { const visual = getBlindZoneVisual(zone.missingCategories); return <button type="button" className={`zone-item zone-item--${visual.pattern}${zone.id === selectedZoneId ? ' is-selected' : ''}`} key={zone.id} aria-pressed={zone.id === selectedZoneId} onClick={() => onSelectZone(zone.id)}><div><strong>{getZoneCode(index)} · {zone.id}</strong><span>缺{visual.severity}类设施：{visual.missingLabels.join('、')}</span></div><p>{formatNumber(zone.areaM2)} m² · 人口代理 {formatNumber(zone.populationProxy, 1)} · {zone.evidence.cellCount} 个连续网格</p><small>范围 POI：菜市场 {zone.evidence.facilityCounts.market || 0} / 药店 {zone.evidence.facilityCounts.pharmacy || 0} / 小学 {zone.evidence.facilityCounts.primary_school || 0}；边界候选 {zone.evidence.boundaryCandidateCellCount || 0}</small></button> })}</div></section>
    <section className="evidence-card evidence-card--wide"><div className="section-kicker">POI SAMPLE</div><h2>分类 POI 明细</h2><div className="poi-table"><div className="poi-table__head"><span>名称</span><span>类别</span><span>距中心</span><span>地址</span></div>{data.pois.slice(0, 30).map((poi, index) => <div className="poi-table__row" key={poi.uid || `${poi.name}-${index}`}><strong>{poi.name}</strong><span>{poi.categoryLabel || REPORT_CATEGORY_LABELS[poi.category] || poi.category}</span><span>{formatNumber(poi.distance)} m</span><small>{poi.address || '—'}</small></div>)}</div>{data.pois.length > 30 && <div className="table-note">当前展示前 30 条，共 {data.pois.length} 条；完整结果保留在接口响应中。</div>}</section>
  </div>
}

function ReportView({ report, onOpenAnalysis, onDownload, onPrint }) {
  if (!report) return <section className="report-empty"><div className="report-empty__icon">▥</div><h1>还没有可展示的体检报告</h1><p>先选择中心点并完成一次生活圈分析，系统会自动生成总分、分类图表、灰区证据和导出文件。</p><button className="button button--primary" type="button" onClick={onOpenAnalysis}>前往生活圈分析 <span>→</span></button></section>
  return <div className="report-page" data-print-report>
    <section className="report-hero"><div><div className="eyebrow">NEIGHBORHOOD HEALTH REPORT / {report.reportVersion}</div><h1>{report.durationMinutes} 分钟生活圈体检报告</h1><p>{report.address || '自定义中心点'} · {report.center?.lng?.toFixed(6)}, {report.center?.lat?.toFixed(6)} BD-09</p></div><div className="report-actions"><button className="button button--secondary" type="button" onClick={onDownload}>下载 HTML</button><button className="button button--primary" type="button" onClick={onPrint}>打印 / 导出 PDF</button></div></section>
    <section className="report-summary"><div className={`score-panel score-panel--${report.band.key}`}><div className="score-ring" style={{ '--score': `${report.score * 3.6}deg` }}><strong>{report.score}</strong><span>/ 100</span></div><div><StatusPill tone={report.score >= 70 ? 'green' : 'amber'}>{report.band.label}</StatusPill><h2>确定性覆盖评分</h2><p>{report.formula}</p>{report.narrative && <div className="report-narrative"><strong>{report.narrative.headline}</strong><p>{report.narrative.finding}</p><p>{report.narrative.action}</p><small>{report.narrative.evidence}</small></div>}</div></div><RadarChart dimensions={report.dimensions} /></section>
    <section className="report-section"><div className="report-section__heading"><div><div className="section-kicker">CATEGORY COVERAGE</div><h2>八类民生设施概览</h2></div><p>数量取生活圈空间筛选结果；菜市场、药店、小学同时展示 1 公里网格覆盖率。</p></div><div className="category-card-grid">{report.categories.map((category) => <article className={`category-card category-card--${category.state}`} key={category.id}><span className="category-card__dot" style={{ background: POI_CATEGORY_COLORS[category.id] || '#71817d' }} /><div><small>{category.label}</small><strong>{category.count}</strong><span>{category.coverage === null ? '生活圈内设施' : `网格覆盖 ${Math.round(category.coverage)}%`}</span></div></article>)}</div></section>
    <section className="report-chart-grid"><BarChart categories={report.categories} /><section className="report-card"><div className="section-kicker">SCORE EVIDENCE</div><h2>评分维度</h2><div className="dimension-list">{Object.entries({ requiredCoverage: '必测覆盖', categoryCompleteness: '种类完整', facilityCount: '设施数量', spatialBalance: '空间均衡', blindFree: '非盲区占比', dataConfidence: '数据置信' }).map(([key, label]) => <div key={key}><span>{label}</span><div><i style={{ width: `${Math.round(report.dimensions[key])}%` }} /></div><strong>{Math.round(report.dimensions[key])}</strong></div>)}</div><p className="report-note">评分阈值集中在版本化配置中；页面直接展示公式和原始证据，不使用 AI 决定是否达标。</p></section></section>
    <section className="report-section"><div className="report-section__heading"><div><div className="section-kicker">GRAY ZONE LIST</div><h2>服务灰区与补设施位置</h2></div><p>补设施位置只是参考，不是最终建设地点。</p></div><div className="report-zone-list">{report.zones.length === 0 ? <div className="empty-state">当前范围未识别到服务灰区。</div> : report.zones.map((zone, index) => <article key={zone.id}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{zone.id}</strong><p>缺失：{zone.missingCategories.map((category) => REPORT_CATEGORY_LABELS[category] || category).join('、')}</p></div><div><strong>{formatNumber(zone.areaM2)} m²</strong><small>人口代理 {formatNumber(zone.populationProxy, 1)}</small></div></article>)}</div></section>
    {report.planning && <PlanningSection planning={report.planning} />}
    <section className="report-audit"><div><div className="section-kicker">AUDIT TRAIL</div><h2>数据与算法记录</h2></div><dl><div><dt>数据时间</dt><dd>{report.dataTimestampLabel}</dd></div><div><dt>数据来源</dt><dd>{report.source}</dd></div><div><dt>等时圈算法</dt><dd>{report.algorithmVersion}</dd></div><div><dt>边界置信度</dt><dd>{report.confidence}</dd></div><div><dt>边界复核</dt><dd>{report.boundaryVerification.withinToleranceCount}/{report.boundaryVerification.requestedDirections} 点达标</dd></div><div><dt>报告版本</dt><dd>{report.reportVersion}</dd></div><div><dt>网格样本</dt><dd>{report.evidence.gridCellCount || 0} 个</dd></div></dl>{report.limitations.length > 0 && <div className="limitations"><strong>限制与降级说明</strong><ul>{report.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>}</section>
  </div>
}

function PlanningSection({ planning }) {
  return <section className="report-section planning-section"><div className="report-section__heading"><div><div className="section-kicker">P5 PLANNING SCENARIO</div><h2>规划优先级与前后情景</h2></div><p>这是基于当前灰区网格的确定性情景估算，不是规划审批或最终选址结论。</p></div><div className="planning-summary"><div><span>规划前综合分</span><strong>{planning.baseline.score}</strong></div><div><span>情景后综合分</span><strong>{planning.scenarioAfter.score}</strong></div><div><span>情景变化</span><strong>{planning.scenarioAfter.scoreDelta >= 0 ? '+' : ''}{planning.scenarioAfter.scoreDelta}</strong></div><div><span>盲区网格</span><strong>{planning.baseline.blindCellCount} → {planning.scenarioAfter.blindCellCount}</strong></div></div><p className="planning-summary__text">{planning.summary}</p><div className="planning-candidates">{planning.candidates.length === 0 ? <div className="empty-state">当前没有可排序的灰区候选。</div> : planning.candidates.map((candidate) => <article key={candidate.id}><div className="planning-candidate__head"><strong>{candidate.zoneId}</strong><span className={`planning-priority planning-priority--${candidate.priorityBand.key}`}>{candidate.priorityBand.label} · {candidate.priorityScore}</span></div><p>建议类别：{candidate.recommendedCategories.map((category) => REPORT_CATEGORY_LABELS[category] || category).join('、') || '—'}</p><small>面积 {formatNumber(candidate.areaM2)} m² · 人口代理 {formatNumber(candidate.populationProxy, 1)} · 情景减少 {candidate.estimatedImpact.blindCellReduction} 个盲区网格</small></article>)}</div><ul className="planning-assumptions">{planning.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></section>
}

function RadarChart({ dimensions }) {
  const axes = [
    ['requiredCoverage', '必测覆盖'], ['categoryCompleteness', '种类完整'], ['facilityCount', '设施数量'], ['spatialBalance', '空间均衡'], ['blindFree', '非盲区'],
  ]
  const center = 125
  const radius = 82
  const point = (index, value = 100) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length
    const distance = radius * value / 100
    return { x: center + Math.cos(angle) * distance, y: center + Math.sin(angle) * distance }
  }
  const polygon = (value) => axes.map((_, index) => { const current = point(index, value); return `${current.x},${current.y}` }).join(' ')
  const values = axes.map(([key], index) => { const current = point(index, dimensions[key]); return `${current.x},${current.y}` }).join(' ')
  return <section className="radar-card"><div><div className="section-kicker">COVERAGE RADAR</div><h2>生活圈五维画像</h2></div><svg viewBox="0 0 250 250" role="img" aria-label="生活圈评分雷达图"><polygon points={polygon(100)} /><polygon points={polygon(75)} /><polygon points={polygon(50)} /><polygon points={polygon(25)} />{axes.map(([, label], index) => { const line = point(index, 100); const text = point(index, 119); return <g key={label}><line x1={center} y1={center} x2={line.x} y2={line.y} /><text x={text.x} y={text.y} textAnchor="middle" dominantBaseline="middle">{label}</text></g> })}<polygon className="radar-value" points={values} /></svg></section>
}

function BarChart({ categories }) {
  const maximum = Math.max(...categories.map((category) => category.count), 1)
  return <section className="report-card"><div className="section-kicker">FACILITY DISTRIBUTION</div><h2>分类数量柱状图</h2><div className="bar-chart">{categories.map((category) => <div key={category.id}><span>{category.label}</span><div><i style={{ width: `${category.count / maximum * 100}%`, background: POI_CATEGORY_COLORS[category.id] || '#71817d' }} /></div><strong>{category.count}</strong></div>)}</div></section>
}

function Diagnostics({ diagnostics, isRunning, onRun, runtime }) {
  return <><section className="page-heading page-heading--compact"><div><div className="eyebrow">SERVICE CONTRACTS / P1</div><h1>API 诊断</h1><p>逐项向数据适配器发起请求，并验证统一响应契约。</p></div></section><section className="diagnostic-note"><span className="diagnostic-note__icon">i</span><div><strong>{runtime.mode === 'online' ? '当前为在线 API 模式' : '当前为离线样例模式'}</strong><span>服务端 AK 仅由 FastAPI 读取；浏览器不会接触或打印服务端 AK。</span></div></section><section className="diagnostic-grid diagnostic-grid--six">{diagnosticItems.map((item) => { const result = diagnostics[item.id]; return <article className="diagnostic-card" key={item.id}><div className="diagnostic-card__top"><div className="diagnostic-icon">{item.icon}</div><StatusPill tone={result?.status === 'success' ? 'green' : result?.status === 'error' ? 'red' : 'neutral'}>{result?.status === 'success' ? '通过' : result?.status === 'error' ? '失败' : '未运行'}</StatusPill></div><h2>{item.label}</h2><p>{item.description}</p><div className="diagnostic-endpoint">POST <code>{diagnosticPath(item.id)}</code></div><button className="button button--outline" type="button" onClick={() => onRun(item)} disabled={isRunning !== null}>{isRunning === item.id ? '请求中…' : runtime.mode === 'online' ? '运行真实请求' : '运行样例请求'} <span>→</span></button>{result && <div className={`diagnostic-result diagnostic-result--${result.status}`}><strong>{result.message}</strong>{result.result?.meta && <span>{result.result.meta.source} · {result.result.meta.durationMs} ms</span>}</div>}</article> })}</section><section className="contract-card"><div><div className="section-kicker">P1 RELIABILITY</div><h2>接入层保障</h2></div><div className="guarantee-list"><span>✓ 指数退避与随机抖动</span><span>✓ QPS 滑动窗口节流</span><span>✓ TTL 请求缓存</span><span>✓ 熔断与错误映射</span><span>✓ request ID 可追踪</span><span>✓ AK 永不进入响应</span></div></section></>
}

function diagnosticPath(id) {
  return ({ geocode: '/api/v1/map/geocode', reverseGeocode: '/api/v1/map/reverse-geocode', coordinateConvert: '/api/v1/map/coordinate-convert', poi: '/api/v1/map/poi/search', routeMatrix: '/api/v1/map/route-matrix', walkingRoute: '/api/v1/map/walking-route', blindSpots: '/api/v1/map/poi/analyze' })[id]
}

function Settings({ runtime, health, durationMinutes }) {
  const rows = [['前端运行模式', runtime.mode === 'mock' ? '样例模式' : '在线模式', runtime.mode === 'mock' ? '内置快照，可完整演示' : '请求 FastAPI 后端'], ['API 地址', runtime.apiBaseUrl, '由 VITE_API_BASE_URL 提供'], ['默认步行时长', `${durationMinutes} 分钟`, '可在分析页切换 5 / 10 / 15 / 20 分钟'], ['浏览器 AK', runtime.hasBrowserAk ? '已配置（已隐藏）' : '未配置', '未配置时使用可交互离线底图'], ['服务端 AK', health.data?.baiduConfigured ? '已配置（后端确认）' : '未确认', '只存在于 backend/.env 或部署环境'], ['实时连通', health.data?.baiduReachable === true ? '已验证' : health.data?.baiduReachable === false ? '验证失败' : '样例或尚未验证', health.message || '等待检查']]
  return <><section className="page-heading page-heading--compact"><div><div className="eyebrow">RUNTIME CONFIGURATION</div><h1>运行配置</h1><p>浏览器 AK 与服务端 AK 分离，页面只显示配置状态。</p></div></section><section className="settings-card"><div className="settings-card__header"><div><div className="section-kicker">ENVIRONMENT</div><h2>当前环境</h2></div><StatusPill tone={health.status === 'healthy' ? 'green' : 'amber'}>{runtime.modeLabel}</StatusPill></div><div className="settings-table">{rows.map(([label, value, note]) => <div className="settings-row" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div></section><section className="settings-tip"><strong>密钥安全边界</strong><p><code>VITE_BAIDU_BROWSER_AK</code> 只用于公开的浏览器地图 SDK；<code>BAIDU_SERVICE_AK</code> 只由 FastAPI 从 <code>backend/.env</code> 或部署环境读取。</p></section></>
}

function MetricCard({ label, value, detail, tone, icon }) { return <article className="metric-card"><div className={`metric-card__icon metric-card__icon--${tone}`}>{icon}</div><div><div className="metric-card__label">{label}</div><strong>{value}</strong><span>{detail}</span></div></article> }
function WorkflowStep({ number, title, detail, state }) { return <div className={`workflow-step workflow-step--${state}`}><span className="workflow-step__number">{number}</span><div><strong>{title}</strong><span>{detail}</span></div></div> }
