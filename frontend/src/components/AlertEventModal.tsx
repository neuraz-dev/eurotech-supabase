'use client'
import { useEffect, useState } from 'react'
import MonitorDialog from './MonitorDialog'
import SourceRecoveryPanel from './SourceRecoveryPanel'
import AlertTabs from './AlertTabs'
import ComparisonBoard, { type BoardRival } from './ComparisonBoard'
import { formatAlertDate, marketplaceLink, relativeLabel, type AlertEvent } from '@/lib/price-alerts'
import {observationLink} from '@monitoring/source-links'
import { QUALITY_LABELS, type ComparisonStatus, type OwnProduct } from '@/lib/monitoring'

const money=(value:unknown,currency='UYU')=>typeof value==='number'?new Intl.NumberFormat('es-UY',{style:'currency',currency}).format(value):'Sin dato'
const referenceLabel=(value:unknown)=>value==='sale'?'Oferta':value==='catalog'?'Catálogo de esta MLU':value==='list'?'Publicación':'No registrada'
function Observation({label,value,zone}:{label:string;value:unknown;zone:string}){
  if(!value||typeof value!=='object')return <p>{label}: sin evidencia registrada.</p>
  const data=value as Record<string,unknown>,fx=data.fx as Record<string,unknown>|null
  return <div className="rounded-lg border border-slate-200 p-3 text-sm">
    <h4 className="font-semibold">{label}</h4>
    <p>Precio original: {money(data.amount,typeof data.currency==='string'?data.currency:'UYU')}</p>
    <p>En UYU: {money(data.normalizedAmount)}</p>
    <p>Consulta: {typeof data.observedAt==='string'?new Date(data.observedAt).toLocaleString('es-UY',{timeZone:zone}):'Sin fecha'}</p>
    {fx&&<p>Cotización: {String(fx.rate)} · {String(fx.source)} · {typeof fx.fetchedAt==='string'?new Date(fx.fetchedAt).toLocaleString('es-UY',{timeZone:zone}):'Sin fecha'}</p>}
    {data.sellerName!=null&&<p>Vendedor: {String(data.sellerName)}</p>}
    {data.itemId!=null?<p>MLU observada: {String(data.itemId)}</p>:data.sourceKind==='user_product'?<p>Publicación no identificada</p>:null}
    {Array.isArray(data.warnings)&&data.warnings.map((warning,i)=><p key={i} className="text-amber-800">{String(warning)}</p>)}
    {data.state==='no_external_offers'&&<p>Sin ofertas observadas</p>}
    {data.lastPricedObservation!=null&&typeof data.lastPricedObservation==='object'&&<Observation label="Último precio observado (histórico)" value={data.lastPricedObservation} zone={zone}/>}
    {data.availabilityEvidence!=null&&<p>Consulta de ofertas: HTTP 404 · No winners found</p>}
    {data.offersConsulted!=null&&<p>Ofertas consultadas: {String(data.offersConsulted)} de {String(data.offersTotal??'total desconocido')} · Cobertura: {data.coverage==='complete'?'Completa':data.coverage==='partial'?'Parcial':'Desconocida'}</p>}
  </div>
}
function ProductEvidence({value}:{value:unknown}){
  if(!value||typeof value!=='object')return null
  const p=value as Record<string,unknown>
  const observation=p.observation as {state?:string}|null
  const attrs=Array.isArray(p.attributes)?p.attributes.filter(a=>a&&typeof a==='object') as {name?:string;id?:string;value_name?:string}[]:[]
  const states:Record<string,string>={active:'Activa',paused:'Pausada',closed:'Cerrada',inactive:'Inactiva',under_review:'En revisión'}
  const conditions:Record<string,string>={new:'Nuevo',used:'Usado',not_specified:'Sin especificar'}
  const shipping=p.shipping&&typeof p.shipping==='object'?p.shipping as Record<string,unknown>:null
  const competition=p.catalog_competition&&typeof p.catalog_competition==='object'?p.catalog_competition as Record<string,unknown>:null
  const competitionStates:Record<string,string>={winning:'Ganador verificado',sharing_first_place:'Primer lugar compartido verificado',competing:'No gana en la consulta',listed:'No compite en catálogo'}
  const description=(value:unknown):string=>typeof value==='string'?value:Array.isArray(value)?value.map(description).filter(Boolean).join('\n\n'):value&&typeof value==='object'?description((value as Record<string,unknown>).plain_text??(value as Record<string,unknown>).text):''
  return <div className="space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
    <p className="font-semibold">{String(p.title??p.id??'Producto')}</p>
    <p>MLU: {String(p.id??'Sin identificación')} · Estado: {states[String(p.status)]??'Sin dato fiable'} · Condición: {conditions[String(p.condition)]??'Sin dato fiable'}</p>
    {p.availability!=null&&<p>Disponibilidad: {observation?.state==='no_external_offers'?'Sin ofertas observadas':p.availability==='unavailable'?'No disponible confirmada':p.availability==='available'?'Disponible en la consulta':'Sin confirmar'}</p>}
    <p>Disponibles: {String(p.available_quantity??'Sin dato')} · Vendidos: {String(p.sold_quantity??'Sin dato')}</p>
    {p.catalog_competition!==undefined&&<p>Adjudicación: {competition?.source==='price_to_win'&&competition.itemId===p.id&&competition.observedAt?`${competitionStates[String(competition.state)]??'No verificado'} · ${String(competition.observedAt)}`:'No verificado'}</p>}
    {!!attrs.length&&<dl className="grid grid-cols-2 gap-x-3">{attrs.map((a,i)=><div key={i}><dt className="text-slate-500">{a.name??a.id}</dt><dd>{a.value_name??'Sin dato'}</dd></div>)}</dl>}
    {p.last_error!=null&&<p className="text-amber-800">Último error: {String(p.last_error)}</p>}
    {shipping&&<details><summary>Envío registrado</summary>
      <p>Envío gratis registrado: {shipping.free_shipping===true?'Sí':shipping.free_shipping===false?'No':'Sin dato'}</p>
      <p>Retiro en local registrado: {shipping.local_pick_up===true?'Sí':shipping.local_pick_up===false?'No':'Sin dato'}</p>
      <p className="text-xs text-slate-500">Estos datos no se incluyen en la comparación de precios.</p>
    </details>}
    {p.descriptions!=null&&<details><summary>Descripción registrada</summary><p className="whitespace-pre-wrap">{description(p.descriptions)||'Sin descripción legible registrada'}</p></details>}
  </div>
}
type Detail={item:AlertEvent;current:{product:OwnProduct;competitors:BoardRival[]}|null}
export default function AlertEventModal({id,zone,onClose}:{id:string;zone:string;onClose:()=>void}){
  const [tab,setTab]=useState('list'),[data,setData]=useState<Detail|null>(null),[error,setError]=useState<string|null>(null),[retry,setRetry]=useState(0)
  useEffect(()=>{
    const controller=new AbortController()
    fetch(`/api/alert-history/${encodeURIComponent(id)}`,{signal:controller.signal}).then(async response=>{
      const body=await response.json()
      if(!response.ok||!body.item)throw new Error(body.error??'No se pudo cargar la alerta')
      if(!controller.signal.aborted){setData(body);setError(null)}
    }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Error de conexión')})
    return ()=>controller.abort()
  },[id,retry])
  const event=data?.item, snapshot=event?.event_snapshot, detail=snapshot?.details
  return <MonitorDialog title="Detalle de alerta" onClose={onClose}>
    {error&&<div role="alert" className="mb-4 text-red-700">{error} <button className="underline" onClick={()=>setRetry(v=>v+1)}>Reintentar</button></div>}
    {!data&&!error&&<p role="status">Cargando evidencia de la alerta…</p>}
    {event&&snapshot&&<>
      <span className="mb-3 inline-block rounded-full bg-blue-50 px-3 py-1 text-sm font-semibold text-blue-800">{snapshot.own.catalog_listing===true?'Catálogo':snapshot.own.catalog_listing===false?'Tradicional':'Tipo no registrado'}</span>
      <p className="mb-4 text-sm text-slate-600"><time dateTime={event.fired_at} title={zone}>{formatAlertDate(event.fired_at,zone)}</time></p>
      <AlertTabs label="Detalle de alerta" value={tab} onChange={setTab} panelId="alert-detail-panel" options={[{value:'list',label:'Lista'},{value:'details',label:'Detalles'}]}/>
      <section role="tabpanel" id="alert-detail-panel" aria-labelledby={`alert-detail-panel-${tab}`} className="mt-4 space-y-4">
        {tab==='list'?<>
          {(snapshot.rows??[]).filter(row=>row.position!=null).sort((a,b)=>(a.price??Infinity)-(b.price??Infinity)||a.id.localeCompare(b.id)).map(row=>{
            const destination=observationLink(row.observation,row.permalink)
            const link=marketplaceLink(destination.url)
            return <article key={row.id} className={`rounded-xl border p-3 ${row.isOwn?'border-blue-500 bg-blue-50':'border-slate-200'}`}>
              <div className="flex gap-3"><span className="text-lg font-bold">{row.position}</span><div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 font-semibold">{row.isOwn&&<span className="mr-2 text-blue-700">Tu publicación</span>}{row.title}</p>
                  {link&&<a href={link} target="_blank" rel="noopener noreferrer" aria-label={`Ver en Mercado Libre: ${row.title}`} title={destination.kind==='item'?'Ver publicación observada en Mercado Libre':'Abrir destino original observado en Mercado Libre'} className="shrink-0 rounded-lg border border-slate-200 p-2 text-blue-700 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-600">
                    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>
                  </a>}
                </div>
                <p className="text-xs text-slate-500">{row.mlu??'Publicación no identificada'}{row.sellerName?` · ${row.sellerName}`:''}</p>
                {(row.sources?.length??0)>1&&<p className="mt-1 text-xs text-slate-500">Procedencias: {row.sources!.map(s=>s.mode==='catalog'?'Seguimiento dinámico':'Publicación fija').filter((s,i,a)=>a.indexOf(s)===i).join(' · ')}</p>}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="text-2xl font-bold">{money(row.price)}</p>
                  <p className={`rounded-lg px-2 py-1 text-xs font-semibold ${row.isOwn||row.relativePct==null?'bg-slate-100 text-slate-600':row.relativePct<0?'bg-red-50 text-red-700':row.relativePct>0?'bg-emerald-50 text-emerald-700':'bg-blue-50 text-blue-700'}`}>{row.isOwn?'Referencia propia · 0 %':relativeLabel(row.relativePct)}</p>
                </div>
              </div></div>
            </article>
          })}
          {!(snapshot.rows??[]).some(row=>row.position!=null)&&<p>No se registró una lista comparable para este evento. Consultá los importes originales en Detalles.</p>}
        </>:<>
          <h3 className="font-semibold">Evidencia del evento</h3>
          <p className="text-sm">{relativeLabel(snapshot.relativePct)} · Referencia: {referenceLabel(detail?.reference)}</p>
          {(event.event_origins?.length??0)>1&&<p className="text-sm">El mismo cambio fue detectado por {event.event_origins!.length} destinos de seguimiento.</p>}
          <h4 className="text-sm font-semibold">Reglas cumplidas</h4>
          <ul className="list-inside list-disc text-sm">{event.matched_rules.map(rule=><li key={rule.id}>{rule.name??'Regla anterior'}{rule.threshold_pct!=null?` · ${rule.threshold_pct} %`:''}{rule.compare_catalog_price===false?' · Excluye catálogo':''}</li>)}</ul>
          {snapshot.storedPrices&&<div className="rounded-lg bg-slate-50 p-3 text-sm">
            <p>Importes históricos; moneda no acreditada en este registro legado.</p>
            <p>Propio: {String(snapshot.storedPrices.own??'Sin dato')}</p>
            <p>Rival anterior: {String(snapshot.storedPrices.rivalBefore??'Sin dato')} · posterior: {String(snapshot.storedPrices.rivalAfter??'Sin dato')}</p>
          </div>}
          <Observation label="Rival antes del cambio" value={detail?.previousRival} zone={zone}/>
          <Observation label="Rival después del cambio" value={detail?.currentRival} zone={zone}/>
          {detail?.ownObservation!=null&&<Observation label="Precio propio registrado" value={detail.ownObservation} zone={zone}/>}
          <ProductEvidence value={detail?.own}/>
          {(snapshot.rows??[]).filter(row=>row.position==null).map(row=><p key={row.id} className="text-sm text-amber-800">Sin ranking: {row.title} · {row.reasons.map(reason=>QUALITY_LABELS[reason as ComparisonStatus]??reason).join(', ')}</p>)}
          {Array.isArray(detail?.rivals)&&detail.rivals.map((r,i)=><ProductEvidence key={i} value={r}/>)}
          {Array.isArray(detail?.comparisonsByRule)&&detail.comparisonsByRule.map((entry: {rule:{id:string;name?:string};result:{reference:string;own:unknown;rival:unknown}},i)=><details key={i} className="rounded-lg border p-3">
            <summary>Comparación de la regla {entry.rule.name??entry.rule.id} · {referenceLabel(entry.result.reference)}</summary>
            <Observation label="Referencia propia de esta regla" value={entry.result.own} zone={zone}/>
            <Observation label="Referencia rival de esta regla" value={entry.result.rival} zone={zone}/>
          </details>)}
          <h3 className="border-t pt-4 font-semibold">Últimos datos consultados — separados del evento</h3>
          {snapshot.own.sku?.trim()==='7270'&&<SourceRecoveryPanel sku="7270" onChanged={()=>setRetry(v=>v+1)}/>}
          <p className="text-xs text-slate-500">Esta sección puede cambiar. No modifica los precios ni la fecha de la alerta.</p>
          {data.current?<><ProductEvidence value={data.current.product}/><ComparisonBoard product={data.current.product} rivals={data.current.competitors}/></>:<p className="text-sm">No hay una publicación propia actual identificada.</p>}
        </>}
      </section>
    </>}
  </MonitorDialog>
}
