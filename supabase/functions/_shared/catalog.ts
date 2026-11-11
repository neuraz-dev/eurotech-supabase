import { positive, type FxQuote, type PriceObservation } from './monitoring.ts'

export type CatalogOffer = {
  itemId: string
  sellerId: number
  sellerName: string | null
  title: string | null
  permalink: string | null
  observation: PriceObservation
  detailsError?: string | null
}
export type CatalogBuyBox = {
  state: 'verified' | 'shared' | 'not_verified'
  winnerId: string | null
  winner: CatalogOffer | null
  observedAt: string | null
  sourceItemId: string | null
  source: 'price_to_win'
}
export type CatalogPublicationEvidence = {status:string|null;subStatus:string[];message:string;observedAt:string;resource:string;httpStatus:number|null;warning?:string}
export type CatalogDiagnosis = {
  kind:'no_offers'|'inactive_parent'|'inactive_catalog'|'catalog_not_found'|'unverified'
  message:string;catalogStatus:string|null;childrenIds:string[];observedAt:string
  publications:Record<string,CatalogPublicationEvidence>
  evidence:{httpStatus:number;resource:string;apiCode?:string;message?:string;metadataResource:string;metadataHttpStatus:number}
}
export type CatalogRecordedPrice = {publicationId:string;amount:number;currency:string|null;observedAt:string|null;source:'stored_record'|'local_backup';backup?:string}
export type CatalogSnapshot = {
  lastRecordedPrices?: CatalogRecordedPrice[]
  diagnosis?: CatalogDiagnosis
  lastPricedSnapshot?: Omit<CatalogSnapshot,'lastPricedSnapshot'>
  catalogId: string
  offers: CatalogOffer[]
  total: number | null
  coverage: 'complete' | 'partial' | 'unknown'
  observedAt: string
  fx: FxQuote | null
  buyBox: CatalogBuyBox
  warnings: string[]
}
export type CatalogPanel = {
  status: 'ready' | 'pending' | 'unavailable' | 'not_applicable'
  catalogId: string | null
  snapshot: CatalogSnapshot | null
  lastAttemptAt: string | null
  lastError: string | null
}

export function catalogRanking(snapshot: CatalogSnapshot, ownId: string) {
  if(snapshot.diagnosis)return []
  const reference = snapshot.offers.find(offer => offer.itemId === ownId)?.observation.normalizedAmount
  const prices = snapshot.offers.map(offer => offer.observation.normalizedAmount).filter(positive)
  return snapshot.offers.map(offer => {
    const price = offer.observation.normalizedAmount
    return {
      ...offer,
      position: positive(price) ? 1 + prices.filter(value => value < price).length : null,
      relativePct: positive(price) && positive(reference) ? (price - reference) / reference * 100 : null,
    }
  }).sort((a, b) =>
    (a.observation.normalizedAmount ?? Infinity) - (b.observation.normalizedAmount ?? Infinity) || a.itemId.localeCompare(b.itemId))
}

/** A UI classification only: associations and their SKU inheritance remain intact. */
export function isSameCatalogRival(
  rival: { id: string; source_kind?: string; observation?: PriceObservation | null },
  catalogId: string,
  snapshot: CatalogSnapshot | null,
) {
  return rival.observation?.catalogProductId === catalogId ||
    (rival.id === catalogId && rival.source_kind !== 'user_product') ||
    !!snapshot?.offers.some(offer => offer.itemId === rival.id || offer.itemId === rival.observation?.itemId)
}
