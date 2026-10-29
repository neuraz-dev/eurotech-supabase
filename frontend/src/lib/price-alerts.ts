import { indexProducts, resolveCompetitorProducts } from './product-ownership.ts'
import { skuKey } from './sku.ts'

export type RuleType = 'price_changed' | 'competitor_cheaper' | 'competitor_pricier'
  | 'price_diff_pct_above' | 'price_diff_pct_below'

export type AlertRule = {
  id: string
  name: string
  rule_type: RuleType
  sku: string | null
  threshold_pct: number | null
  compare_catalog_price: boolean
  enabled: boolean
  created_at: string
  ml_price_alerts: [{ count: number }] | []
}

export type ProductPriceRow = {
  id: string
  sku: string | null
  title: string | null
  status: string | null
  price: number | null
  sale_price: number | null
  catalog_price: number | null
  synced_at: string | null
}

export type AlertRow = {
  id: string
  our_sku: string
  competitor_item_id: string
  our_price: number | null
  catalog_price: number | null
  competitor_price_before: number | null
  competitor_price_after: number | null
  diff_pct: number | null
  fired_at: string
  read_at: string | null
  ml_price_alert_rules: Pick<AlertRule, 'id' | 'name' | 'rule_type' | 'threshold_pct' | 'compare_catalog_price'> | null
  ml_competitor_items: {
    our_product_id: string | null
    our_sku: string
    title: string | null
    seller_name: string | null
    thumbnail: string | null
    price: number | null
    paused: boolean | null
    status: string | null
  } | null
}

export type PublicationAlert = AlertRow & {
  row_key: string
  owner_product_id: string
  owner_sku: string | null
  owner_title: string
  owner_status: string | null
}

function currentAlert(alert: AlertRow, product: ProductPriceRow): AlertRow | null {
  const rule = alert.ml_price_alert_rules
  const competitor = alert.ml_competitor_items
  if (!rule || !competitor || competitor.paused || ['paused', 'closed'].includes(competitor.status ?? '')) return null
  const competitorPrice = competitor.price ?? alert.competitor_price_after
  if (competitorPrice == null) return null
  const ourPrice = product.sale_price
    ?? (rule.compare_catalog_price !== false ? product.catalog_price : null)
    ?? product.price
  const diff = ourPrice != null && ourPrice !== 0
    ? Number((((ourPrice - competitorPrice) / ourPrice) * 100).toFixed(2))
    : null
  let current = false
  switch (rule.rule_type) {
    case 'price_changed': current = true; break
    case 'competitor_cheaper': current = ourPrice != null && competitorPrice < ourPrice; break
    case 'competitor_pricier': current = ourPrice != null && competitorPrice > ourPrice; break
    case 'price_diff_pct_above': current = diff != null && rule.threshold_pct != null && diff >= rule.threshold_pct; break
    case 'price_diff_pct_below': current = diff != null && rule.threshold_pct != null && diff <= -rule.threshold_pct; break
  }
  return current ? { ...alert, our_price: ourPrice, catalog_price: product.catalog_price, competitor_price_after: competitorPrice, diff_pct: diff } : null
}

// Input must be ordered by fired_at DESC, id DESC, as in the database query.
export function resolvePublicationAlerts(alerts: AlertRow[], products: ProductPriceRow[]): PublicationAlert[] {
  const index = indexProducts(products)
  const selected = new Map<string, PublicationAlert>()
  for (const alert of alerts) {
    if (!alert.ml_competitor_items) continue
    for (const product of resolveCompetitorProducts(alert.ml_competitor_items, index)) {
      if (selected.has(product.id)) continue
      const current = currentAlert(alert, product)
      if (!current) continue
      selected.set(product.id, {
        ...current,
        row_key: `${product.id}:${alert.id}`,
        owner_product_id: product.id,
        owner_sku: product.sku,
        owner_title: product.title ?? product.id,
        owner_status: product.status,
      })
    }
  }
  return [...selected.values()]
}

export function productSkuOptions(products: ProductPriceRow[]) {
  const options = new Map<string, { sku: string; title: string }>()
  const sorted = [...products].sort((a, b) => (b.synced_at ?? '').localeCompare(a.synced_at ?? '') || a.id.localeCompare(b.id))
  for (const product of sorted) {
    const key = skuKey(product.sku)
    if (key && product.sku && !options.has(key)) options.set(key, { sku: product.sku.trim(), title: product.title ?? product.id })
  }
  return [...options.values()].sort((a, b) => a.sku.localeCompare(b.sku, 'es'))
}

export type AlertFilters = { read: 'all' | 'unread'; sku: string; rule: string; competitor: string; status: 'all' | 'active' }

export function competitorName(alert: AlertRow) {
  return alert.ml_competitor_items?.seller_name?.trim() || alert.ml_competitor_items?.title?.trim() || ''
}

export function filterPublicationAlerts(alerts: PublicationAlert[], filters: AlertFilters) {
  return alerts.filter(alert =>
    (filters.read !== 'unread' || !alert.read_at)
    && (!filters.sku || skuKey(alert.owner_sku) === skuKey(filters.sku))
    && (!filters.rule || alert.ml_price_alert_rules?.id === filters.rule)
    && (!filters.competitor || competitorName(alert) === filters.competitor)
    && (filters.status !== 'active' || alert.owner_status === 'active'))
}

export function updateAlertReadAt(alerts: PublicationAlert[], ids: Set<string>, readAt: string) {
  return alerts.map(alert => ids.has(alert.id) ? { ...alert, read_at: readAt } : alert)
}

export function removeAlerts(alerts: PublicationAlert[], ids: Set<string>) {
  return alerts.filter(alert => !ids.has(alert.id))
}
