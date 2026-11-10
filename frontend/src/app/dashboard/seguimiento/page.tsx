import { createAdminClient } from '@/lib/supabase/admin'
import TrackingSection from './TrackingSection'
import { skuKey } from '@/lib/sku'
import { enrichTracked } from '@monitoring/monitor-service'

export const dynamic = 'force-dynamic'

export default async function SeguimientoPage() {
  const admin = createAdminClient()

  const [itemsRes, skusRes] = await Promise.all([
    enrichTracked(admin),

    admin
      .schema('ml')
      .from('ml_products')
      .select('sku, title, thumbnail, price, catalog_price, currency_id')
      .not('sku', 'is', null)
      .not('status', 'in', '("paused","closed")')
      .order('title'),
  ])

  const items = itemsRes
  const skuMap = new Map<
    string,
    {
      sku: string
      title: string
      thumbnail: string | null
      price: number | null
      catalog_price: number | null
      currency_id: string | null
    }
  >()
  for (const p of skusRes.data ?? []) {
    const key = skuKey(p.sku as string | null)
    if (!key || skuMap.has(key)) continue
    skuMap.set(key, {
      sku: p.sku as string,
      title: p.title,
      thumbnail: p.thumbnail,
      price: p.price,
      catalog_price: p.catalog_price,
      currency_id: p.currency_id,
    })
  }
  const skus = Array.from(skuMap.values())

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Seguimiento</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            Historial de precio, stock y ventas de productos bajo seguimiento
          </p>
        </div>
      </div>
      <TrackingSection
        initialItems={
          items as Parameters<typeof TrackingSection>[0]['initialItems']
        }
        skus={skus}
      />
    </div>
  )
}
