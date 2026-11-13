import { identityOf, syncFailure, type SyncReporting } from './sync-report.ts'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { buildAlertEvents } from './alert-events.ts'
import { MlHttpError } from './ml-observation.ts'
import {recoverPendingFixedTargets,isConfirmedSource404} from './source-recovery.ts'
import {
  retainLastPricedObservation,
  observe, positive,
  type CompetitorLink,
  type OwnProduct,
  type PriceObservation,
  type SourceKind,
} from './monitoring.ts'
import {
  fetchFx,
  fetchTarget,
  competitorRecord,
  trackingSnapshot,
  type MlContext,
} from './ml-observation.ts'

export async function allRows<T>(
  client: SupabaseClient,
  table: string,
  select = '*',
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .schema('ml')
      .from(table)
      .select(select)
      .order('id')
      .range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    rows.push(...((data ?? []) as T[]))
    if (!data || data.length < 1000) return rows
  }
}
export type RivalRecord = {
  id: string
  target_kind: 'item' | 'catalog'
  observation: PriceObservation | null
  status: string | null
  title: string | null
  price: number | null
  currency_id: string | null
  permalink: string | null
  seller_name: string | null
  our_sku: string | null
  our_product_id: string | null
  usd_price: number | null
  thumbnail: string | null
  seller_id: number | null
  synced_at: string | null
  paused: boolean
  availability?: string
  observation_revision?: number
  source_kind?:SourceKind
  source_id?:string
  source_url?:string|null
}
type Rule = {
  id: string
  rule_type: string
  sku: string | null
  threshold_pct: number | null
  enabled: boolean
  compare_catalog_price: boolean
}
export async function syncCompetitors(
  client: SupabaseClient,
  context: Omit<MlContext, 'fx'> & { fxUrl?: string },
  reporting: SyncReporting = {},
) {
  const recovery=reporting.ids ? {} : await recoverPendingFixedTargets(client,{...context,fx:null})
  const [allRivals, links, products, rules, fx] = await Promise.all([
    allRows<RivalRecord>(client, 'ml_competitor_items'),
    allRows<CompetitorLink>(client, 'ml_competitor_links'),
    allRows<OwnProduct>(client, 'ml_products'),
    allRows<Rule>(client, 'ml_price_alert_rules'),
    fetchFx(context.fetcher, context.fxUrl),
  ])
  const rivals = reporting.ids ? allRivals.filter(r => reporting.ids!.includes(r.id)) : allRivals
  const stats = {
    items_processed: rivals.length,
    items_updated: 0,
    items_failed: 0,
    items_skipped: 0,
    alerts_fired: 0,
    alert_errors: 0,
  }
  for (let offset = 0; offset < rivals.length; offset += 10) {
    await Promise.all(
      rivals.slice(offset, offset + 10).map(async (rival) => {
        const associations = links.filter(
          (link) => link.competitor_item_id === rival.id && !link.removed_at,
        )
        if (!associations.length) {
          stats.items_skipped++
          reporting.report?.({entity_id:rival.id,identity:identityOf(rival),outcome:'skipped',category:'not_applicable',message:'El rival no tiene asociaciones vigentes.',operation:'rivales'})
          return
        }
        const attemptedAt = new Date().toISOString()
        try {
          const value = await fetchTarget(
            { kind: rival.target_kind, id: rival.id,sourceKind:rival.source_kind,sourceId:rival.source_id,sourceUrl:rival.source_url??rival.permalink,itemId:rival.observation?.itemId,sellerId:rival.observation?.sellerId??rival.seller_id,catalogId:rival.observation?.catalogProductId },
            { ...context, fx },
          )
          value.title ??= rival.title
          value.thumbnail ??= rival.thumbnail
          if(value.observation.sellerId === (rival.observation?.sellerId ?? rival.seller_id))
            value.observation.sellerName ??= rival.observation?.sellerName ?? rival.seller_name
          const availability = value.status !== 'active' || value.available_quantity === 0
            || value.observation.state === 'no_external_offers'
            || !(Number(value.observation.amount) > 0) ? 'unavailable' : 'available'
          let persisted = false
          let obsolete = false
          let repairWarning = false
          let baseline = rival
          let committed = false
          for (let attempt = 0; attempt < 3; attempt++) {
            const previous = baseline.observation ?? (positive(baseline.price) ? {
              ...observe(baseline.price,baseline.currency_id,baseline.synced_at,'legacy_record'),
              sellerId:baseline.seller_id,sellerName:baseline.seller_name,
            } : null)
            value.observation = retainLastPricedObservation(value.observation,previous)
            const events = buildAlertEvents(
              { ...value, id:rival.id, target_kind:rival.target_kind, availability },
              baseline.observation, products, allRivals, links, rules, fx,
            )
            const { data, error } = await client.schema('ml').rpc('record_monitor_observation', {
              p_id:rival.id, p_expected:baseline.observation_revision ?? 0,
              p_update:{...competitorRecord(value),availability,
                previous_price:baseline.observation?.normalizedAmount ?? value.observation.lastPricedObservation?.normalizedAmount ?? null,last_attempt_at:attemptedAt},
              p_events:events,
            })
            if(error){ stats.alert_errors++; throw new Error(`No se pudo persistir observación y eventos: ${error.message}`) }
            if(!data || (!data.conflict && !data.obsolete &&
              (!Number.isInteger(data.revision) || !Number.isInteger(data.alerts)))){
              stats.alert_errors++
              throw new Error('La base no confirmó la persistencia de la observación y sus eventos')
            }
            if(!data?.conflict){
              if(!data?.obsolete){stats.items_updated++;persisted=true}else obsolete=true
              stats.alerts_fired+=Number(data?.alerts ?? 0)
              if(value.target.sourceKind !== 'user_product' && value.observation.state !== 'no_external_offers'){
                const repair=await client.schema('ml').rpc('repair_verified_source_archives',{p_rival:rival.id})
                if(repair.error)repairWarning=true
              }
              committed=true;break
            }
            const latest=await client.schema('ml').from('ml_competitor_items').select('*').eq('id',rival.id).single()
            if(latest.error)throw latest.error
            baseline=latest.data as RivalRecord
          }
          if(!committed)throw new Error('Observación concurrente; reintentar la sincronización')
          const noOffers = value.observation.state === 'no_external_offers'
          const evidence = value.observation.availabilityEvidence
          const offerWarnings = value.observation.warnings ?? []
          const conversionMissing = value.observation.amount != null && value.observation.normalizedAmount == null
          reporting.report?.({entity_id:rival.id,identity:{...identityOf(rival),title:value.title ?? rival.title,seller:value.observation.sellerName,itemId:value.observation.itemId,url:value.permalink},outcome:obsolete?'skipped':conversionMissing||repairWarning||offerWarnings.length?'warning':'updated',message:repairWarning?'Observación guardada; no se pudo completar la revisión de archivos.':obsolete?'Otra consulta más reciente ya está guardada.':conversionMissing?'Observación guardada; no hay conversión válida para comparar.':offerWarnings.length?offerWarnings.join(' '):noOffers?`Actualizado · Sin ofertas observadas${evidence?' · No winners found':''}`:persisted?'Observación y eventos guardados.':'Consulta completada.',operation:'rivales',resource:evidence?.resource ?? value.observation.resolution?.resource,http_status:evidence?.httpStatus,...(noOffers?{category:'availability'}:{})})
        } catch (error) {
          stats.items_failed++
          const failure = syncFailure(error,'rivales')
          const unresolvedMissing = error instanceof MlHttpError && [404,410].includes(error.status)
            && !isConfirmedSource404(error,{kind:rival.target_kind,id:rival.id,sourceKind:rival.source_kind,sourceId:rival.source_id},rival.observation)
          reporting.report?.({entity_id:rival.id,identity:identityOf(rival),outcome:'failed',...failure,
            ...(unresolvedMissing?{category:'resolution',message:`${failure.message}. La identidad del recurso no está validada; no se confirmó indisponibilidad.`}:{}),
          })
          const { error: writeError } = await client
            .schema('ml')
            .from('ml_competitor_items')
            .update({
              ...(isConfirmedSource404(error,{kind:rival.target_kind,id:rival.id,sourceKind:rival.source_kind,sourceId:rival.source_id},rival.observation)
                ? {availability:'unavailable'} : {}),
              last_attempt_at: attemptedAt,
              last_error:
                error instanceof MlHttpError && [404,410].includes(error.status)
                  && (!rival.observation?.resolution||rival.observation.resolution.resource!==error.resource)
                  ? `Identidad del rival por resolver: ${error.message}. No se confirmó indisponibilidad.`
                  : error instanceof Error ? error.message : 'Error de consulta',
            })
            .eq('id', rival.id)
          if (writeError)
            console.error('No se pudo registrar el fallo de consulta')
        }
      }),
    )
  }
  return {
    success: stats.items_failed === 0 && stats.alert_errors === 0,
    ...stats,
    ...recovery,
    synced_at: new Date().toISOString(),
  }
}
type TrackingRow = {
  id: string
  active: boolean
  created_at: string
  target_kind: 'item' | 'catalog'
  target_id: string
  target_review_required: boolean
  ml_item_id: string
  url: string | null
  title: string | null
  thumbnail: string | null
  seller_id: number | null
  seller_name: string | null
  our_sku: string | null
  last_scraped_at: string | null
  last_error: string | null
  source_kind?:SourceKind
  source_id?:string
  source_url?:string|null
}
export async function enrichTracked(client: SupabaseClient, id?: string) {
  const items = id
    ? await (async () => {
        const { data, error } = await client
          .schema('ml')
          .from('ml_tracked_items')
          .select('*')
          .eq('id', id)
        if (error) throw new Error(error.message)
        return (data ?? []) as TrackingRow[]
      })()
    : (await allRows<TrackingRow>(client, 'ml_tracked_items'))
        .filter((item) => item.active)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
  async function enrich(item: TrackingRow) {
    const { data, error } = await client
      .schema('ml')
      .from('ml_tracked_snapshots')
      .select('*')
      .eq('tracked_item_id', item.id)
      .order('scraped_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(2)
    if (error) throw new Error(error.message)
    return {
      ...item,
      latest_snapshot: data?.[0] ?? null,
      prev_snapshot: data?.[1] ?? null,
    }
  }
  const results: Awaited<ReturnType<typeof enrich>>[] = []
  for (let offset = 0; offset < items.length; offset += 20)
    results.push(
      ...(await Promise.all(items.slice(offset, offset + 20).map(enrich))),
    )
  return results
}
export async function syncTracked(
  client: SupabaseClient,
  context: Omit<MlContext, 'fx'> & { fxUrl?: string },
  reporting: SyncReporting = {},
) {
  const [allItems, fx] = await Promise.all([
    enrichTracked(client),
    fetchFx(context.fetcher, context.fxUrl),
  ])
  const items = reporting.ids ? allItems.filter(i => reporting.ids!.includes(i.id)) : allItems
  let stored = 0,
    failed = 0
  for (const item of items) {
    if (item.target_review_required) {
      failed++
      reporting.report?.({entity_id:item.id,identity:identityOf(item),outcome:'failed',category:'resolution',message:'La identidad del seguimiento requiere resolución.',operation:'seguimiento'})
      continue
    }
    const attemptedAt = new Date().toISOString()
    try {
      const value = await fetchTarget(
        { kind: item.target_kind, id: item.target_id,sourceKind:item.source_kind,sourceId:item.source_id,sourceUrl:item.source_url??item.url,itemId:item.latest_snapshot?.selected_item_id,sellerId:item.seller_id,catalogId:item.latest_snapshot?.observation?.catalogProductId },
        { ...context, fx },
      )
      const next = trackingSnapshot(value)
      const previous = item.latest_snapshot
      const changed =
        !previous ||
        [
          'price',
          'currency_id',
          'sale_price',
          'original_price',
          'available_quantity',
          'sold_quantity',
          'status',
          'selected_item_id',
          'seller_id',
        ].some((key) => next[key as keyof typeof next] !== previous[key])
      if (changed) {
        const { error } = await client
          .schema('ml')
          .from('ml_tracked_snapshots')
          .insert({
            ...next,
            tracked_item_id: item.id,
            scraped_at: attemptedAt,
          })
        if (error) throw new Error(error.message)
        stored++
      }
      const { error } = await client
        .schema('ml')
        .from('ml_tracked_items')
        .update({
          title: value.title ?? item.title,
          thumbnail: value.thumbnail ?? item.thumbnail,
          seller_id: value.observation.sellerId,
          seller_name: value.observation.sellerName,
          source_kind:value.observation.sourceKind,source_id:value.observation.resolution?.sourceId,source_url:value.observation.sourceUrl,url:value.permalink,
          last_scraped_at: attemptedAt,
          last_attempt_at: attemptedAt,
          last_error: null,
        })
        .eq('id', item.id)
        .select('id')
        .single()
      if (error) throw new Error(`No se pudo guardar el seguimiento: ${error.message}`)
      reporting.report?.({entity_id:item.id,identity:{...identityOf(item),title:value.title ?? item.title,seller:value.observation.sellerName,itemId:value.observation.itemId,url:value.permalink},outcome:(value.observation.warnings?.length || value.observation.amount != null && value.observation.normalizedAmount == null)?'warning':'updated',message:value.observation.warnings?.length?value.observation.warnings.join(' '):value.observation.amount != null && value.observation.normalizedAmount == null?'Consulta guardada sin conversión válida.':changed?'Consulta y cambio guardados.':'Consulta guardada; sin cambios.',operation:'seguimiento'})
    } catch (error) {
      failed++
      reporting.report?.({entity_id:item.id,identity:identityOf(item),outcome:'failed',...syncFailure(error,'seguimiento')})
      await client
        .schema('ml')
        .from('ml_tracked_items')
        .update({
          last_attempt_at: attemptedAt,
          last_error: error instanceof Error ? error.message : 'Error',
        })
        .eq('id', item.id)
    }
  }
  return {
    success: failed === 0,
    scraped: items.length,
    items_failed: failed,
    snapshots_stored: stored,
  }
}
