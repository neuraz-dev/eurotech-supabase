export type SyncStage = 'own' | 'catalog' | 'rivals' | 'tracked'
export type SyncOutcome = 'updated' | 'failed' | 'skipped' | 'warning'
export type SyncIdentity = {
  id: string
  title?: string | null
  sku?: string | null
  seller?: string | null
  url?: string | null
  itemId?: string | null
  sourceId?: string | null
}
export type SyncResult = {
  entity_id: string
  identity: SyncIdentity
  outcome: SyncOutcome
  message: string
  category?: string
  operation?: string
  resource?: string
  http_status?: number | null
  attempts?: number
}
export type SyncReporting = {
  ids?: string[]
  report?: (result: SyncResult) => void
}
// Never persist response bodies or headers from external services. Known errors
// can still contain credentials in URLs or strings; redact those defensively.
export function safeSyncMessage(message: string): string {
  return message.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [oculto]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[credencial oculta]',
    )
    .replace(
      /((?:access_token|refresh_token|client_secret|apikey|authorization)["'\s]*[:=]["'\s]*)[^\s&",;}'<]+/gi,
      '$1[oculto]',
    )
    .slice(0, 2000)
}
export function syncFailure(
  error: unknown,
  operation = 'consulta',
): Omit<SyncResult, 'entity_id' | 'identity' | 'outcome'> {
  const object = error && typeof error === 'object'
    ? error as {
      status?: number
      resource?: string
      message?: string
      apiCode?: string
    }
    : {}
  const message = safeSyncMessage(
    error instanceof Error
      ? error.message
      : object.message ?? 'No se pudo completar la operación',
  )
  const status = object.status ??
    (Number(message.match(/(?:HTTP|status|→)\s*(\d{3})/)?.[1] ?? 0) || null)
  const category = object.apiCode === 'ResourceDeprecated'
    ? 'resource_deprecated'
    : operation === 'persistencia' || /persist|guard|upsert/i.test(message)
    ? 'persistence'
    : status === 401 || /token|credencial/i.test(message)
    ? 'authentication'
    : status === 403
    ? 'permissions'
    : status === 429
    ? 'rate_limit'
    : /identidad|resolv|ambig|resoluci/i.test(message)
    ? 'resolution'
    : status === 404 || status === 410
    ? 'availability'
    : status && status >= 500
    ? 'server'
    : /red|fetch|network|timeout|abort/i.test(message)
    ? 'network'
    : 'validation'
  return {
    message,
    category,
    operation,
    http_status: status,
    resource: object.resource,
  }
}
export function identityOf(row: Record<string, unknown>): SyncIdentity {
  const observation = row.observation as Record<string, unknown> | null
  return {
    id: String(row.id),
    title: row.title as string | null,
    sku: (row.sku ?? row.our_sku) as string | null,
    seller: row.seller_name as string | null,
    url: (row.permalink ?? row.source_url ?? row.url) as string | null,
    itemId: (observation?.itemId ?? row.ml_item_id ?? row.id) as string,
    sourceId: (row.source_id ?? row.catalog_product_id ?? row.target_id) as
      | string
      | null,
  }
}
