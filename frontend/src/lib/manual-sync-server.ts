import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ApiError } from '@/lib/monitoring/server'
import type { ManualSyncAction } from './manual-sync'
const actions = ['all', 'own', 'catalog', 'rivals', 'tracked', 'product']
export function syncId(value: string) {
  if (
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
  ) throw new ApiError(400, 'Identificador de sincronización inválido')
  return value
}
export async function startSync(
  action: ManualSyncAction,
  origin: string,
  targetId: string | null = null,
  requestKey = crypto.randomUUID(),
) {
  if (
    !actions.includes(action) || origin.length > 100 ||
    (action === 'product' && !/^ML[AU]\d+$/.test(targetId ?? '')) ||
    (targetId !== null && (!['product', 'catalog'].includes(action) || !/^ML[AU]\d+$/.test(targetId)))
  ) throw new ApiError(400, 'Alcance inválido')
  if (action === 'catalog' && targetId) {
    const { data, error } = await createAdminClient().schema('ml').from('ml_products')
      .select('catalog_product_id,catalog_listing').eq('id', targetId).maybeSingle()
    if (error) throw error
    if (!data) throw new ApiError(404, 'No se encontró la publicación')
    if (!data.catalog_listing || !data.catalog_product_id) throw new ApiError(400, 'La publicación no tiene catálogo asociado')
  }
  syncId(requestKey)
  const { data: { user }, error: authError } = await (await createClient()).auth
    .getUser()
  if (authError || !user) {
    throw new ApiError(401, 'Iniciá sesión para continuar')
  }
  const { data, error } = await createAdminClient().schema('ml').rpc(
    'start_manual_sync',
    {
      p_action: action,
      p_target: targetId,
      p_origin: origin,
      p_user: user.id,
      p_label: user.email ?? user.id,
      p_request: requestKey,
    },
  )
  if (error || !data?.id) {
    throw new ApiError(
      503,
      error?.message.includes('Vault')
        ? 'No está configurado el servicio de sincronización manual.'
        : 'No se pudo registrar la actualización. Reintentá.',
    )
  }
  return {
    accepted: true,
    runId: data.id,
    url: `/dashboard/sincronizaciones/${data.id}`,
    run: data,
  }
}
export function pageOffset(params: URLSearchParams) {
  const value = Number(params.get('page') ?? 1)
  if (!Number.isInteger(value) || value < 1 || value > 100000) {
    throw new ApiError(400, 'Página inválida')
  }
  return { page: value, offset: (value - 1) * 50 }
}
export async function listSyncRuns(params: URLSearchParams) {
  const { page, offset } = pageOffset(params)
  let query = createAdminClient().schema('ml').from('ml_sync_runs').select(
    '*',
    { count: 'exact' },
  )
  const action = params.get('action'), status = params.get('status')
  if (action) {
    if (!actions.includes(action)) throw new ApiError(400, 'Acción inválida')
    query = query.eq('action', action)
  }
  if (status) {
    if (
      !['queued', 'running', 'completed', 'partial', 'failed', 'warnings']
        .includes(status)
    ) throw new ApiError(400, 'Estado inválido')
    query = query.eq('status', status)
  }
  for (const key of ['from', 'until']) {
    if (params.get(key)) {
      const parsed = Date.parse(params.get(key)!)
      if (!Number.isFinite(parsed)) throw new ApiError(400, 'Fecha inválida')
      query = key === 'from'
        ? query.gte('created_at', new Date(parsed).toISOString())
        : query.lt('created_at', new Date(parsed).toISOString())
    }
  }
  const { data, error, count } = await query.order('created_at', {
    ascending: false,
  }).order('id', { ascending: false }).range(offset, offset + 49)
  if (error) throw error
  return { items: data, count: count ?? 0, page }
}
export async function syncRunDetail(id: string, params: URLSearchParams) {
  const admin = createAdminClient(),
    run = await admin.schema('ml').from('ml_sync_runs').select('*').eq(
      'id',
      syncId(id),
    ).maybeSingle()
  if (run.error) throw run.error
  if (!run.data) throw new ApiError(404, 'No se encontró la sincronización')
  if (params.get('summary') === '1') return { run: run.data }
  const { page, offset } = pageOffset(params)
  let query = admin.schema('ml').from('ml_sync_results').select('*', {
    count: 'exact',
  }).eq('run_id', id)
  const outcome = params.get('outcome'), stage = params.get('stage')
  if (outcome) {
    if (!['updated', 'failed', 'skipped', 'warning'].includes(outcome)) {
      throw new ApiError(400, 'Resultado inválido')
    }
    query = query.eq('outcome', outcome)
  }
  if (stage) {
    if (!['own', 'catalog', 'rivals', 'tracked'].includes(stage)) {
      throw new ApiError(400, 'Etapa inválida')
    }
    query = query.eq('stage', stage)
  }
  const [results, stages] = await Promise.all([
    query.order('id', { ascending: true }).range(offset, offset + 49),
    admin.schema('ml').rpc('manual_sync_stage_summary', { p_run: id }),
  ])
  if (results.error) throw results.error
  if (stages.error) throw stages.error
  return {
    run: run.data,
    items: results.data,
    count: results.count ?? 0,
    page,
    stages: stages.data,
  }
}
