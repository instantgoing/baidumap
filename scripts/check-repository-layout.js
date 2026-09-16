import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const requiredPaths = [
  'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json', 'playwright.config.js',
  'Dockerfile', 'docker-compose.yml', '.dockerignore', '.env.example',
  'backend/Dockerfile', 'backend/.dockerignore', 'backend/.env.example',
  'backend/app', 'backend/tests', 'src', 'tests', 'e2e', 'scripts', 'docs',
  '.github/workflows/ci.yml', 'docs/submission-metadata.md',
  'config/evidence-parameters.v1.json', 'scripts/check-repository-layout.js',
]

for (const path of requiredPaths) assert.ok(existsSync(path), `独立仓库根目录缺少：${path}`)

const frontendEnv = readFileSync('.env.example', 'utf8')
assert.doesNotMatch(frontendEnv, /^VITE_.*SERVICE_AK/m, '前端环境示例不得声明服务端 AK')
assert.match(readFileSync('backend/.env.example', 'utf8'), /^BAIDU_SERVICE_AK=$/m)

const metadata = readFileSync('docs/submission-metadata.md', 'utf8')
for (const field of ['比赛平台', '截止时间', '独立仓库 URL', '在线演示 URL', '团队名称']) {
  assert.match(metadata, new RegExp(`\\| ${field} \\| 待填写 \\|`), `${field} 未知时必须标记为待填写`)
}

const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
const currentRoot = resolve(process.cwd())
const gitRoot = git.status === 0 ? resolve(git.stdout.trim()) : null
const requireIndependentRoot = process.argv.includes('--require-independent-root')

if (!gitRoot) {
  const message = '未检测到 Git 仓库；发布副本初始化后必须重新检查。'
  if (requireIndependentRoot) throw new Error(message)
  console.warn(`警告：${message}`)
} else if (gitRoot !== currentRoot) {
  const message = `当前 Git 根目录为 ${gitRoot}，不是项目目录 ${currentRoot}。请在父仓库外发布独立副本。`
  if (requireIndependentRoot) throw new Error(message)
  console.warn(`警告：${message}`)
} else {
  console.log(`Git 根目录正确：${gitRoot}`)
}

console.log(`独立仓库布局检查通过：${requiredPaths.length} 项根目录证据齐全。`)
