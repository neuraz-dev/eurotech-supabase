'use client'
import {useEffect,useState} from 'react'
import {marketplaceLink} from '@/lib/price-alerts'
import type {Candidate} from '@monitoring/source-recovery'
type Repair={key:string;status:string;candidates:Candidate[];last_error:string|null}
export default function SourceRecoveryPanel({sku,onChanged}:{sku:string;onChanged?:()=>void}){
 const [items,setItems]=useState<Repair[]>([]),[error,setError]=useState<string|null>(null),[pending,setPending]=useState(false),[refresh,setRefresh]=useState(0)
 const [candidate,setCandidate]=useState('')
 useEffect(()=>{
  const controller=new AbortController()
  fetch('/api/monitor-repairs?'+new URLSearchParams({sku}),{signal:controller.signal}).then(async response=>{
   const body=await response.json();if(!response.ok||!Array.isArray(body.items))throw new Error('No se pudo cargar la recuperación del rival')
   if(!controller.signal.aborted){setItems(body.items);setError(null)}
  }).catch(e=>{if(!controller.signal.aborted)setError(e.message)})
  return ()=>controller.abort()
 },[sku,refresh])
 async function recover(key:string,itemId?:string){
  setPending(true);setError(null)
  try{
   const response=await fetch('/api/monitor-repairs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,itemId})})
   const body=await response.json();if(!response.ok||!body.ok)throw new Error(body.error??'No se pudo recuperar el rival')
   setRefresh(v=>v+1);if(body.resolved)onChanged?.()
  }catch(e){setError(e instanceof Error?e.message:'Error de conexión. Reintentá.')}
  finally{setPending(false)}
 }
 if(!items.some(r=>r.status==='pending')&&!error)return null
 return <aside className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm" aria-label="Recuperación de rival original">
  <p className="font-semibold">FERROFERTASIMP · Publicación original por recuperar</p>
  <p>Se conserva el catálogo dinámico. Esta recuperación agrega por separado la publicación que asignó el operador, sin volver a revisar su equivalencia.</p>
  {error&&<p role="alert" className="text-red-700">{error} <button className="underline" onClick={()=>setRefresh(v=>v+1)}>Reintentar consulta</button></p>}
  {items.filter(r=>r.status==='pending').map(repair=><div key={repair.key} className="space-y-2">
   {repair.last_error&&<p className="text-amber-900">Último intento: {repair.last_error}</p>}
   <button disabled={pending} className="font-medium text-blue-700 underline disabled:opacity-50" onClick={()=>recover(repair.key)}>{pending?'Verificando…':'Buscar y validar publicación original'}</button>
   <div className="flex flex-wrap items-end gap-2"><label className="text-xs">MLU original (opcional)<input value={candidate} onChange={e=>setCandidate(e.target.value.toUpperCase())} placeholder="MLU…" className="mt-1 block rounded border border-slate-300 px-2 py-1"/></label><button disabled={pending||!/^ML[AU]\d+$/.test(candidate)} onClick={()=>recover(repair.key,candidate)} className="text-blue-700 underline disabled:opacity-50">Verificar MLU original</button></div>
   {repair.candidates.length>1&&<p>Elegí la publicación original entre estas candidatas verificadas del mismo vendedor y catálogo:</p>}
   {repair.candidates.map(candidate=><div key={candidate.id} className="rounded border border-amber-200 bg-white p-2">
    <p>{candidate.title??candidate.id} · {candidate.id}</p>
    {candidate.verification==='public_page'&&<p className="text-xs text-amber-900">Identificada en la página pública; pendiente de verificación por API.</p>}
    <p>{candidate.price?.toLocaleString('es-UY')} {candidate.currency_id}</p>
    {marketplaceLink(candidate.permalink)&&<a href={marketplaceLink(candidate.permalink)!} target="_blank" rel="noopener noreferrer" className="mr-3 text-blue-700 underline">Ver publicación</a>}
    <button disabled={pending} onClick={()=>recover(repair.key,candidate.id)} className="text-blue-700 underline disabled:opacity-50">Elegir y verificar</button>
   </div>)}
  </div>)}
 </aside>
}
