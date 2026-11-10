import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { withMonitorAuth } from '@/lib/monitoring/server'
import { syncCatalog } from '@monitoring/catalog-service'

const ML_API = process.env.ML_API_BASE_URL ?? 'https://api.mercadolibre.com'

async function getMlToken(admin: ReturnType<typeof createAdminClient>) {
  const { data } = await admin
    .schema('ml')
    .from('ml_tokens')
    .select('access_token, user_id')
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data
}

async function POSTImpl() {
  const admin = createAdminClient()
  const tokenRow = await getMlToken(admin)
  if (!tokenRow)
    return NextResponse.json({ error: 'No token' }, { status: 500 })

  const { access_token, user_id } = tokenRow
  const headers = { Authorization: `Bearer ${access_token}` }

  const catalogResult = await syncCatalog(admin, {
    token: access_token,
    sellerId: Number(user_id),
    apiUrl: process.env.ML_API_BASE_URL,
    fxUrl: process.env.MONITOR_FX_URL,
  })

  // ── 2. Category names ─────────────────────────────────────────────────────
  const { data: allProducts } = await admin
    .schema('ml')
    .from('ml_products')
    .select('category_id')

  const categoryIds = [
    ...new Set((allProducts ?? []).map((p) => p.category_id).filter(Boolean)),
  ] as string[]

  const categoryRows: { id: string; name: string; full_path: string }[] = []

  await Promise.all(
    categoryIds.map(async (catId) => {
      try {
        const res = await fetch(`${ML_API}/categories/${catId}`, { headers })
        if (!res.ok) return
        const data = await res.json()
        if (data.name) {
          const pathParts: string[] = (data.path_from_root ?? []).map(
            (p: { name: string }) => p.name,
          )
          // Remove generic top-level nodes, keep last 2-3 meaningful segments
          const meaningfulPath = pathParts.filter(
            (p: string) =>
              ![
                'Uruguay',
                'Accesorios para Vehículos',
                'Herramientas',
              ].includes(p),
          )
          const full_path = meaningfulPath.join(' › ') || pathParts.join(' › ')
          categoryRows.push({ id: catId, name: data.name, full_path })
        }
      } catch {
        /* skip */
      }
    }),
  )

  if (categoryRows.length > 0) {
    await admin.schema('ml').from('ml_categories').upsert(categoryRows)
  }

  return NextResponse.json({
    ok: true,
    ...catalogResult,
    categories_synced: categoryRows.length,
  })
}

export const POST = withMonitorAuth(POSTImpl)
