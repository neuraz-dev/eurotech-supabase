import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createCompetitorHandler } from '../../supabase/functions/ml-sync-competitor/handler.ts'
import { syncCatalog } from '../../supabase/functions/_shared/catalog-service.ts'
import {
  syncTracked,
  enrichTracked,
} from '../../supabase/functions/_shared/monitor-service.ts'
import {
  fetchTarget,
  trackingSnapshot,
} from '../../supabase/functions/_shared/ml-observation.ts'
const url = process.env.MONITOR_TEST_SUPABASE_URL
if (
  !url ||
  new URL(url).hostname !== '127.0.0.1' ||
  new URL(url).port !== '55421'
)
  throw new Error(
    'Integration tests require the isolated local stack at 127.0.0.1:55421',
  )
const key = process.env.MONITOR_TEST_SECRET_KEY!
const client = createClient(url, key, { auth: { persistSession: false } }),
  api = 'http://127.0.0.1:55430'
const context = {
  token: 'synthetic',
  sellerId: 1,
  apiUrl: api,
  fxUrl: `${api}/fx`,
}
async function check<T extends { error: unknown }>(query: PromiseLike<T>) {
  const result = await query
  assert.equal(result.error, null)
  return result
}
before(async () => {
  const { data, error } = await client
    .schema('ml')
    .from('monitor_local_fixture_guard')
    .select('id')
    .single()
  assert.equal(error, null)
  assert.equal(
    data?.id,
    'eurotech-monitor-improvements',
    'Integration tests require a synthetic fixture marker',
  )
})
test('concurrent associations are idempotent and never steal another destination', async () => {
  const { data: before } = await check(
    client
      .schema('ml')
      .from('ml_competitor_links')
      .select('*')
      .eq('competitor_item_id', 'MLU200'),
  )
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      client.schema('ml').rpc('link_competitor', {
        p_item: { id: 'MLU200', target_kind: 'item' },
        p_scope: 'publication',
        p_target: 'MLU102',
      }),
    ),
  )
  for (const result of results) assert.equal(result.error, null)
  assert.equal(
    new Set(results.map((result) => result.data.association.id)).size,
    1,
  )
  const { data: after } = await check(
    client
      .schema('ml')
      .from('ml_competitor_links')
      .select('*')
      .eq('competitor_item_id', 'MLU200'),
  )
  for (const link of before!)
    assert.ok(after!.some((row) => row.id === link.id))
  await check(
    client
      .schema('ml')
      .from('ml_competitor_links')
      .delete()
      .eq('id', results[0].data.association.id),
  )
})
test('catalog reference resolves the exact MLU; equal observed price and explicit winner evidence remain independent', async () => {
  await check(
    client
      .schema('ml')
      .from('ml_products')
      .update({ catalog_product_id: 'MLU900', site_id: 'MLU' })
      .eq('id', 'MLU101'),
  )
  const result = await syncCatalog(client, context)
  assert.equal(result.success, true)
  const { data } = await check(
    client
      .schema('ml')
      .from('ml_products')
      .select('*')
      .eq('id', 'MLU101')
      .single(),
  )
  assert.equal(data.catalog_item_id, 'MLU101')
  assert.equal(data.catalog_price, 1000)
  assert.equal(data.catalog_observation.normalizedAmount, 900)
  assert.equal(data.catalog_competition.state, 'winning')
})
test('the authenticated scheduled handler persists raw observations without generating alerts before review', async () => {
  await check(
    client.schema('ml').from('ml_tokens').upsert({
      id: 1,
      access_token: 'synthetic',
      user_id: 1,
      expires_at: '2100-01-01T00:00:00Z',
    }),
  )
  const handler = createCompetitorHandler(client, {
    serviceKey: key,
    ...{ apiUrl: api, fxUrl: `${api}/fx` },
  })
  const response = await handler(
    new Request('http://local.test', {
      method: 'POST',
      headers: { apikey: key },
    }),
  )
  assert.equal(response.status, 200)
  assert.equal((await response.json()).alerts_fired, 0)
  const { data } = await check(
    client
      .schema('ml')
      .from('ml_competitor_items')
      .select('*')
      .eq('id', 'MLU200')
      .single(),
  )
  assert.equal(data.observation.amount, 900)
  assert.equal(data.observation.currency, 'UYU')
})
test('fixed/dynamic targets remain distinct; seller switches at the same price create snapshots and reactivation preserves history', async () => {
  const observation = await fetchTarget(
    { kind: 'catalog', id: 'MLU990' },
    { ...context, fx: null },
  )
  const { data } = await check(
    client.schema('ml').rpc('save_tracking', {
      p_item: {
        target_kind: 'catalog',
        target_id: 'MLU990',
        url: 'https://www.mercadolibre.com.uy/p/MLU990',
        title: 'Catálogo de prueba',
      },
      p_snapshot: trackingSnapshot(observation),
    }),
  )
  await fetch(`${api}/control`, {
    method: 'POST',
    body: JSON.stringify({ version: 2 }),
  })
  assert.equal((await syncTracked(client, context)).success, true)
  const [item] = await enrichTracked(client, data.id)
  assert.equal(item.latest_snapshot.price, item.prev_snapshot.price)
  assert.notEqual(
    item.latest_snapshot.selected_item_id,
    item.prev_snapshot.selected_item_id,
  )
  const { count: before } = await check(
    client
      .schema('ml')
      .from('ml_tracked_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('tracked_item_id', data.id),
  )
  await check(
    client
      .schema('ml')
      .from('ml_tracked_items')
      .update({ active: false })
      .eq('id', data.id),
  )
  const { data: reactivated } = await check(
    client.schema('ml').rpc('save_tracking', {
      p_item: { target_kind: 'catalog', target_id: 'MLU990' },
      p_snapshot: null,
    }),
  )
  assert.equal(reactivated.reactivated, true)
  const { count: after } = await check(
    client
      .schema('ml')
      .from('ml_tracked_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('tracked_item_id', data.id),
  )
  assert.equal(before, after)
  await check(
    client.schema('ml').from('ml_tracked_items').delete().eq('id', data.id),
  )
  await fetch(`${api}/control`, { method: 'POST', body: '{}' })
})
