import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { allRows } from './monitor-service.ts'
import { fetchFx, type MlContext } from './ml-observation.ts'
import { observe, positive, type PriceObservation } from './monitoring.ts'

export async function syncCatalog(
  client: SupabaseClient,
  context: Omit<MlContext, 'fx'> & { fxUrl?: string },
) {
  const products = await allRows<{
    id: string
    catalog_product_id: string | null
    catalog_listing: boolean | null
    site_id: string | null
  }>(
    client,
    'ml_products',
    'id,catalog_product_id,catalog_listing,site_id',
  )
  const fx = await fetchFx(context.fetcher, context.fxUrl),
    fetcher = context.fetcher ?? fetch,
    api = context.apiUrl ?? 'https://api.mercadolibre.com'
  let updated = 0,
    failed = 0,
    skipped = 0
  const errors: { itemId: string; catalogId: string; message: string }[] = []
  const offers = new Map<string, Promise<{
    results: { item_id: string; seller_id: number; price: number; currency_id: string; condition?: string }[]
    paging?: { total?: number }
    observedAt: string
  }>>()
  const loadOffers = (catalogId: string) => {
    let pending = offers.get(catalogId)
    if (!pending) {
      pending = (async () => {
        const response = await fetcher(
          `${api}/products/${catalogId}/items?status=active&limit=20`,
          { headers: { Authorization: `Bearer ${context.token}` }, signal: AbortSignal.timeout(20_000) },
        )
        if (!response.ok) throw new Error(`Catálogo HTTP ${response.status}`)
        const data = await response.json()
        if (!Array.isArray(data.results)) throw new Error('Respuesta de catálogo inválida')
        return { ...data, observedAt: new Date().toISOString() }
      })()
      offers.set(catalogId, pending!)
    }
    return pending!
  }
  const syncProduct = async (product: typeof products[number]) => {
    // A User Product groups the seller's own listings; it is not evidence that
    // the publication belongs to a competitive catalog.
    const catalogId = product.catalog_product_id
    if (!catalogId) { skipped++; return }
    try {
      const headers = { Authorization: `Bearer ${context.token}` },
        data = await loadOffers(catalogId),
        now = data.observedAt
      const rows = data.results
      const own = rows.find((row) => row.item_id === product.id)
      const candidates = rows
        .filter((row) => row.seller_id !== context.sellerId)
        .map((row) => ({
          row,
          observation: observe(row.price, row.currency_id, now, 'catalog', fx),
        }))
      const sorted = candidates
        .filter((row) => positive(row.observation.normalizedAmount))
        .sort(
          (a, b) =>
            a.observation.normalizedAmount! - b.observation.normalizedAmount!,
        )
      const best = sorted[0] ?? candidates[0]
      const minimum: PriceObservation = {
        ...(best?.observation ?? observe(null, null, now, 'catalog', fx)),
        itemId: best?.row.item_id ?? null,
        sellerId: best?.row.seller_id ?? null,
        offersConsulted: rows.length,
        offersTotal: data.paging?.total ?? null,
        coverage:
          data.paging?.total == null
            ? 'unknown'
            : data.paging.total > rows.length
              ? 'partial'
              : 'complete',
        state: candidates.length ? 'observed' : 'no_external_offers',
      }
      let competition: Record<string, unknown> = {
        state: 'not_verified',
        itemId: product.id,
        observedAt: null,
        source: 'price_to_win',
      }
      if (product.catalog_listing) {
        try {
          const response = await fetcher(
            `${api}/items/${product.id}/price_to_win?siteId=${encodeURIComponent(product.site_id ?? 'MLU')}&version=v2`,
            { headers, signal: AbortSignal.timeout(15_000) },
          )
          if (response.ok) {
            const evidence = await response.json()
            if (
              evidence.item_id === product.id &&
              evidence.consistent !== false &&
              [
                'winning',
                'competing',
                'sharing_first_place',
                'listed',
              ].includes(evidence.status)
            ) {
              competition = {
                state: evidence.status,
                itemId: product.id,
                winnerId: evidence.winner?.item_id ?? null,
                observedAt: now,
                source: 'price_to_win',
              }
            }
          }
        } catch {
          /* unavailable evidence is never a loss or victory */
        }
      }
      const { error } = await client
        .schema('ml')
        .from('ml_products')
        .update({
          catalog_price: own?.price ?? null,
          catalog_currency_id: own?.currency_id ?? null,
          catalog_item_id: own?.item_id ?? null,
          catalog_observed_at: now,
          catalog_observation: minimum,
          catalog_competition: competition,
          fx_quote: fx,
          buybox_price: minimum.normalizedAmount,
          buybox_seller_id: minimum.sellerId,
        })
        .eq('id', product.id)
        .select('id')
        .single()
      if (error) throw new Error(error.message)
      updated++
    } catch (error) {
      failed++
      if (errors.length < 20) errors.push({
        itemId: product.id, catalogId,
        message: error instanceof Error ? error.message : 'Error de consulta',
      })
    }
  }
  // Bound concurrency on the local machine and reuse offers for related MLUs.
  for (let offset = 0; offset < products.length; offset += 4) {
    await Promise.all(products.slice(offset, offset + 4).map(syncProduct))
  }
  return {
    catalog_prices_updated: updated,
    items_failed: failed,
    items_skipped: skipped,
    errors,
    success: failed === 0,
  }
}
