type Fetcher = (url: string, init: RequestInit) => Promise<Response>
type Stage = 'Propios' | 'Catálogo' | 'Rivales'
export async function runMonitorSync(
  fetcher: Fetcher,
  progress: (message: string) => void = () => {},
) {
  const summaries: string[] = [], errors: string[] = []
  for (const [stage, url] of [
    ['Propios', '/api/sync-own'],
    ['Catálogo', '/api/sync-catalog'],
    ['Rivales', '/api/sync-competitors'],
  ] as [Stage, string][]) {
    progress([...summaries, `${stage}: sincronizando…`].join('\n'))
    try {
      const response = await fetcher(url, { method: 'POST' })
      const data = await response.json()
      // Rival handlers use HTTP 500 for a partially successful run, retaining
      // updated/failed counters in the body. Surface those counters too.
      const partial = stage !== 'Propios' && data.success === false && Number.isFinite(data.items_failed)
      if (!response.ok && !partial) throw new Error(data.error ?? `HTTP ${response.status}`)
      if (stage === 'Propios') {
        if (data.body?.success !== true || !Number.isFinite(data.body.upserted))
          throw new Error(data.error ?? data.body?.error ?? 'Respuesta de propios inválida')
        summaries.push(`Propios: ${data.body.upserted} actualizados${data.body.has_more ? '; otras páginas siguen en proceso' : ''}.`)
      } else {
        const updated = stage === 'Catálogo' ? data.catalog_prices_updated : data.items_updated
        if (!Number.isFinite(updated) || !Number.isFinite(data.items_failed) || typeof data.success !== 'boolean')
          throw new Error('Respuesta de sincronización inválida')
        summaries.push(`${stage}: ${updated} actualizados, ${data.items_failed} fallidos${stage === 'Rivales' ? `; ${data.alerts_fired ?? 0} alertas` : ''}.`)
        if (!data.success || data.items_failed > 0) {
          const details = stage === 'Catálogo' && Array.isArray(data.errors)
            ? data.errors.slice(0, 3).map((e: { itemId: string; message: string }) => `${e.itemId}: ${e.message}`).join('; ')
            : data.error
          errors.push(`${stage}: ${details || 'consulta parcial; revisar los elementos con error'}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error de red'
      summaries.push(`${stage}: no se pudo completar.`)
      errors.push(`${stage}: ${message}`)
    }
  }
  return { success: errors.length === 0, message: [...summaries, ...errors].join('\n') }
}
