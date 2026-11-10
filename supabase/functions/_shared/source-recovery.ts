import type {SupabaseClient} from 'npm:@supabase/supabase-js@2'
import {fetchTarget,competitorRecord,MlHttpError,type MlContext} from './ml-observation.ts'
import {sourceIdentity} from './source-links.ts'
export type Recovery={key:string;sku:string;catalog_id:string;expected_seller_id:number;status:string;candidates:Candidate[];last_error:string|null;evidence:Record<string,unknown>}
export type Candidate={id:string;title:string|null;price:number|null;currency_id:string|null;permalink:string|null;verification?:'api'|'public_page'}
/** Discovery only. A candidate is never accepted by title or catalog-list seller alone. */
export async function fixedCandidates(repair:Recovery,context:MlContext){
 const fetcher=context.fetcher??fetch,api=context.apiUrl??'https://api.mercadolibre.com'
 const ids=new Set<string>();let offset=0
 for(;;){
  const resource=`/products/${repair.catalog_id}/items?status=active&limit=20&offset=${offset}`
  const response=await fetcher(api+resource,{headers:{Authorization:'Bearer '+context.token},signal:AbortSignal.timeout(20000)})
  if(!response.ok)throw new MlHttpError(response.status,resource)
  const body=await response.json()
  if(!Array.isArray(body.results))throw new Error('Catálogo sin ofertas verificables')
  for(const row of body.results)if(row.seller_id===repair.expected_seller_id&&typeof row.item_id==='string')ids.add(row.item_id)
  offset+=body.results.length
  const total=body.paging?.total
  if(typeof total!=='number'&&body.results.length===20)throw new Error('Cobertura desconocida; no se puede elegir una publicación automáticamente')
  if(typeof total==='number'&&offset>=total||body.results.length<20&&typeof total!=='number')break
  if(!body.results.length||offset>=1000)throw new Error('Cobertura incompleta del catálogo; recuperación pendiente')
 }
 const values=[]
 for(const id of ids){
  const value=await fetchTarget({kind:'item',id,sourceKind:'item',sourceId:id,catalogId:repair.catalog_id,sellerId:repair.expected_seller_id},context)
  if(value.observation.sellerId===repair.expected_seller_id&&value.observation.catalogProductId===repair.catalog_id)values.push(value)
 }
 return values
}
export async function recoverFixedTarget(client:SupabaseClient,repair:Recovery,context:MlContext,selectedId?:string,actor?:string){
 try{
  const values=selectedId?[await fetchTarget({kind:'item',id:selectedId,catalogId:repair.catalog_id,sellerId:repair.expected_seller_id},context)]:await fixedCandidates(repair,context)
  const verified=values.filter(v=>v.observation.sellerId===repair.expected_seller_id&&v.observation.catalogProductId===repair.catalog_id)
  if(selectedId&&verified.length!==1)throw new Error('La MLU no pertenece al vendedor y catálogo originales')
  const candidates:Candidate[]=verified.map(v=>({id:v.observation.itemId!,title:v.title,price:v.observation.amount,currency_id:v.observation.currency,permalink:v.permalink,verification:'api'}))
  const options=selectedId?[...(repair.candidates??[]).filter(c=>c.id!==selectedId),...candidates]:candidates
  const save=await client.schema('ml').from('ml_monitor_repairs').update({candidates:options,last_error:null,updated_at:new Date().toISOString()}).eq('key',repair.key).eq('status','pending').select('key')
  if(save.error)throw save.error
  if(!Array.isArray(save.data)||save.data.length!==1){
   const latest=await client.schema('ml').from('ml_monitor_repairs').select('status,evidence').eq('key',repair.key).maybeSingle()
   if(!latest.error&&latest.data?.status==='resolved')return {resolved:true,candidates:[],item:latest.data}
   throw new Error('La base no confirmó el estado de recuperación; reintentá')
  }
  if(verified.length===1){
   const {data,error}=await client.schema('ml').rpc('complete_monitor_fixed_recovery',{p_key:repair.key,p_item:competitorRecord(verified[0]),p_actor:actor??null})
   if(error)throw error
   return {resolved:true,candidates,item:data}
  }
  return {resolved:false,candidates,message:verified.length?'Elegí la publicación original entre las candidatas verificadas.':'No se encontró una publicación verificable del vendedor original.'}
 }catch(error){
  const message=error instanceof Error?error.message:'No se pudo verificar la publicación original'
  const result=await client.schema('ml').from('ml_monitor_repairs').update({last_error:message,updated_at:new Date().toISOString()}).eq('key',repair.key).eq('status','pending')
  if(result.error)throw new Error('No se pudo guardar el estado de recuperación')
  throw error
 }
}
export async function recoverPendingFixedTargets(client:SupabaseClient,context:MlContext){
 const {data,error}=await client.schema('ml').from('ml_monitor_repairs').select('*').eq('kind','recover_fixed').eq('status','pending')
 if(error)throw error
 let pending=0,resolved=0
 for(const repair of data??[]){try{const r=await recoverFixedTarget(client,repair,context);if(r.resolved)resolved++;else pending++}catch{pending++}}
 return {recoveries_pending:pending,recoveries_resolved:resolved}
}
export function isConfirmedSource404(error:unknown,target:Parameters<typeof sourceIdentity>[0],previous:{resolution?:{sourceKind:string;sourceId:string;resource:string;validatedAt:string}}|null){
 const identity=sourceIdentity(target),proof=previous?.resolution
 return error instanceof MlHttpError&&[404,410].includes(error.status)&&!!proof?.validatedAt
   &&(identity.kind!=='item'||error.resource===`/items/${identity.id}`)
   &&proof.sourceKind===identity.kind&&proof.sourceId===identity.id&&proof.resource===error.resource
}
