import { withMonitorAuth } from '@/lib/monitoring/server'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

async function GETImpl(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const admin = createAdminClient()
  const { data, error } = await admin
    .schema('ml')
    .from('ml_tracked_snapshots')
    .select('*')
    .eq('tracked_item_id', id)
    .order('scraped_at', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export const GET = withMonitorAuth(GETImpl)
