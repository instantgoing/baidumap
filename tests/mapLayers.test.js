import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getBlindZoneVisual,
  getDurationBand,
  getPoiVisual,
  getZoneCode,
  selectAccessibleHeatSamples,
} from '../src/map/mapLayers.js'

test('blind zones expose color-independent severity and category labels', () => {
  assert.deepEqual(getBlindZoneVisual(['pharmacy', 'primary_school']), {
    severity: 2,
    pattern: 'double',
    missingLabels: ['药店', '小学'],
  })
  assert.equal(getZoneCode(2), 'G03')
})

test('POI and duration bands have stable shapes in addition to colors', () => {
  assert.equal(getPoiVisual('market').shape, 'square')
  assert.equal(getPoiVisual('pharmacy').shape, 'cross')
  assert.equal(getPoiVisual('primary_school').shape, 'triangle')
  assert.equal(getDurationBand(120, 900).shape, 'circle')
  assert.equal(getDurationBand(450, 900).shape, 'diamond')
  assert.equal(getDurationBand(800, 900).shape, 'triangle')
})

test('accessible heat samples are evenly limited per time band', () => {
  const samples = Array.from({ length: 90 }, (_, index) => ({ status: 'ok', duration: (index % 3 + 1) * 250, lng: index, lat: index }))
  const selected = selectAccessibleHeatSamples(samples, 900, 6)
  assert.equal(selected.length, 18)
  assert.deepEqual(new Set(selected.map((sample) => getDurationBand(sample.duration, 900).id)), new Set(['near', 'middle', 'edge']))
})
