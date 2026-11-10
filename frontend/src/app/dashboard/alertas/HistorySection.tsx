'use client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import Image from 'next/image'
import Pagination from '@/components/Pagination'
import Select from '@/components/Select'
import AlertTabs from '@/components/AlertTabs'
import AlertEventModal from '@/components/AlertEventModal'
import MonitorDialog from '@/components/MonitorDialog'
import RulesSection from './RulesSection'
import SyncButton from '../productos/SyncButton'
import { archiveLabels, dateBounds, formatAlertDate, relativeLabel, type AlertPage, type AlertOptions, type AlertRule } from '@/lib/price-alerts'
const subscribe=()=>()=>{}
const timezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone
const field='rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus-visible:outline-2 focus-visible:outline-blue-600'

type Filters={scope:string;read:string;from:string;to:string;sku:string;seller:string;rule:string}
const defaults:Filters={scope:'inbox',read:'all',from:'',to:'',sku:'',seller:'',rule:''}
export default function HistorySection({initialPage,options,rules}:{initialPage:AlertPage;options:AlertOptions;rules:AlertRule[]}){
  const zone=useSyncExternalStore(subscribe,timezone,()=> 'UTC')
  const [filters,setFilters]=useState(defaults),[page,setPage]=useState(initialPage)
  const [index,setIndex]=useState(0),[refresh,setRefresh]=useState(0)
  const [loading,setLoading]=useState(false),[error,setError]=useState<string|null>(null)
  const [pending,setPending]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null)
  const [selected,setSelected]=useState<string|null>(null),[showRules,setShowRules]=useState(false)
  const [undo,setUndo]=useState<{id?:string;batchId?:string}|null>(null)
  const [previousInitial,setPreviousInitial]=useState(initialPage)
  if(previousInitial!==initialPage){
    setPreviousInitial(initialPage);setRefresh(value=>value+1);setLoading(true)
  }
  let query='',filterError:string|null=null
  try {
    const bounds=dateBounds(filters.from,filters.to)
    const params=new URLSearchParams({...filters,from:bounds.from,to:bounds.to})
    params.set('page', String(index + 1))
    query=params.toString()
  } catch(e){filterError=e instanceof Error?e.message:'Rango inválido'}
  useEffect(()=>{
    if(!query)return
    const controller=new AbortController()
    fetch('/api/alert-history?'+query,{signal:controller.signal}).then(async response=>{
      const data=await response.json()
      if(!response.ok||!Array.isArray(data.items)||!data.counts)throw new Error(data.error??'No se pudo cargar el listado')
      if(!controller.signal.aborted){setPage(data);setError(null);setIndex(previous=>Math.min(previous,Math.max(0,Math.ceil(data.counts.total/50)-1)))}
    }).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Error de conexión')})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return ()=>controller.abort()
  },[query,refresh])
  function change(changes:Partial<Filters>){
    setFilters(previous=>({...previous,...changes}));setIndex(0);setLoading(true)
  }
  function reload(){setLoading(true);setRefresh(value=>value+1)}
  async function action(url:string,method:string,body?:object){
    setPending(url);setError(null);setNotice(null)
    try{
      const response=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined})
      const data=await response.json()
      if(!response.ok||!data.ok)throw new Error(data.error??'No se pudo guardar el cambio')
      reload();return data
    } catch(e){setError(e instanceof Error?e.message:'No se pudo guardar el cambio');return null}
    finally{setPending(null)}
  }
  async function archive(id:string){
    const result=await action('/api/alert-history/'+id,'DELETE')
    if(result){setUndo({id});setNotice('Alerta enviada al historial.')}
  }
  async function undoArchive(){
    if(!undo)return
    const data=undo.id?await action('/api/alert-history/'+undo.id,'PATCH',{restore:true})
      :await action('/api/alert-history','PATCH',{action:'restore_batch',batchId:undo.batchId})
    if(data){setUndo(null);setNotice(data.blocked?`${data.count} restauradas; ${data.blocked} permanecen en Historial porque ya no están disponibles.`:'Archivo deshecho.')}
  }
  async function archiveRead(){
    setPending('impact');setError(null)
    try{
      const response=await fetch('/api/alert-history?'+query+'&impact=read'),impact=await response.json()
      if(!response.ok)throw new Error(impact.error??'No se pudo calcular el alcance')
      if(!impact.count){setNotice('No hay alertas leídas para archivar.');return}
      if(!confirm(`Archivar ${impact.count} alertas leídas que coinciden con los filtros, en todas las páginas. Se conservarán en Historial.`))return
      const data=await action('/api/alert-history?'+query,'DELETE')
      if(data){setUndo({batchId:data.batchId});setNotice(`${data.count} alertas enviadas al historial.`)}
    }catch(e){setError(e instanceof Error?e.message:'No se pudo archivar')}
    finally{setPending(null)}
  }
  const date=(value:string)=>formatAlertDate(value,zone)
  return <div className="space-y-5">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold text-slate-900">Alertas de precio</h1><p className="mt-1 text-sm text-slate-500">Cuándo cambió el precio de tus rivales. Los eventos se conservan.</p></div>
      <div className="flex flex-wrap gap-3"><SyncButton/><button className={field} onClick={()=>setShowRules(true)}>Reglas · {rules.length}</button></div>
    </header>
    <AlertTabs label="Sección de alertas" panelId="alert-scope" value={filters.scope} onChange={scope=>change({scope})}
      options={[{value:'inbox',label:'Alertas'},{value:'history',label:'Historial'}]}/>
    <section role="tabpanel" id="alert-scope" aria-labelledby={`alert-scope-${filters.scope}`} className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Resumen de resultados">
        {[['Total',page.counts.total],['Desventaja',page.counts.disadvantage],['Ventaja',page.counts.advantage],['Empate',page.counts.tie]].map(([label,value])=><div key={label} className="rounded-xl border border-slate-200 bg-white px-4 py-3"><p className="text-xs text-slate-500">{label}</p><p className="text-xl font-bold text-slate-900">{value}</p></div>)}
      </div>
      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
        <AlertTabs label="Lectura de alertas" panelId="alert-read" value={filters.read} onChange={read=>change({read})}
          options={[{value:'all',label:`Todas (${page.counts.all})`},{value:'unread',label:`No leídas (${page.counts.unread})`},{value:'read',label:`Leídas (${page.counts.read})`}]}/>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <label className="text-xs text-slate-600">Desde<input type="date" value={filters.from} onChange={e=>change({from:e.target.value})} className={`mt-1 block w-full ${field}`}/></label>
          <label className="text-xs text-slate-600">Hasta<input type="date" value={filters.to} onChange={e=>change({to:e.target.value})} className={`mt-1 block w-full ${field}`}/></label>
          <div className="min-w-0 text-xs text-slate-600"><label htmlFor="alert-filter-sku">SKU</label><Select id="alert-filter-sku" aria-label="SKU" searchable value={filters.sku} onValueChange={sku=>change({sku})} className="mt-1" options={[{value:'',label:'Todos los SKU'},...options.skus.map(sku=>({value:sku,label:sku}))]}/></div>
          <div className="min-w-0 text-xs text-slate-600"><label htmlFor="alert-filter-seller">Vendedor rival</label><Select id="alert-filter-seller" aria-label="Vendedor rival" searchable value={filters.seller} onValueChange={seller=>change({seller})} className="mt-1" options={[{value:'',label:'Todos los vendedores'},...options.sellers.map(seller=>({value:seller,label:seller}))]}/></div>
          <div className="min-w-0 text-xs text-slate-600"><label htmlFor="alert-filter-rule">Regla</label><Select id="alert-filter-rule" aria-label="Regla" searchable value={filters.rule} onValueChange={rule=>change({rule})} className="mt-1" options={[{value:'',label:'Todas las reglas'},...options.rules.map(rule=>({value:rule.id,label:rule.name}))]}/></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <span>Fecha de detección · {zone} · Hasta incluye el día completo.</span>
          <button className="text-blue-700 underline" onClick={()=>change({...defaults,scope:filters.scope})}>Limpiar filtros</button>
        </div>
      </div>
      {filterError&&<p role="alert" className="text-sm text-red-700">{filterError}</p>}
      {error&&<div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}. Se conservan los últimos datos mostrados. <button className="underline" onClick={reload}>Reintentar</button></div>}
      {notice&&<div role="status" className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{notice} {undo&&<button disabled={!!pending} className="ml-3 font-semibold underline" onClick={undoArchive}>Deshacer</button>}</div>}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
        <span role="status">{filterError?'Rango de fechas inválido':loading?'Actualizando resultados…':`${page.counts.total} eventos · más recientes primero`}</span>
        <div className="flex gap-4">
          <button disabled={!!pending||loading||!!filterError} className="text-blue-700 underline disabled:opacity-40" onClick={()=>action('/api/alert-history?'+query,'PATCH',{action:'read'})}>Marcar resultados como leídos</button>
          {filters.scope==='inbox'&&<button disabled={!!pending||loading||!!filterError} className="text-slate-700 underline disabled:opacity-40" onClick={archiveRead}>Archivar leídas</button>}
        </div>
      </div>
      <div role="tabpanel" id="alert-read" aria-labelledby={`alert-read-${filters.read}`} aria-busy={loading} className="space-y-3">
        {!page.items.length&&!loading&&<p className="rounded-xl border border-dashed p-8 text-center text-slate-500">No hay eventos para estos filtros.</p>}
        {page.items.map(event=>{
          const snapshot=event.event_snapshot, own=snapshot.own, rival=snapshot.rival
          const thumbnail=own.thumbnail?.replace(/^http:/,'https:')
          const border=snapshot.relativePct==null?'border-slate-200':snapshot.relativePct<0?'border-red-300':snapshot.relativePct>0?'border-emerald-300':'border-blue-300'
          return <article key={event.id} className={`flex items-start gap-3 rounded-xl border bg-white p-4 ${border}`} aria-label={`Alerta de ${own.title??event.our_sku}`}>
            <button type="button" onClick={()=>setSelected(event.id)} className="flex min-w-0 flex-1 gap-3 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-blue-600">
              {thumbnail?<Image src={thumbnail} alt="" width={64} height={64} unoptimized className="h-16 w-16 shrink-0 rounded-lg object-contain"/>:<span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-xs text-slate-400">Sin imagen</span>}
              <div className="min-w-0 flex-1 space-y-1">
                <h2 className="text-sm font-semibold leading-snug text-slate-900"><span className="mr-2 inline-block rounded bg-slate-100 px-1.5 py-0.5 align-middle font-mono text-[10px] font-normal text-slate-500" aria-label={`SKU ${own.sku||event.our_sku||'Sin SKU'}`}>{own.sku||event.our_sku||'Sin SKU'}</span>{own.title??'Publicación pendiente de identificación'}</h2>
                <p className="text-xs text-slate-500"><time dateTime={event.fired_at}>{date(event.fired_at)}</time></p>
                <p className="break-words text-xs text-slate-600">{rival.sellerName??'Sin vendedor identificado'}</p>
                <p className={`inline-block rounded-lg px-2 py-1 text-xs font-semibold ${snapshot.relativePct==null?'bg-slate-50 text-slate-500':snapshot.relativePct<0?'bg-red-50 text-red-700':snapshot.relativePct>0?'bg-emerald-50 text-emerald-700':'bg-blue-50 text-blue-700'}`}>{relativeLabel(snapshot.relativePct)}</p>
                {event.archived_at&&<p className="pt-1 text-xs text-slate-500">{archiveLabels[event.archive_reason??'']??'Archivada'} · {date(event.archived_at)}</p>}
              </div>
            </button>
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
              <button disabled={!!pending} aria-label={event.read_at?'Marcar como no leída':'Marcar como leída'} title={event.read_at?'Marcar como no leída':'Marcar como leída'} onClick={()=>action('/api/alert-history/'+event.id,'PATCH',{read:!event.read_at})} className={`${field} !p-2 disabled:opacity-40`}>{event.read_at?'↶':'✓'}</button>
              {!event.archived_at&&<button disabled={!!pending} aria-label="Archivar alerta" title="Eliminar de Alertas y conservar en Historial" onClick={()=>archive(event.id)} className={`${field} !p-2 disabled:opacity-40`}>×</button>}
            </div>
          </article>
        })}
      </div>
      <Pagination currentPage={index + 1} totalPages={Math.ceil(page.counts.total / 50)} disabled={loading}
        onPageChange={next => { setIndex(next - 1); setLoading(true) }} label="Paginación de alertas" />
    </section>
    {selected&&<AlertEventModal id={selected} zone={zone} onClose={()=>setSelected(null)}/>}
    {showRules&&<MonitorDialog title="Reglas de alerta" onClose={()=>setShowRules(false)}><RulesSection initialRules={rules} skus={options.skus.map(sku=>({sku,title:sku}))}/></MonitorDialog>}
  </div>
}
