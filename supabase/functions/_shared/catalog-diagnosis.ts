import type { MlContext } from './ml-observation.ts'
import type { CatalogDiagnosis, CatalogPublicationEvidence } from './catalog.ts'

export function publicationState(status: string | null, sub: string[]): string {
  if (sub.includes('deleted')) return 'Marcada como eliminada'
  if (status === 'paused') return sub.includes('out_of_stock') ? 'Sin stock' : sub.includes('paused_by_seller') ? 'Pausada por el vendedor' : 'Pausada; motivo no informado'
  if (status === 'under_review') return sub.includes('forbidden') ? 'En revisión por moderación' : 'En revisión'
  return status === 'active' ? 'Activa' : status === 'inactive' ? 'Inactiva' : status === 'closed' ? 'Cerrada' : status ? `Estado: ${status}` : 'Estado no verificable'
}

/** Read only the fields needed for diagnosis; external response bodies are never persisted. */
export async function diagnoseCatalog(catalogId: string, ids: string[], context: MlContext,
  failure: { status: number; resource: string; noWinners?: boolean }): Promise<CatalogDiagnosis> {
  const api = context.apiUrl ?? 'https://api.mercadolibre.com'
  const fetcher = context.fetcher ?? fetch
  const now = new Date().toISOString()
  const request = (resource: string) => fetcher(api + resource, {
    headers: { Authorization: `Bearer ${context.token}` }, signal: AbortSignal.timeout(15_000),
  })
  const resource = `/products/${encodeURIComponent(catalogId)}`
  const response = await request(resource)
  let kind: CatalogDiagnosis['kind'], message: string, catalogStatus: string | null = null
  let childrenIds: string[] = []
  if (response.status === 404) {
    kind = 'catalog_not_found'; message = 'Catálogo no encontrado; asociación por revisar'
  } else {
    if (!response.ok) throw Object.assign(new Error(`Verificación de catálogo HTTP ${response.status}`), { status: response.status, resource })
    let body
    try { body = await response.json() } catch { throw new Error('Respuesta de metadatos de catálogo inválida') }
    if (body?.id !== catalogId || !['active', 'inactive'].includes(body.status) ||
      !Array.isArray(body.children_ids) || body.children_ids.some((id: unknown) => typeof id !== 'string' || !/^ML[AU]\d+$/.test(id)) ||
      !('buy_box_winner' in body) || body.buy_box_winner !== null &&
      (typeof body.buy_box_winner !== 'object' || !/^ML[AU]\d+$/.test(body.buy_box_winner?.item_id ?? '')))
      throw new Error('Metadatos de catálogo con identidad o estructura inválida')
    catalogStatus = body.status; childrenIds = body.children_ids
    if (body.status === 'inactive') {
      kind = childrenIds.length ? 'inactive_parent' : 'inactive_catalog'
      message = childrenIds.length ? 'Catálogo padre inactivo; asociación por revisar' : 'Catálogo inactivo; asociación por revisar'
    } else if (failure.noWinners && body.buy_box_winner === null) {
      kind = 'no_offers'; message = 'Sin ofertas de catálogo observadas'
    } else if (failure.noWinners) {
      kind = 'unverified'; message = 'Disponibilidad de catálogo no verificable: la consulta de ofertas y el ganador informado no coinciden'
    } else throw Object.assign(new Error(`Catálogo HTTP ${failure.status}`), failure)
  }
  const publications: Record<string, CatalogPublicationEvidence> = {}
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = ids.slice(offset, offset + 20)
    const bulkResource = `/items/bulk?ids=${batch.join(',')}`
    let entries: {id?:string;status_code?:number;body?:{id?:string;status?:string;sub_status?:unknown}}[] = []
    let httpStatus: number | null = null
    try {
      const res = await request(bulkResource); httpStatus = res.status
      if (res.ok) { const data = await res.json(); if (Array.isArray(data)) entries = data }
    } catch { /* Auxiliary state failures cannot invent a pause reason. */ }
    for (const id of batch) {
      const matches = entries.filter(entry => entry?.id === id)
      const entry = matches.length === 1 ? matches[0] : null
      const body = entry?.body
      const valid = httpStatus === 200 && entry?.status_code === 200 && body?.id === id &&
        typeof body.status === 'string' && !!body.status && Array.isArray(body.sub_status) && body.sub_status.every(v => typeof v === 'string')
      const status = valid ? body!.status! : null
      const subStatus = valid ? body!.sub_status as string[] : []
      publications[id] = { status, subStatus, message: publicationState(status, subStatus),
        observedAt: now, resource: bulkResource, httpStatus: entry?.status_code ?? httpStatus,
        ...(!valid ? {warning:'No se pudo verificar el estado actual de la publicación propia'} : {}),
      }
    }
  }
  return {kind,message,catalogStatus,childrenIds,publications,observedAt:now,
    evidence:{httpStatus:failure.status,resource:failure.resource,
      ...(failure.noWinners ? {apiCode:'not_found',message:'No winners found'} : {}),
      metadataResource:resource,metadataHttpStatus:response.status},
  }
}
