import { NextRequest, NextResponse } from 'next/server'
import type { CatalogPanel, CatalogSnapshot } from '@/lib/catalog'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  ApiError,
  forProduct,
  loadCompetitors,
  withMonitorAuth,
} from '@/lib/monitoring/server'
export const GET = withMonitorAuth(
  async (
    req: NextRequest,
    { params }: { params: Promise<{ sku: string }> },
  ) => {
    const { sku: id } = await params,
      admin = createAdminClient()
    const { data: product, error } = await admin
      .schema('ml')
      .from('ml_products')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!product) throw new ApiError(404, 'No se encontró la publicación')
    let compareCatalog = true
    const ruleId = req.nextUrl.searchParams.get('ruleId')
    if (ruleId) {
      const { data: rule, error } = await admin
        .schema('ml')
        .from('ml_price_alert_rules')
        .select('compare_catalog_price')
        .eq('id', ruleId)
        .maybeSingle()
      if (error) throw error
      if (!rule) throw new ApiError(404, 'No se encontró la regla')
      compareCatalog = rule.compare_catalog_price
    }
    let catalog: CatalogPanel = { status: 'not_applicable', catalogId: null, snapshot: null, lastAttemptAt: null, lastError: null }
    if (product.catalog_listing) {
      catalog = { ...catalog, status: 'pending', catalogId: product.catalog_product_id ?? null }
      if (catalog.catalogId) {
        const saved = await admin.schema('ml').from('ml_catalog_snapshots').select('*')
          .eq('catalog_product_id', catalog.catalogId).maybeSingle()
        if (saved.error) {
          catalog = { ...catalog, status: 'unavailable', lastError: 'No se pudieron cargar las ofertas del catálogo.' }
        } else if (saved.data) {
          catalog = { ...catalog, status: saved.data.snapshot ? 'ready' : saved.data.last_error ? 'unavailable' : 'pending',
            snapshot: saved.data.snapshot as CatalogSnapshot | null,
            lastAttemptAt: saved.data.last_attempt_at, lastError: saved.data.last_error }
        }
      }
    }
    return NextResponse.json({
      catalog,
      product,
      competitors: forProduct(await loadCompetitors(admin), product),
      compareCatalog,
    })
  },
)
