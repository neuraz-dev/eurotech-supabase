import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import {
  ApiError,
  affectedProducts,
  readBody,
  resolveObservation,
  withMonitorAuth,
  loadCompetitors,
} from '@/lib/monitoring/server'
import { competitorRecord, parseTarget } from '@monitoring/ml-observation'

export const GET = withMonitorAuth(async () =>
  NextResponse.json(await loadCompetitors()),
)
export const POST = withMonitorAuth(async (req: NextRequest) => {
  const body = await readBody(req)
  const input = typeof body.itemIdOrUrl === 'string' ? body.itemIdOrUrl : ''
  const scope = body.linkMode === 'sku' ? 'sku' : 'publication'
  const ownId = typeof body.ourProductId === 'string' ? body.ourProductId : null
  const sku = typeof body.ourSku === 'string' ? body.ourSku : null
  await affectedProducts(scope, ownId, sku)
  let record: Record<string, unknown>
  try {
    record = competitorRecord(
      await resolveObservation(
        input,
        body.targetKind as string | undefined,
        body.fixedItemId as string | undefined,
      ),
    )
  } catch (error) {
    if (error instanceof ApiError) throw error
    const target = parseTarget(input)
    if (
      target.kind !== 'item' ||
      !(error instanceof Error) ||
      !/Mercado Libre HTTP (403|404)/.test(error.message)
    )
      throw error
    record = {
      id: target.id,
      target_kind: 'item',
      title: null,
      price: null,
      currency_id: null,
      observation: null,
      synced_at: null,
      permalink: input.startsWith('http') ? input : null,
      status: null,
    }
  }
  const admin = createAdminClient()
  const { data, error } = await admin.schema('ml').rpc('link_competitor', {
    p_item: record,
    p_scope: scope,
    p_target: scope === 'sku' ? sku : ownId,
  })
  if (error) throw error
  const item = (await loadCompetitors(admin)).find(
    (item) => item.id === data.item.id,
  )
  if (!item) throw new Error('No se pudo recuperar el rival persistido')
  return NextResponse.json({ ok: true, item, association: data.association })
})
export const PATCH = withMonitorAuth(async (req: NextRequest) => {
  const body = await readBody(req)
  if (typeof body.associationId !== 'string')
    throw new ApiError(400, 'Falta associationId')
  const changes: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (typeof body.paused === 'boolean') changes.paused = body.paused
  if (body.restore === true) changes.removed_at = null
  if (['pending', 'accepted', 'rejected'].includes(String(body.equivalence))) {
    changes.equivalence = body.equivalence
    changes.review_source = 'manual_review'
    changes.reviewed_at = new Date().toISOString()
    changes.reviewed_by = (
      await (await createClient()).auth.getUser()
    ).data.user!.id
  }
  if (Object.keys(changes).length === 1)
    throw new ApiError(400, 'No hay cambios válidos')
  const { data, error } = await createAdminClient()
    .schema('ml')
    .from('ml_competitor_links')
    .update(changes)
    .eq('id', body.associationId)
    .select()
    .maybeSingle()
  if (error) throw error
  if (!data) throw new ApiError(404, 'La asociación ya no existe')
  return NextResponse.json({ ok: true, association: data })
})
export const DELETE = withMonitorAuth(async (req: NextRequest) => {
  const body = await readBody(req)
  if (typeof body.associationId !== 'string')
    throw new ApiError(400, 'Falta associationId')
  const { data, error } = await createAdminClient()
    .schema('ml')
    .from('ml_competitor_links')
    .update({
      removed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', body.associationId)
    .select()
    .maybeSingle()
  if (error) throw error
  if (!data) throw new ApiError(404, 'La asociación ya no existe')
  return NextResponse.json({ ok: true, association: data })
})
