import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { syncCatalog } from '../../supabase/functions/_shared/catalog-service.ts'

test('sync queries only catalogs, reuses offers, and preserves failed sources without renewing their dates', async () => {
  const writes: string[] = [], calls: string[] = []
  const products = [
    { id: 'MLU1', catalog_product_id: 'MLU100', catalog_listing: false },
    { id: 'MLU2', catalog_product_id: 'MLU100', catalog_listing: false },
    { id: 'MLU3', catalog_product_id: null, user_product_id: 'MLUU300', catalog_listing: false },
    { id: 'MLU4', catalog_product_id: 'MLU404', catalog_listing: false },
  ]
  const client = createClient('https://db.test', 'test', { global: { fetch: async (input, init) => {
    const req = new Request(input, init)
    if (req.url.includes('/rpc/record_catalog_snapshot')) return Response.json(null)
    if (req.method === 'PATCH') {
      const id = new URL(req.url).searchParams.get('id')!.replace('eq.', '')
      writes.push(id)
      return Response.json({ id })
    }
    return Response.json(products)
  } } })
  const result = await syncCatalog(client, { token: 'test', sellerId: 1, apiUrl: 'https://ml.test', fxUrl: 'https://ml.test/fx', fetcher: async (input) => {
    const url = String(input); calls.push(url)
    if (url.endsWith('/fx')) return Response.json({ rates: { UYU: 40 } })
    if (url.includes('/items?ids=')) return Response.json([])
    if (url.includes('/users/')) return Response.json({id:Number(url.split('/').pop()),nickname:'Vendedor'})
    if (url.includes('MLU404')) return new Response(null, { status: 403 })
    return Response.json({ results: [
      { item_id: 'MLU1', seller_id: 1, price: 100, currency_id: 'UYU' },
      { item_id: 'MLU90', seller_id: 2, price: 90, currency_id: 'UYU' },
    ], paging: { total: 2 } })
  } })
  assert.equal(result.success, false)
  assert.equal(result.catalog_prices_updated, 2)
  assert.equal(result.items_failed, 1)
  assert.equal(result.items_skipped, 1)
  assert.equal(calls.filter(url => url.includes('/products/MLU100/')).length, 1)
  assert.equal(calls.some(url => url.includes('MLUU300')), false)
  assert.deepEqual(writes.sort(), ['MLU1', 'MLU2'])
  assert.deepEqual(result.errors, [{ itemId: 'MLU4', catalogId: 'MLU404', message: 'Catálogo HTTP 403' }])
})
