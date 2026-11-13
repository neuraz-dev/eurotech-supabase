import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  fetchFx,
  fetchTarget,
  parseTarget,
  type ObservedTarget,
} from '../../../../supabase/functions/_shared/ml-observation.ts'
import {
  allRows,
  type RivalRecord,
} from '../../../../supabase/functions/_shared/monitor-service.ts'
import { linksForProduct, normalizeSku, type CompetitorLink } from './index'

export { allRows }
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export function withMonitorAuth<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      const {
        data: { user },
        error,
      } = await (await createClient()).auth.getUser()
      if (error || !user)
        return NextResponse.json(
          { error: 'Iniciá sesión para continuar.' },
          { status: 401 },
        )
      return await handler(...args)
    } catch (error) {
      console.error(
        '[monitor]',
        error instanceof Error ? error.message : 'Error',
      )
      return NextResponse.json(
        {
          error:
            error instanceof ApiError
              ? error.message
              : 'No se pudo completar la operación. Volvé a intentarlo.',
        },
        { status: error instanceof ApiError ? error.status : 500 },
      )
    }
  }
}
export async function readBody(req: Request) {
  try {
    const body = await req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error()
    return body as Record<string, unknown>
  } catch {
    throw new ApiError(400, 'Solicitud inválida')
  }
}
export async function mlContext(admin = createAdminClient()) {
  const { data, error } = await admin
    .schema('ml')
    .from('ml_tokens')
    .select('access_token,user_id')
    .order('expires_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data?.access_token || !data.user_id)
    throw new ApiError(503, 'No hay una cuenta de Mercado Libre disponible')
  return {
    token: data.access_token as string,
    sellerId: Number(data.user_id),
    apiUrl: process.env.ML_API_BASE_URL,
  }
}
export async function resolveObservation(
  input: string,
  mode?: string,
  fixedItemId?: string,
): Promise<ObservedTarget> {
  let target
  try {
    target = parseTarget(input)
  } catch {
    throw new ApiError(400, 'URL o ID de Mercado Libre inválido')
  }
  const context = await mlContext()
  const fx = await fetchFx(fetch, process.env.MONITOR_FX_URL)
  if (target.kind === 'catalog' && mode !== 'catalog' && mode !== 'item')
    throw new ApiError(400, 'Elegí catálogo dinámico o publicación fija')
  const candidate=fixedItemId||target.itemId
  if(target.kind==='catalog'&&mode==='item'&&candidate){
    if(!/^ML[AU]\d+$/.test(candidate))throw new ApiError(400,'MLU candidata inválida')
    const fixed=await fetchTarget({kind:'item',id:candidate,catalogId:target.sourceKind==='catalog'?target.id:null},{...context,fx})
    if(target.sourceKind==='user_product'?fixed.observation.userProductId!==target.id:fixed.observation.catalogProductId!==target.id)
      throw new ApiError(422,'La MLU no pertenece al destino original')
    return fixed
  }
  const value = await fetchTarget({...target,itemId:candidate}, { ...context, fx })
  if (target.kind === 'catalog' && mode === 'item') {
    if (!value.observation.itemId)
      throw new ApiError(422, 'No se encontró una publicación rival para fijar')
    if (fixedItemId && fixedItemId !== value.observation.itemId)
      throw new ApiError(
        409,
        'Cambió la publicación observada. Revisá la previsualización nuevamente.',
      )
    return fetchTarget({kind:'item',id:value.observation.itemId,sourceKind:'item',sourceId:value.observation.itemId,catalogId:value.observation.catalogProductId,sellerId:value.observation.sellerId}, {...context,fx})
  }
  return value
}
export async function affectedProducts(
  scope: string,
  ownProductId: string | null,
  sku: string | null,
) {
  const admin = createAdminClient()
  if (scope === 'publication') {
    const { data, error } = await admin
      .schema('ml')
      .from('ml_products')
      .select('id,sku,title,status,catalog_listing')
      .eq('id', ownProductId ?? '')
      .maybeSingle()
    if (error) throw error
    if (!data) throw new ApiError(404, 'No se encontró la publicación propia')
    return [data]
  }
  if (scope !== 'sku' || !normalizeSku(sku))
    throw new ApiError(400, 'Seleccioná un SKU válido')
  const products = await allRows<{
    id: string
    sku: string | null
    title: string
    status: string | null
    catalog_listing: boolean | null
  }>(admin, 'ml_products', 'id,sku,title,status,catalog_listing')
  const matches = products.filter(
    (product) => normalizeSku(product.sku) === normalizeSku(sku),
  )
  if (!matches.length) throw new ApiError(404, 'No se encontró el SKU')
  return matches
}
export async function loadCompetitors(admin = createAdminClient()) {
  const [rivals, links, products] = await Promise.all([
    allRows<RivalRecord & Record<string, unknown>>(
      admin,
      'ml_competitor_items',
    ),
    allRows<CompetitorLink>(admin, 'ml_competitor_links'),
    allRows<{ id: string; sku: string | null }>(admin, 'ml_products', 'id,sku'),
  ])
  const ids = new Set(products.map((product) => product.id)),
    skus = new Set(
      products.map((product) => normalizeSku(product.sku)).filter(Boolean),
    )
  return rivals.map((rival) => ({
    ...rival,
    links: links
      .filter(
        (link) => link.competitor_item_id === rival.id && !link.removed_at,
      )
      .map((link) => ({
        ...link,
        orphaned:
          link.scope === 'publication'
            ? !ids.has(link.our_product_id ?? '')
            : !skus.has(normalizeSku(link.our_sku)),
      })),
  }))
}
export function forProduct<T extends { links: CompetitorLink[] }>(
  rivals: T[],
  product: { id: string; sku: string | null },
) {
  return rivals
    .map((rival) => ({
      ...rival,
      links: linksForProduct(rival.links, product),
    }))
    .filter((rival) => rival.links.length)
}
export async function invokeMonitor(
  functionName: 'ml-sync-competitor' | 'ml-scrape-tracked',
) {
  const key = process.env.SUPABASE_SECRET_KEY
  if (!key) throw new ApiError(503, 'Falta la credencial interna')
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/${functionName}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        'x-sync-secret': key,
        ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(120_000),
      cache: 'no-store',
    },
  )
  const data = await response.json()
  return NextResponse.json(data, { status: response.ok ? 200 : 502 })
}
