export type ManualSyncAction =
  | 'all'
  | 'own'
  | 'catalog'
  | 'rivals'
  | 'tracked'
  | 'product'
export type ManualSyncStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'warnings'
export type ManualSyncRun = {
  id: string
  action: ManualSyncAction
  origin: string
  target_id: string | null
  requested_by_label: string
  status: ManualSyncStatus
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_count: number
  failed_count: number
  skipped_count: number
  warning_count: number
  total_count: number
  completed_count: number
}
export type ManualSyncResult = {
  id: number
  stage: string
  entity_id: string
  identity: {
    id: string
    title?: string
    sku?: string
    seller?: string
    url?: string
    itemId?: string | null
    sourceId?: string
  }
  outcome: 'updated' | 'failed' | 'skipped' | 'warning'
  message: string
  category: string | null
  operation: string | null
  resource: string | null
  http_status: number | null
  attempts: number
  recorded_at: string
}
export const syncLabels: Record<string, string> = {
  all: 'Propios, catálogo y rivales',
  own: 'Productos propios',
  catalog: 'Catálogo',
  rivals: 'Rivales',
  tracked: 'Seguimiento',
  product: 'Publicación propia',
}
export const syncStatusLabels: Record<ManualSyncStatus, string> = {
  queued: 'En cola',
  running: 'En proceso',
  completed: 'Finalizada',
  partial: 'Con fallos',
  failed: 'No completada',
  warnings: 'Con advertencias',
}
export const syncIsActive = (run: ManualSyncRun) =>
  ['queued', 'running'].includes(run.status)
export function syncMessage(run: ManualSyncRun) {
  if (syncIsActive(run)) return 'Actualizando…'
  if (run.status === 'completed') return 'Actualización finalizada'
  if (run.status === 'partial') return 'Actualizados con algunos fallos'
  if (run.status === 'warnings') {
    return 'Actualización finalizada con advertencias'
  }
  return 'No se pudo completar la actualización'
}
export const syncUrl = (id: string) => `/dashboard/sincronizaciones/${id}`
export async function startManualSync(
  action: ManualSyncAction,
  origin: string,
  targetId?: string,
  requestKey = crypto.randomUUID(),
) {
  const response = await fetch('/api/manual-sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, origin, targetId, requestKey }),
  })
  const data = await response.json()
  if (!response.ok || !data.run?.id) {
    throw new Error(data.error ?? 'No se pudo iniciar la actualización')
  }
  return data.run as ManualSyncRun
}
// Polling observes durable work; losing this observer never stops the worker.
export async function waitForManualSync(
  run: ManualSyncRun,
  progress: (run: ManualSyncRun) => void = () => {},
) {
  progress(run)
  while (syncIsActive(run)) {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const response = await fetch(`/api/manual-sync/${run.id}?summary=1`, {
      cache: 'no-store',
    })
    const data = await response.json()
    if (!response.ok || !data.run?.id) {
      throw new Error(
        'No se pudo consultar el progreso. La actualización continúa; revisá Sincronizaciones.',
      )
    }
    run = data.run as ManualSyncRun
    progress(run)
  }
  return run
}
