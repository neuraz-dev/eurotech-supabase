import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAllRows } from '@/lib/fetch-all-rows'
import { indexProducts, resolveCompetitorProducts } from '@/lib/product-ownership'
import { skuKey } from '@/lib/sku'

const PRODUCT_SELECT = 'id, title, sku, price, sale_price, catalog_price, buybox_price, status, thumbnail, permalink, currency_id, available_quantity, pictures, synced_at'
const COMPETITOR_SELECT = 'id, our_sku, our_product_id, title, price, currency_id, usd_price, thumbnail, permalink, seller_name, status, paused'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sku: string }> },
) {
  const { sku: ownerLookup } = await params
  const admin = createAdminClient()

  try {
    const byId = await admin.schema('ml').from('ml_products')
      .select(PRODUCT_SELECT).eq('id', ownerLookup).maybeSingle()
    if (byId.error) throw new Error(byId.error.message)
    let product = byId.data

    if (!product) {
      // Normalize locally: ilike treats %/_ as wildcards and does not trim stored SKUs.
      const products = await fetchAllRows('los productos', (from, to) => admin
        .schema('ml').from('ml_products').select(PRODUCT_SELECT).order('id').range(from, to))
      const key = skuKey(ownerLookup)
      const matches = key ? products.filter(p => skuKey(p.sku) === key) : []
      matches.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active')
        || (b.synced_at ?? '').localeCompare(a.synced_at ?? '') || a.id.localeCompare(b.id))
      product = matches[0] ?? null
    }

    if (!product) return NextResponse.json({ product: null, competitors: [] })

    const productId = product.id as string
    const competitors = await fetchAllRows('los rivales', (from, to) => admin
      .schema('ml').from('ml_competitor_items').select(COMPETITOR_SELECT)
      .or(`our_product_id.is.null,our_product_id.eq.${productId}`)
      .order('id').range(from, to))
    const index = indexProducts([{ id: productId, sku: product.sku as string | null }])
    return NextResponse.json({
      product,
      competitors: competitors.filter(c => resolveCompetitorProducts(c, index).length > 0),
    })
  } catch (error) {
    console.error('[product-panel]', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'No se pudo cargar la publicación.' }, { status: 500 })
  }
}
