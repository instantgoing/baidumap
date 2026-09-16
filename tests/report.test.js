import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReportHtml, buildReportModel } from '../src/report/reportModel.js'

const data = {
  center: { lng: 116.3, lat: 40 },
  serviceAreaPois: [],
  quality: {
    serviceAreaCount: 18,
    serviceAreaFilter: 'polygon',
    categoryCounts: { market: 3, pharmacy: 5, primary_school: 2, community_healthcare: 2, hospital: 1, kindergarten: 2, eldercare: 1, convenience_store: 2 },
  },
  blindSpots: {
    coverage: {
      market: { coverageRatio: 0.8 },
      pharmacy: { coverageRatio: 0.9 },
      primary_school: { coverageRatio: 0.7 },
    },
    evidence: { gridCellCount: 100, blindCellCount: 20 },
    zones: [{ id: 'zone-1', polygon: [{ lng: 116.31, lat: 40 }, { lng: 116.32, lat: 40 }, { lng: 116.32, lat: 40.01 }], missingCategories: ['primary_school'], areaM2: 20000, populationProxy: 160 }],
  },
}

test('builds a bounded, auditable stage 4 report model', () => {
  const report = buildReportModel({
    data,
    isochrone: { algorithmVersion: 'isochrone-v1', confidence: { level: 'high' }, warnings: [] },
    meta: { capturedAt: '2026-09-12T08:00:00+08:00', source: 'fixture' },
    address: '测试社区',
    center: data.center,
    durationMinutes: 15,
  })

  assert.ok(report.score >= 0 && report.score <= 100)
  assert.equal(report.categories.length, 8)
  assert.equal(report.candidateSites.length, 1)
  assert.equal(report.algorithmVersion, 'isochrone-v1')
  assert.match(report.formula, /必测覆盖 30%/)
})

test('category cards count only POIs inside the selected service area', () => {
  const report = buildReportModel({
    data: {
      ...data,
      serviceAreaPois: [
        { category: 'market' },
        { category: 'convenience_store' },
      ],
      quality: {
        ...data.quality,
        serviceAreaCount: 2,
        categoryCounts: { market: 30, pharmacy: 20, primary_school: 10 },
      },
    },
    center: data.center,
  })

  assert.equal(report.categories.find((category) => category.id === 'market').count, 1)
  assert.equal(report.categories.find((category) => category.id === 'convenience_store').count, 1)
  assert.equal(report.categories.find((category) => category.id === 'pharmacy').count, 0)
})

test('exports a self-contained print report and escapes user text', () => {
  const report = buildReportModel({ data, address: '<script>alert(1)</script>', center: data.center })
  const html = buildReportHtml(report)

  assert.match(html, /<!doctype html>/)
  assert.match(html, /报告版本/)
  assert.doesNotMatch(html, /<script>alert/)
  assert.match(html, /&lt;script&gt;/)
})
