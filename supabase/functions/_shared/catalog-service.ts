import { identityOf, syncFailure, type SyncReporting } from './sync-report.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { allRows } from './monitor-service.ts'
import { fetchFx, type MlContext } from './ml-observation.ts'
import { observe, positive, type PriceObservation } from './monitoring.ts'

export async function syncCatalog(
  client: SupabaseClient,
  context: Omit<MlContext, 'fx'> & { fxUrl?: string },
  reporting: SyncReporting = {},
) {
  const allProducts = await allRows<{
    id: string
    catalog_product_id: string | null
    catalog_listing: boolean | null
    site_id: string | null
    title: string | null
    sku: string | null
    permalink: string | null
  }>(
    client,
    'ml_products',
    'id,catalog_product_id,catalog_listing,site_id,title,sku,permalink',
  )
  const products = reporting.ids ? allProducts.filter(p => reporting.ids!.includes(p.id)) : allProducts
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
        if (!response.ok) throw Object.assign(new Error(`Catálogo HTTP ${response.status}`), { status: response.status, resource: `/products/${catalogId}/items` })
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
    if (!catalogId) {
      skipped++
      reporting.report?.({ entity_id: product.id, identity: identityOf(product), outcome: 'skipped', category: 'not_applicable', message: 'La publicación no tiene catálogo asociado.', operation: 'catálogo' })
      return
    }
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
      const warnings: string[] = []
      if (candidates.some(c => c.observation.amount != null && c.observation.normalizedAmount == null)) warnings.push('Hay ofertas sin conversión válida a UYU.')
      if (minimum.coverage !== 'complete') warnings.push('La cobertura de ofertas es parcial o desconocida.')
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
      if (product.catalog_listing && competition.state === 'not_verified') warnings.push('No se pudo verificar la adjudicación del catálogo.')
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
      reporting.report?.({ entity_id: product.id, identity: identityOf(product), outcome: warnings.length ? 'warning' : 'updated', message: warnings.join(' ') || 'Precio de catálogo guardado.', operation: 'catálogo', resource: `/products/${catalogId}/items` })
    } catch (error) {
      failed++
      reporting.report?.({ entity_id: product.id, identity: identityOf(product), outcome: 'failed', ...syncFailure(error, 'catálogo') })
      errors.push({
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

// Preserve the category-name refresh previously performed by /api/sync-catalog.
// It is auxiliary: a category failure must not stop publication price refreshes.
export async function syncCategoryNames(client: SupabaseClient,
  categoryIds: string[], context: Pick<MlContext,'token'|'apiUrl'|'fetcher'>,
) {
  const warnings: import('./sync-report.ts').SyncResult[] = []
  const fetcher=context.fetcher??fetch
  for(let offset=0;offset<categoryIds.length;offset+=4){
    await Promise.all(categoryIds.slice(offset,offset+4).map(async id=>{
      try{
        const resource=`/categories/${encodeURIComponent(id)}`
        const response=await fetcher(`${context.apiUrl??'https://api.mercadolibre.com'}${resource}`,{headers:{Authorization:`Bearer ${context.token}`},signal:AbortSignal.timeout(15_000)})
        if(!response.ok)throw Object.assign(new Error(`Categoría HTTP ${response.status}`),{status:response.status,resource})
        const value=await response.json()
        if(typeof value.name!=='string')throw new Error('La categoría no devolvió un nombre válido')
        const path=(value.path_from_root??[]).map((node:{name:string})=>node.name).filter((name:string)=>!['Uruguay','Accesorios para Vehículos','Herramientas'].includes(name))
        const saved=await client.schema('ml').from('ml_categories').upsert({id,name:value.name,full_path:path.join(' › ')||value.name}).select('id').single()
        if(saved.error||saved.data?.id!==id)throw new Error('No se pudo guardar el nombre de la categoría')
      }catch(error){warnings.push({entity_id:`$stage:category:${id}`,identity:{id:`$stage:category:${id}`,title:`Nombre de categoría ${id}`},outcome:'warning',...syncFailure(error,'categorías')})}
    }))
  }
  return warnings
}
