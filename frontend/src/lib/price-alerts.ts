import type { AlertEvent } from '../../../supabase/functions/_shared/alert-events.ts'
import {safeMarketplaceUrl} from '../../../supabase/functions/_shared/source-links.ts'
export { relativeLabel } from '../../../supabase/functions/_shared/alert-events.ts'
export type { AlertEvent, EventSnapshot, EventListRow } from '../../../supabase/functions/_shared/alert-events.ts'
export type AlertRule = {
  id:string; name:string; rule_type:string; sku:string|null; threshold_pct:number|null;
  compare_catalog_price:boolean; enabled:boolean; created_at:string; ml_price_alerts:[{count:number}]|[]
}
export type AlertPage = {
  items:AlertEvent[];nextCursor:string|null;
  counts:{all:number;read:number;unread:number;total:number;advantage:number;disadvantage:number;tie:number}
}
export type AlertOptions={skus:string[];sellers:string[];rules:{id:string;name:string}[]}
export function formatAlertDate(value:string,zone:string){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'numeric',day:'2-digit',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true}).formatToParts(new Date(value))
  const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(p=>p.type===type)?.value??''
  const month=['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'][Number(part('month'))-1]
  return `${month} ${part('day')}, ${part('year')} · ${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`
}
export const archiveLabels:Record<string,string>={
  manual:'Archivada por el operador',legacy_superseded:'Registro anterior',unidentified:'Publicación propia pendiente de identificación',
  own_missing:'La publicación propia ya no está disponible',own_inactive:'Publicación propia no activa',
  rival_missing:'El rival ya no está disponible',rival_unavailable:'Publicación rival no disponible',association_disabled:'Comparación suspendida o desvinculada',
}
export function dateBounds(from:string,to:string){
  const parse=(value:string)=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('Fecha inválida')
    const date=new Date(value+'T00:00:00')
    const [year,month,day]=value.split('-').map(Number)
    if(date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day)throw new Error('Fecha inválida')
    return date
  }
  const start=from?parse(from):null,end=to?parse(to):null
  if(start&&end&&start>end)throw new Error('Desde no puede ser posterior a Hasta')
  if(end)end.setDate(end.getDate()+1)
  return {from:start?.toISOString() ?? '',to:end?.toISOString() ?? ''}
}
export function marketplaceLink(value:string|null|undefined){
  return safeMarketplaceUrl(value)
}
