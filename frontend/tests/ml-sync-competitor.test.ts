import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createCompetitorHandler } from '../../supabase/functions/ml-sync-competitor/handler.ts'

const rival = (id = 'MLU123', catalog = false) => ({
  id, our_sku: 'sku', our_product_id: 'own', title: 'Rival', price: 80,
  previous_price: 80, thumbnail: null, permalink: catalog ? `https://example.test/p/${id}` : null,
})

function fixture(t: TestContext, options: {
  items?: ReturnType<typeof rival>[]; noToken?: boolean; expired?: boolean;
  upstreamStatus?: number; individualStatus?: number; omitResults?: boolean;
  writeError?: boolean; alertError?: boolean; catalogEmpty?: boolean; failedId?: string;
} = {}) {
  const writes: { table: string; rows: Record<string, unknown>[] }[] = []
  const requests: string[] = []
  const items = options.items ?? [rival()]
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init), url = new URL(req.url)
    requests.push(req.url)
    if (url.origin === 'https://db.test') {
      const table = url.pathname.split('/').pop()!
      if (req.method === 'GET') {
        if (table === 'ml_tokens') return Response.json(options.noToken ? null : {
          id: 1, access_token: 'temporary', refresh_token: null, user_id: 1,
          expires_at: new Date(Date.now() + (options.expired ? -1000 : 3600000)).toISOString(),
        })
        if (table === 'ml_competitor_items') return Response.json(items)
        if (table === 'ml_products') return Response.json([{ id: 'own', sku: 'sku', price: 100, sale_price: null, catalog_price: null }])
        if (table === 'ml_price_alert_rules') return Response.json([{ id: 'rule', sku: null, enabled: true, rule_type: 'competitor_cheaper', compare_catalog_price: false }])
      }
      if (req.method === 'POST') {
        const payload = await req.json()
        const rows = Array.isArray(payload) ? payload : [payload]
        if (table === 'ml_competitor_items') {
          // PostgreSQL validates NOT NULL columns before resolving an upsert conflict.
          if (options.writeError || rows.some(row => !row.our_sku)) {
            return Response.json({ message: 'competitor persistence failed' }, { status: 400 })
          }
        }
        if (table === 'ml_price_alerts' && options.alertError) return Response.json({ message: 'alert persistence failed' }, { status: 400 })
        writes.push({ table, rows })
        return new Response(null, { status: 201 })
      }
      throw new Error(`Unexpected database request: ${req.method} ${table}`)
    }
    if (url.origin === 'https://open.er-api.com') return Response.json({ rates: { UYU: 40 } })
    assert.equal(url.origin, 'https://api.mercadolibre.com')
    assert.equal(req.method, 'GET', 'No OAuth refresh or remote writes')
    if (options.upstreamStatus) return Response.json({}, { status: options.upstreamStatus })
    if (url.pathname.startsWith('/products/')) return Response.json({ results: options.catalogEmpty ? [] : [{ seller_id: 2, price: 80, currency_id: 'UYU' }] })
    return Response.json(options.omitResults ? [] : items.map(item => ({
      // ML multiget responses may put the ID only inside body.
      code: item.id === options.failedId ? 403 : options.individualStatus ?? 200,
      body: { id: item.id, price: 80, title: 'Rival', currency_id: 'UYU', status: 'active' },
    })))
  }
  t.mock.method(globalThis, 'fetch', fakeFetch)
  const client = createClient('https://db.test', 'local-service', {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fakeFetch },
  })
  return { writes, requests, handler: createCompetitorHandler(client, { serviceKey: 'local-service', syncSecrets: ['local-sync'] }) }
}

const request = (headers: HeadersInit = { 'x-sync-secret': 'local-sync' }) => new Request('http://local/functions/v1/ml-sync-competitor', { method: 'POST', headers })

test('rejects unauthorized requests before any API or database access', async t => {
  const { handler, writes, requests } = fixture(t)
  assert.equal((await handler(request({}))).status, 401)
  assert.equal((await handler(request({ apikey: 'wrong' }))).status, 401)
  assert.deepEqual(writes, [])
  assert.deepEqual(requests, [])
})

test('updates unchanged direct prices and timestamp, retaining the required SKU', async t => {
  const { handler, writes } = fixture(t)
  const response = await handler(request({ authorization: 'Bearer local-service' }))
  assert.equal(response.status, 200)
  const stats = await response.json()
  assert.equal(stats.success, true)
  assert.equal(stats.items_updated, 1)
  assert.equal(stats.items_failed, 0)
  const row = writes.find(w => w.table === 'ml_competitor_items')!.rows[0]
  assert.equal(writes.find(w => w.table === 'ml_price_alerts')!.rows[0].competitor_item_id, 'MLU123')
  assert.equal(row.our_sku, 'sku')
  assert.equal(row.price, 80)
  assert.ok(Date.parse(row.synced_at as string) > Date.now() - 10000)
})

test('updates catalog prices through the same persistence and alert flow', async t => {
  const { handler, writes } = fixture(t, { items: [rival('MLU456', true)] })
  assert.equal((await handler(request())).status, 200)
  assert.equal(writes[0].rows[0].id, 'MLU456')
  assert.equal(writes[1].table, 'ml_price_alerts')
})

for (const catalog of [false, true]) {
  test(`reports upstream failure instead of success (${catalog ? 'catalog' : 'direct'})`, async t => {
    const { handler, writes } = fixture(t, { items: [rival('MLU123', catalog)], upstreamStatus: 403 })
    const response = await handler(request())
    assert.equal(response.status, 500)
    assert.equal((await response.json()).items_failed, 1)
    assert.deepEqual(writes, [])
  })
  test(`does not emit alerts when price persistence fails (${catalog ? 'catalog' : 'direct'})`, async t => {
    const { handler, writes } = fixture(t, { items: [rival('MLU123', catalog)], writeError: true })
    const response = await handler(request())
    assert.equal(response.status, 500)
    assert.equal((await response.json()).success, false)
    assert.deepEqual(writes, [])
  })
}

for (const options of [{ individualStatus: 403 }, { omitResults: true }]) {
  test(`reports individual and missing item responses: ${JSON.stringify(options)}`, async t => {
    const { handler } = fixture(t, options)
    const response = await handler(request())
    assert.equal(response.status, 500)
    assert.equal((await response.json()).items_failed, 1)
  })
}

test('reports alert persistence errors even after prices have been updated', async t => {
  const { handler } = fixture(t, { alertError: true })
  const response = await handler(request())
  assert.equal(response.status, 500)
  const stats = await response.json()
  assert.equal(stats.success, false)
  assert.equal(stats.items_updated, 1)
  assert.equal(stats.alert_errors, 1)
})

test('distinguishes empty catalogs from retrieval failures', async t => {
  const { handler } = fixture(t, { items: [rival('MLU123', true)], catalogEmpty: true })
  const response = await handler(request())
  assert.equal(response.status, 200)
  assert.equal((await response.json()).items_skipped, 1)
})

test('keeps successful updates while reporting a partially failed run', async t => {
  const { handler } = fixture(t, { items: [rival(), rival('MLU456')], failedId: 'MLU456' })
  const response = await handler(request())
  assert.equal(response.status, 500)
  const stats = await response.json()
  assert.equal(stats.success, false)
  assert.equal(stats.items_processed, 2)
  assert.equal(stats.items_updated, 1)
  assert.equal(stats.items_failed, 1)
})

test('an empty competitor list succeeds without retrieving prices or emitting alerts', async t => {
  const { handler, writes, requests } = fixture(t, { items: [] })
  const response = await handler(request())
  assert.equal(response.status, 200)
  assert.equal((await response.json()).items_processed, 0)
  assert.deepEqual(writes, [])
  assert.equal(requests.some(url => url.includes('mercadolibre.com')), false)
})

for (const options of [{ noToken: true }, { expired: true }]) {
  test(`refuses missing or expired tokens without remote writes: ${JSON.stringify(options)}`, async t => {
    const { handler, writes } = fixture(t, options)
    assert.equal((await handler(request())).status, 500)
    assert.deepEqual(writes, [])
  })
}
