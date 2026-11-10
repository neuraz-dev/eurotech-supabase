import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  ApiError,
  readBody,
  withMonitorAuth,
  resolveObservation,
} from '@/lib/monitoring/server'
import { enrichTracked } from '@monitoring/monitor-service'
import { trackingSnapshot } from '@monitoring/ml-observation'
type Context = { params: Promise<{ id: string }> }
async function save(id: string, changes: Record<string, unknown>) {
  const admin = createAdminClient()
  const { data, error } = await admin
    .schema('ml')
    .from('ml_tracked_items')
    .update(changes)
    .eq('id', id)
    .select('id')
    .maybeSingle()
  if (error) throw error
  if (!data) throw new ApiError(404, 'No se encontró el seguimiento')
  return NextResponse.json({
    ok: true,
    item: (await enrichTracked(admin, id))[0],
  })
}
export const PATCH = withMonitorAuth(
  async (req: NextRequest, { params }: Context) => {
    const body = await readBody(req)
    if (body.resolveIdentity === true) {
      const value = await resolveObservation(
        typeof body.url === 'string' ? body.url : '',
        String(body.targetKind),
        body.fixedItemId as string | undefined,
      )
      const admin = createAdminClient()
      const { data, error } = await admin.schema('ml').rpc('save_tracking', {
        p_item: {
          resolve_id: (await params).id,
          target_kind: value.target.kind,
          source_kind:value.observation.sourceKind,source_id:value.observation.resolution?.sourceId,source_url:value.observation.sourceUrl,
          target_id: value.target.id,
          url: value.permalink,
          title: value.title,
          thumbnail: value.thumbnail,
          seller_id: value.observation.sellerId,
          seller_name: value.observation.sellerName,
        },
        p_snapshot: trackingSnapshot(value),
      })
      if (error) throw error
      return NextResponse.json({
        ok: true,
        item: (await enrichTracked(admin, data.id))[0],
      })
    }
    const changes: Record<string, unknown> = {}
    if (typeof body.our_sku === 'string' || body.our_sku === null)
      changes.our_sku = body.our_sku
    if (typeof body.active === 'boolean') changes.active = body.active
    if (!Object.keys(changes).length)
      throw new ApiError(400, 'No hay cambios válidos')
    return save((await params).id, changes)
  },
)
export const DELETE = withMonitorAuth(
  async (_req: NextRequest, { params }: Context) =>
    save((await params).id, { active: false }),
)
