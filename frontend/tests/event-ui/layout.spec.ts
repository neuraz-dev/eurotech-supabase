import { expect, test } from '@playwright/test'

const routes = ['/dashboard', '/dashboard/productos', '/dashboard/alertas', '/dashboard/seguimiento', '/dashboard/sincronizaciones', '/dashboard/usuarios']

for (const route of routes) {
  test(`${route} uses the document as its page scroll container`, async ({ page }) => {
    await page.goto(route)
    const main = page.getByRole('main')
    await expect(main).toBeVisible()
    const state = await main.evaluate(element => ({
      overflow: getComputedStyle(element).overflowY,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }))
    expect(['visible', 'clip']).toContain(state.overflow)
    expect(state.documentWidth).toBeLessThanOrEqual(state.viewportWidth + 1)
  })
}

test('product drawer covers the full viewport without horizontal overflow and restores page scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1307, height: 900 })
  await page.goto('/dashboard/productos')
  await page.getByRole('button', { name: 'grid', exact: true }).click()
  await expect(page.getByText('Cargando publicaciones restantes…', { exact: true })).toBeHidden()
  const metrics = () => page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    scroll: window.scrollY,
    scrollHeight: document.scrollingElement!.scrollHeight,
    clientHeight: document.scrollingElement!.clientHeight,
  }))
  expect((await metrics()).width).toBeLessThanOrEqual((await metrics()).viewport + 1)
  expect((await metrics()).scrollHeight).toBeGreaterThan((await metrics()).clientHeight)
  await page.mouse.wheel(0, 450)
  await expect.poll(async () => (await metrics()).scroll).toBeGreaterThan(0)
  await page.screenshot({ path: '/tmp/eurotech-background-scroll.png' })
  await page.getByRole('button', { name: /^Abrir ML/ }).first().click()
  const overlay = page.getByTestId('product-panel-overlay')
  const drawer = page.getByTestId('product-detail-panel')
  await expect(overlay).toBeVisible()
  expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, width: 1307, height: 900 })
  expect(await drawer.boundingBox()).toEqual({ x: 707, y: 0, width: 600, height: 900 })
  expect((await metrics()).width).toBeLessThanOrEqual((await metrics()).viewport + 1)
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')
  await page.screenshot({ path: '/tmp/eurotech-layout-drawer-desktop.png' })
  await overlay.click({ position: { x: 15, y: 15 } })
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
  expect((await metrics()).width).toBeLessThanOrEqual((await metrics()).viewport + 1)
  await page.getByRole('button', { name: 'listado', exact: true }).click()
  expect((await metrics()).width).toBeLessThanOrEqual((await metrics()).viewport + 1)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /^Abrir ML/ }).first().click()
  expect(await drawer.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
  expect(await overlay.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 })
  expect((await metrics()).width).toBeLessThanOrEqual((await metrics()).viewport + 1)
  await page.screenshot({ path: '/tmp/eurotech-layout-drawer-mobile.png' })
  await page.getByRole('button', { name: '×', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
})
