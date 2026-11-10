import { deepStrictEqual as assertEquals } from 'node:assert/strict'

// Pure upstream/REST simulation. This process has no network permission and
// cannot reach the restored local database or Mercado Libre.
Deno.env.set('SUPABASE_URL', 'https://db.test')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-secret')
Deno.env.set('ML_API_BASE_URL', 'https://ml.test')
Deno.env.set('MONITOR_FX_URL', 'https://fx.test')
let responder: (request: Request) => Response | Promise<Response>
globalThis.fetch = (input, init) =>
  Promise.resolve(responder(new Request(input, init)))
const service = await import('./service.ts')
const item = {
  id: 'MLU1',
  title: 'Publicación propia',
  price: 100,
  currency_id: 'UYU',
  status: 'active',
  seller_id: 1,
}
function upstream(
  options: { pricesFailed?: boolean; unconfirmed?: boolean } = {},
) {
  return (request: Request) => {
    const url = new URL(request.url)
    if (url.hostname === 'fx.test') return Response.json({ rates: { UYU: 40 } })
    if (url.hostname === 'db.test') {
      return Response.json(options.unconfirmed ? [] : [{ id: 'MLU1' }])
    }
    if (url.pathname === '/items/bulk') {
      return Response.json([{ id: item.id, status_code: 200, body: item }])
    }
    if (url.pathname.endsWith('/prices')) {
      return options.pricesFailed
        ? new Response(null, { status: 403 })
        : Response.json({ prices: [] })
    }
    throw new Error(`Unexpected simulated resource ${url.pathname}`)
  }
}
Deno.test('own authoritative price failure records exact target and HTTP status without upserting', async () => {
  responder = upstream({ pricesFailed: true })
  const result = await service.fetchAndUpsertItems(['MLU1'], 'test')
  assertEquals(result.upserted, 0)
  assertEquals(result.results[0].outcome, 'failed')
  assertEquals(result.results[0].http_status, 403)
  assertEquals(result.results[0].resource, '/items/MLU1/prices')
})
Deno.test('own HTTP success without affected rows is not a successful synchronization', async () => {
  responder = upstream({ unconfirmed: true })
  const result = await service.fetchAndUpsertItems(['MLU1'], 'test')
  assertEquals(result.upserted, 0)
  assertEquals(result.results[0].outcome, 'failed')
  assertEquals(result.results[0].category, 'persistence')
})
Deno.test('own successful upsert confirms identities and retains original price currency', async () => {
  responder = upstream()
  const result = await service.fetchAndUpsertItems(['MLU1'], 'test')
  assertEquals(result.upserted, 1)
  assertEquals(result.results[0].outcome, 'updated')
  assertEquals(result.results[0].identity.id, 'MLU1')
})
Deno.test('own discovery reads every page and exposes a failed seller-status listing', async () => {
  let activePage = 0
  responder = (request) => {
    const url = new URL(request.url)
    if (url.searchParams.get('status') === 'paused') {
      return new Response(null, { status: 403 })
    }
    if (url.searchParams.get('status') === 'active') {
      activePage++
      return Response.json({
        results: activePage === 1 ? ['MLU1'] : activePage === 2 ? ['MLU2'] : [],
        paging: { total: 2 },
        scroll_id: 'cursor',
      })
    }
    return Response.json({ results: [], paging: { total: 0 } })
  }
  const errors: string[] = []
  const ids = await service.fetchAllItemIds(
    'test',
    1,
    (status) => errors.push(status),
  )
  assertEquals(ids, ['MLU1', 'MLU2'])
  assertEquals(activePage, 3)
  assertEquals(errors, ['paused'])
})

function bulkEntry(id: string, changes: Record<string, unknown> = {}) {
  return { id, status_code: 200, body: { ...item, id }, ...changes }
}
function simulateBulk(
  payload: unknown,
  options: {
    http?: number
    noFx?: boolean
    prices?: unknown
    writeError?: boolean
  } = {},
) {
  const writes: Record<string, unknown>[] = [], calls: string[] = []
  responder = async (request) => {
    const url = new URL(request.url)
    calls.push(url.pathname + url.search)
    if (url.hostname === 'fx.test') {
      return options.noFx
        ? new Response(null, { status: 503 })
        : Response.json({ rates: { UYU: 40 } })
    }
    if (url.hostname === 'db.test') {
      if (options.writeError) {
        return Response.json({ message: 'Guardado rechazado' }, { status: 400 })
      }
      const rows = await request.json()
      writes.push(...rows)
      return Response.json(rows.map((row: { id: string }) => ({ id: row.id })))
    }
    if (url.pathname === '/items/bulk') {
      return Response.json(payload, { status: options.http ?? 200 })
    }
    if (url.pathname.endsWith('/prices')) {
      return Response.json(options.prices ?? { prices: [] })
    }
    throw new Error('Unexpected request ' + url.pathname)
  }
  return { writes, calls }
}
Deno.test('bulk matches out-of-order responses by root id, preserving every successful item', async () => {
  const { writes, calls } = simulateBulk([bulkEntry('MLU2'), bulkEntry('MLU1')])
  const result = await service.fetchAndUpsertItems(['MLU1', 'MLU2'], 'test')
  assertEquals(result.upserted, 2)
  assertEquals(writes.map((row) => row.id), ['MLU1', 'MLU2'])
  assertEquals(calls.some((path) => path.startsWith('/items?')), false)
})
Deno.test('bulk HTTP 200 with an individual 403 updates only successful entries', async () => {
  const { writes, calls } = simulateBulk([
    bulkEntry('MLU1'),
    bulkEntry('MLU2', { status_code: 403, body: { error: 'access_denied' } }),
  ])
  const result = await service.fetchAndUpsertItems(['MLU1', 'MLU2'], 'test')
  assertEquals(result.upserted, 1)
  assertEquals(writes.map((row) => row.id), ['MLU1'])
  const failure = result.results.find((row) => row.entity_id === 'MLU2')!
  assertEquals(failure.http_status, 403)
  assertEquals(failure.category, 'permissions')
  assertEquals(failure.resource, '/items/bulk?ids=MLU1,MLU2')
  assertEquals(calls.includes('/items/MLU2/prices'), false)
})
for (
  const [name, entries] of [
    ['missing', []],
    ['duplicate', [bulkEntry('MLU2'), bulkEntry('MLU2')]],
    ['mismatched', [bulkEntry('MLU2', { body: { ...item, id: 'MLU999' } })]],
    ['invalid status', [bulkEntry('MLU2', { status_code: '200' })]],
    ['legacy status', [{
      id: 'MLU2',
      code: 200,
      body: { ...item, id: 'MLU2' },
    }]],
    ['null body', [bulkEntry('MLU2', { body: null })]],
    ['invalid body', [bulkEntry('MLU2', { body: { id: 'MLU2' } })]],
    ['invalid amount', [
      bulkEntry('MLU2', { body: { ...item, id: 'MLU2', price: -1 } }),
    ]],
  ] as [string, unknown[]][]
) {
  Deno.test(`bulk ${name} entry cannot overwrite an old product or prevent another update`, async () => {
    const { writes } = simulateBulk([bulkEntry('MLU1'), ...entries])
    const result = await service.fetchAndUpsertItems(['MLU1', 'MLU2'], 'test')
    assertEquals(result.upserted, 1)
    assertEquals(writes.map((row) => row.id), ['MLU1'])
    assertEquals(
      result.results.find((row) => row.entity_id === 'MLU2')!.outcome,
      'failed',
    )
  })
}
Deno.test('bulk malformed envelope fails all requested targets without using stored prices', async () => {
  const { writes } = simulateBulk({ results: [bulkEntry('MLU1')] })
  const result = await service.fetchAndUpsertItems(['MLU1', 'MLU2'], 'test')
  assertEquals(result.upserted, 0)
  assertEquals(writes, [])
  assertEquals(result.results.map((row) => row.outcome), ['failed', 'failed'])
})
Deno.test('ResourceDeprecated is distinct from permissions and does not retain response bodies', async () => {
  for (const individual of [false, true]) {
    const body = {
      error: 'ResourceDeprecated',
      message: 'access_token=DO_NOT_STORE client_secret=DO_NOT_STORE',
    }
    const { writes } = simulateBulk(
      individual ? [bulkEntry('MLU1', { status_code: 403, body })] : body,
      { http: individual ? 200 : 403 },
    )
    const result = await service.fetchAndUpsertItems(['MLU1'], 'test')
    assertEquals(result.results[0].category, 'resource_deprecated')
    assertEquals(result.results[0].message.includes('ResourceDeprecated'), true)
    assertEquals(JSON.stringify(result).includes('DO_NOT_STORE'), false)
    assertEquals(writes, [])
  }
})
Deno.test('own bulk persistence failure is not an update', async () => {
  const { writes } = simulateBulk([bulkEntry('MLU1')], { writeError: true })
  const result = await service.fetchAndUpsertItems(['MLU1'], 'test')
  assertEquals(result.upserted, 0)
  assertEquals(result.results[0].category, 'persistence')
  assertEquals(writes, [])
})
Deno.test('USD prices retain original currency and warn if conversion is unavailable', async () => {
  const { writes } = simulateBulk([
    bulkEntry('MLU1', { body: { ...item, currency_id: 'USD', price: 72.80 } }),
  ], { noFx: true })
  const result = await service.fetchAndUpsertItems(['MLU1'], 'test')
  assertEquals(result.upserted, 1)
  assertEquals(writes[0].price, 72.80)
  assertEquals(writes[0].currency_id, 'USD')
  assertEquals(result.results[0].outcome, 'warning')
})
Deno.test('malformed prices cannot clear a stored promotion or count as updated', async () => {
  for (
    const prices of [{}, { id: 'MLU999', prices: [] }, { prices: [null] }, {
      prices: [{ type: 'promotion', amount: null }],
    }]
  ) {
    const { writes } = simulateBulk([bulkEntry('MLU1')], { prices })
    const result = await service.fetchAndUpsertItems(['MLU1'], 'test')
    assertEquals(result.upserted, 0)
    assertEquals(result.results[0].outcome, 'failed')
    assertEquals(writes, [])
  }
})
Deno.test('scheduled own batches never request more than 20 targets', async () => {
  const ids = Array.from({ length: 41 }, (_, i) => `MLU${i + 1}`)
  const calls: string[][] = []
  responder = async (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'fx.test') return Response.json({ rates: { UYU: 40 } })
    if (url.hostname === 'db.test') {
      return Response.json(
        (await request.json()).map((row: { id: string }) => ({ id: row.id })),
      )
    }
    if (url.pathname === '/items/bulk') {
      const batch = url.searchParams.get('ids')!.split(',')
      calls.push(batch)
      return Response.json(batch.map((id) => bulkEntry(id)))
    }
    return Response.json({ prices: [] })
  }
  const result = await service.fetchAndUpsertItems(ids, 'test')
  assertEquals(result.upserted, 41)
  assertEquals(calls.map((batch) => batch.length), [20, 20, 1])
})
