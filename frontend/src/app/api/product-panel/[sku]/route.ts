import { NextRequest, NextResponse } from 'next/server'
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
    return NextResponse.json({
      product,
      competitors: forProduct(await loadCompetitors(admin), product),
      compareCatalog,
    })
  },
)
