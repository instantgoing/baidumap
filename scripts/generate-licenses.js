import { readFileSync, writeFileSync } from 'node:fs'

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const root = lock.packages['']
const directNames = new Set([...Object.keys(root.dependencies || {}), ...Object.keys(root.devDependencies || {})])
const packages = Object.entries(lock.packages)
  .filter(([path]) => path.startsWith('node_modules/'))
  .map(([path, metadata]) => ({
    name: path.split('node_modules/').at(-1),
    version: metadata.version,
    license: metadata.license || 'UNKNOWN',
    direct: directNames.has(path.split('node_modules/').at(-1)),
  }))
  .sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const licenseCounts = packages.reduce((counts, item) => ({ ...counts, [item.license]: (counts[item.license] || 0) + 1 }), {})
const lines = [
  '# 第三方依赖许可清单',
  '',
  '本文件由 `npm run licenses` 根据 `package-lock.json` 生成。它是归档索引，各软件包中的原始许可文本才是有效授权文件。',
  '',
  '## 许可证统计',
  '',
  '| SPDX/声明 | npm 包数 |',
  '| --- | ---: |',
  ...Object.entries(licenseCounts).sort(([a], [b]) => a.localeCompare(b)).map(([license, count]) => `| ${license} | ${count} |`),
  '',
  '## Python 直接依赖',
  '',
  '| 依赖 | 版本范围 | 许可证 | 用途 |',
  '| --- | --- | --- | --- |',
  '| FastAPI | `>=0.104,<1` | MIT | HTTP API 框架 |',
  '| HTTPX | `>=0.25,<1` | BSD-3-Clause | 异步上游客户端 |',
  '| Pydantic | `>=2,<3` | MIT | 请求/响应模型 |',
  '| python-dotenv | `>=1,<2` | BSD-3-Clause | 本地环境变量加载 |',
  '| Uvicorn | `>=0.24,<1` | BSD-3-Clause | ASGI 服务器 |',
  '',
  '## npm 完整锁定清单',
  '',
  '| 依赖 | 版本 | 许可证 | 关系 |',
  '| --- | --- | --- | --- |',
  ...packages.map((item) => `| ${item.name} | ${item.version} | ${item.license} | ${item.direct ? '直接' : '传递'} |`),
  '',
  '## 容器基础镜像',
  '',
  '- `node:22-alpine`：前端构建阶段。',
  '- `nginx:1.27-alpine`：前端静态文件和 `/api` 反向代理。',
  '- `python:3.13-slim`：FastAPI 运行阶段。',
  '',
  '基础镜像会带入操作系统级软件包；发布镜像时应使用 SBOM/镜像扫描生成当次构建的精确清单。',
  '',
]

writeFileSync('THIRD_PARTY_NOTICES.md', `${lines.join('\n')}\n`, 'utf8')
console.log(`已写入 THIRD_PARTY_NOTICES.md：${packages.length} 个 npm 包，5 个 Python 直接依赖。`)
