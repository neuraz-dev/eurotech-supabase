import { observe, positive, type FxQuote } from './monitoring.ts'
import { catalogOfferUrl, safeMarketplaceUrl } from './source-links.ts'
import type { MlContext } from './ml-observation.ts'
import type { CatalogBuyBox, CatalogOffer, CatalogSnapshot } from './catalog.ts'

type OfferRow = { item_id: string; seller_id: number; price: number | null; currency_id: string | null; title?: string; seller_name?: string }
export type CatalogProduct = { id: string; catalog_product_id: string | null; catalog_listing: boolean | null; site_id?: string | null; title?: string | null; sku?: string | null; permalink?: string | null }
export type CompetitionEvidence = { state: string; itemId: string; winnerId?: string | null; observedAt: string | null; source: 'price_to_win' }

export async function collectCatalogOffers(
  catalogId: string,
  products: CatalogProduct[],
  context: MlContext,
): Promise<{ snapshot: CatalogSnapshot; competitions: Map<string, CompetitionEvidence> }> {
  const fetcher = context.fetcher ?? fetch
  const api = context.apiUrl ?? 'https://api.mercadolibre.com'
  const deadline = AbortSignal.timeout(95_000)
  const get = async (resource: string) => {
    const response = await fetcher(`${api}${resource}`, {
      headers: { Authorization: `Bearer ${context.token}` },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
    })
    if (!response.ok) throw Object.assign(new Error(`Catálogo HTTP ${response.status}`), { status: response.status, resource })
    return response.json()
  }
  const warnings: string[] = []
  const found = new Map<string, OfferRow>()
  let total: number | null = null
  let offset = 0
  let exhausted = false
  while (!exhausted) {
    const page = await get(`/products/${encodeURIComponent(catalogId)}/items?status=active&limit=20&offset=${offset}`)
    if (!Array.isArray(page.results)) throw new Error('Respuesta de catálogo inválida')
    if (Number.isInteger(page.paging?.total) && page.paging.total >= 0) total = page.paging.total
    const previousSize = found.size
    for (const row of page.results) {
      if (typeof row.item_id !== 'string' || !/^ML[AU]\d+$/.test(row.item_id) || !Number.isFinite(row.seller_id)) {
        throw new Error('El catálogo devolvió una oferta sin identidad válida')
      }
      found.set(row.item_id, row)
    }
    offset += page.results.length
    exhausted = page.results.length === 0 || (total != null && offset >= total) || (total == null && page.results.length < 20)
    if (!exhausted && found.size === previousSize) {
      warnings.push('La paginación no avanzó; la cobertura es parcial.')
      break
    }
    if (offset >= 20000 && !exhausted) {
      warnings.push('Se alcanzó el límite de consulta; la cobertura es parcial.')
      break
    }
  }
  const now = new Date().toISOString()
  const offers: CatalogOffer[] = [...found.values()].map(row => ({
    itemId: row.item_id, sellerId: row.seller_id, sellerName: row.seller_name ?? null,
    title: row.title ?? products.find(product => product.id === row.item_id)?.title ?? null,
    permalink: catalogOfferUrl(catalogId, row.item_id),
    observation: {
      ...observe(row.price, row.currency_id, now, 'catalog', context.fx),
      itemId: row.item_id, sellerId: row.seller_id, catalogProductId: catalogId,
    },
  }))
  // Fetch item metadata in bounded multi-get batches. Offer prices come from the
  // catalog response, so metadata failures never replace them with stale prices.
  for (let start = 0; start < offers.length; start += 20) {
    const batch = offers.slice(start, start + 20)
    try {
      const details = await get(`/items?ids=${batch.map(offer => offer.itemId).join(',')}`)
      if (!Array.isArray(details)) throw new Error('Metadatos de ofertas no disponibles')
      for (const offer of batch) {
        const detail = details.find(entry => entry.code === 200 && entry.body?.id === offer.itemId)?.body
        if (!detail || detail.catalog_product_id !== catalogId || detail.seller_id !== offer.sellerId) {
          offer.detailsError = 'No se pudieron verificar los detalles de esta oferta.'
          continue
        }
        offer.title = typeof detail.title === 'string' ? detail.title : offer.title
        offer.permalink = safeMarketplaceUrl(detail.permalink) ?? offer.permalink
        offer.observation.itemPermalink = offer.permalink
      }
    } catch {
      batch.forEach(offer => { offer.detailsError = 'No se pudieron consultar los detalles de esta oferta.' })
    }
  }
  // Some accounts can read an item individually but cannot use multi-get.
  const missingDetails = offers.filter(offer => offer.detailsError)
  for (let start = 0; start < missingDetails.length; start += 4) {
    await Promise.all(missingDetails.slice(start, start + 4).map(async offer => {
      try {
        const detail = await get(`/items/${offer.itemId}`)
        if (detail.id !== offer.itemId || detail.catalog_product_id !== catalogId || detail.seller_id !== offer.sellerId) return
        offer.title = typeof detail.title === 'string' ? detail.title : offer.title
        offer.permalink = safeMarketplaceUrl(detail.permalink) ?? offer.permalink
        offer.observation.itemPermalink = offer.permalink
        offer.detailsError = null
      } catch { /* Keep explicit missing metadata when both endpoints fail. */ }
    }))
  }
  const sellers = [...new Set(offers.map(offer => offer.sellerId))]
  for (let start = 0; start < sellers.length; start += 4) {
    await Promise.all(sellers.slice(start, start + 4).map(async id => {
      try {
        const seller = await get(`/users/${id}`)
        if (seller.id === id && typeof seller.nickname === 'string') {
          for (const offer of offers.filter(offer => offer.sellerId === id)) {
            offer.sellerName = seller.nickname
            offer.observation.sellerName = seller.nickname
          }
        }
      } catch { /* Missing seller names are shown explicitly in the UI. */ }
    }))
  }
  const competitions = new Map<string, CompetitionEvidence>()
  const winners = new Set<string>()
  let shared = false
  let sourceItemId: string | null = null
  for (let start = 0; start < products.length; start += 4) {
    await Promise.all(products.slice(start, start + 4).filter(product => product.catalog_listing).map(async product => {
      let evidence: CompetitionEvidence = { state: 'not_verified', itemId: product.id, observedAt: null, source: 'price_to_win' }
      try {
        const raw = await get(`/items/${product.id}/price_to_win?siteId=${encodeURIComponent(product.site_id ?? 'MLU')}&version=v2`)
        if (raw.item_id === product.id && raw.consistent !== false &&
          (!raw.catalog_product_id || raw.catalog_product_id === catalogId) &&
          ['winning', 'competing', 'sharing_first_place', 'listed'].includes(raw.status)) {
          const winnerId = raw.status === 'winning' ? product.id : raw.winner?.item_id
          evidence = { ...evidence, state: raw.status, observedAt: now, winnerId: typeof winnerId === 'string' && /^ML[AU]\d+$/.test(winnerId) ? winnerId : null }
          if (evidence.winnerId) winners.add(evidence.winnerId)
          if (raw.status === 'sharing_first_place') shared = true
          sourceItemId ??= product.id
        }
      } catch { /* A missing response is never evidence of a win or loss. */ }
      competitions.set(product.id, evidence)
    }))
  }
  const winnerId = winners.size === 1 ? [...winners][0] : null
  const buyBox: CatalogBuyBox = {
    state: winners.size > 1 ? 'not_verified' : shared ? 'shared' : winnerId ? 'verified' : 'not_verified',
    winnerId,
    winner: offers.find(offer => offer.itemId === winnerId) ?? null,
    observedAt: sourceItemId ? now : null,
    sourceItemId, source: 'price_to_win',
  }
  if (winners.size > 1) warnings.push('Las respuestas del buy-box no coinciden; no se verificó un ganador único.')
  if (buyBox.state === 'not_verified') warnings.push('No se pudo verificar el buy-box del catálogo.')
  if (offers.some(offer => offer.detailsError || !offer.sellerName)) warnings.push('Hay ofertas con detalles o vendedor no disponibles.')
  if (offers.some(offer => !positive(offer.observation.normalizedAmount))) warnings.push('Hay ofertas sin precio o conversión válida a UYU.')
  const coverage = total == null ? 'unknown' : exhausted && found.size === total ? 'complete' : 'partial'
  if (coverage !== 'complete') warnings.push('La cobertura de ofertas es parcial o desconocida.')
  return { snapshot: { catalogId, offers, total, coverage, observedAt: now, fx: context.fx, buyBox, warnings }, competitions }
}
