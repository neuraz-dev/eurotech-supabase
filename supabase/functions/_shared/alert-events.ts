import {
  compare, linksForProduct, observe, positive, ruleFires,
  type CompetitorLink, type FxQuote, type OwnProduct, type PriceObservation,
} from './monitoring.ts'
import {observationLink} from './source-links.ts'

export type EventRule = {
  id: string; name?: string; rule_type: string; threshold_pct: number | null
  enabled: boolean; sku: string | null; compare_catalog_price: boolean
}
export type EventProduct = OwnProduct & {
  title?: string | null; thumbnail?: string | null; permalink?: string | null; status?: string | null
}
export type EventRival = {
  id: string; target_kind: 'item' | 'catalog'; observation: PriceObservation | null
  status: string | null; availability?: string; title?: string | null
  seller_name?: string | null; permalink?: string | null; thumbnail?: string | null
}
export type EventListRow = {
  id: string; isOwn: boolean; title: string; mlu: string | null
  sellerName: string | null; price: number | null; relativePct: number | null
  permalink: string | null; observation: PriceObservation | null
  position: number | null; reasons: string[]
  sources?:{rivalId:string;mode:'item'|'catalog';associationIds:string[]}[]
  linkKind?:'item'|'source'
}
export type EventSnapshot = {
  version: number; legacy: boolean; detectedAt: string; relativePct: number | null
  own: { id: string | null; sku: string | null; title?: string | null; thumbnail?: string | null; permalink?: string | null; catalog_listing?: boolean | null }
  rival: { id: string | null; title?: string | null; sellerName?: string | null; permalink?: string | null; thumbnail?: string | null }
  rows: EventListRow[]; note?: string
  details?: Record<string, unknown>; storedPrices?: Record<string, unknown>
}
export type AlertEvent = {
  id: string; fired_at: string; read_at: string | null; archived_at: string | null
  archive_reason: string | null; our_product_id: string | null; competitor_item_id: string | null
  event_origins?:{rival_id:string;association_ids:string[];detected_at:string}[]
  our_sku: string; event_snapshot: EventSnapshot; matched_rules: EventRule[]; is_legacy: boolean
}

const details = (value: object) => {
  const record = value as Record<string, unknown>
  return Object.fromEntries([
    'id','sku','title','status','availability','condition','attributes','pictures','shipping','descriptions',
    'thumbnail','permalink','seller_name','seller_id','available_quantity','sold_quantity',
    'price','sale_price','catalog_price','currency_id','synced_at','catalog_observation',
    'catalog_competition','fx_quote','observation','target_kind','last_error','last_attempt_at',
  ].filter(key => record[key] !== undefined).map(key => [key, record[key]]))
}
export function originalPriceChanged(previous: PriceObservation | null, next: PriceObservation) {
  return !!previous && positive(previous.amount) && positive(next.amount)
    && !!previous.currency && !!next.currency
    && (previous.currency !== next.currency || previous.amount !== next.amount)
}
function normalized(rival: EventRival, fx: FxQuote | null): EventRival {
  const o = rival.observation
  return { ...rival, observation: o ? { ...o, ...observe(o.amount,o.currency,o.observedAt,o.source,fx) } : null }
}
export function buildAlertEvents(
  rival: EventRival, previous: PriceObservation | null,
  products: EventProduct[], rivals: EventRival[], links: CompetitorLink[], rules: EventRule[], fx: FxQuote | null,
) {
  if (!previous || !rival.observation || !originalPriceChanged(previous,rival.observation)
    || rival.status !== 'active' || rival.availability === 'unavailable') return []
  const current = normalized(rival,fx)
  const events: Record<string, unknown>[] = []
  for (const source of products) {
    if (source.status !== 'active') continue
    const product = { ...source, fx_quote: fx }
    const applicable = linksForProduct(links.filter(l=>l.competitor_item_id===rival.id),product)
    const matched = rules.filter(rule => rule.enabled
      && (!rule.sku || rule.sku.trim().toLowerCase() === product.sku?.trim().toLowerCase()))
      .map(rule => ({ rule, result: compare(product,current,applicable,{compareCatalog:rule.compare_catalog_price,fx}) }))
      .filter(({rule,result}) => ruleFires(rule,result,previous))
    if (!matched.length) continue
    const standard = compare(product,current,applicable,{fx})
    const ownAmount = standard.own.normalizedAmount
    const rows: EventListRow[] = [{
      id: product.id,isOwn:true,title:product.title ?? product.id,mlu:product.id,sellerName:null,
      price:ownAmount,relativePct:positive(ownAmount)?0:null,permalink:product.permalink ?? null,
      observation:standard.own,position:null,reasons:positive(ownAmount)?[]:['Sin precio propio comparable'],
    }]
    const seen = new Map<string,EventListRow>()
    for (const candidate of [rival,...rivals.filter(r=>r.id!==rival.id)]) {
      const activeLinks=linksForProduct(links.filter(l=>l.competitor_item_id===candidate.id),product)
      if (!activeLinks.length) continue
      const item=normalized(candidate,fx)
      const result=compare(product,item,activeLinks,{fx})
      const mlu=item.observation?.itemId ?? (item.target_kind==='item'?item.id:null)
      const identity=mlu ?? item.id
      if(identity===product.id)continue
      const price=result.status==='comparable'?result.rival?.normalizedAmount ?? null:null
      const link=observationLink(item.observation,item.permalink)
      const sources=result.status==='comparable'?[{rivalId:item.id,mode:item.target_kind,associationIds:result.associationIds}]:[]
      const entry:EventListRow={id:item.id,isOwn:false,title:item.title ?? item.id,mlu,
        sellerName:item.observation?.sellerName ?? item.seller_name ?? null,
        price,relativePct:positive(ownAmount)&&positive(price)?(price-ownAmount)/ownAmount*100:null,
        permalink:link.url,linkKind:link.kind,sources,
        observation:item.observation,position:null,reasons:result.reasons,
      }
      const existing=seen.get(identity)
      if(existing){
        const origins=[...(existing.sources??[]),...sources]
        if(existing.price==null&&price!=null)Object.assign(existing,entry)
        existing.sources=origins
      }else{seen.set(identity,entry);rows.push(entry)}
    }
    rows.sort((a,b)=>(a.price ?? Infinity)-(b.price ?? Infinity)||a.id.localeCompare(b.id))
    let previousPrice:number|null=null, position=0, comparableCount=0
    for(const row of rows)if(positive(row.price)){
      comparableCount++
      if(row.price!==previousPrice)position=comparableCount
      row.position=position;previousPrice=row.price
    }
    const snapshot:EventSnapshot={version:2,legacy:false,detectedAt:rival.observation.observedAt!,
      relativePct:standard.deltaPct==null?null:-standard.deltaPct,
      own:{id:product.id,sku:product.sku,title:product.title,thumbnail:product.thumbnail,
        permalink:product.permalink,catalog_listing:product.catalog_listing},
      rival:{id:rival.id,title:rival.title,sellerName:rival.observation.sellerName ?? rival.seller_name,
        permalink:rival.permalink,thumbnail:rival.thumbnail},rows,
      details:{own:details(source),rivals:[rival,...rivals.filter(r=>r.id!==rival.id)]
        .filter(r=>linksForProduct(links.filter(l=>l.competitor_item_id===r.id),product).length).map(details),
        ownObservation:standard.own,previousRival:previous,currentRival:rival.observation,evaluationFx:fx,
        reference:standard.reference,comparisonsByRule:matched.map(({rule,result})=>({rule,result}))},
    }
    events.push(structuredClone({rule_id:matched[0].rule.id,our_sku:product.sku ?? '',our_product_id:product.id,
      our_price:standard.own.normalizedAmount,catalog_price:product.catalog_price,
      competitor_price_before:previous.normalizedAmount,competitor_price_after:current.observation?.normalizedAmount,
      diff_pct:standard.deltaPct,fired_at:snapshot.detectedAt,
      comparison_snapshot:{...standard,previousRival:previous},event_snapshot:snapshot,
      matched_rules:matched.map(({rule})=>rule),
    }))
  }
  return events
}

export function relativeLabel(value:number|null) {
  if(value==null || !Number.isFinite(value))return 'Rival — · Sin comparación'
  const absolute=Math.abs(value)
  const number=absolute>0&&absolute<0.005?'menos de 0,01':absolute.toLocaleString('es-UY',{maximumFractionDigits:2})
  return `Rival ${value<0?'−':value>0?'+':''}${number} % · ${value<0?'Desventaja':value>0?'Ventaja':'Empate'}`
}
