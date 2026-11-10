import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { ApiError } from '@/lib/monitoring/server'
import type { AlertEvent } from '@monitoring/alert-events'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function alertId(id:string) { if(!uuid.test(id))throw new ApiError(400,'Identificador inválido'); return id.toLowerCase() }
export function alertFilters(params:URLSearchParams) {
  const scope=params.get('scope') ?? 'inbox', read=params.get('read') ?? (params.get('unread')==='true'?'unread':'all')
  if(!['inbox','history'].includes(scope)||!['all','read','unread'].includes(read))throw new ApiError(400,'Filtro inválido')
  const from=params.get('from'), to=params.get('to'), sku=params.get('sku') ?? '', seller=params.get('seller') ?? '', rule=params.get('rule') ?? ''
  for(const date of [from,to])if(date && (!date.includes('T') || !Number.isFinite(Date.parse(date)) || !/(Z|[+-]\d\d:\d\d)$/.test(date)))throw new ApiError(400,'Fecha inválida')
  if(from&&to&&Date.parse(from)>=Date.parse(to))throw new ApiError(400,'El inicio debe ser anterior al final')
  if(sku.length>255||seller.length>300||(rule&&!uuid.test(rule)))throw new ApiError(400,'Filtro inválido')
  return {scope,read,from,to,sku,seller,rule:rule.toLowerCase()}
}
export async function loadAlertPage(params=new URLSearchParams()) {
  let date:string|null=null, id:string|null=null
  if(params.get('cursor')){
    try {
      const cursor=JSON.parse(Buffer.from(params.get('cursor')!,'base64url').toString())
      if(!Array.isArray(cursor)||cursor.length!==2||typeof cursor[0]!=='string'||typeof cursor[1]!=='string'||!Number.isFinite(Date.parse(cursor[0]))||!uuid.test(cursor[1]))throw new Error()
      ;[date,id]=cursor
    } catch {throw new ApiError(400,'Cursor inválido')}
  }
  const numbered = params.has('page')
  const page = Number(params.get('page') ?? 1)
  if (numbered && (!Number.isSafeInteger(page) || page < 1 || page > 100000)) throw new ApiError(400, 'Página inválida')
  if (numbered && params.get('cursor')) throw new ApiError(400, 'Usá página o cursor, no ambos')
  const {data,error}=numbered
    ? await createAdminClient().schema('ml').rpc('list_monitor_alerts_page',{p_filters:alertFilters(params),p_page:page})
    : await createAdminClient().schema('ml').rpc('list_monitor_alerts',{p_filters:alertFilters(params),p_cursor_date:date,p_cursor_id:id})
  if(error)throw error
  const rows=data.items as AlertEvent[], items=rows.slice(0,50), last=items.at(-1)
  return {...data,items,...(numbered?{page}:{}),nextCursor:rows.length>50&&last?Buffer.from(JSON.stringify([last.fired_at,last.id])).toString('base64url'):null}
}
export async function alertActor() {
  const {data:{user},error}=await (await createClient()).auth.getUser()
  if(error||!user)throw new ApiError(401,'Iniciá sesión para continuar')
  return user.id
}
export async function bulkAlertAction(action:'read'|'archive_read',params:URLSearchParams) {
  const {data,error}=await createAdminClient().schema('ml').rpc('mutate_monitor_alerts',{
    p_action:action,p_filters:alertFilters(params),p_actor:await alertActor(),p_batch:crypto.randomUUID(),
  })
  if(error)throw error
  return data
}
