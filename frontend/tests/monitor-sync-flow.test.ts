import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runMonitorSync } from '../src/lib/monitor-sync.ts'

const own = { body: { success: true, upserted: 100, has_more: true } }
const rival = { success: true, items_updated: 2, items_failed: 0, alerts_fired: 1 }
test('partial catalog sync still runs rivals and reports each stage without claiming success', async () => {
  const calls: string[] = []
  const result = await runMonitorSync(async (url) => {
    calls.push(url)
    return Response.json(url.endsWith('sync-own') ? own : url.endsWith('sync-catalog')
      ? { success: false, catalog_prices_updated: 8, items_failed: 1, errors: [{ itemId: 'MLU100', message: 'Catálogo HTTP 404' }] }
      : rival)
  })
  assert.equal(calls.length, 3)
  assert.equal(result.success, false)
  assert.match(result.message, /Catálogo: 8 actualizados, 1 fallidos/)
  assert.match(result.message, /MLU100: Catálogo HTTP 404/)
  assert.match(result.message, /Rivales: 2 actualizados/)
  assert.match(result.message, /otras páginas siguen en proceso/)
})
test('network and malformed responses do not prevent the remaining stages from running', async () => {
  let calls = 0
  const result = await runMonitorSync(async () => {
    calls++
    if (calls === 1) throw new Error('Sin red')
    return Response.json(calls === 2 ? {} : rival)
  })
  assert.equal(calls, 3)
  assert.equal(result.success, false)
  assert.match(result.message, /Sin red/)
  assert.match(result.message, /Respuesta de sincronización inválida/)
})
test('HTTP 500 partial rival sync preserves persisted progress in the summary', async () => {
  const result = await runMonitorSync(async (url) => Response.json(
    url.endsWith('sync-own') ? own : url.endsWith('sync-catalog')
      ? { success: true, catalog_prices_updated: 1, items_failed: 0 }
      : { ...rival, success: false, items_updated: 1, items_failed: 1 },
    { status: url.endsWith('sync-competitors') ? 500 : 200 },
  ))
  assert.equal(result.success, false)
  assert.match(result.message, /Rivales: 1 actualizados, 1 fallidos/)
})
