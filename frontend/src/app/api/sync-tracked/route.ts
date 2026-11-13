import { NextResponse } from 'next/server'
import { withMonitorAuth } from '@/lib/monitoring/server'
import { startSync } from '@/lib/manual-sync-server'
// Manual endpoints enqueue durable work. Scheduled Edge calls keep their existing contracts.
export const POST=withMonitorAuth(async()=>NextResponse.json(await startSync('tracked','sync-tracked'),{status:202}))
