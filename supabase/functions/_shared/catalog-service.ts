import { identityOf, syncFailure, type SyncReporting } from './sync-report.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { allRows } from './monitor-service.ts'
import { fetchFx, type MlContext } from './ml-observation.ts'
import { observe, positive, type PriceObservation } from './monitoring.ts'
import { collectCatalogOffers, type CatalogProduct } from './catalog-offers.ts'

export async function syncCatalog(
  client: SupabaseClient,
  context: Omit<MlContext, 'fx'> & { fxUrl?: string },
  reporting: SyncReporting = {},
) {
  const allProducts = await allRows<CatalogProduct>(client, 'ml_products',
    'id,catalog_product_id,catalog_listing,site_id,title,sku,permalink,catalog_price,catalog_currency_id,catalog_observed_at')
  const products = reporting.ids ? allProducts.filter(product => reporting.ids!.includes(product.id)) : allProducts
  const fx = await fetchFx(context.fetcher, context.fxUrl)
  let updated = 0, failed = 0, skipped = 0
  const errors: { itemId: string; catalogId: string; message: string }[] = []
  const catalogs = new Map<string, ReturnType<typeof collectCatalogOffers>>()
  const load = (catalogId: string) => {
    let pending = catalogs.get(catalogId)
    if (!pending) {
      pending = (async () => {
        try {
          const result = await collectCatalogOffers(catalogId,
            allProducts.filter(product => product.catalog_product_id === catalogId), { ...context, fx })
          if(result.snapshot.diagnosis){
            const previous = await client.schema('ml').from('ml_catalog_snapshots').select('snapshot').eq('catalog_product_id',catalogId).maybeSingle()
            if(previous.error)throw new Error('No se pudo leer el historial del catálogo')
            const old = previous.data?.snapshot as typeof result.snapshot | undefined
            const recorded = new Map((old?.lastRecordedPrices ?? []).map(price => [price.publicationId,price]))
            for(const product of allProducts.filter(p=>p.catalog_product_id===catalogId))if(positive(product.catalog_price)){
              recorded.set(product.id,{publicationId:product.id,amount:product.catalog_price,
                currency:product.catalog_currency_id??null,observedAt:product.catalog_observed_at??null,source:'stored_record'})
            }
            if(recorded.size)result.snapshot.lastRecordedPrices=[...recorded.values()]
            if(old?.offers?.length){
              const {lastPricedSnapshot: _last, ...priced} = old
              result.snapshot.lastPricedSnapshot = priced
            }else if(old?.lastPricedSnapshot)result.snapshot.lastPricedSnapshot=old.lastPricedSnapshot
          }
          const saved = await client.schema('ml').rpc('record_catalog_snapshot', {
            p_catalog: catalogId, p_snapshot: result.snapshot, p_error: null,
          })
          if (saved.error) throw new Error(`No se pudo guardar el catálogo: ${saved.error.message}`)
          return result
        } catch (error) {
          const recorded = await client.schema('ml').rpc('record_catalog_snapshot', {
            p_catalog: catalogId, p_snapshot: null, p_error: syncFailure(error, 'catálogo').message,
          })
          if (recorded.error) throw new Error(`No se pudo guardar el fallo del catálogo: ${recorded.error.message}`)
          throw error
        }
      })()
      catalogs.set(catalogId, pending)
    }
    return pending
  }
  const syncProduct = async (product: CatalogProduct) => {
    const catalogId = product.catalog_product_id
    if (!catalogId) {
      skipped++
      reporting.report?.({ entity_id: product.id, identity: identityOf(product), outcome: 'skipped', category: 'not_applicable', message: 'La publicación no tiene catálogo asociado.', operation: 'catálogo' })
      return
    }
    try {
      const { snapshot, competitions } = await load(catalogId)
      const own = snapshot.offers.find(offer => offer.itemId === product.id)
      const external = snapshot.offers.filter(offer => offer.sellerId !== context.sellerId)
      const sorted = [...external].sort((a, b) => (a.observation.normalizedAmount ?? Infinity) - (b.observation.normalizedAmount ?? Infinity))
      const best = sorted.find(offer => positive(offer.observation.normalizedAmount)) ?? sorted[0]
      const minimum: PriceObservation = {
        ...(best?.observation ?? observe(null, null, snapshot.observedAt, 'catalog', fx)),
        itemId: best?.itemId ?? null, sellerId: best?.sellerId ?? null,
        offersConsulted: snapshot.offers.length, offersTotal: snapshot.total,
        coverage: snapshot.coverage, state: external.length ? 'observed' : 'no_external_offers',
      }
      const { error } = await client.schema('ml').from('ml_products').update({
        catalog_price: own?.observation.amount ?? null,
        catalog_currency_id: own?.observation.currency ?? null,
        catalog_item_id: own?.itemId ?? null,
        catalog_observed_at: snapshot.observedAt,
        catalog_observation: minimum,
        catalog_competition: competitions.get(product.id) ?? { state: 'not_verified', itemId: product.id, observedAt: null, source: 'price_to_win' },
        fx_quote: fx,
        // Legacy minimum-price fields are kept for compatibility. The new UI
        // reads snapshot.buyBox exclusively for the actual catalog winner.
        buybox_price: minimum.normalizedAmount,
        buybox_seller_id: minimum.sellerId,
      }).eq('id', product.id).select('id').single()
      if (error) throw new Error(`No se pudo guardar la publicación: ${error.message}`)
      updated++
      const diagnosis = snapshot.diagnosis
      const publication = diagnosis?.publications[product.id]
      const diagnosticWarning = diagnosis && (diagnosis.kind !== 'no_offers' || !!publication?.warning)
      reporting.report?.({ entity_id: product.id, identity: identityOf(product), outcome: diagnosticWarning || snapshot.warnings.length ? 'warning' : 'updated',
        message: diagnosis ? `${diagnosis.message} · Publicación propia: ${publication?.message ?? 'Estado no verificable'}${publication?.warning?` · ${publication.warning}`:''}` : snapshot.warnings.join(' ') || 'Ofertas y precio de catálogo guardados.',
        operation:'catálogo',resource:diagnosis?.evidence.resource ?? `/products/${catalogId}/items`,
        ...(diagnosis?{category:diagnosis.kind==='no_offers'?'availability':'resolution',http_status:diagnosis.evidence.httpStatus}:{}), })
    } catch (error) {
      failed++
      reporting.report?.({ entity_id: product.id, identity: identityOf(product), outcome: 'failed', ...syncFailure(error, 'catálogo') })
      errors.push({ itemId: product.id, catalogId, message: error instanceof Error ? error.message : 'Error de consulta' })
    }
  }
  for (let offset = 0; offset < products.length; offset += 4) {
    await Promise.all(products.slice(offset, offset + 4).map(syncProduct))
  }
  return { catalog_prices_updated: updated, items_failed: failed, items_skipped: skipped, errors, success: failed === 0 }
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
