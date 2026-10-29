import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { productSkuOptions, resolvePublicationAlerts, type AlertRow, type AlertRule, type ProductPriceRow } from '@/lib/price-alerts'
import AlertasLayout from './AlertasLayout'

export const dynamic = 'force-dynamic'

export default async function AlertasPage() {
  const admin = createAdminClient()

  let data: [AlertRule[], AlertRow[], ProductPriceRow[]]
  try {
    data = await Promise.all([
      fetchAllRows<AlertRule>('las reglas', (from, to) => admin
        .schema('ml').from('ml_price_alert_rules')
        .select('*, ml_price_alerts(count)')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)),
      fetchAllRows<AlertRow>('las alertas', (from, to) => admin
        .schema('ml').from('ml_price_alerts')
        .select(`
          id, our_sku, competitor_item_id,
          our_price, catalog_price, competitor_price_before, competitor_price_after,
          diff_pct, fired_at, read_at,
          ml_price_alert_rules ( id, name, rule_type, threshold_pct, compare_catalog_price ),
          ml_competitor_items ( our_sku, title, seller_name, thumbnail, price, paused, status, our_product_id )
        `)
        .order('fired_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
        .returns<AlertRow[]>()),
      fetchAllRows<ProductPriceRow>('los productos', (from, to) => admin
        .schema('ml').from('ml_products')
        .select('id, sku, title, status, price, sale_price, catalog_price, synced_at')
        .order('id')
        .range(from, to)),
    ])

  } catch (error) {
    console.error('[alertas]', error)
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Alertas de precio</h1>
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error instanceof Error ? error.message : 'No se pudieron cargar las alertas de precio.'}
        </div>
      </div>
    )
  }
  const [rules, alerts, products] = data
  return <AlertasLayout rules={rules} initialAlerts={resolvePublicationAlerts(alerts, products)} skus={productSkuOptions(products)} />
}
