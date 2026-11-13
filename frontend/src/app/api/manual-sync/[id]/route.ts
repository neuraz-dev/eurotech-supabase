import { NextRequest, NextResponse } from 'next/server'
import { withMonitorAuth } from '@/lib/monitoring/server'
import { syncRunDetail } from '@/lib/manual-sync-server'
export const GET = withMonitorAuth(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) =>
  NextResponse.json(
    await syncRunDetail((await params).id, req.nextUrl.searchParams),
  )
)
