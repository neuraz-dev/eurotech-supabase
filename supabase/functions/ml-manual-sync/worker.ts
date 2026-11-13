import { recoverPendingFixedTargets } from '../_shared/source-recovery.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import {
  allRows,
  syncCompetitors,
  syncTracked,
} from '../_shared/monitor-service.ts'
import { syncCatalog, syncCategoryNames } from '../_shared/catalog-service.ts'
import {
  identityOf,
  syncFailure,
  type SyncIdentity,
  type SyncResult,
  type SyncStage,
} from '../_shared/sync-report.ts'

export type ManualTask = {
  id: string
  run_id: string
  stage: SyncStage
  kind: 'discover' | 'batch'
  payload: SyncIdentity[]
  lease_token: string
  attempts: number
}
export type OwnAdapter = {
  token: () => Promise<{ access_token: string; user_id: number }>
  discover: (
    token: string,
    seller: number,
  ) => Promise<string[] | { ids: string[]; failures: SyncResult[] }>
  update: (
    ids: string[],
    token: string,
  ) => Promise<{ upserted: number; results: SyncResult[] }>
}
export function batches<T>(items: T[], size: number) {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}
export async function executeManualTask(
  client: SupabaseClient,
  task: ManualTask,
  own: OwnAdapter,
  options: { apiUrl?: string; fxUrl?: string; fetcher?: typeof fetch } = {},
): Promise<
  {
    results: SyncResult[]
    children: { key: string; payload: SyncIdentity[] }[]
  }
> {
  if (task.kind === 'discover') {
    const run = await client.schema('ml').from('ml_sync_runs').select(
      'target_id',
    ).eq('id', task.run_id).single()
    if (run.error) throw run.error
    let identities: SyncIdentity[]
    let failures: SyncResult[] = []
    if (task.stage === 'own') {
      const token = await own.token()
      const discovery = run.data.target_id
        ? [run.data.target_id as string]
        : await own.discover(token.access_token, token.user_id)
      const ids = Array.isArray(discovery) ? discovery : discovery.ids
      if (!Array.isArray(discovery)) failures = discovery.failures
      const products = await allRows<Record<string, unknown>>(
        client,
        'ml_products',
        'id,title,sku,permalink',
      )
      const known = new Map(
        products.map((row) => [String(row.id), identityOf(row)]),
      )
      identities = ids.map((id) => known.get(id) ?? { id, itemId: id })
    } else {
      if (task.stage === 'rivals') {
        try {
          const token = await own.token()
          const recovery = await recoverPendingFixedTargets(client, {
            token: token.access_token,
            sellerId: Number(token.user_id),
            fx: null,
            ...options,
          })
          if (recovery.recoveries_pending) {
            failures.push({
              entity_id: '$stage:recovery',
              identity: {
                id: '$stage:recovery',
                title: 'Resolución de identidades pendientes',
              },
              outcome: 'warning',
              category: 'resolution',
              operation: 'resolución',
              message:
                `${recovery.recoveries_pending} recuperaciones siguen pendientes. Los destinos identificados se consultarán normalmente.`,
            })
          }
        } catch (error) {
          failures.push({
            entity_id: '$stage:recovery',
            identity: {
              id: '$stage:recovery',
              title: 'Revisión de identidades',
            },
            outcome: 'warning',
            ...syncFailure(error, 'resolución'),
          })
        }
      }
      const table = {
        catalog: 'ml_products',
        rivals: 'ml_competitor_items',
        tracked: 'ml_tracked_items',
      }[task.stage]
      let rows = await allRows<Record<string, unknown>>(client, table)
      if (task.stage === 'tracked') rows = rows.filter((row) => row.active)
      if (task.stage === 'catalog' && run.data.target_id) {
        const selected = rows.find(row => row.id === run.data.target_id)
        if (!selected?.catalog_product_id || !selected.catalog_listing) {
          throw new Error('La publicación no tiene catálogo asociado')
        }
        rows = rows.filter(row => row.catalog_product_id === selected.catalog_product_id)
      }
      identities = rows.map(identityOf)
      if (task.stage === 'catalog') {
        const categories = [
          ...new Set(
            rows.map((row) => row.category_id).filter((id): id is string =>
              typeof id === 'string' && !!id
            ),
          ),
        ]
        if (categories.length) {
          const token = await own.token()
          failures = await syncCategoryNames(client, categories, {
            token: token.access_token,
            apiUrl: options.apiUrl,
            fetcher: options.fetcher,
          })
        }
      }
    }
    // A single bounded batch fits inside the lease and Edge runtime lifetime.
    return {
      results: failures,
      children: batches(identities, task.stage === 'own' ? 10 : 4).map((
        payload,
        i,
      ) => ({ key: `batch:${i}`, payload })),
    }
  }
  const results = new Map<string, SyncResult>()
  const token = await own.token()
  const context = {
    token: token.access_token,
    sellerId: Number(token.user_id),
    ...options,
    fetcher: options.fetcher ?? ((input, init) =>
      fetch(input, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(20_000),
      })) as typeof fetch,
  }
  const report = (result: SyncResult) => {
    const saved = task.payload.find((row) => row.id === result.entity_id)
    const identity = {
      ...saved,
      ...Object.fromEntries(
        Object.entries(result.identity).filter(([, v]) => v != null),
      ),
    } as SyncIdentity
    results.set(result.entity_id, { ...result, identity })
  }
  let ids = task.payload.map((row) => row.id)
  for (let attempt = 1; attempt <= 2 && ids.length; attempt++) {
    if (task.stage === 'own') {
      const update = await own.update(ids, token.access_token)
      update.results.forEach(report)
    } else if (task.stage === 'catalog') {
      await syncCatalog(client, context, { ids, report })
    } else if (task.stage === 'rivals') {
      await syncCompetitors(client, context, { ids, report })
    } else await syncTracked(client, context, { ids, report })
    ids = ids.filter((id) => {
      const result = results.get(id)
      if (result) result.attempts = Math.max(result.attempts ?? 1, attempt)
      return result?.outcome === 'failed' &&
        ['network', 'server', 'rate_limit', 'persistence'].includes(
          result.category ?? '',
        )
    })
    if (ids.length && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }
  for (const identity of task.payload) {
    if (!results.has(identity.id)) {
      results.set(identity.id, {
        entity_id: identity.id,
        identity,
        outcome: 'skipped',
        category: 'not_applicable',
        message: 'El destino ya no está disponible en el alcance solicitado.',
        operation: 'selección',
      })
    }
  }
  return { results: [...results.values()], children: [] }
}
export async function processManualQueue(
  client: SupabaseClient,
  own: OwnAdapter,
  options: { apiUrl?: string; fxUrl?: string; fetcher?: typeof fetch } = {},
  budgetMs = 20_000,
) {
  const started = Date.now()
  let processed = 0
  while (Date.now() - started < budgetMs) {
    const claimed = await client.schema('ml').rpc('claim_manual_sync_task')
    if (claimed.error) {
      throw new Error('No se pudo reclamar la tarea de sincronización')
    }
    const task = claimed.data?.[0] as ManualTask | undefined
    if (!task) break
    let outcome: Awaited<ReturnType<typeof executeManualTask>>
    try {
      outcome = await executeManualTask(client, task, own, options)
    } catch (error) {
      outcome = {
        children: [],
        results: (task.kind === 'discover' ? [{ id: '$stage' }] : task.payload)
          .map((identity) => ({
            entity_id: identity.id,
            identity,
            outcome: 'failed',
            ...syncFailure(
              error,
              task.kind === 'discover' ? 'descubrimiento' : 'consulta',
            ),
          })),
      }
    }
    const finished = await client.schema('ml').rpc('finish_manual_sync_task', {
      p_task: task.id,
      p_lease: task.lease_token,
      p_results: outcome.results,
      p_children: outcome.children,
    })
    if (finished.error || finished.data !== true) {
      throw new Error(
        'No se confirmó el guardado del resultado; la cola recuperará la tarea',
      )
    }
    processed++
  }
  return { processed }
}
