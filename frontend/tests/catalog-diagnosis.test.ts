import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createClient} from '@supabase/supabase-js'
import {diagnoseCatalog,publicationState} from '../../supabase/functions/_shared/catalog-diagnosis.ts'
import {syncCatalog} from '../../supabase/functions/_shared/catalog-service.ts'
import {catalogRanking,type CatalogSnapshot} from '../../supabase/functions/_shared/catalog.ts'
const failure={status:404,resource:'/products/MLU100/items?status=active&limit=20&offset=0',noWinners:true}
const metadata={id:'MLU100',status:'active',children_ids:[],buy_box_winner:null}
function context(meta:unknown=metadata,metaStatus=200,bulk?:unknown){
 const calls:string[]=[]
 return {calls,token:'test',sellerId:1,fx:null,apiUrl:'https://ml.test',fxUrl:'https://ml.test/fx',fetcher:async(input:RequestInfo|URL)=>{
  const url=new URL(String(input));calls.push(url.pathname+url.search)
  if(url.pathname==='/products/MLU100')return meta instanceof Response?meta.clone():Response.json(meta,{status:metaStatus})
  if(url.pathname==='/items/bulk')return Response.json(bulk??url.searchParams.get('ids')!.split(',').reverse().map(id=>({id,status_code:200,body:{id,status:'paused',sub_status:['paused_by_seller']}})))
  if(url.pathname==='/fx')return Response.json({rates:{UYU:40}})
  if(url.pathname==='/products/MLU100/items')return Response.json({error:'not_found',message:'No winners found'},{status:404})
  throw new Error('Unexpected '+url)
 }}
}
for(const [meta,status,kind] of [[metadata,200,'no_offers'],[{...metadata,status:'inactive',children_ids:['MLU200']},200,'inactive_parent'],[{...metadata,status:'inactive'},200,'inactive_catalog'],[{},404,'catalog_not_found'],[{...metadata,buy_box_winner:{item_id:'MLU8'}},200,'unverified']] as const){
 test(`catalog classification ${kind} preserves independent own state`,async()=>{
  const ctx=context(meta,status)
  const value=await diagnoseCatalog('MLU100',['MLU1','MLU2'],ctx,failure)
  assert.equal(value.kind,kind);assert.equal(value.publications.MLU1.message,'Pausada por el vendedor')
  assert.equal(value.evidence.httpStatus,404);assert.equal(value.evidence.metadataHttpStatus,status)
  assert.equal(value.evidence.message,'No winners found')
 })
}
for(const status of [401,403,429,500])test(`metadata HTTP ${status} remains a technical failure`,async()=>{
 await assert.rejects(diagnoseCatalog('MLU100',['MLU1'],context({},status),failure),e=>(e as {status:number}).status===status)
})
for(const meta of [{...metadata,id:'MLU9'},{...metadata,children_ids:null},{...metadata,buy_box_winner:{}},{...metadata,status:'other'}])test('malformed metadata is not a completed diagnosis',async()=>{
 await assert.rejects(diagnoseCatalog('MLU100',[],context(meta),failure),/inválida/)
})
test('own bulk batches are bounded at 20 and match unordered identities',async()=>{
 const ctx=context();const ids=Array.from({length:41},(_,i)=>'MLU'+(i+1))
 const result=await diagnoseCatalog('MLU100',ids,ctx,failure)
 assert.equal(ctx.calls.filter(c=>c.startsWith('/items/bulk')).length,3)
 assert.equal(Object.keys(result.publications).length,41)
 assert.equal(result.publications.MLU41.status,'paused')
})
test('bulk mixed failures, duplicate and inconsistent identities are warnings without an invented pause',async()=>{
 const entries=[{id:'MLU1',status_code:200,body:{id:'MLU1',status:'active',sub_status:[]}},{id:'MLU2',status_code:403},{id:'MLU3',status_code:200,body:{id:'MLU4',status:'paused',sub_status:['out_of_stock']}},{id:'MLU5',status_code:200},{id:'MLU5',status_code:200}]
 const r=await diagnoseCatalog('MLU100',['MLU1','MLU2','MLU3','MLU5','MLU6'],context(metadata,200,entries),failure)
 assert.equal(r.publications.MLU1.message,'Activa')
 for(const id of ['MLU2','MLU3','MLU5','MLU6']){assert.equal(r.publications[id].status,null);assert.ok(r.publications[id].warning)}
})
test('own state labels reflect sub_status without assigning it to the catalog',()=>{
 assert.equal(publicationState('paused',['out_of_stock']),'Sin stock')
 assert.equal(publicationState('paused',[]),'Pausada; motivo no informado')
 assert.equal(publicationState('under_review',['forbidden']),'En revisión por moderación')
 assert.equal(publicationState('inactive',['forbidden','deleted']),'Marcada como eliminada')
})
const historical:CatalogSnapshot={catalogId:'MLU100',offers:[{itemId:'MLU1',sellerId:1,title:'Propio',sellerName:'Propio',permalink:null,observation:{amount:100,currency:'UYU',normalizedAmount:100,normalizedCurrency:'UYU',observedAt:'2026-11-01T00:00:00Z',source:'catalog',fx:null}}],total:1,coverage:'complete',observedAt:'2026-11-01T00:00:00Z',fx:null,buyBox:{state:'not_verified',winnerId:null,winner:null,observedAt:null,sourceItemId:null,source:'price_to_win'},warnings:[]}
for(const writeError of [false,true])test(`catalog service caches diagnosis, preserves history and confirms writes (${writeError})`,async()=>{
 const ctx=context();const reports:{outcome:string;message:string}[]=[];const writes:Record<string,unknown>[]=[]
 let stored:CatalogSnapshot=structuredClone(historical)
 const client=createClient('https://db.test','test',{global:{fetch:async(input,init)=>{
  const req=new Request(input,init),url=new URL(req.url)
  if(url.pathname.endsWith('/record_catalog_snapshot')){const body=await req.json();if(body.p_snapshot)stored=body.p_snapshot;return Response.json(null)}
  if(req.method==='PATCH'){writes.push(await req.json());return writeError?Response.json({message:'Write failed'},{status:400}):Response.json({id:url.searchParams.get('id')!.slice(3)})}
  if(url.pathname.endsWith('/ml_catalog_snapshots'))return Response.json({snapshot:stored})
  return Response.json([{id:'MLU1',catalog_product_id:'MLU100',catalog_listing:true,catalog_price:123,catalog_currency_id:null,catalog_observed_at:null},{id:'MLU2',catalog_product_id:'MLU100',catalog_listing:false}])
 }}})
 const result=await syncCatalog(client,ctx,{report:r=>reports.push(r)})
 assert.equal(result.items_failed,writeError?2:0);assert.equal(result.catalog_prices_updated,writeError?0:2)
 assert.equal(ctx.calls.filter(c=>c==='/products/MLU100').length,1)
 assert.deepEqual(stored.lastPricedSnapshot,historical);assert.equal(stored.offers.length,0)
 assert.deepEqual(stored.lastRecordedPrices,[{publicationId:'MLU1',amount:123,currency:null,observedAt:null,source:'stored_record'}])
 assert.equal(catalogRanking(stored,'MLU1').length,0)
 for(const write of writes){assert.equal(write.catalog_price,null);assert.equal(write.price,undefined);assert.equal(write.sale_price,undefined);assert.equal(write.catalog_product_id,undefined)}
 if(!writeError){
  assert.ok(reports.every(r=>r.outcome==='updated'&&r.message.includes('Pausada por el vendedor')))
  await syncCatalog(client,ctx)
  assert.deepEqual(stored.lastPricedSnapshot,historical)
 }
})

test('invalid metadata JSON has a validation message rather than an authentication diagnosis',async()=>{
 await assert.rejects(diagnoseCatalog('MLU100',[],context(new Response('invalid JSON',{status:200})),failure),/Respuesta de metadatos de catálogo inválida/)
})
