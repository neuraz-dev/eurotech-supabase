import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { createCompetitorHandler } from '../../supabase/functions/ml-sync-competitor/handler.ts'
import { observe } from '../../supabase/functions/_shared/monitoring.ts'
const now = new Date().toISOString()
function fixture(
  t: TestContext,
  options: {
    catalog?: boolean
    noToken?: boolean
    expired?: boolean
    upstreamStatus?: number
    writeError?: boolean
    alertError?: boolean
    unconfirmedWrite?: boolean
    empty?: boolean
    onlyOwn?: boolean
    currency?: string
    noFx?: boolean
    pending?: boolean
    shared?: boolean
    overlap?: boolean
    partial?: boolean
    malformed?: boolean
    emptyCatalog?: boolean
    many?: boolean
    conflict?: boolean
    samePrice?: boolean
    noObservation?: boolean
    knownIdentity?: boolean
    priceMissing?: boolean
    catalogMalformed?: boolean
  } = {},
) {
  const writes: {
      table: string
      method: string
      row: Record<string, unknown>
    }[] = [],
    requests: string[] = []
  let rpcCalls=0
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init),
      url = new URL(req.url),
      table = url.pathname.split('/').pop()!
    requests.push(req.url)
    if (url.origin === 'https://db.test') {
      if(table==='repair_verified_source_archives')return Response.json(0)
      if(table==='record_monitor_observation'){
        const payload=await req.json()
        rpcCalls++
        if(options.conflict&&rpcCalls===1)return Response.json({conflict:true})
        if(options.writeError||options.alertError)return Response.json({message:'Atomic persistence failed'},{status:400})
        if(options.unconfirmedWrite)return Response.json(null)
        writes.push({table:'ml_competitor_items',method:'PATCH',row:payload.p_update})
        for(const event of payload.p_events)writes.push({table:'ml_price_alerts',method:'POST',row:event})
        return Response.json({alerts:payload.p_events.length,revision:1})
      }
      if (req.method === 'GET') {
        if (table === 'ml_tokens')
          return options.noToken
            ? Response.json(null)
            : Response.json({
                id: 1,
                access_token: 'test',
                refresh_token: null,
                user_id: 1,
                expires_at: new Date(
                  Date.now() + (options.expired ? -1000 : 3600000),
                ).toISOString(),
              })
        if (table === 'ml_monitoring_settings')
          return Response.json({ max_age_hours: 4 })
        const id = options.catalog ? 'MLU999' : 'MLU200'
        const link = {
          id: 'link',
          competitor_item_id: id,
          scope: options.shared ? 'sku' : 'publication',
          our_product_id: options.shared ? null : 'MLU100',
          our_sku: options.shared ? 'sku' : null,
          paused: false,
          removed_at: null,
          equivalence: options.pending ? 'pending' : 'accepted',
        }
        let data: unknown[] = []
        if (table === 'ml_competitor_items')
          data = options.empty
            ? []
            : [
                {
                  id,
                  target_kind: options.catalog ? 'catalog' : 'item',
                  observation: options.noObservation?null:{...observe(options.samePrice?80:90, 'UYU', now, 'item'),...(options.knownIdentity?{itemId:id,resolution:{sourceKind:'item',sourceId:id,itemId:id,sellerId:2,resource:'/items/'+id,validatedAt:now}}:{})},
                  status: 'active',
                },
              ]
        if (table === 'ml_competitor_links')
          data = [
            link,
            ...(options.overlap
              ? [
                  {
                    ...link,
                    id: 'extra',
                    scope: 'publication',
                    our_product_id: 'MLU100',
                    our_sku: null,
                  },
                ]
              : []),
          ]
        if (table === 'ml_products')
          data = [
            {
              id: 'MLU100',
              sku: ' SKU ',
              price: 100,
              sale_price: null,
              catalog_price: null,
              currency_id: 'UYU',
              status: 'active',
              synced_at: now,
            },
            ...(options.shared
              ? [
                  {
                    id: 'MLU101',
                    sku: 'sku',
                    price: 200,
                    sale_price: null,
                    catalog_price: null,
                    currency_id: 'UYU',
                    status: 'active',
                    synced_at: now,
                  },
                ]
              : []),
          ]
        if (table === 'ml_price_alert_rules')
          data = [
            {
              id: 'rule',
              sku: null,
              enabled: true,
              rule_type: 'competitor_cheaper',
              compare_catalog_price: true,
            },
          ]
        if (options.many && table === 'ml_products')
          data = Array.from({ length: 1501 }, (_, i) => ({
            id: `P${String(i).padStart(4, '0')}`,
            sku: 'sku',
            price: 100,
            sale_price: null,
            catalog_price: null,
            currency_id: 'UYU',
            status: 'active',
            synced_at: now,
          }))
        if(options.partial&&table==='ml_competitor_items')data.push({...data[0] as Record<string,unknown>,id:'MLU201'})
        if(options.partial&&table==='ml_competitor_links')data.push({...link,id:'link-201',competitor_item_id:'MLU201'})
        if(options.conflict&&table==='ml_competitor_items'&&url.searchParams.has('id'))return Response.json({...data[0] as Record<string,unknown>,observation_revision:1})
        const offset = Number(url.searchParams.get('offset') ?? 0),
          limit = Number(url.searchParams.get('limit') ?? 1000)
        return Response.json(data.slice(offset, offset + limit))
      }
      const payload = await req.json(),
        rows = Array.isArray(payload) ? payload : [payload]
      if (
        (table === 'ml_competitor_items' && options.writeError) ||
        (table === 'ml_price_alerts' && options.alertError)
      )
        return Response.json({ message: 'persist failed' }, { status: 400 })
      for (const row of rows) writes.push({ table, method: req.method, row })
      return req.method === 'PATCH'
        ? Response.json({
            id: table === 'ml_competitor_items' ? 'MLU200' : 'x',
          })
        : new Response(null, { status: 201 })
    }
    if (url.origin === 'https://open.er-api.com')
      return options.noFx
        ? Response.json({}, { status: 503 })
        : Response.json({ rates: { UYU: 40 } })
    assert.equal(url.origin, 'https://api.mercadolibre.com')
    assert.equal(req.method, 'GET', 'No remote writes or OAuth refresh')
    if (options.upstreamStatus)
      return Response.json({}, { status: options.upstreamStatus })
    if(options.partial&&url.pathname==='/items/MLU201')return Response.json({},{status:403})
    if(options.malformed&&url.pathname.startsWith('/items/'))return Response.json({})
    if(options.catalogMalformed&&url.pathname.endsWith('/items'))return Response.json({})
    if(options.priceMissing&&url.pathname.startsWith('/items/'))return Response.json({id:url.pathname.split('/').pop(),seller_id:2,status:'active'})
    if(options.emptyCatalog&&url.pathname.endsWith('/items'))return Response.json({results:[],paging:{total:0}})
    if (url.pathname.endsWith('/items'))
      return Response.json({
        paging: { total: 1 },
        results: [
          {
            item_id: 'MLU200',
            seller_id: options.onlyOwn ? 1 : 2,
            price: 80,
            currency_id: options.currency ?? 'UYU',
          },
        ],
      })
    if (url.pathname.startsWith('/items/'))
      return Response.json({
        id: url.pathname.split('/').pop(),
        seller_id: 2,
        price: 80,
        currency_id: options.currency ?? 'UYU',
        title: 'Rival',
        status: 'active',
      })
    return Response.json({ name: 'Rival', nickname: 'Rival' })
  }
  t.mock.method(globalThis, 'fetch', fakeFetch)
  const client = createClient('https://db.test', 'test', {
    global: { fetch: fakeFetch },
  })
  return {
    handler: createCompetitorHandler(client, { serviceKey: 'secret' }),
    writes,
    requests,
    rpcCalls:()=>rpcCalls,
  }
}
const request = () =>
  new Request('https://local.test', {
    method: 'POST',
    headers: { apikey: 'secret' },
  })
test('rejects unauthorized requests before any database or upstream access', async (t) => {
  const f = fixture(t)
  assert.equal(
    (await f.handler(new Request('https://local.test', { method: 'POST' })))
      .status,
    401,
  )
  assert.deepEqual(f.requests, [])
})
for (const catalog of [false, true]) {
  test(`persists current observations before generating alerts (${catalog ? 'catalog' : 'fixed'})`, async (t) => {
    const f = fixture(t, { catalog })
    const response = await f.handler(request())
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.items_updated, 1)
    assert.equal(body.alerts_fired, 1)
    assert.ok(f.writes[0].row.observation)
    const alert = f.writes.find((w) => w.table === 'ml_price_alerts')!.row
    assert.equal(alert.our_product_id, 'MLU100')
    assert.equal(alert.diff_pct, 20)
    assert.ok(alert.comparison_snapshot)
  })
  test(`does not emit alerts or renew freshness after failed retrieval (${catalog})`, async (t) => {
    const f = fixture(t, { catalog, upstreamStatus: 403 })
    const r = await f.handler(request())
    assert.equal(r.status, 500)
    assert.equal(f.writes.length, 1)
    assert.ok(f.writes[0].row.last_error)
    assert.equal(f.writes[0].row.synced_at, undefined)
  })
  test(`does not emit alerts after persistence failure (${catalog})`, async (t) => {
    const f = fixture(t, { catalog, writeError: true })
    assert.equal((await f.handler(request())).status, 500)
    assert.ok(!f.writes.some((w) => w.table === 'ml_price_alerts'))
  })
}
test('pending equivalence still refreshes observations without generating comparisons', async (t) => {
  const f = fixture(t, { pending: true })
  assert.equal((await f.handler(request())).status, 200)
  assert.ok(!f.writes.some((w) => w.table === 'ml_price_alerts'))
})
test('a missing conversion preserves USD and blocks comparative alerts', async (t) => {
  const f = fixture(t, { currency: 'USD', noFx: true })
  assert.equal((await f.handler(request())).status, 200)
  assert.equal(f.writes[0].row.currency_id, 'USD')
  assert.equal(
    (f.writes[0].row.observation as { normalizedAmount: null })
      .normalizedAmount,
    null,
  )
  assert.ok(!f.writes.some((w) => w.table === 'ml_price_alerts'))
})
test('own-only catalogs invalidate the current observation instead of falling back to own offers', async (t) => {
  const f = fixture(t, { catalog: true, onlyOwn: true })
  assert.equal((await f.handler(request())).status, 200)
  assert.equal(
    (f.writes[0].row.observation as { state: string }).state,
    'no_external_offers',
  )
  assert.ok(!f.writes.some((w) => w.table === 'ml_price_alerts'))
})
test('SKU links evaluate every own MLU and overlapping origins do not duplicate events', async (t) => {
  const f = fixture(t, { shared: true, overlap: true })
  assert.equal((await f.handler(request())).status, 200)
  const alerts = f.writes.filter((w) => w.table === 'ml_price_alerts')
  assert.deepEqual(
    alerts.map((w) => [w.row.our_product_id, w.row.diff_pct]),
    [
      ['MLU100', 20],
      ['MLU101', 60],
    ],
  )
})
test('stable pagination includes all 1501 publications', async (t) => {
  const f = fixture(t, { many: true, shared: true })
  assert.equal((await f.handler(request())).status, 200)
  assert.equal(
    f.writes.filter((w) => w.table === 'ml_price_alerts').length,
    1501,
  )
})
test('event write failure rolls back the observation rather than losing the change', async (t) => {
  const f = fixture(t, { alertError: true })
  const r = await f.handler(request())
  assert.equal(r.status, 500)
  assert.equal((await r.json()).items_updated, 0)
  assert.ok(!f.writes.some(write=>write.row.observation))
})
for (const options of [{ noToken: true }, { expired: true }])
  test(`missing or expired token fails without remote writes ${JSON.stringify(options)}`, async (t) => {
    const f = fixture(t, options)
    assert.equal((await f.handler(request())).status, 500)
    assert.equal(f.writes.length, 0)
  })

test('an empty rival set performs no item queries and emits no alerts',async t=>{
 const f=fixture(t,{empty:true}),response=await f.handler(request()),result=await response.json()
 assert.equal(response.status,200);assert.equal(result.items_processed,0);assert.deepEqual(f.writes,[])
 assert.ok(!f.requests.some(url=>url.startsWith('https://api.mercadolibre.com/')))
})
test('a partially failed run retains successful observations and reports its failed item',async t=>{
 const f=fixture(t,{partial:true}),response=await f.handler(request()),result=await response.json()
 assert.equal(response.status,500);assert.equal(result.items_updated,1);assert.equal(result.items_failed,1);assert.equal(result.alerts_fired,1)
 assert.ok(f.writes.some(write=>write.table==='ml_competitor_items'&&write.row.observation))
})
test('a missing item identity in an HTTP 200 body is a retrieval failure',async t=>{
 const f=fixture(t,{malformed:true}),response=await f.handler(request())
 assert.equal(response.status,500);assert.ok(f.writes[0].row.last_error);assert.equal(f.writes[0].row.synced_at,undefined)
})
test('an empty catalog clears comparison eligibility without inventing a zero price',async t=>{
 const f=fixture(t,{catalog:true,emptyCatalog:true}),response=await f.handler(request())
 assert.equal(response.status,200);assert.equal((f.writes[0].row.observation as {amount:null}).amount,null)
 assert.equal(f.writes.filter(write=>write.table==='ml_price_alerts').length,0)
})

for(const options of [{samePrice:true},{noObservation:true}])test(`unchanged price or initial baseline creates no event ${JSON.stringify(options)}`,async t=>{
 const f=fixture(t,options),result=await (await f.handler(request())).json()
 assert.equal(result.alerts_fired,0)
 assert.equal(f.writes.filter(w=>w.table==='ml_price_alerts').length,0)
})
test('a concurrent revision is reloaded and retried without losing the event',async t=>{
 const f=fixture(t,{conflict:true}),response=await f.handler(request()),result=await response.json()
 assert.equal(response.status,200);assert.equal(f.rpcCalls(),2);assert.equal(result.alerts_fired,1)
 assert.equal(f.writes.filter(w=>w.table==='ml_price_alerts').length,1)
})
test('an HTTP success without a persisted result is reported as a sync failure',async t=>{
 const f=fixture(t,{unconfirmedWrite:true}),response=await f.handler(request()),result=await response.json()
 assert.equal(response.status,500);assert.equal(result.items_updated,0);assert.equal(result.alerts_fired,0)
 assert.equal(result.alert_errors,1)
})
for(const status of [403,429,503])test(`technical HTTP ${status} does not mark a known rival unavailable`,async t=>{
 const f=fixture(t,{upstreamStatus:status,knownIdentity:true})
 await f.handler(request())
 assert.equal(f.writes[0].row.availability,undefined)
})
test('404 only confirms unavailable after the source identity was established',async t=>{
 const unknown=fixture(t,{upstreamStatus:404})
 await unknown.handler(request())
 assert.equal(unknown.writes[0].row.availability,undefined)
 assert.match(String(unknown.writes[0].row.last_error),/por resolver/)
})
test('a confirmed missing rival is marked unavailable without overwriting its observation',async t=>{
 const f=fixture(t,{upstreamStatus:404,knownIdentity:true})
 await f.handler(request())
 assert.equal(f.writes[0].row.availability,'unavailable')
 assert.equal(f.writes[0].row.observation,undefined)
})
for(const options of [{priceMissing:true},{catalog:true,catalogMalformed:true}])test(`malformed HTTP 200 is not confirmed unavailability ${JSON.stringify(options)}`,async t=>{
 const f=fixture(t,options),response=await f.handler(request())
 assert.equal(response.status,500)
 assert.equal(f.writes[0].row.availability,undefined)
 assert.equal(f.writes[0].row.observation,undefined)
})
