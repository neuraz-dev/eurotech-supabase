import { NextRequest, NextResponse } from 'next/server'
import {
  ApiError,
  affectedProducts,
  resolveObservation,
  withMonitorAuth,
} from '@/lib/monitoring/server'
import { parseTarget } from '@monitoring/ml-observation'
export const GET = withMonitorAuth(async (req: NextRequest) => {
  const p = req.nextUrl.searchParams
  const products = await affectedProducts(
    p.get('scope') ?? 'publication',
    p.get('productId'),
    p.get('sku'),
  )
  let observed = null
  try {
    observed = p.get('input')
      ? await resolveObservation(
          p.get('input')!,
          p.get('targetKind') ?? undefined,
          p.get('fixedItemId')??undefined,
        )
      : null
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (
      parseTarget(p.get('input') ?? '').kind !== 'item' ||
      !(error instanceof Error) ||
      !/Mercado Libre HTTP (403|404)/.test(error.message)
    )
      throw error
  }
  return NextResponse.json({
    products,
    count: products.length,
    includesFuture: p.get('scope') === 'sku',
    observed,
  })
})
