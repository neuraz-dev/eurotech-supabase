import { NextRequest, NextResponse } from 'next/server'
import { readBody, withMonitorAuth } from '@/lib/monitoring/server'
import { listSyncRuns, startSync } from '@/lib/manual-sync-server'
import type { ManualSyncAction } from '@/lib/manual-sync'
export const GET = withMonitorAuth(async (req: NextRequest) =>
  NextResponse.json(await listSyncRuns(req.nextUrl.searchParams))
)
export const POST = withMonitorAuth(async (req: NextRequest) => {
  const body = await readBody(req)
  return NextResponse.json(
    await startSync(
      String(body.action) as ManualSyncAction,
      typeof body.origin === 'string' ? body.origin : 'manual',
      typeof body.targetId === 'string' ? body.targetId : null,
      typeof body.requestKey === 'string' ? body.requestKey : undefined,
    ),
    { status: 202 },
  )
})
