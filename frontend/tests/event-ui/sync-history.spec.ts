import { expect, type Page, test } from '@playwright/test'
import type { ManualSyncResult, ManualSyncRun } from '../../src/lib/manual-sync'
const runId = '12345678-1234-4234-8234-123456789001'
const run = (status: ManualSyncRun['status'] = 'partial'): ManualSyncRun => ({
  id: runId,
  action: 'all',
  origin: 'productos-alertas',
  target_id: null,
  requested_by_label: 'monitor.local@example.test',
  status,
  created_at: '2026-11-09T23:00:00Z',
  started_at: '2026-11-09T23:00:01Z',
  finished_at: status === 'running' || status === 'queued'
    ? null
    : '2026-11-09T23:02:00Z',
  updated_count: 100,
  failed_count: 49,
  skipped_count: 3,
  warning_count: 1,
  total_count: 153,
  completed_count: 153,
})
const result = (i: number): ManualSyncResult => ({
  id: i,
  stage: i % 2 ? 'catalog' : 'rivals',
  entity_id: `MLU${i}`,
  identity: {
    id: `MLU${i}`,
    title: `Publicación fallida ${i}`,
    sku: '7270',
    seller: 'Vendedor rival',
    itemId: `MLU${i}`,
    url: `https://articulo.mercadolibre.com.uy/MLU-${i}-_JM`,
  },
  outcome: 'failed',
  message: 'Mercado Libre HTTP 404: recurso no disponible',
  category: 'availability',
  operation: 'consulta',
  resource: `/items/MLU${i}`,
  http_status: 404,
  attempts: 1,
  recorded_at: '2026-11-09T23:01:00Z',
})
async function mock(page: Page, { failOnce = false, active = false } = {}) {
  const requests: string[] = []
  let fail = failOnce, started = false, polls = 0
  await page.route('**/api/manual-sync**', async (route) => {
    const req = route.request(), url = new URL(req.url())
    requests.push(url.search)
    if (req.method() === 'POST') {
      started = true
      return route.fulfill({
        status: 202,
        json: {
          accepted: true,
          run: run('running'),
          runId,
          url: `/dashboard/sincronizaciones/${runId}`,
        },
      })
    }
    if (fail) {
      fail = false
      return route.fulfill({
        status: 503,
        json: { error: 'Consulta fallida; reintentá' },
      })
    }
    if (url.searchParams.get('summary')) {
      polls++
      return route.fulfill({
        json: { run: run(active && polls < 2 ? 'running' : 'partial') },
      })
    }
    if (url.pathname.endsWith(runId)) {
      const current = run(active && !started ? 'running' : 'partial'),
        pageNumber = Number(url.searchParams.get('page') ?? 1)
      const count = url.searchParams.get('outcome') === 'failed' ? 49 : 53
      return route.fulfill({
        json: {
          run: current,
          items: Array.from({
            length: Math.min(50, count - (pageNumber - 1) * 50),
          }, (_, i) => result(i + 1 + (pageNumber - 1) * 50)),
          count,
          page: pageNumber,
          stages: [{
            stage: 'own',
            pending: 0,
            updated: 100,
            failed: 0,
            skipped: 0,
            warning: 0,
          }, {
            stage: 'catalog',
            pending: 0,
            updated: 0,
            failed: 25,
            skipped: 3,
            warning: 1,
          }, {
            stage: 'rivals',
            pending: 0,
            updated: 0,
            failed: 24,
            skipped: 0,
            warning: 0,
          }],
        },
      })
    }
    return route.fulfill({ json: { items: [run()], count: 1, page: 1 } })
  })
  return requests
}
test('history remains accessible after reload and reports all counts', async ({ page }) => {
  await mock(page)
  await page.goto('/dashboard/sincronizaciones')
  await expect(
    page.getByRole('heading', { name: 'Sincronizaciones', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('49 fallidos', { exact: false })).toBeVisible()
  await page.getByRole('link', { name: 'Ver log', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Publicación fallida 49', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('HTTP 404', { exact: false }).first())
    .toBeVisible()
  await expect(
    page.getByRole('link', {
      name: 'Abrir Publicación fallida 49 en Mercado Libre',
    }),
  ).toHaveAttribute('href', 'https://articulo.mercadolibre.com.uy/MLU-49-_JM')
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Publicación fallida 49', exact: true }),
  ).toBeVisible()
})
test('history applies browser-local complete-day boundaries and custom filters', async ({ page }) => {
  const requests = await mock(page)
  await page.goto('/dashboard/sincronizaciones')
  await page.getByLabel('Desde', { exact: true }).fill('2026-11-09')
  await page.getByLabel('Hasta', { exact: true }).fill('2026-11-09')
  await expect.poll(() =>
    requests.some((q) =>
      new URLSearchParams(q).get('from') === '2026-11-09T05:00:00.000Z' &&
      new URLSearchParams(q).get('until') === '2026-11-10T05:00:00.000Z'
    )
  ).toBe(true)
  await page.getByRole('button', { name: 'Estado', exact: true }).click()
  await page.getByRole('option', { name: 'Con fallos', exact: true }).click()
  await expect.poll(() =>
    requests.some((q) => new URLSearchParams(q).get('status') === 'partial')
  ).toBe(true)
})
test('detail paginates results and keyboard operates the custom select', async ({ page }) => {
  await mock(page)
  await page.goto(`/dashboard/sincronizaciones/${runId}`)
  const select = page.getByRole('button', { name: 'Resultado', exact: true })
  await select.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('option', { name: 'Todos los resultados', exact: true })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Publicación fallida 50', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Siguiente →', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Publicación fallida 53', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Publicación fallida 1', exact: true }),
  ).toHaveCount(0)
})
test('failed reads remain retryable and never present an empty history as success', async ({ page }) => {
  await mock(page, { failOnce: true })
  await page.goto('/dashboard/sincronizaciones')
  await expect(page.getByRole('alert').filter({ hasText: 'Consulta fallida' }))
    .toContainText('Consulta fallida')
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Ver log', exact: true }))
    .toBeVisible()
})
test('manual button links to durable progress without showing the verbose error list', async ({ page }) => {
  await mock(page, { active: true })
  await page.goto('/dashboard/productos')
  await page.getByRole('button', {
    name: 'Actualizar propios y rivales',
    exact: true,
  }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Ver progreso' }))
    .toContainText('Actualizando…')
  await page.getByRole('link', { name: 'Ver progreso', exact: true }).click()
  await expect(
    page.getByRole('heading', {
      name: 'Detalle de sincronización',
      exact: true,
    }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Publicación fallida 49', exact: true }),
  ).toBeVisible()
})
test('mobile detail keeps identity, cause and external link readable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mock(page)
  await page.goto(`/dashboard/sincronizaciones/${runId}`)
  await expect(
    page.getByRole('heading', { name: 'Publicación fallida 1', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth
    ),
  ).toBe(true)
})

test('authenticated real history API is bounded and its completed log opens without defaulting to empty failures', async ({ page, request }) => {
  const list = await request.get('/api/manual-sync')
  expect(list.status()).toBe(200)
  const data = await list.json()
  expect(data.items.length).toBeLessThanOrEqual(50)
  expect(Number.isInteger(data.count)).toBe(true)
  expect((await request.get('/api/manual-sync?status=invalid')).status()).toBe(
    400,
  )
  expect((await request.get('/api/manual-sync?page=-1')).status()).toBe(400)
  const completed = data.items.find((item: ManualSyncRun) =>
    item.status === 'completed' && item.updated_count > 0
  )
  test.skip(!completed, 'No hay una ejecución real completada en este ambiente')
  await page.goto(`/dashboard/sincronizaciones/${completed.id}`)
  await expect(
    page.getByRole('heading', {
      name: 'Detalle de sincronización',
      exact: true,
    }),
  ).toBeVisible()
  await expect(
    page.getByText('Publicación y precios guardados.', { exact: true }),
  ).toBeVisible()
  await page.screenshot({
    path: '/tmp/monitor-manual-history-desktop.png',
    fullPage: true,
  })
})

test('desktop navigation scrolls within its area without covering the session controls', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await mock(page)
  await page.goto('/dashboard/sincronizaciones')
  const nav = page.getByRole('complementary').getByRole('navigation')
  const exit = page.getByRole('button', { name: 'Cerrar sesión', exact: true })
  await expect(exit).toBeVisible()
  const navBox = await nav.boundingBox(), exitBox = await exit.boundingBox()
  expect(navBox!.y + navBox!.height).toBeLessThan(exitBox!.y)
})

test('deprecated own resource is displayed separately from permissions without altering the log', async ({ page }) => {
  let writes = 0
  await page.route('**/api/manual-sync/**', async (route) => {
    if (route.request().method() !== 'GET') writes++
    const row = {
      ...result(1),
      stage: 'own',
      category: 'resource_deprecated',
      http_status: 403,
      message: 'Recurso deprecado (ResourceDeprecated) · HTTP 403',
      resource: '/items/bulk?ids=MLU1',
    }
    await route.fulfill({
      json: { run: run('failed'), items: [row], count: 1, page: 1, stages: [] },
    })
  })
  await page.goto(`/dashboard/sincronizaciones/${runId}`)
  await expect(page.getByText(/Recurso deprecado · HTTP 403 · 1 intento/))
    .toBeVisible()
  expect(writes).toBe(0)
})
