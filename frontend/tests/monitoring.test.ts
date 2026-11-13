import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compare,
  comparisonText,
  observe,
  referencePrice,
  ruleFires,
  adjudicationLabel,
  type CompetitorLink,
  type OwnProduct,
} from '../../supabase/functions/_shared/monitoring.ts'
import {
  fetchTarget,
  parseTarget,
} from '../../supabase/functions/_shared/ml-observation.ts'
const now = Date.now(),
  at = new Date(now).toISOString()
const product: OwnProduct = {
  id: 'MLU1',
  sku: ' SKU ',
  price: 1000,
  sale_price: null,
  catalog_price: null,
  currency_id: 'UYU',
  synced_at: at,
}
const link: CompetitorLink = {
  id: 'link',
  competitor_item_id: 'MLU2',
  scope: 'sku',
  our_product_id: null,
  our_sku: 'sku',
  paused: false,
  removed_at: null,
  equivalence: 'accepted',
}
const rival = (
  amount: number | null = 900,
  currency: string | null = 'UYU',
  time = at,
) => ({
  status: 'active',
  observation: observe(amount, currency, time, 'item'),
})
test('the same denominator, meaning and text cover cheaper, dearer and equal rivals', () => {
  for (const [price, pct, meaning] of [
    [900, 10, 'disadvantage'],
    [1100, -10, 'advantage'],
    [1000, 0, 'tie'],
  ] as const) {
    const result = compare(product, rival(price), [link], { now })
    assert.equal(result.deltaPct, pct)
    assert.equal(result.meaning, meaning)
    assert.match(
      comparisonText(result),
      meaning === 'tie'
        ? /Empate/
        : meaning === 'disadvantage'
          ? /10 % más barato.*Desventaja/
          : /10 % más caro.*Ventaja/,
    )
  }
})
test('offer, exact catalog and list respect the rule; another MLU of the seller is never a reference', () => {
  const p = {
    ...product,
    sale_price: 800,
    catalog_price: 850,
    catalog_item_id: 'MLU1',
    catalog_currency_id: 'UYU',
    catalog_observed_at: at,
  }
  assert.equal(referencePrice(p).reference, 'sale')
  p.sale_price = null as unknown as number
  assert.equal(referencePrice(p).observation.amount, 850)
  assert.equal(referencePrice(p, false).observation.amount, 1000)
  assert.equal(
    referencePrice({ ...p, catalog_item_id: 'OTHER' }).reference,
    'list',
  )
})
test('zero, negatives, NaN, Infinity and null invalidate without silently falling back', () => {
  for (const value of [0, -1, NaN, Infinity, null]) {
    const result = compare({ ...product, price: value }, rival(), [link], {
      now,
    })
    assert.equal(result.status, 'no_price')
    assert.equal(result.deltaPct, null)
  }
  assert.equal(
    compare({ ...product, sale_price: 0 }, rival(), [link]).status,
    'no_price',
  )
})
test('prices remain comparable beyond the former four-hour boundary', () => {
  const old = new Date(now - 4 * 3_600_000).toISOString()
  assert.equal(
    compare({ ...product, synced_at: old }, rival(900, 'UYU', old), [link], {
      now,
    }).status,
    'comparable',
  )
  assert.equal(
    compare({ ...product, synced_at: old }, rival(), [link], { now: now + 1 })
      .status,
    'comparable',
  )
  assert.equal(
    compare(product, rival(900, 'UYU', old), [link], { now: now + 1 }).status,
    'comparable',
  )
  assert.equal(
    compare({ ...product, synced_at: old }, rival(), [link], {
      now,
      maxAgeHours: 5,
    }).status,
    'comparable',
  )
})
test('unresolved currencies never rank; conversion preserves complete source evidence', () => {
  const result = compare(product, rival(20, 'USD'), [link], { now })
  assert.equal(result.status, 'no_conversion')
  assert.equal(result.deltaPct, null)
  const quote = { rate: 40, source: 'test', fetchedAt: at, publishedAt: at }
  const observation = observe(20, 'USD', at, 'item', quote)
  assert.equal(observation.amount, 20)
  assert.equal(observation.currency, 'USD')
  assert.equal(observation.normalizedAmount, 800)
  assert.deepEqual(observation.fx, quote)
  assert.equal(
    compare(product, { observation, status: 'active' }, [link], { now })
      .deltaPct,
    20,
  )
  assert.equal(
    compare(product, rival(20, null), [link]).status,
    'no_conversion',
  )
})
test('links combine explicitly; paused, removed, rejected and pending links do not grant equivalence', () => {
  for (const changes of [
    { paused: true },
    { removed_at: at },
    { equivalence: 'pending' as const },
    { equivalence: 'rejected' as const },
  ]) {
    assert.notEqual(
      compare(product, rival(), [{ ...link, ...changes }]).status,
      'comparable',
    )
  }
  const specific = {
    ...link,
    id: 'specific',
    scope: 'publication' as const,
    our_product_id: product.id,
    our_sku: null,
    equivalence: 'pending' as const,
  }
  assert.equal(compare(product, rival(), [link, specific]).status, 'comparable')
  assert.deepEqual(compare(product, rival(), [link, specific]).associationIds, [
    'link',
  ])
  assert.equal(
    compare({ ...product, sku: null }, rival(), [link]).status,
    'paused',
  )
  assert.equal(
    compare({ ...product, sku: null }, rival(), [
      { ...specific, equivalence: 'accepted' },
    ]).status,
    'comparable',
  )
})
test('price_changed uses original values, so a rate movement is not a rival price change', () => {
  const quote = { rate: 40, source: 'test', fetchedAt: at, publishedAt: null }
  const before = observe(20, 'USD', at, 'item', quote)
  const after = observe(20, 'USD', at, 'item', { ...quote, rate: 41 })
  const result = compare(product, { status: 'active', observation: after }, [
    link,
  ])
  assert.equal(
    ruleFires(
      { rule_type: 'price_changed', threshold_pct: null },
      result,
      before,
    ),
    false,
  )
  assert.equal(
    ruleFires({ rule_type: 'competitor_cheaper', threshold_pct: null }, result),
    true,
  )
})
test('catalog minimum normalizes mixed currencies, excludes own listings and declares partial coverage', async () => {
  const fetcher = async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('/items'))
      return Response.json({
        paging: { total: 25 },
        results: [
          { item_id: 'OWN', seller_id: 1, price: 1, currency_id: 'UYU' },
          { item_id: 'USD', seller_id: 2, price: 30, currency_id: 'USD' },
          { item_id: 'UYU', seller_id: 3, price: 900, currency_id: 'UYU' },
        ],
      })
    return Response.json({ name: 'Catálogo', nickname: 'Rival' })
  }
  const result = await fetchTarget(
    { kind: 'catalog', id: 'MLU99' },
    {
      token: 'test',
      sellerId: 1,
      fx: { rate: 40, source: 'test', fetchedAt: at, publishedAt: null },
      fetcher,
    },
  )
  assert.equal(result.observation.itemId, 'UYU')
  assert.equal(result.observation.normalizedAmount, 900)
  assert.equal(result.observation.offersConsulted, 3)
  assert.equal(result.observation.coverage, 'partial')
})
test('a catalog with only own listings never becomes its own competitor', async () => {
  const result = await fetchTarget(
    { kind: 'catalog', id: 'MLU99' },
    {
      token: 'test',
      sellerId: 1,
      fx: null,
      fetcher: async () =>
        Response.json({
          results: [
            { item_id: 'OWN', seller_id: 1, price: 1, currency_id: 'UYU' },
          ],
        }),
    },
  )
  assert.equal(result.observation.state, 'no_external_offers')
  assert.equal(result.observation.amount, null)
})
test('target mode follows explicit URL identity rather than digit count; unexpected hosts fail', () => {
  assert.deepEqual(
    parseTarget('https://www.mercadolibre.com.uy/producto/p/MLU999'),
    { kind: 'catalog', id: 'MLU999',sourceKind:'catalog',sourceId:'MLU999',sourceUrl:'https://www.mercadolibre.com.uy/producto/p/MLU999' },
  )
  assert.deepEqual(parseTarget('MLU1234567890123'), {
    kind: 'item',
    id: 'MLU1234567890123',
  })
  assert.throws(() => parseTarget('https://evil.test/p/MLU99'))
})
test('price ties never imply winning; only explicit evidence for the exact MLU verifies adjudication without expiration', () => {
  assert.equal(compare(product, rival(1000), [link]).meaning, 'tie')
  assert.equal(adjudicationLabel(product), 'No verificado')
  const evidence = {
    state: 'winning',
    itemId: product.id,
    observedAt: at,
    source: 'price_to_win',
  }
  assert.match(
    adjudicationLabel({ ...product, catalog_competition: evidence }),
    /Ganador verificado/,
  )
  assert.equal(
    adjudicationLabel({
      ...product,
      catalog_competition: { ...evidence, itemId: 'OTHER' },
    }),
    'No verificado',
  )
  assert.equal(
    adjudicationLabel({
      ...product,
      catalog_competition: { ...evidence, source: 'price_equality' },
    }),
    'No verificado',
  )
  assert.equal(
    adjudicationLabel(
      { ...product, catalog_competition: evidence },
      now + 4 * 3_600_000 + 1,
    ),
    'Ganador verificado en la consulta',
  )
})

test('thresholds use the exact gap rather than its rounded presentation', () => {
  const result = compare(product, rival(800.01), [link])
  assert.equal(
    ruleFires({ rule_type: 'price_diff_pct_above', threshold_pct: 20 }, result),
    false,
  )
  const tiny = compare({ ...product, price: 1_000_000 }, rival(1_000_000.01), [
    link,
  ])
  assert.equal(
    ruleFires({ rule_type: 'price_diff_pct_above', threshold_pct: 0 }, tiny),
    false,
  )
  assert.match(comparisonText(tiny), /menos de 0,01.*Ventaja/)
})

test('different FX rates never create a false advantage between two USD prices', () => {
  const quote = { rate: 40, source: 'test', fetchedAt: at, publishedAt: null }
  const own = { ...product, price: 20, currency_id: 'USD', fx_quote: quote }
  const observation = observe(20, 'USD', at, 'item', { ...quote, rate: 41 })
  const result = compare(own, { status: 'active', observation }, [link])
  assert.equal(result.status, 'comparable')
  assert.equal(result.deltaPct, 0)
  assert.equal(
    ruleFires({ rule_type: 'competitor_pricier', threshold_pct: null }, result),
    false,
  )
})
