import { withMonitorAuth } from '@/lib/monitoring/server'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

// POST /api/sync-product?id=MLU640834497
//
// A single-product refresh must use the same ML Edge Function as the scheduled
// sync. That function reads /items/{id}/prices, which is the authoritative
// source for a current promotion and clears promotions that no longer apply.
async function POSTImpl(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const key = process.env.SUPABASE_SECRET_KEY
  if (!key)
    return NextResponse.json(
      { error: 'missing SUPABASE_SECRET_KEY' },
      { status: 500 },
    )

  const syncResponse = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/ml-sync`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        'x-sync-secret': key,
        ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ ids: [id] }),
      cache: 'no-store',
    },
  )

  if (!syncResponse.ok) {
    const body = await syncResponse.text()
    return NextResponse.json(
      { error: `ML sync failed (${syncResponse.status}): ${body}` },
      { status: 502 },
    )
  }

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

export const POST = withMonitorAuth(POSTImpl)
