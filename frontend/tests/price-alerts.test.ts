import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchAllRows } from '../src/lib/fetch-all-rows.ts'
import { indexProducts, resolveCompetitorProducts } from '../src/lib/product-ownership.ts'
import {
  resolvePublicationAlerts, filterPublicationAlerts, productSkuOptions, updateAlertReadAt, removeAlerts,
  type AlertFilters, type AlertRow, type ProductPriceRow, type RuleType,
} from '../src/lib/price-alerts.ts'

const product = (id: string, overrides: Partial<ProductPriceRow> = {}): ProductPriceRow => ({
  id, sku: ' SKU ', title: id, status: 'active', price: 100, sale_price: null,
  catalog_price: null, synced_at: '2026-10-29T00:00:00Z', ...overrides,
})
const alert = (id: string, overrides: Partial<AlertRow> = {}): AlertRow => ({
  id, our_sku: 'sku', competitor_item_id: 'rival', our_price: 999, catalog_price: null,
  competitor_price_before: 90, competitor_price_after: 80, diff_pct: 99,
  fired_at: '2026-10-29T00:00:00Z', read_at: null,
  ml_price_alert_rules: { id: 'rule', name: 'rule', rule_type: 'competitor_cheaper', threshold_pct: null, compare_catalog_price: true },
  ml_competitor_items: { our_product_id: null, our_sku: 'sku', title: 'Rival', seller_name: ' Seller ', thumbnail: null, price: 80, paused: false, status: 'active' },
  ...overrides,
})
const filters: AlertFilters = { read: 'all', sku: '', rule: '', competitor: '', status: 'all' }

test('explicit links never fall back to a shared SKU, including missing IDs and products without SKU', () => {
  const p1 = product('one'), p2 = product('two'), noSku = product('no-sku', { sku: null })
  const index = indexProducts([p1, p2, noSku])
  assert.deepEqual(resolveCompetitorProducts({ our_product_id: 'two', our_sku: 'sku' }, index), [p2])
  assert.deepEqual(resolveCompetitorProducts({ our_product_id: 'missing', our_sku: 'sku' }, index), [])
  assert.deepEqual(resolveCompetitorProducts({ our_product_id: 'no-sku', our_sku: 'old' }, index), [noSku])
  assert.deepEqual(resolveCompetitorProducts({ our_product_id: null, our_sku: ' sKu ' }, index), [p1, p2])
  assert.deepEqual(resolveCompetitorProducts({ our_product_id: null, our_sku: ' ' }, index), [])
})

test('legacy rivals use every matching publication, with independent prices and original source IDs', () => {
  const source = alert('shared')
  const before = structuredClone(source)
  const rows = resolvePublicationAlerts([source], [product('one'), product('two', { price: 200, status: 'paused' }), product('cheap', { price: 50 })])
  assert.deepEqual(rows.map(r => [r.id, r.owner_product_id, r.our_price, r.diff_pct]), [
    ['shared', 'one', 100, 20], ['shared', 'two', 200, 60],
  ])
  assert.equal(new Set(rows.map(r => r.row_key)).size, 2)
  assert.notEqual(rows[0], rows[1])
  assert.deepEqual(source, before)
})

test('selects the latest qualifying alert per publication, skipping newer non-current alerts', () => {
  const invalid = alert('new-invalid', { ml_competitor_items: { ...alert('x').ml_competitor_items!, price: 500 } })
  const rows = resolvePublicationAlerts([invalid, alert('valid'), alert('old')], [product('one'), product('two')])
  assert.deepEqual(rows.map(r => r.id), ['valid', 'valid'])
})

test('includes own publications in every state and without SKU; excludes missing owners and paused/closed rivals', () => {
  const states = ['active', 'paused', 'under_review', 'closed', 'inactive', null]
  assert.equal(resolvePublicationAlerts([alert('all')], states.map((status, i) => product(String(i), { status }))).length, 6)
  for (const changes of [{ paused: true }, { status: 'paused' }, { status: 'closed' }]) {
    const a = alert('excluded'); Object.assign(a.ml_competitor_items!, changes)
    assert.equal(resolvePublicationAlerts([a], [product('one')]).length, 0)
  }
  const explicit = alert('no-sku'); explicit.ml_competitor_items!.our_product_id = 'one'
  assert.equal(resolvePublicationAlerts([explicit], [product('one', { sku: null })]).length, 1)
  assert.deepEqual(resolvePublicationAlerts([alert('orphan', { ml_competitor_items: null })], [product('one')]), [])
  const missing = alert('missing'); missing.ml_competitor_items!.our_sku = '2779'
  assert.deepEqual(resolvePublicationAlerts([missing], [product('one')]), [])
})

test('reference prices prefer sale, optional catalog, then list, preserving zero and null', () => {
  const p = product('one', { price: 200, catalog_price: 150, sale_price: 100 })
  assert.equal(resolvePublicationAlerts([alert('sale')], [p])[0].our_price, 100)
  p.sale_price = null
  assert.equal(resolvePublicationAlerts([alert('catalog')], [p])[0].our_price, 150)
  const noCatalog = alert('list'); noCatalog.ml_price_alert_rules!.compare_catalog_price = false
  assert.equal(resolvePublicationAlerts([noCatalog], [p])[0].our_price, 200)
  const changed = alert('zero'); changed.ml_price_alert_rules!.rule_type = 'price_changed'
  assert.equal(resolvePublicationAlerts([changed], [product('one', { sale_price: 0 })])[0].our_price, 0)
  assert.equal(resolvePublicationAlerts([changed], [product('one', { price: null })])[0].diff_pct, null)
})

test('evaluates each rule and threshold boundary using current rival price with historical fallback', () => {
  const cases: [RuleType, number, number | null, boolean][] = [
    ['price_changed', 80, null, true], ['competitor_cheaper', 80, null, true],
    ['competitor_cheaper', 100, null, false], ['competitor_pricier', 120, null, true],
    ['price_diff_pct_above', 80, 20, true], ['price_diff_pct_above', 80, 21, false],
    ['price_diff_pct_below', 120, 20, true], ['price_diff_pct_below', 120, 21, false],
    ['price_diff_pct_above', 80, null, false],
  ]
  for (const [rule_type, price, threshold_pct, expected] of cases) {
    const a = alert('rule'); Object.assign(a.ml_price_alert_rules!, { rule_type, threshold_pct }); a.ml_competitor_items!.price = price
    assert.equal(resolvePublicationAlerts([a], [product('one')]).length > 0, expected, `${rule_type}:${price}:${threshold_pct}`)
  }
  const a = alert('fallback'); a.ml_competitor_items!.price = null
  assert.equal(resolvePublicationAlerts([a], [product('one')])[0].competitor_price_after, 80)
  a.competitor_price_after = null
  assert.deepEqual(resolvePublicationAlerts([a], [product('one')]), [])
  a.ml_price_alert_rules = null
  assert.deepEqual(resolvePublicationAlerts([a], [product('one')]), [])
})

test('all is unfiltered; SKU filters normalize and do not exclude SKU-less rows by default', () => {
  const a = alert('shared')
  const explicit = alert('explicit'); explicit.ml_competitor_items!.our_product_id = 'no-sku'
  const rows = resolvePublicationAlerts([a, explicit], [product('one'), product('two', { status: 'paused' }), product('no-sku', { sku: null })])
  assert.equal(filterPublicationAlerts(rows, filters).length, 3)
  assert.equal(filterPublicationAlerts(rows, { ...filters, sku: ' SkU ' }).length, 2)
  assert.equal(filterPublicationAlerts(rows, { ...filters, status: 'active' }).length, 2)
  assert.equal(filterPublicationAlerts(rows, { ...filters, competitor: 'Seller', rule: 'rule' }).length, 3)
  assert.equal(filterPublicationAlerts(rows, { ...filters, rule: 'other' }).length, 0)
})

test('read and delete update every occurrence of a source alert; counts and unread filters follow shared state', () => {
  const rows = resolvePublicationAlerts([alert('shared')], [product('one'), product('two')])
  const read = updateAlertReadAt(rows, new Set(['shared']), '2026-10-29T12:00:00Z')
  assert.equal(read.filter(r => !r.read_at).length, 0)
  assert.equal(filterPublicationAlerts(read, { ...filters, read: 'unread' }).length, 0)
  assert.equal(filterPublicationAlerts(read, filters).length, 2)
  assert.equal(removeAlerts(read, new Set(['shared'])).length, 0)
  assert.equal(rows.filter(r => !r.read_at).length, 2)
})

test('SKU options normalize and deduplicate while keeping the most recent publication title', () => {
  const options = productSkuOptions([
    product('old', { synced_at: null }), product('new', { sku: 'sku', title: 'New' }), product('none', { sku: null }),
  ])
  assert.deepEqual(options, [{ sku: 'sku', title: 'New' }])
})

test('pagination keeps >1000 products and alerts outside the first 200, with inclusive stable ranges', async () => {
  const products = Array.from({ length: 1501 }, (_, i) => product(`p${i}`, { sku: `sku${i}` }))
  const alerts = products.map((p, i) => {
    const a = alert(`a${i}`, { our_sku: p.sku! }); a.ml_competitor_items!.our_sku = p.sku!; return a
  })
  const calls: [number, number][] = []
  const load = <T,>(data: T[]) => fetchAllRows('test', async (from, to) => {
    calls.push([from, to]); return { data: data.slice(from, to + 1), error: null }
  })
  const rows = resolvePublicationAlerts(await load(alerts), await load(products))
  assert.equal(rows.length, 1501)
  assert.equal(rows.at(-1)!.owner_product_id, 'p1500')
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [0, 999], [1000, 1999]])
})

test('pagination handles an exact multiple, successful empty queries, and later-page failures without partial results', async () => {
  let calls = 0
  const rows = await fetchAllRows('test', async from => {
    calls++; return { data: from === 0 ? Array(1000).fill('row') : [], error: null }
  })
  assert.equal(rows.length, 1000); assert.equal(calls, 2)
  assert.deepEqual(await fetchAllRows('test', async () => ({ data: [], error: null })), [])
  await assert.rejects(fetchAllRows('las alertas', async from => from === 0
    ? { data: Array(1000).fill('row'), error: null }
    : { data: null, error: { message: 'missing column' } }), /No se pudieron cargar las alertas: missing column/)
})
