import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClient } from '@supabase/supabase-js'
import { syncCatalog } from '../../supabase/functions/_shared/catalog-service.ts'
import {
  executeManualTask,
  type ManualTask,
  type OwnAdapter,
  processManualQueue,
} from '../../supabase/functions/ml-manual-sync/worker.ts'
import {
  safeSyncMessage,
  syncFailure,
  type SyncResult,
} from '../../supabase/functions/_shared/sync-report.ts'
const task = (overrides: Partial<ManualTask> = {}): ManualTask => ({
  id: 'task',
  run_id: 'run',
  stage: 'own',
  kind: 'batch',
  payload: [{ id: 'MLU1', title: 'Nombre guardado', sku: '7270' }],
  lease_token: 'lease',
  attempts: 1,
  ...overrides,
})
function database(fetcher: (req: Request) => Promise<Response>) {
  return createClient('https://db.test', 'test', {
    global: { fetch: async (input, init) => fetcher(new Request(input, init)) },
  })
}
const adapter: OwnAdapter = {
  token: async () => ({ access_token: 'secret', user_id: 1 }),
  discover: async () => ['MLU1'],
  update: async (ids) => ({
    upserted: ids.length,
    results: ids.map((id) => ({
      entity_id: id,
      identity: { id },
      outcome: 'updated',
      message: 'Guardado',
    })),
  }),
}
test('every failed catalog target is reported beyond the former 20-error cap', async () => {
  const products = Array.from(
    { length: 49 },
    (_, i) => ({
      id: `MLU${i}`,
      title: `Producto ${i}`,
      sku: '7270',
      catalog_product_id: `MLU${i + 100}`,
    }),
  )
  const client = database(async () => Response.json(products)),
    reported: SyncResult[] = []
  const result = await syncCatalog(client, {
    token: 'test',
    sellerId: 1,
    fxUrl: 'https://fx.test',
    fetcher: async (input) =>
      String(input).includes('fx.test')
        ? Response.json({ rates: { UYU: 40 } })
        : new Response(null, { status: 404 }),
  }, { report: (r) => reported.push(r) })
  assert.equal(result.items_failed, 49)
  assert.equal(result.errors.length, 49)
  assert.equal(reported.length, 49)
  assert.equal(reported[48].identity.title, 'Producto 48')
  assert.equal(reported[48].http_status, 404)
})
test('a batch preserves names, SKU and identifiers from discovery after source removal', async () => {
  const client = database(async () => Response.json(null))
  const result = await executeManualTask(client, task(), adapter)
  assert.equal(result.results[0].identity.title, 'Nombre guardado')
  assert.equal(result.results[0].identity.sku, '7270')
  assert.equal(result.results[0].outcome, 'updated')
})
test('own discovery retains a failed status listing without discarding known pages', async () => {
  const ids = Array.from({ length: 1005 }, (_, i) => `MLU${i}`)
  let pages = 0
  const client = database(async (req) => {
    if (req.url.includes('ml_sync_runs')) {
      return Response.json({ target_id: null })
    }
    pages++
    return Response.json(
      pages === 1
        ? ids.slice(0, 1000).map((id) => ({ id, title: id }))
        : ids.slice(1000).map((id) => ({ id, title: id })),
    )
  })
  const result = await executeManualTask(client, task({ kind: 'discover' }), {
    ...adapter,
    discover: async () => ({
      ids,
      failures: [{
        entity_id: '$stage:paused',
        identity: { id: '$stage:paused' },
        outcome: 'failed',
        message: 'Permisos insuficientes',
        http_status: 403,
      }],
    }),
  })
  assert.equal(pages, 2)
  assert.equal(result.children.length, 101)
  assert.equal(result.children.flatMap((child) => child.payload).length, 1005)
  assert.equal(result.results[0].http_status, 403)
})
test('confirmed own failures never become success or use old database prices', async () => {
  const result = await executeManualTask(
    database(async () => Response.json(null)),
    task(),
    {
      ...adapter,
      update: async () => ({
        upserted: 0,
        results: [{
          entity_id: 'MLU1',
          identity: { id: 'MLU1' },
          outcome: 'failed',
          message: 'No autorizado',
          category: 'authentication',
          http_status: 401,
        }],
      }),
    },
  )
  assert.equal(result.results[0].outcome, 'failed')
  assert.equal(result.results[0].attempts, 1)
})
test('an exhausted external retry reports attempts and keeps the persisted identity', async () => {
  let attempts = 0
  const result = await executeManualTask(
    database(async () => Response.json(null)),
    task(),
    {
      ...adapter,
      update: async () => {
        attempts++
        return {
          upserted: 0,
          results: [{
            entity_id: 'MLU1',
            identity: { id: 'MLU1' },
            outcome: 'failed',
            message: 'Servicio HTTP 503',
            category: 'server',
          }],
        }
      },
    },
  )
  assert.equal(attempts, 2)
  assert.equal(result.results[0].attempts, 2)
})
test('worker fails without acknowledging an unconfirmed database finish', async () => {
  let claimed = false
  const client = database(async (req) => {
    if (req.url.includes('claim_manual_sync_task')) {
      if (claimed) return Response.json([])
      claimed = true
      return Response.json([task()])
    }
    if (req.url.includes('finish_manual_sync_task')) return Response.json(false)
    throw new Error('unexpected call')
  })
  await assert.rejects(
    () => processManualQueue(client, adapter),
    /No se confirmó el guardado/,
  )
})
test('worker records token failure for every known target and keeps a global discovery error global', async () => {
  for (const kind of ['batch', 'discover'] as const) {
    let claimed = false, recorded: SyncResult[] = []
    const client = database(async (req) => {
      if (req.url.includes('claim_manual_sync_task')) {
        if (claimed) return Response.json([])
        claimed = true
        return Response.json([task({ kind })])
      }
      if (req.url.includes('ml_sync_runs')) {
        return Response.json({ target_id: null })
      }
      if (req.url.includes('finish_manual_sync_task')) {
        recorded = (await req.json()).p_results
        return Response.json(true)
      }
      throw new Error('unexpected call')
    })
    await processManualQueue(client, {
      ...adapter,
      token: async () => {
        throw new Error('Token no disponible')
      },
    })
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].outcome, 'failed')
    assert.equal(recorded[0].entity_id, kind === 'batch' ? 'MLU1' : '$stage')
  }
})
test('credentials are redacted and failures retain useful categories', () => {
  const safe = safeSyncMessage(
    'access_token=secret123 Authorization: Bearer abc123 apikey=key123 eyJabc.def.ghi',
  )
  for (const value of ['secret123', 'abc123', 'key123', 'eyJabc.def.ghi']) {
    assert.equal(safe.includes(value), false)
  }
  assert.equal(
    syncFailure(Object.assign(new Error('Consulta HTTP 403'), { status: 403 }))
      .category,
    'permissions',
  )
  assert.equal(
    syncFailure(new Error('No se pudo guardar'), 'persistencia').category,
    'persistence',
  )
})
