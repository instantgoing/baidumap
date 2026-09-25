import { expect, test } from '@playwright/test'

test('stage 4 main flow works in mock mode and exports an auditable report', async ({ page }) => {
  const startedAt = Date.now()
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '生活圈分析工作台' })).toBeVisible()
  await expect(page.locator('.topbar .status-pill')).toContainText('样例数据就绪')

  await page.getByRole('button', { name: '10 分钟' }).click()
  const map = page.getByRole('img', { name: '离线样例地图，可点击重新选择中心点' })
  await map.click({ position: { x: 260, y: 150 } })
  await expect(page.getByText('当前来源：地图点击')).toBeVisible()

  await page.getByRole('button', { name: /分析 10 分钟生活圈/ }).click()
  await expect(page.locator('.analysis-progress__headline strong')).toHaveText('分析完成')
  await expect(page.getByRole('progressbar', { name: '分析进度' })).toHaveAttribute('aria-valuenow', '100')
  await expect(page.getByText('三类必测设施覆盖')).toBeVisible()
  await expect(page.getByText('灰区判定证据')).toBeVisible()

  const heatmapToggle = page.getByRole('button', { name: /走路快慢/ })
  await expect(heatmapToggle).toHaveAttribute('aria-pressed', 'true')
  await heatmapToggle.click()
  await expect(heatmapToggle).toHaveAttribute('aria-pressed', 'false')

  await page.getByRole('button', { name: /查看完整报告/ }).click()
  await expect(page.getByRole('heading', { name: '10 分钟生活圈体检报告' })).toBeVisible()
  await expect(page.getByRole('img', { name: '生活圈评分雷达图' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '分类数量柱状图' })).toBeVisible()
  await expect(page.getByText('12/12 点达标')).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 HTML' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toContain('10分钟生活圈体检报告.html')

  const viewportFits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
  expect(viewportFits).toBe(true)
  expect(Date.now() - startedAt).toBeLessThan(180_000)
})
