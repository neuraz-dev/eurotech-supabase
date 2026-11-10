import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { withMonitorAuth, ApiError, loadCompetitors, forProduct } from '@/lib/monitoring/server'
import { alertActor, alertId } from '@/lib/alert-server'
type Context={params:Promise<{id:string}>}
export const GET=withMonitorAuth(async(_req:NextRequest,{params}:Context)=>{
  const {id}=await params, admin=createAdminClient()
  const {data:item,error}=await admin.schema('ml').from('ml_price_alerts').select('*').eq('id',alertId(id)).maybeSingle()
  if(error)throw error
  if(!item)throw new ApiError(404,'No se encontró la alerta')
  const origins=await admin.schema('ml').from('ml_price_event_origins').select('rival_id,association_ids,detected_at').eq('alert_id',item.id)
  if(origins.error)throw origins.error
  item.event_origins=origins.data
  let current=null
  if(item.our_product_id){
    const result=await admin.schema('ml').from('ml_products').select('*').eq('id',item.our_product_id).maybeSingle()
    if(result.error)throw result.error
    if(result.data)current={product:result.data,competitors:forProduct(await loadCompetitors(admin),result.data)}
  }
  return NextResponse.json({item,current})
})
export const PATCH=withMonitorAuth(async(req:NextRequest,{params}:Context)=>{
  const {id}=await params, admin=createAdminClient()
  const raw=await req.text()
  let body:Record<string,unknown>={read:true}
  if(raw){
    try{body=JSON.parse(raw)}catch{throw new ApiError(400,'Solicitud inválida')}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError(400,'Solicitud inválida')
  }
  if(body.restore===true){
    const {data,error}=await admin.schema('ml').rpc('restore_monitor_alert',{p_id:alertId(id)})
    if(error)throw new ApiError(409,error.message)
    return NextResponse.json({ok:true,item:data})
  }
  if(typeof body.read!=='boolean')throw new ApiError(400,'Estado de lectura inválido')
  const {data,error}=await admin.schema('ml').from('ml_price_alerts')
    .update({read_at:body.read===false?null:new Date().toISOString()}).eq('id',alertId(id)).select().maybeSingle()
  if(error)throw error
  if(!data)throw new ApiError(404,'No se encontró la alerta')
  return NextResponse.json({ok:true,item:data})
})
export const DELETE=withMonitorAuth(async(_req:NextRequest,{params}:Context)=>{
  const {id}=await params, admin=createAdminClient()
  const {data,error}=await admin.schema('ml').from('ml_price_alerts')
    .update({archived_at:new Date().toISOString(),archive_reason:'manual',archived_by:await alertActor()})
    .eq('id',alertId(id)).is('archived_at',null).select().maybeSingle()
  if(error)throw error
  if(!data)throw new ApiError(409,'La alerta ya está archivada o no existe')
  return NextResponse.json({ok:true,item:data})
})
