import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { createMockApiClient } from '../src/api/mockData.js'

const requiredFiles = [
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  '.github/workflows/ci.yml',
  'docs/technical-design.md',
  'docs/real-community-report.md',
  'docs/acceptance-stage6.md',
  'docs/demo-data.md',
  'docs/demo-script.md',
  'docs/submission-checklist.md',
  'docs/repository-release.md',
  'docs/submission-metadata.md',
  '.dockerignore',
  'backend/.dockerignore',
  'config/evidence-parameters.v1.json',
  'data/validation/README.md',
  'data/validation/poi-ground-truth.template.csv',
  'data/validation/system-poi-review.template.csv',
  'data/validation/boundary-samples.template.csv',
  'data/validation/gray-area-samples.template.csv',
  'backend/scripts/community_validation.py',
  'docs/engineering-evidence.md',
  'backend/scripts/route_matrix_benchmark.py',
  'artifacts/benchmarks/route-matrix-simulated.json',
  'docs/multi-source-poi-strategy.md',
  'backend/app/services/multisource_poi.py',
  'docs/acceptance-competition-final.md',
]

for (const path of requiredFiles) assert.ok(existsSync(path), `缺少第六阶段交付物：${path}`)

const documentationFiles = ['README.md', ...requiredFiles.filter((path) => path.endsWith('.md'))]
for (const documentPath of new Set(documentationFiles)) {
  const markdown = readFileSync(documentPath, 'utf8')
  for (const match of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, '').split('#')[0]
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue
    assert.ok(existsSync(resolve(dirname(documentPath), target)), `${documentPath} 包含失效相对链接：${target}`)
  }
}

const ignore = readFileSync('.gitignore', 'utf8')
for (const entry of ['.env', '.env.local', '.env.*', '!.env.example', '!.env.e2e', '!backend/.env.example', '.env.*.local', '*.log']) {
  assert.ok(ignore.split(/\r?\n/).includes(entry), `.gitignore 缺少 ${entry}`)
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const installedPackages = Object.entries(lock.packages).filter(([path]) => path.startsWith('node_modules/'))
const packagesWithoutLicense = installedPackages.filter(([, metadata]) => !metadata.license)
assert.equal(packagesWithoutLicense.length, 0, `package-lock 中存在无许可证元数据的依赖：${packagesWithoutLicense.map(([path]) => path).join(', ')}`)

const client = createMockApiClient()
const center = { lng: 116.284206, lat: 40.051819 }
const snapshot = await client.analyzePois({ center })
assert.equal(snapshot.meta.source, 'sample-snapshot')
assert.match(snapshot.meta.capturedAt, /^2026-09-10T09:00:00\+08:00$/)
assert.equal(snapshot.data.pois.length, 18)
assert.equal(snapshot.data.blindSpots.zones.length, 3)
for (const category of ['market', 'pharmacy', 'primary_school']) {
  assert.ok(snapshot.data.blindSpots.coverage[category], `样例快照缺少必测类别 ${category}`)
}

const snapshotHash = createHash('sha256').update(readFileSync('src/api/mockData.js')).digest('hex')
const benchmark = JSON.parse(readFileSync('artifacts/benchmarks/route-matrix-simulated.json', 'utf8'))
assert.equal(benchmark.environment.source, 'offline-simulated')
assert.ok(benchmark.parameters.runs >= 3, 'RouteMatrix 基准至少运行 3 次')
assert.equal(benchmark.runs.length, benchmark.parameters.runs * 4, '基准必须保留四种场景的全部轮次')
assert.ok(benchmark.summaries.every((item) => item.elapsedMs.allRuns.length === benchmark.parameters.runs), '基准摘要不得只保留最佳值')
const demoScript = readFileSync('docs/demo-script.md', 'utf8')
const demoSections = ['问题与价值', '真实路网等时圈', '三类设施盲区', '真实验证', '工程优化与容错', '开源收尾']
let previousSection = -1
for (const section of demoSections) {
  const position = demoScript.indexOf(`## ${section}`)
  assert.ok(position > previousSection, `三分钟演示缺少或顺序错误：${section}`)
  previousSection = position
}
for (const phrase of ['现场备用方案', '断网', '无服务端 AK', '常见评委问答', 'sample-snapshot']) {
  assert.ok(demoScript.includes(phrase), `三分钟演示缺少：${phrase}`)
}
console.log(`提交自检通过：${requiredFiles.length} 份交付物，${installedPackages.length} 个 npm 包许可证已标注。`)
console.log(`固定样例：18 POI / 3 灰区，mockData.js SHA-256 ${snapshotHash}`)
console.log(`RouteMatrix 离线模拟：${benchmark.parameters.runs} 轮 × 4 场景，原始轮次全部保留。`)
