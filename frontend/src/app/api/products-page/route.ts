import { withMonitorAuth } from '@/lib/monitoring/server'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

const PRODUCT_SELECT = `id, catalog_item_id, catalog_currency_id, catalog_observed_at, catalog_observation, catalog_competition, fx_quote, title, subtitle, sku, price, sale_price, catalog_price, buybox_price, buybox_seller_id, base_price, original_price, currency_id,
 available_quantity, sold_quantity, initial_quantity,
 status, condition, listing_type_id, buying_mode,
 thumbnail, permalink, category_id, domain_id,
 catalog_product_id, parent_item_id, family_id, family_name, user_product_id, inventory_id, seller_custom_field,
 warranty, health, automatic_relist, catalog_listing,
 date_created, last_updated, synced_at, start_time, stop_time`

async function GETImpl(req: NextRequest) {
  const from = Math.max(0, Number(req.nextUrl.searchParams.get('from') ?? '0'))
  const limit = Math.max(
    1,
    Math.min(1000, Number(req.nextUrl.searchParams.get('limit') ?? '250')),
  )
  const includeCount = req.nextUrl.searchParams.get('count') === 'true'

  const admin = createAdminClient()
  const { data, error, count } = await admin
    .schema('ml')
    .from('ml_products')
    .select(PRODUCT_SELECT, { count: includeCount ? 'exact' : undefined })
    .neq('status', 'closed')
    .neq('status', 'under_review')
    .order('last_updated', { ascending: false })
    .range(from, from + limit - 1)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    products: data ?? [],
    count: count ?? null,
    nextFrom: from + (data?.length ?? 0),
    hasMore: (data?.length ?? 0) === limit,
  })
}

export const GET = withMonitorAuth(GETImpl)
