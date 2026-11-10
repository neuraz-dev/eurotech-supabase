import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { buildAlertEvents } from '../../../supabase/functions/_shared/alert-events.ts'
import { observe } from '../../../supabase/functions/_shared/monitoring.ts'
const admin = () =>
  createClient(
    process.env.MONITOR_TEST_SUPABASE_URL!,
    process.env.MONITOR_TEST_SECRET_KEY!,
    { auth: { persistSession: false } },
  )
const at = () => new Date().toISOString()
test.beforeEach(async () => {
  await fetch('http://127.0.0.1:55430/control', { method: 'POST', body: '{}' })
  const db = admin()
  for (const table of [
    'ml_price_alerts',
    'ml_price_alert_rules',
    'ml_competitor_links',
    'ml_tracked_snapshots',
    'ml_tracked_items',
  ]) {
    const { error } = await db
      .schema('ml')
      .from(table)
      .delete()
      .not('id', 'is', null)
    if (error) throw error
  }
  const { error } = await db
    .schema('ml')
    .from('ml_competitor_links')
    .insert({ competitor_item_id: 'MLU200', scope: 'sku', our_sku: 'sku-test' })
  if (error) throw error
  await db
    .schema('ml')
    .from('ml_products')
    .update({ synced_at: at() })
    .in('id', ['MLU100', 'MLU101', 'MLU102'])
  await db
    .schema('ml')
    .from('ml_competitor_items')
    .update({
      observation: {
        amount: 900,
        currency: 'UYU',
        normalizedAmount: 900,
        normalizedCurrency: 'UYU',
        observedAt: at(),
        source: 'item',
        fx: null,
        itemId: 'MLU200',
        sellerId: 2,
      },
      price: 900,
      currency_id: 'UYU',
      status: 'active',
    })
    .eq('id', 'MLU200')
})
async function openProduct(page: Page, id = 'MLU100') {
  await page.goto('/dashboard/productos')
  await page.getByRole('button', { name: `Abrir ${id}`, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByRole('region', { name: 'Comparación de precios' }),
  ).toBeVisible()
}
test('API access requires a session before privileged operations', async ({
  playwright,
}) => {
  const api = await playwright.request.newContext({
    baseURL: 'http://127.0.0.1:3000',
    storageState: { cookies: [], origins: [] },
  })
  for (const path of [
    '/api/competitors',
    '/api/tracked-items',
    '/api/product-panel/MLU100',
    '/api/alert-rules',
  ])
    expect((await api.get(path)).status()).toBe(401)
  expect((await api.post('/api/competitors', { data: {} })).status()).toBe(401)
  await api.dispose()
})
test('failed equivalence save preserves the dialog; retry persists the shared reference and meaning', async ({
  page,
}) => {
  await openProduct(page)
  await expect(
    page.getByText('Equivalencia por revisar', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Revisar equivalencia' }).click()
  await page.route('**/api/competitors', async (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({
          status: 500,
          json: { error: 'Fallo sintético de persistencia' },
        })
      : route.continue(),
  )
  await page.getByRole('button', { name: 'Confirmo equivalencia' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
    'Fallo sintético',
  )
  await page.unroute('**/api/competitors')
  await page.getByRole('button', { name: 'Confirmo equivalencia' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.getByText(/Rival 10 % más barato.*Desventaja/),
  ).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: 'Abrir MLU100', exact: true }).click()
  await expect(
    page.getByText(/Rival 10 % más barato.*Desventaja/),
  ).toBeVisible()
})
test('unlink preserves the shared object and undo restores the same association', async ({
  page,
}) => {
  await openProduct(page)
  const db = admin(),
    { data: links } = await db
      .schema('ml')
      .from('ml_competitor_links')
      .select('id')
  await page.getByRole('button', { name: 'Quitar esta asociación' }).click()
  await expect(page.getByRole('button', { name: 'Deshacer' })).toBeVisible()
  const { data: rival } = await db
    .schema('ml')
    .from('ml_competitor_items')
    .select('id')
    .eq('id', 'MLU200')
    .single()
  expect(rival?.id).toBe('MLU200')
  await page.getByRole('button', { name: 'Deshacer' }).click()
  await expect(
    page.getByRole('button', { name: 'Revisar equivalencia' }),
  ).toBeVisible()
  const { data: restored } = await db
    .schema('ml')
    .from('ml_competitor_links')
    .select('id,removed_at')
  expect(restored?.[0]).toEqual({ id: links![0].id, removed_at: null })
})
test('preview includes all SKU publications and shared plus specific associations remain visible together', async ({
  page,
  request,
}) => {
  for (const data of [
    { ourSku: 'sku-test', linkMode: 'sku' },
    { ourProductId: 'MLU101', linkMode: 'mlu' },
  ]) {
    const response = await request.post('/api/competitors', {
      data: { itemIdOrUrl: 'MLU202', targetKind: 'item', ...data },
    })
    expect(response.ok()).toBeTruthy()
  }
  await openProduct(page, 'MLU101')
  const article = page.getByRole('article').filter({ hasText: 'Rival MLU202' })
  await expect(article).toHaveCount(1)
  await expect(article.getByRole('combobox')).toBeVisible()
  await expect(article.getByRole('combobox').locator('option')).toHaveCount(2)
  await page
    .getByRole('button', {
      name: /Agregar competidor|Agregar rival|Agregar competidor/,
    })
    .first()
    .click()
  const dialog = page.getByRole('dialog')
  await dialog
    .getByRole('textbox', { name: 'URL o ID de Mercado Libre' })
    .fill('MLU203')
  await dialog
    .getByLabel('Todas las publicaciones del SKU, incluidas las futuras')
    .check()
  await dialog.getByRole('button', { name: 'Previsualizar' }).click()
  await expect(dialog.getByText('2 publicaciones afectadas')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})
test('tracking explicitly selects catalog mode, retries failed save and reactivates with its complete item', async ({
  page,
}) => {
  await page.goto('/dashboard/seguimiento')
  await page.getByRole('button', { name: '+ Agregar', exact: false }).click()
  let dialog = page.getByRole('dialog')
  await dialog
    .getByRole('textbox', { name: 'URL o ID de Mercado Libre' })
    .fill('https://www.mercadolibre.com.uy/p/MLU900')
  await expect(
    dialog.getByRole('button', { name: 'Previsualizar' }),
  ).toBeDisabled()
  await dialog
    .getByLabel('Catálogo dinámico: el vendedor y la MLU pueden cambiar')
    .check()
  await dialog.getByRole('button', { name: 'Previsualizar' }).click()
  await expect(dialog.getByText(/Catálogo dinámico: MLU900/)).toBeVisible()
  await page.route('**/api/tracked-items', async (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 500, json: { error: 'No se pudo persistir' } })
      : route.continue(),
  )
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click()
  await expect(dialog.getByRole('textbox')).toHaveValue(
    'https://www.mercadolibre.com.uy/p/MLU900',
  )
  await expect(dialog.getByRole('alert')).toContainText('No se pudo persistir')
  await page.unroute('**/api/tracked-items')
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click()
  await expect(
    page.getByRole('row').filter({ hasText: 'Catálogo de prueba' }),
  ).toHaveCount(1)
  await page.getByTitle('Dejar de seguir').click()
  await page.getByRole('button', { name: '+ Agregar', exact: false }).click()
  dialog = page.getByRole('dialog')
  await dialog
    .getByRole('textbox')
    .fill('https://www.mercadolibre.com.uy/p/MLU900')
  await dialog
    .getByLabel('Catálogo dinámico: el vendedor y la MLU pueden cambiar')
    .check()
  await dialog.getByRole('button', { name: 'Previsualizar' }).click()
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click()
  await expect(
    page.getByRole('row').filter({ hasText: 'Catálogo de prueba' }),
  ).toHaveCount(1)
})
test('failed suspension keeps the persisted comparison; retry suspends only its association', async ({
  page,
}) => {
  await admin()
    .schema('ml')
    .from('ml_competitor_links')
    .update({ equivalence: 'accepted' })
    .eq('competitor_item_id', 'MLU200')
  await openProduct(page)
  await page.route('**/api/competitors', async (route) =>
    route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, json: { error: 'Fallo al suspender' } })
      : route.continue(),
  )
  await page.getByRole('button', { name: 'Suspender comparación' }).click()
  await expect(
    page
      .getByRole('region', { name: 'Comparación de precios' })
      .getByRole('alert'),
  ).toContainText('Fallo al suspender')
  await expect(
    page.getByText(/Rival 10 % más barato.*Desventaja/),
  ).toBeVisible()
  await page.unroute('**/api/competitors')
  await page.getByRole('button', { name: 'Suspender comparación' }).click()
  await expect(
    page.getByRole('button', { name: 'Reanudar comparación' }),
  ).toBeVisible()
  await expect(
    page.getByText('Comparación suspendida', { exact: true }),
  ).toBeVisible()
})
test('an alert that excludes catalog keeps its reference when opening the comparison panel', async ({
  page,
  request,
}) => {
  const db = admin()
  await db
    .schema('ml')
    .from('ml_competitor_links')
    .update({ equivalence: 'accepted' })
    .eq('competitor_item_id', 'MLU200')
  const response = await request.post('/api/alert-rules', {
    data: {
      name: 'Sin catálogo',
      rule_type: 'competitor_cheaper',
      compare_catalog_price: false,
    },
  })
  expect(response.ok()).toBeTruthy()
  const rule = await response.json()
  const [own,rival,links]=await Promise.all([
    db.schema('ml').from('ml_products').select('*').eq('id','MLU101').single(),
    db.schema('ml').from('ml_competitor_items').select('*').eq('id','MLU200').single(),
    db.schema('ml').from('ml_competitor_links').select('*').eq('competitor_item_id','MLU200'),
  ])
  const events=buildAlertEvents(rival.data,observe(950,'UYU',at(),'item'),[own.data],[rival.data],links.data??[],[rule],null)
  expect(events).toHaveLength(1)
  const {error}=await db.schema('ml').from('ml_price_alerts').insert({...events[0],competitor_item_id:'MLU200',event_target_id:'MLU200'})
  expect(error).toBeNull()
  await page.goto('/dashboard/alertas')
  await page.getByRole('heading',{name:'Producto de prueba catálogo',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Detalle de alerta'})
  await dialog.getByRole('tab',{name:'Detalles',exact:true}).click()
  await expect(dialog.getByText('Sin catálogo · Excluye catálogo')).toBeVisible()
  await expect(dialog.getByText('Comparación de la regla Sin catálogo · Publicación')).toBeVisible()

})
test('ambiguous legacy tracking requires an explicit target review and retains its identity', async ({
  page,
}) => {
  const db = admin()
  const { data, error } = await db
    .schema('ml')
    .from('ml_tracked_items')
    .insert({
      ml_item_id: 'MLU901',
      target_id: 'MLU901',
      target_kind: 'item',
      target_review_required: true,
      url: 'https://www.mercadolibre.com.uy/p/MLU901',
      title: 'Legado ambiguo',
    })
    .select('id')
    .single()
  expect(error).toBeNull()
  await page.goto('/dashboard/seguimiento')
  await page.getByRole('button', { name: 'Revisar objeto' }).click()
  const dialog = page.getByRole('dialog')
  await dialog
    .getByLabel('Catálogo dinámico: el vendedor y la MLU pueden cambiar')
    .check()
  await dialog.getByRole('button', { name: 'Previsualizar' }).click()
  await dialog.getByRole('button', { name: 'Confirmar y guardar' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const { data: resolved } = await db
    .schema('ml')
    .from('ml_tracked_items')
    .select('id,target_kind,target_review_required')
    .eq('id', data!.id)
    .single()
  expect(resolved).toEqual({
    id: data!.id,
    target_kind: 'catalog',
    target_review_required: false,
  })
})
