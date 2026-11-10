import { startSync } from '@/lib/manual-sync-server'
import { withMonitorAuth } from '@/lib/monitoring/server'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// POST enqueues the authoritative prices refresh; GET reads confirmed persisted values.
async function GETImpl(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const { data, error } = await createAdminClient()
    .schema('ml')
    .from('ml_products')
    .select(
      'price,sale_price,catalog_price,catalog_item_id,catalog_currency_id,catalog_observed_at,catalog_observation,catalog_competition,fx_quote,currency_id,synced_at,buybox_price,buybox_seller_id,descriptions',
    )
    .eq('id', id)
    .single()

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? 'Producto no encontrado' },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    id,
    ...data,
  })
}

export const GET = withMonitorAuth(GETImpl)
export const POST = withMonitorAuth(async(req:NextRequest)=>NextResponse.json(await startSync('product','sync-product',req.nextUrl.searchParams.get('id')),{status:202}))
