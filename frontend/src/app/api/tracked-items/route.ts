import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  ApiError,
  readBody,
  resolveObservation,
  withMonitorAuth,
} from '@/lib/monitoring/server'
import { enrichTracked } from '@monitoring/monitor-service'
import { trackingSnapshot } from '@monitoring/ml-observation'
export const GET = withMonitorAuth(async () =>
  NextResponse.json(await enrichTracked(createAdminClient())),
)
export const POST = withMonitorAuth(async (req: NextRequest) => {
  const body = await readBody(req)
  if (typeof body.url !== 'string') throw new ApiError(400, 'Pegá una URL o ID')
  const value = await resolveObservation(
    body.url,
    body.targetKind as string | undefined,
    body.fixedItemId as string | undefined,
  )
  const admin = createAdminClient()
  const { data, error } = await admin.schema('ml').rpc('save_tracking', {
    p_item: {
      target_kind: value.target.kind,
          source_kind:value.observation.sourceKind,source_id:value.observation.resolution?.sourceId,source_url:value.observation.sourceUrl,
      target_id: value.target.id,
      url: value.permalink,
      title: value.title,
      thumbnail: value.thumbnail,
      seller_id: value.observation.sellerId,
      seller_name: value.observation.sellerName,
      our_sku: typeof body.ourSku === 'string' ? body.ourSku : null,
    },
    p_snapshot: trackingSnapshot(value),
  })
  if (error)
    throw new ApiError(
      error.code === '23505' ? 409 : 500,
      error.code === '23505'
        ? 'Este objeto ya está en seguimiento'
        : 'No se pudo guardar el seguimiento',
    )
  const [item] = await enrichTracked(admin, data.id)
  return NextResponse.json({ ok: true, item, reactivated: data.reactivated })
})
