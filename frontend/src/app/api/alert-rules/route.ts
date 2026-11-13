import { withMonitorAuth } from '@/lib/monitoring/server'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

async function GETImpl() {
  const admin = createAdminClient()
  const { data, error } = await admin
    .schema('ml')
    .from('ml_price_alert_rules')
    .select('*, ml_price_alerts(count)')
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

async function POSTImpl(req: NextRequest) {
  const body = await req.json()
  const { name, rule_type, sku, threshold_pct, compare_catalog_price } = body

  if (
    typeof name !== 'string' ||
    !name.trim() ||
    ![
      'price_changed',
      'competitor_cheaper',
      'competitor_pricier',
      'price_diff_pct_above',
      'price_diff_pct_below',
    ].includes(rule_type)
  ) {
    return NextResponse.json(
      { error: 'name y rule_type son requeridos' },
      { status: 400 },
    )
  }

  const needsThreshold = [
    'price_diff_pct_above',
    'price_diff_pct_below',
  ].includes(rule_type)
  if (
    needsThreshold &&
    (threshold_pct == null ||
      !Number.isFinite(Number(threshold_pct)) ||
      Number(threshold_pct) < 0)
  ) {
    return NextResponse.json(
      { error: 'threshold_pct es requerido para este tipo de regla' },
      { status: 400 },
    )
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .schema('ml')
    .from('ml_price_alert_rules')
    .insert({
      name: name.trim(),
      rule_type,
      sku: sku || null,
      threshold_pct: needsThreshold ? Number(threshold_pct) : null,
      compare_catalog_price: compare_catalog_price !== false,
      enabled: true,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export const GET = withMonitorAuth(GETImpl)
export const POST = withMonitorAuth(POSTImpl)
