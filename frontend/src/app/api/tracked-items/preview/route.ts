import { NextRequest, NextResponse } from 'next/server'
import { resolveObservation, withMonitorAuth } from '@/lib/monitoring/server'
export const GET = withMonitorAuth(async (req: NextRequest) =>
  NextResponse.json({
    observed: await resolveObservation(
      req.nextUrl.searchParams.get('input') ?? '',
      req.nextUrl.searchParams.get('targetKind') ?? undefined,
      req.nextUrl.searchParams.get('fixedItemId')??undefined,
    ),
  }),
)
