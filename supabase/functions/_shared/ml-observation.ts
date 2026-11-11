import {
  observe,
  positive,
  type FxQuote,
  type MonitoringTarget,
  type PriceObservation,
} from './monitoring.ts'
import {catalogOfferUrl,safeMarketplaceUrl,sourceIdentity} from './source-links.ts'

export class MlHttpError extends Error {
  status:number
  resource:string
  noWinners:boolean
  constructor(status:number,resource='',noWinners=false) { super(`Mercado Libre HTTP ${status}`); this.status=status;this.resource=resource;this.noWinners=noWinners }
}

type MlData = Record<string, unknown>
export type ObservedTarget = {
  target: MonitoringTarget
  observation: PriceObservation
  title: string | null
  thumbnail: string | null
  permalink: string
  status: string | null
  condition: string | null
  attributes: unknown[]
  available_quantity: number | null
  sold_quantity: number | null
  original_price: number | null
  sale_price: number | null
  health: number | null
}
export type MlContext = {
  token: string
  sellerId: number
  fx: FxQuote | null
  fetcher?: typeof fetch
  apiUrl?: string
  now?: string
}
export function parseTarget(input: string): MonitoringTarget {
  const trimmed = input.trim()
  let match: RegExpMatchArray | null = null
  try {
    const url = new URL(trimmed)
    if (
      !/(^|\.)mercadolibre\.com\.uy$/i.test(url.hostname) &&
      !/(^|\.)mercadolibre\.com\.ar$/i.test(url.hostname)
    )
      throw new Error('Dominio de Mercado Libre inválido')
    match = url.pathname.match(/\/(?:p|up)\/(ML[A-Z]+\d+)/i)
    if (match) {const id=match[1].toUpperCase();return {kind:'catalog',id,sourceKind:/^ML[AU]U\d+$/.test(id)?'user_product':'catalog',sourceId:id,sourceUrl:safeMarketplaceUrl(trimmed),...(url.searchParams.get('wid')||url.hash.match(/(?:[?&#]|^)wid=(ML[AU]\d+)/i)?.[1]||url.searchParams.get('pdp_filters')?.match(/item_id:(ML[AU]\d+)/i)?.[1]?{itemId:url.searchParams.get('wid')??url.hash.match(/(?:[?&#]|^)wid=(ML[AU]\d+)/i)?.[1]??url.searchParams.get('pdp_filters')?.match(/item_id:(ML[AU]\d+)/i)?.[1]}:{})}}
    const wid =
      url.searchParams.get('wid') ??
      url.hash.match(/(?:[?&#]|^)wid=(ML[A-Z]+\d+)/i)?.[1]
    match = url.pathname.match(/\/(ML[A-Z]+)-?(\d+)/i)
    const id = wid ?? (match ? match[1] + match[2] : null)
    if (id && /^ML[A-Z]+\d+$/i.test(id))
      return { kind: 'item', id: id.toUpperCase(),sourceKind:'item',sourceId:id.toUpperCase(),sourceUrl:safeMarketplaceUrl(trimmed) }
  } catch (error) {
    if (/^https?:/i.test(trimmed)) throw error
  }
  if (/^ML[A-Z]+\d+$/i.test(trimmed))
    return /^ML[AU]U\d+$/i.test(trimmed)?{kind:'catalog',id:trimmed.toUpperCase(),sourceKind:'user_product',sourceId:trimmed.toUpperCase()}:{ kind: 'item', id: trimmed.toUpperCase() }
  throw new Error('URL o ID de Mercado Libre inválido')
}
export async function fetchFx(
  fetcher = fetch,
  url = 'https://open.er-api.com/v6/latest/USD',
): Promise<FxQuote | null> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return null
    const data = await response.json()
    if (!positive(data.rates?.UYU)) return null
    return {
      rate: data.rates.UYU,
      source: 'open.er-api.com',
      fetchedAt: new Date().toISOString(),
      publishedAt:
        typeof data.time_last_update_utc === 'string'
          ? data.time_last_update_utc
          : null,
    }
  } catch {
    return null
  }
}
const nullableNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const nullableString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null

export async function fetchTarget(
  target: MonitoringTarget,
  context: MlContext,
): Promise<ObservedTarget> {
  const fetcher = context.fetcher ?? fetch
  const api = context.apiUrl ?? 'https://api.mercadolibre.com'
  const source=sourceIdentity(target)
  const headers = { Authorization: `Bearer ${context.token}` }
  const get = async (path: string) => {
    const response = await fetcher(`${api}${path}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) {
      // Retain only the recognized business signal, never an external error body.
      const error = response.status === 404 ? await response.json().catch(() => null) : null
      throw new MlHttpError(response.status,path,
        error?.error === 'not_found' && error?.message === 'No winners found')
    }
    return (await response.json()) as MlData
  }
  let noOfferEvidence: PriceObservation['availabilityEvidence']
  const getOffers = async (path: string, firstPage: boolean): Promise<MlData> => {
    try { return await get(path) } catch (error) {
      if (!firstPage || !(error instanceof MlHttpError) || !error.noWinners) throw error
      noOfferEvidence = {httpStatus:404,apiCode:'not_found',message:'No winners found',
        resource:path,observedAt:context.now ?? new Date().toISOString()}
      return {results:[],paging:{total:0}}
    }
  }
  let now = context.now ?? ''
  let body: MlData
  let observation: PriceObservation
  let metadata: MlData = {}
  let resource=''
  if(source.kind==='user_product'){
    // Public offers can be readable even when /items and /user-products deny access.
    // The source remains a User Product, and a missing MLU is not resolution evidence.
    const rows: MlData[] = []
    const warnings: string[] = []
    const pages = new Set<string>()
    let offset = 0
    let total: number | null = null
    let complete = false
    for (let page = 0; page < 50; page++) {
      const path = `/products/${source.id}/items?status=active&limit=20${offset ? `&offset=${offset}` : ''}`
      try {
        const data = await getOffers(path, page === 0)
        if (!Array.isArray(data.results)) throw new Error('Ofertas del producto sin lista válida')
        const batch = data.results as MlData[]
        if (batch.some(row => !row || !positive(row.seller_id) ||
          !('price' in row) || row.price != null && nullableNumber(row.price) == null ||
          row.currency_id != null && typeof row.currency_id !== 'string'))
          throw new Error('Ofertas del producto con vendedor, importe o moneda inválidos')
        const signature = JSON.stringify(batch)
        if (batch.length && pages.has(signature)) throw new Error('La API repitió una página de ofertas')
        pages.add(signature)
        rows.push(...batch)
        offset += batch.length
        const paging = data.paging as {total?: unknown} | undefined
        if (paging?.total != null) {
          if (!Number.isInteger(paging.total) || Number(paging.total) < 0)
            throw new Error('Total de ofertas inválido')
          total = Number(paging.total)
        }
        if (total != null ? offset >= total : batch.length < 20) { complete = true; break }
        if (!batch.length) throw new Error('La API no devolvió las ofertas restantes')
      } catch (error) {
        if (!rows.length) throw error
        warnings.push(`Cobertura parcial (${path}): ${error instanceof Error ? error.message : 'falló la consulta de ofertas'}`)
        break
      }
    }
    if (!complete && !warnings.length) warnings.push('Cobertura parcial: se alcanzó el límite de 1.000 ofertas por consulta')
    resource = `/products/${source.id}/items?status=active&limit=20`
    now = context.now ?? new Date().toISOString()
    const external = rows.filter(row => row.seller_id !== context.sellerId &&
      (!target.sellerId || row.seller_id === target.sellerId) &&
      (row.status == null || row.status === 'active'))
    const offers = external.map(row => ({row, price: observe(nullableNumber(row.price), nullableString(row.currency_id), now, 'user_product', context.fx)}))
    const valid = offers.filter(offer => positive(offer.price.normalizedAmount))
      .sort((a,b) => a.price.normalizedAmount! - b.price.normalizedAmount!)
    const best = valid[0] ?? offers.find(offer => positive(offer.price.amount)) ?? offers[0]
    if (!complete && !positive(best?.price.normalizedAmount))
      throw new Error('Cobertura parcial sin precio comparable; se conserva la observación anterior')
    body = best?.row ?? {}
    observation = {...(best?.price ?? observe(null,null,now,'user_product',context.fx)),
      offersConsulted: rows.length, offersTotal: total,
      coverage: complete ? total == null ? 'unknown' : 'complete' : 'partial',
      state: external.length ? 'observed' : 'no_external_offers', warnings,
    }
  } else if (source.kind === 'catalog') {
    resource=`/products/${source.id}/items?status=active&limit=20`
    const data = await getOffers(resource, true)
    if (!Array.isArray(data.results)) throw new Error('Respuesta de catálogo sin lista de ofertas válida')
    now = context.now ?? new Date().toISOString()
    const results = (
      Array.isArray(data.results) ? data.results : []
    ) as MlData[]
    if(results.some(row=>!row||typeof row.item_id!=='string'||nullableNumber(row.seller_id)==null||!('price' in row)))throw new Error('Respuesta de catálogo con ofertas sin identidad o precio')
    const external = results.filter(
      (row) =>
        nullableNumber(row.seller_id) !== context.sellerId &&
        nullableNumber(row.seller_id) != null &&
        (row.status == null || row.status === 'active'),
    )
    const observed = external.map((row) => ({
      row,
      price: observe(
        nullableNumber(row.price),
        nullableString(row.currency_id),
        now,
        'catalog',
        context.fx,
      ),
    }))
    // An unconvertible currency must never win a numeric minimum.
    const valid = observed
      .filter((row) => positive(row.price.normalizedAmount))
      .sort((a, b) => a.price.normalizedAmount! - b.price.normalizedAmount!)
    const best = valid[0] ?? observed[0]
    body = best?.row ?? {}
    observation = best?.price ?? observe(null, null, now, 'catalog', context.fx)
    const paging = data.paging as { total?: number } | undefined
    const total = nullableNumber(paging?.total)
    observation = {
      ...observation,
      offersConsulted: results.length,
      offersTotal: total,
      coverage:
        total == null
          ? 'unknown'
          : total > results.length
            ? 'partial'
            : 'complete',
      state: external.length ? 'observed' : 'no_external_offers',
    }
    try {
      metadata = await get(`/products/${source.id}`)
    } catch {
      /* metadata is optional */
    }
  } else {
    resource=`/items/${source.id}`
    try{body=await get(resource)}catch(error){
      if(!(error instanceof MlHttpError)||error.status!==403||!target.catalogId)throw error
      // The app may read catalog offers but not competitor /items. A successful
      // offer response proves membership and seller without treating 403 as stock loss.
      let found:MlData|undefined
      for(let offset=0;offset<1000;offset+=20){
        resource=`/products/${target.catalogId}/items?status=active&limit=20&offset=${offset}`
        const page=await get(resource)
        if(!Array.isArray(page.results))throw new Error('Catálogo sin ofertas verificables')
        const match=(page.results as MlData[]).find(r=>r.item_id===source.id)
        if(match){
          if(nullableNumber(match.seller_id)==null||match.seller_id===context.sellerId||target.sellerId&&match.seller_id!==target.sellerId)throw new Error('Vendedor de la publicación fija no verificado')
          found={...match,id:source.id,catalog_product_id:target.catalogId,status:match.status??'active',permalink:catalogOfferUrl(target.catalogId,source.id)}
          break
        }
        const total=(page.paging as {total?:number}|undefined)?.total
        if(page.results.length<20||typeof total==='number'&&offset+page.results.length>=total)break
      }
      if(!found)throw new Error('La publicación fija no apareció en las ofertas consultadas; no se confirmó indisponibilidad')
      body=found
    }
    if (body.id !== source.id)
      throw new Error('La consulta no devolvió la MLU seleccionada')
    if (!('price' in body) && !('sale_price' in body))
      throw new Error('Respuesta de publicación sin campo de precio')
    if (body.price != null && (typeof body.price !== 'number' || !Number.isFinite(body.price)))
      throw new Error('Respuesta de publicación con precio inválido')
    now = context.now ?? new Date().toISOString()
    if (nullableNumber(body.seller_id) === context.sellerId)
      throw new Error('La publicación seleccionada pertenece a nuestra cuenta')
    const sale = body.sale_price as { amount?: number } | null
    observation = observe(
      sale?.amount ?? nullableNumber(body.price),
      nullableString(body.currency_id),
      now,
      'item',
      context.fx,
    )
  }
  if(noOfferEvidence) observation = {...observation,availabilityEvidence:noOfferEvidence}
  const itemId =
    source.kind === 'user_product'
      ? [body.item_id, body.id].find((id): id is string => typeof id === 'string' && /^ML[AU]\d+$/.test(id)) ?? null
      : nullableString(body.item_id) ?? (source.kind === 'item' ? nullableString(body.id) : null)
  if(source.kind==='catalog'&&itemId&&!body.permalink){
    try{
      const detail=await get(`/items/${itemId}`)
      if(detail.id===itemId&&detail.catalog_product_id===source.id&&detail.seller_id===body.seller_id)
        body={...detail,...body,permalink:detail.permalink}
    }catch{/* Optional item link never changes price validity or source availability. */}
  }
  const sellerId = nullableNumber(body.seller_id) ?? (observation.state === 'no_external_offers' ? target.sellerId ?? null : null)
  let sellerName = nullableString(body.seller_name)
  if (sellerId && !sellerName) {
    try {
      sellerName = nullableString((await get(`/users/${sellerId}`)).nickname)
    } catch {
      /* seller name is optional */
    }
  }
  const pictures = metadata.pictures as { url?: string }[] | undefined
  observation = {
    ...observation,
    itemId,
    sellerId,
    sellerName,
    condition: nullableString(body.condition),
    catalogProductId:source.kind==='catalog'?source.id:nullableString(body.catalog_product_id),userProductId:source.kind==='user_product'?source.id:nullableString(body.user_product_id),
    sourceKind:source.kind,sourceUrl:source.url,
    itemPermalink:(itemId?safeMarketplaceUrl(nullableString(body.permalink)):null)??(source.kind==='catalog'&&itemId?catalogOfferUrl(source.id,itemId):null),
    resolution:{sourceKind:source.kind,sourceId:source.id,itemId,sellerId,resource,validatedAt:now},
  }
  return {
    target:{...target,sourceKind:source.kind,sourceId:source.id,sourceUrl:source.url},
    observation,
    title: nullableString(metadata.name) ?? nullableString(body.title),
    thumbnail: nullableString(body.thumbnail) ?? pictures?.[0]?.url ?? null,
    permalink:
      source.kind==='item'?(safeMarketplaceUrl(nullableString(body.permalink))??source.url??''):(source.url??''),
    status:
      nullableString(body.status) ??
      (target.kind === 'catalog' && observation.state !== 'no_external_offers' ? 'active' : null),
    condition: nullableString(body.condition),
    attributes: Array.isArray(body.attributes) ? body.attributes : [],
    available_quantity: nullableNumber(body.available_quantity),
    sold_quantity: nullableNumber(body.sold_quantity),
    original_price: nullableNumber(body.original_price),
    sale_price: nullableNumber(
      (body.sale_price as { amount?: unknown } | null)?.amount,
    ),
    health: nullableNumber(body.health),
  }
}
export function competitorRecord(value: ObservedTarget) {
  const o = value.observation
  return {
    id: value.target.id,
    target_kind: value.target.kind,
    source_kind:o.sourceKind??value.target.sourceKind??value.target.kind,
    source_id:o.resolution?.sourceId??value.target.sourceId??value.target.id,
    source_url:o.sourceUrl??value.permalink,
    title: value.title,
    thumbnail: value.thumbnail,
    permalink: value.permalink,
    price: o.normalizedAmount ?? o.amount,
    currency_id: o.normalizedCurrency ?? o.currency,
    usd_price: o.currency === 'USD' ? o.amount : null,
    seller_id: o.sellerId,
    seller_name: o.sellerName,
    status: value.status,
    condition: value.condition,
    attributes: value.attributes,
    available_quantity: value.available_quantity,
    sold_quantity: value.sold_quantity,
    observation: o,
    synced_at: o.observedAt,
    last_error: null,
  }
}
export function trackingSnapshot(value: ObservedTarget) {
  return {
    price: value.observation.amount,
    currency_id: value.observation.currency,
    original_price: value.original_price,
    sale_price: value.sale_price,
    available_quantity: value.available_quantity,
    sold_quantity: value.sold_quantity,
    status: value.status,
    health: value.health,
    observation: value.observation,
    selected_item_id: value.observation.itemId ?? null,
    seller_id: value.observation.sellerId ?? null,
    seller_name: value.observation.sellerName ?? null,
  }
}
