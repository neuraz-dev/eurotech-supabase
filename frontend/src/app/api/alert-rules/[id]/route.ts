import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ApiError, readBody, withMonitorAuth } from '@/lib/monitoring/server'
import { alertId } from '@/lib/alert-server'
type Context = { params: Promise<{ id: string }> }
export const GET = withMonitorAuth(
  async (_req: NextRequest, { params }: Context) => {
    const { count, error } = await createAdminClient()
      .schema('ml')
      .from('ml_price_alerts')
      .select('id', { count: 'exact', head: true })
      .contains('matched_rules', JSON.stringify([{id:alertId((await params).id)}]))
    if (error) throw error
    return NextResponse.json({
      count: count ?? 0,
      scope: 'Eventos vinculados a esta regla; sus datos se conservarán al eliminarla',
    })
  },
)
export const PATCH = withMonitorAuth(
  async (req: NextRequest, { params }: Context) => {
    const body = await readBody(req),
      changes: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      }
    if ('name' in body) {
      if (typeof body.name !== 'string' || !body.name.trim())
        throw new ApiError(400, 'Nombre inválido')
      changes.name = body.name.trim()
    }
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean')
        throw new ApiError(400, 'Estado inválido')
      changes.enabled = body.enabled
    }
    if ('compare_catalog_price' in body) {
      if (typeof body.compare_catalog_price !== 'boolean')
        throw new ApiError(400, 'Referencia inválida')
      changes.compare_catalog_price = body.compare_catalog_price
    }
    if ('rule_type' in body) {
      if (
        ![
          'price_changed',
          'competitor_cheaper',
          'competitor_pricier',
          'price_diff_pct_above',
          'price_diff_pct_below',
        ].includes(String(body.rule_type))
      )
        throw new ApiError(400, 'Tipo de regla inválido')
      changes.rule_type = body.rule_type
    }
    if ('sku' in body) {
      if (body.sku !== null && typeof body.sku !== 'string')
        throw new ApiError(400, 'SKU inválido')
      changes.sku =
        typeof body.sku === 'string' ? body.sku.trim() || null : null
    }
    if ('threshold_pct' in body) {
      if (
        body.threshold_pct !== null &&
        (typeof body.threshold_pct !== 'number' ||
          !Number.isFinite(body.threshold_pct) ||
          body.threshold_pct < 0)
      )
        throw new ApiError(400, 'Umbral inválido')
      changes.threshold_pct = body.threshold_pct
    }
    if (Object.keys(changes).length === 1)
      throw new ApiError(400, 'No hay cambios válidos')
    const { data, error } = await createAdminClient()
      .schema('ml')
      .from('ml_price_alert_rules')
      .update(changes)
      .eq('id', (await params).id)
      .select()
      .maybeSingle()
    if (error) throw error
    if (!data) throw new ApiError(404, 'La regla ya no existe')
    return NextResponse.json({ ok: true, item: data })
  },
)
export const DELETE = withMonitorAuth(
  async (_req: NextRequest, { params }: Context) => {
    const { data, error } = await createAdminClient()
      .schema('ml')
      .from('ml_price_alert_rules')
      .delete()
      .eq('id', (await params).id)
      .select('id')
      .maybeSingle()
    if (error) throw error
    if (!data) throw new ApiError(404, 'La regla ya no existe')
    return NextResponse.json({ ok: true, id: data.id })
  },
)
