import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { withMonitorAuth, readBody, ApiError } from '@/lib/monitoring/server'
import { loadAlertPage, bulkAlertAction, alertActor, alertId } from '@/lib/alert-server'

export const GET=withMonitorAuth(async(req:NextRequest)=>{
  const params=new URLSearchParams(req.nextUrl.searchParams)
  if(params.get('impact')==='read'){
    params.set('scope','inbox');params.set('read','read');params.delete('cursor')
    const page=await loadAlertPage(params)
    return NextResponse.json({count:page.counts.total,scope:'Alertas leídas que coinciden con los filtros, en todas las páginas'})
  }
  return NextResponse.json(await loadAlertPage(params))
})
export const DELETE=withMonitorAuth(async(req:NextRequest)=>NextResponse.json(await bulkAlertAction('archive_read',req.nextUrl.searchParams)))
export const PATCH=withMonitorAuth(async(req:NextRequest)=>{
  const body=await readBody(req)
  if(body.action==='restore_batch'){
    const {data,error}=await createAdminClient().schema('ml').rpc('restore_monitor_alert_batch',{
      p_batch:alertId(String(body.batchId)),p_actor:await alertActor(),
    })
    if(error)throw error
    return NextResponse.json(data)
  }
  if(body.action!=='read')throw new ApiError(400,'Acción inválida')
  return NextResponse.json(await bulkAlertAction('read',req.nextUrl.searchParams))
})
