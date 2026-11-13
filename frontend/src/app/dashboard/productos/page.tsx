import { createAdminClient } from '@/lib/supabase/admin'
import ProductsTable from './ProductsTable'
import SyncButton from './SyncButton'
import { loadCompetitors } from '@/lib/monitoring/server'

export const dynamic = 'force-dynamic'

type ProductsTableProps = Parameters<typeof ProductsTable>[0]

async function fetchInitialProducts(
  supabase: ReturnType<typeof createAdminClient>,
) {
  const pageSize = 200
  const { data, error, count } = await supabase
    .schema('ml')
    .from('ml_products')
    .select(
      `id, catalog_item_id, catalog_currency_id, catalog_observed_at, catalog_observation, catalog_competition, fx_quote, title, subtitle, sku, price, sale_price, catalog_price, buybox_price, buybox_seller_id, base_price, original_price, currency_id,
 available_quantity, sold_quantity, initial_quantity,
 status, condition, listing_type_id, buying_mode,
 thumbnail, permalink, category_id, domain_id,
 catalog_product_id, parent_item_id, family_id, family_name, user_product_id, inventory_id, seller_custom_field,
 warranty, health, automatic_relist, catalog_listing,
 date_created, last_updated, synced_at, start_time, stop_time`,
      { count: 'planned' },
    )
    .neq('status', 'closed')
    .neq('status', 'under_review')
    .order('last_updated', { ascending: false })
    .range(0, pageSize - 1)

  return { data: data ?? [], error, count: count ?? 0, pageSize }
}

export default async function ProductosPage() {
  const supabase = createAdminClient()

  const [
    productsResult,
    competitorsResult,
    categoriesResult,
    lastProductSyncResult,
    lastCompetitorSyncResult,
  ] = await Promise.all([
    fetchInitialProducts(supabase),
    loadCompetitors(supabase).then((data) => ({ data, error: null })),

    supabase.schema('ml').from('ml_categories').select('id, name, full_path'),

    supabase
      .schema('ml')
      .from('ml_products')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
      .single(),

    supabase
      .schema('ml')
      .from('ml_competitor_items')
      .select('synced_at')
      .order('synced_at', { ascending: false })
      .limit(1)
      .single(),
  ])

  const { data: products, error, count } = productsResult
  const competitors = competitorsResult.data
  const lastProductSync = lastProductSyncResult.data?.synced_at ?? null
  const lastCompetitorSync = lastCompetitorSyncResult.data?.synced_at ?? null
  const categoryMap: Record<string, string> = {}
  const categories = (categoriesResult.data ?? []) as {
    id: string
    name: string
    full_path: string | null
  }[]
  for (const c of categories) {
    categoryMap[c.id] = c.full_path ?? c.name
  }

  const competitorsBySku = { all: competitors }

  if (error) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Productos</h1>
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          Error al cargar productos: {error.message}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Productos</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {count ?? 0} publicaciones
          </p>
          <div className="flex items-center gap-4 mt-1.5">
            <span className="text-xs text-gray-400">
              Propios:{' '}
              <span className="text-gray-600 font-medium">
                {lastProductSync
                  ? new Intl.DateTimeFormat('es-UY', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(lastProductSync))
                  : 'Nunca'}
              </span>
            </span>
            <span className="text-gray-200 select-none">·</span>
            <span className="text-xs text-gray-400">
              Competencia:{' '}
              <span className="text-gray-600 font-medium">
                {lastCompetitorSync
                  ? new Intl.DateTimeFormat('es-UY', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(lastCompetitorSync))
                  : 'Nunca'}
              </span>
            </span>
          </div>
        </div>
        <SyncButton />
      </div>

      {!products || products.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
          No hay productos sincronizados aún.
        </div>
      ) : (
        <ProductsTable
          initialProducts={products as ProductsTableProps['initialProducts']}
          totalCount={count ?? products.length}
          competitorsBySku={
            competitorsBySku as ProductsTableProps['competitorsBySku']
          }
          categoryMap={categoryMap}
        />
      )}
    </div>
  )
}
