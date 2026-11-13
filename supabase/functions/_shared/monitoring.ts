/** Pure monitoring contract. No runtime, network, or framework dependencies. */
export type SourceKind = 'item' | 'catalog' | 'user_product'
export type MonitoringTarget = { kind: 'item' | 'catalog'; id: string; sourceKind?:SourceKind; sourceId?:string; sourceUrl?:string|null; itemId?:string|null; sellerId?:number|null;catalogId?:string|null }
export type FxQuote = {
  rate: number
  source: string
  fetchedAt: string
  publishedAt: string | null
}
export type PriceObservation = {
  amount: number | null
  currency: string | null
  normalizedAmount: number | null
  normalizedCurrency: 'UYU' | null
  observedAt: string | null
  source: string
  fx: FxQuote | null
  itemId?: string | null
  sellerId?: number | null
  sellerName?: string | null
  offersConsulted?: number
  offersTotal?: number | null
  coverage?: 'partial' | 'complete' | 'unknown'
  warnings?: string[]
  availabilityEvidence?: {httpStatus:404;apiCode:'not_found';message:'No winners found';resource:string;observedAt:string}
  lastPricedObservation?: Omit<PriceObservation,'lastPricedObservation'>
  state?: 'observed' | 'no_external_offers'
  condition?: string | null
  catalogProductId?:string|null
  userProductId?:string|null
  sourceKind?:SourceKind
  sourceUrl?:string|null
  itemPermalink?:string|null
  resolution?:{sourceKind:SourceKind;sourceId:string;itemId:string|null;sellerId:number|null;resource:string;validatedAt:string}
}
export type CompetitorLink = {
  id: string
  competitor_item_id: string
  scope: 'publication' | 'sku'
  our_product_id: string | null
  our_sku: string | null
  paused: boolean
  removed_at: string | null
  equivalence: 'pending' | 'accepted' | 'rejected'
  orphaned?: boolean
  reviewed_at?: string | null
  reviewed_by?: string | null
  review_source?: 'manual_review' | 'legacy_manual_assignment' | null
}
export type OwnProduct = {
  id: string
  sku: string | null
  price: number | null
  sale_price: number | null
  catalog_price: number | null
  currency_id?: string | null
  synced_at: string | null
  catalog_item_id?: string | null
  catalog_currency_id?: string | null
  catalog_observed_at?: string | null
  fx_quote?: FxQuote | null
  attributes?: unknown[] | null
  catalog_listing?: boolean | null
  catalog_observation?: PriceObservation | null
  catalog_competition?: {
    state: string
    itemId: string
    observedAt: string | null
    source: string
    winnerId?: string | null
  } | null
}
export type ComparisonStatus =
  | 'comparable'
  | 'no_price'
  | 'no_conversion'
  | 'incompatible_fx'
  | 'stale'
  | 'review'
  | 'paused'
  | 'inactive'
  | 'no_external_offers'
export type ComparisonResult = {
  previousRival?: PriceObservation | null
  maxAgeHours?: number | null
  evaluatedAt: string
  status: ComparisonStatus
  reasons: ComparisonStatus[]
  own: PriceObservation
  rival: PriceObservation | null
  deltaPct: number | null
  deltaAmount: number | null
  meaning: 'disadvantage' | 'advantage' | 'tie' | null
  basis: 'price_only'
  reference: 'sale' | 'catalog' | 'list'
  associationIds: string[]
}
export const QUALITY_LABELS: Record<ComparisonStatus, string> = {
  comparable: 'Comparable',
  no_price: 'Sin precio',
  no_conversion: 'Sin conversión',
  incompatible_fx: 'Cotizaciones distintas',
  stale: 'Desactualizado',
  review: 'Equivalencia por revisar',
  paused: 'Comparación suspendida',
  inactive: 'Rival inactivo',
  no_external_offers: 'Sin ofertas observadas',
}
export function normalizeSku(value: string | null | undefined): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() || null : null
}
export function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
export function observe(
  amount: number | null,
  currency: string | null,
  observedAt: string | null,
  source: string,
  fx: FxQuote | null = null,
): PriceObservation {
  const convertible =
    currency === 'UYU' || (currency === 'USD' && fx && positive(fx.rate))
  return {
    amount,
    currency,
    observedAt,
    source,
    fx: currency === 'USD' ? fx : null,
    normalizedAmount:
      positive(amount) && convertible
        ? Math.round(amount * (currency === 'USD' ? fx!.rate : 1) * 100) / 100
        : null,
    normalizedCurrency: convertible ? 'UYU' : null,
  }
}
export function referencePrice(product: OwnProduct, compareCatalog = true) {
  const reference: ComparisonResult['reference'] =
    product.sale_price != null
      ? 'sale'
      : compareCatalog &&
          product.catalog_price != null &&
          product.catalog_item_id === product.id
        ? 'catalog'
        : 'list'
  const catalog = reference === 'catalog'
  return {
    reference,
    observation: observe(
      reference === 'sale'
        ? product.sale_price
        : catalog
          ? product.catalog_price
          : product.price,
      catalog
        ? (product.catalog_currency_id ?? null)
        : (product.currency_id ?? null),
      catalog ? (product.catalog_observed_at ?? null) : product.synced_at,
      reference,
      product.fx_quote ?? null,
    ),
  }
}
export function linksForProduct(
  links: CompetitorLink[],
  product: Pick<OwnProduct, 'id' | 'sku'>,
) {
  return links.filter(
    (link) =>
      !link.removed_at &&
      (link.scope === 'publication'
        ? link.our_product_id === product.id
        : !!normalizeSku(product.sku) &&
          normalizeSku(link.our_sku) === normalizeSku(product.sku)),
  )
}
export function comparisonFx(product:OwnProduct,rivals:{observation?:PriceObservation|null}[]):FxQuote|null {
  const quotes=[product.fx_quote,...rivals.map(r=>r.observation?.fx)]
    .filter((q):q is FxQuote=>!!q&&positive(q.rate))
  quotes.sort((a,b)=>(Date.parse(b.fetchedAt)||0)-(Date.parse(a.fetchedAt)||0))
  return quotes[0]??null
}
export function adjudicationLabel(
  product: OwnProduct,
  _now?: number,
  _maxAgeHours?: number,
) {
  const evidence = product.catalog_competition
  if (
    !evidence ||
    evidence.source !== 'price_to_win' ||
    evidence.itemId !== product.id ||
    !evidence.observedAt
  )
    return 'No verificado'
  return (
    (
      {
        winning: 'Ganador verificado en la consulta',
        sharing_first_place: 'Primer lugar compartido verificado',
        competing: 'No gana en la consulta verificada',
        listed: 'No compite en catálogo',
      } as Record<string, string>
    )[evidence.state] ?? 'No verificado'
  )
}
export function compare(
  product: OwnProduct,
  rival: { observation?: PriceObservation | null; status?: string | null; availability?: string },
  links: CompetitorLink[],
  options: {
    compareCatalog?: boolean
    now?: number
    maxAgeHours?: number
    fx?: FxQuote | null
  } = {},
): ComparisonResult {
  const fx = options.fx === undefined ? comparisonFx(product,[rival]) : options.fx
  const { reference, observation: own } = referencePrice(
    {...product,fx_quote:fx}, options.compareCatalog,
  )
  const raw = rival.observation ?? null
  const observation = raw ? {...raw,...observe(raw.amount,raw.currency,raw.observedAt,raw.source,fx)} : null
  const applicable = linksForProduct(links, product)
  const enabled = applicable.filter((link) => !link.paused)
  const accepted = enabled.filter((link) => link.equivalence === 'accepted')
  const reasons: ComparisonStatus[] = []
  if (!applicable.length || !enabled.length) reasons.push('paused')
  else if (!accepted.length) reasons.push('review')
  if (observation?.state !== 'no_external_offers' && (rival.availability === 'unavailable' || (rival.status && rival.status !== 'active'))) reasons.push('inactive')
  if (observation?.state === 'no_external_offers')
    reasons.push('no_external_offers')
  if (!positive(own.amount) || !positive(observation?.amount))
    reasons.push('no_price')
  if (
    (positive(own.amount) && !positive(own.normalizedAmount)) ||
    (positive(observation?.amount) && !positive(observation?.normalizedAmount))
  )
    reasons.push('no_conversion')
  const valid = !reasons.length
  const deltaAmount = valid
    ? own.normalizedAmount! - observation!.normalizedAmount!
    : null
  const deltaPct =
    deltaAmount == null ? null : (deltaAmount / own.normalizedAmount!) * 100
  return {
    maxAgeHours: null,
    evaluatedAt: new Date(options.now ?? Date.now()).toISOString(),
    status: reasons[0] ?? 'comparable',
    reasons,
    own,
    rival: observation,
    deltaPct,
    deltaAmount,
    meaning:
      deltaAmount == null
        ? null
        : deltaAmount > 0
          ? 'disadvantage'
          : deltaAmount < 0
            ? 'advantage'
            : 'tie',
    basis: 'price_only',
    reference,
    associationIds: accepted.map((link) => link.id),
  }
}
export function comparisonText(result: ComparisonResult) {
  if (result.status !== 'comparable') return QUALITY_LABELS[result.status]
  if (result.meaning === 'tie') return 'Empate de precio'
  const percentage =
    Math.abs(result.deltaPct!) < 0.005
      ? 'menos de 0,01'
      : Math.abs(result.deltaPct!).toLocaleString('es-UY', {
          maximumFractionDigits: 2,
        })
  return `Rival ${percentage} % más ${result.meaning === 'disadvantage' ? 'barato' : 'caro'} que tu precio · ${result.meaning === 'disadvantage' ? 'Desventaja' : 'Ventaja'}`
}
export function ruleFires(
  rule: { rule_type: string; threshold_pct: number | null },
  result: ComparisonResult,
  previous: PriceObservation | null = null,
) {
  if (result.status !== 'comparable') return false
  if (rule.rule_type === 'price_changed')
    return (
      !!previous &&
      positive(previous.amount) &&
      positive(result.rival?.normalizedAmount) &&
      positive(result.rival?.amount) &&
      (previous.currency !== result.rival?.currency || previous.amount !== result.rival?.amount) &&
      !result.reasons.some((reason) =>
        ['review', 'paused', 'inactive', 'no_external_offers'].includes(reason),
      )
    )
  switch (rule.rule_type) {
    case 'competitor_cheaper':
      return result.deltaAmount! > 0
    case 'competitor_pricier':
      return result.deltaAmount! < 0
    case 'price_diff_pct_above':
      return (
        rule.threshold_pct != null && result.deltaPct! >= rule.threshold_pct
      )
    case 'price_diff_pct_below':
      return (
        rule.threshold_pct != null && result.deltaPct! <= -rule.threshold_pct
      )
    default:
      return false
  }
}

/** Keep historical evidence separate from a current, non-comparable observation. */
export function retainLastPricedObservation(current: PriceObservation, previous: PriceObservation | null): PriceObservation {
  if(current.state !== 'no_external_offers' || !previous) return current
  const {lastPricedObservation, ...priced} = previous
  const last = positive(previous.amount) ? priced : lastPricedObservation
  return last ? {...current,lastPricedObservation:last} : current
}
