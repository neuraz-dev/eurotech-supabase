import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fetchTarget,parseTarget,MlHttpError,type MlContext} from '../../supabase/functions/_shared/ml-observation.ts'
import {safeMarketplaceUrl,sourceIdentity} from '../../supabase/functions/_shared/source-links.ts'
import {fixedCandidates,isConfirmedSource404,type Recovery} from '../../supabase/functions/_shared/source-recovery.ts'
import {buildAlertEvents,type EventRule,type EventSnapshot} from '../../supabase/functions/_shared/alert-events.ts'
import {observe,retainLastPricedObservation,type CompetitorLink,compare} from '../../supabase/functions/_shared/monitoring.ts'
const at='2026-11-09T00:00:00Z'
test('7270 follows the cheapest normalized external catalog offer, independently of the original seller',async()=>{
 const ctx=context({
  '/products/MLU2081534097/items?status=active&limit=20':{results:[
   {item_id:'MLU1',seller_id:1,price:1,currency_id:'UYU'},
   {item_id:'MLU806560888',seller_id:255754420,price:72.8,currency_id:'USD'},
   {item_id:'MLU1490594786',seller_id:158159914,price:1914.25,currency_id:'UYU'},
  ],paging:{total:3}},
  '/products/MLU2081534097':403,'/items/MLU1490594786':403,'/users/158159914':{nickname:'BROIMPO'},
 })
 ctx.fx={rate:40,source:'test',fetchedAt:at,publishedAt:null}
 const value=await fetchTarget(parseTarget('https://www.mercadolibre.com.uy/p/MLU2081534097'),ctx)
 assert.equal(value.target.kind,'catalog');assert.equal(value.observation.itemId,'MLU1490594786')
 assert.equal(value.observation.amount,1914.25);assert.equal(value.observation.coverage,'complete')
 assert.equal(value.observation.sellerName,'BROIMPO')
})
const item={id:'MLU12',user_product_id:'MLUU123',catalog_product_id:'MLU999',seller_id:2,seller_name:'FERROFERTASIMP',price:80,currency_id:'UYU',status:'active',permalink:'https://articulo.mercadolibre.com.uy/MLU-12-producto-_JM'}
function context(routes:Record<string,unknown|number>,calls:string[]=[]):MlContext{return {token:'test',sellerId:1,fx:null,apiUrl:'https://ml.test',now:at,fetcher:async input=>{
 const url=new URL(String(input));const path=url.pathname+url.search;calls.push(path)
 const body=routes[path];assert.notEqual(body,undefined,'Unexpected resource '+path)
 if(body instanceof Response)return body.clone()
 return typeof body==='number'?Response.json({},{status:body}):Response.json(body)
}}}
test('source URLs preserve /up and repair legacy /p/MLUU without accepting unrelated origins',()=>{
 for(const url of ['https://www.mercadolibre.com.uy/up/MLUU123','https://www.mercadolibre.com.uy/p/MLUU123']){
  const t=parseTarget(url);assert.equal(t.sourceKind,'user_product');assert.equal(sourceIdentity(t).url,'https://www.mercadolibre.com.uy/up/MLUU123')
 }
 assert.equal(safeMarketplaceUrl('https://evil.test/up/MLUU123'),null)
 assert.equal(safeMarketplaceUrl('https://secret@mercadolibre.com.uy/up/MLUU123'),null)
 assert.equal(sourceIdentity({kind:'catalog',id:'MLU2081534097'}).kind,'catalog')
})
const upTarget={...parseTarget('https://www.mercadolibre.com.uy/up/MLUU123'),sellerId:2,itemId:'MLU12'}
const offersPath='/products/MLUU123/items?status=active&limit=20'
const offer={seller_id:2,seller_name:'FERROFERTASIMP',price:80,currency_id:'UYU'}
test('User Product public offers succeed without accessing restricted individual endpoints or reusing a previous MLU',async()=>{
 const calls:string[]=[]
 const value=await fetchTarget(upTarget,context({[offersPath]:{results:[offer],paging:{total:1}}},calls))
 assert.deepEqual(calls,[offersPath]);assert.equal(value.observation.itemId,null)
 assert.equal(value.observation.sellerId,2);assert.equal(value.observation.amount,80)
 assert.equal(value.observation.userProductId,'MLUU123');assert.equal(value.observation.catalogProductId,null)
 assert.equal(value.observation.sourceKind,'user_product');assert.equal(value.observation.coverage,'complete')
 assert.equal(value.observation.itemPermalink,null);assert.equal(value.permalink,'https://www.mercadolibre.com.uy/up/MLUU123')
})
test('User Product keeps a concrete MLU only when returned in the current offers',async()=>{
 const value=await fetchTarget(upTarget,context({[offersPath]:{results:[{...offer,item_id:'MLU13'}],paging:{total:1}}}))
 assert.equal(value.observation.itemId,'MLU13')
})
test('User Product selects the normalized minimum across pages for the associated seller',async()=>{
 const ctx=context({[offersPath]:{results:[{...offer,price:2,currency_id:'USD'},{...offer,price:1,seller_id:3}],paging:{total:3}},[offersPath+'&offset=2']:{results:[{...offer,price:75}],paging:{total:3}}})
 ctx.fx={rate:40,source:'test',fetchedAt:at,publishedAt:null}
 const value=await fetchTarget(upTarget,ctx)
 assert.equal(value.observation.amount,75);assert.equal(value.observation.offersConsulted,3)
 assert.equal(value.observation.coverage,'complete');assert.equal(value.observation.sellerId,2)
})
test('User Product excludes our seller and invalid prices without choosing another assigned vendor',async()=>{
 const value=await fetchTarget(upTarget,context({[offersPath]:{results:[{...offer,seller_id:1,price:1},{...offer,price:-1},{...offer,price:0},{...offer,seller_id:3,price:1},offer],paging:{total:5}}}))
 assert.equal(value.observation.amount,80)
 const missing=await fetchTarget(upTarget,context({[offersPath]:{results:[{...offer,seller_id:1},{...offer,seller_id:3}],paging:{total:2}}}))
 assert.equal(missing.observation.state,'no_external_offers');assert.equal(missing.observation.amount,null)
})
test('failed conversion preserves original currency without winning over a comparable offer',async()=>{
 const value=await fetchTarget(upTarget,context({[offersPath]:{results:[{...offer,price:1,currency_id:'USD'},offer],paging:{total:2}}}))
 assert.equal(value.observation.currency,'UYU');assert.equal(value.observation.amount,80)
 const unconverted=await fetchTarget(upTarget,context({[offersPath]:{results:[{...offer,currency_id:'USD'}],paging:{total:1}}}))
 assert.equal(unconverted.observation.currency,'USD');assert.equal(unconverted.observation.normalizedAmount,null)
})
test('partial pagination retains a valid observed price with explicit warning',async()=>{
 const value=await fetchTarget(upTarget,context({[offersPath]:{results:[offer],paging:{total:2}},[offersPath+'&offset=1']:403}))
 assert.equal(value.observation.amount,80);assert.equal(value.observation.coverage,'partial')
 assert.match(value.observation.warnings![0],/HTTP 403/)
 await assert.rejects(fetchTarget(upTarget,context({[offersPath]:{results:[{...offer,price:0}],paging:{total:2}},[offersPath+'&offset=1']:500})),/Cobertura parcial sin precio/)
})
test('malformed offers are not successful observations',async()=>{
 for(const results of [null,[{price:80,currency_id:'UYU'}],[{...offer,price:'80'}]])
  await assert.rejects(fetchTarget(upTarget,context({[offersPath]:{results}})),/válid/)
})
for(const status of [401,403,404,429,500])test(`User Product offers HTTP ${status} retains a technical error`,async()=>{
 await assert.rejects(fetchTarget(upTarget,context({[offersPath]:status})),e=>e instanceof MlHttpError&&e.status===status)
})
test('a previous item ID alone cannot turn an unrelated resource 404 into unavailability',()=>{
 const target={kind:'catalog' as const,id:'MLUU123'}
 const proof={resolution:{sourceKind:'user_product',sourceId:'MLUU123',resource:'/items/MLU12',validatedAt:at}}
 assert.equal(isConfirmedSource404(new MlHttpError(404,'/products/MLUU123/items'),target,proof),false)
 assert.equal(isConfirmedSource404(new MlHttpError(404,'/items/MLU12'),target,proof),true)
 assert.equal(isConfirmedSource404(new MlHttpError(401,'/items/MLU12'),target,proof),false)
 assert.equal(isConfirmedSource404(new MlHttpError(404,'/items/MLU12'),target,{}),false)
})
test('fixed recovery verifies exact seller and catalog; a matching title is insufficient',async()=>{
 const repair={catalog_id:'MLU999',expected_seller_id:2} as Recovery
 const values=await fixedCandidates(repair,context({
 '/products/MLU999/items?status=active&limit=20&offset=0':{results:[{item_id:'MLU12',seller_id:2},{item_id:'MLU13',seller_id:3}],paging:{total:2}},
 '/items/MLU12':item,
 }))
 assert.equal(values.length,1);assert.equal(values[0].observation.sellerId,2)
 const wrong=await fixedCandidates(repair,context({
 '/products/MLU999/items?status=active&limit=20&offset=0':{results:[{item_id:'MLU12',seller_id:2}],paging:{total:1}},'/items/MLU12':{...item,catalog_product_id:'MLU888'},
 }))
 assert.equal(wrong.length,0)
})
const own={id:'MLU100',sku:'7270',title:'Propio',status:'active',price:100,sale_price:null,catalog_price:null,currency_id:'UYU',synced_at:at}
const dynamic={id:'MLU999',target_kind:'catalog' as const,status:'active',observation:{...observe(80,'UYU',at,'catalog'),itemId:'MLU12'}}
const fixed={...dynamic,id:'MLU12',target_kind:'item' as const}
const links:CompetitorLink[]=[dynamic,fixed].map(r=>({id:'link-'+r.id,competitor_item_id:r.id,scope:'sku',our_product_id:null,our_sku:'7270',paused:false,equivalence:'accepted',removed_at:null}))
const rule:EventRule={id:'rule',enabled:true,rule_type:'competitor_cheaper',threshold_pct:null,sku:null,compare_catalog_price:true}
test('same MLU has one ranked row and both origins; pausing fixed leaves dynamic comparison independent',()=>{
 const events=buildAlertEvents(dynamic,observe(90,'UYU',at,'catalog'),[own],[dynamic,fixed],links,[rule],null)
 const rows=(events[0].event_snapshot as EventSnapshot).rows
 assert.equal(rows.length,2);assert.equal(rows[0].sources?.length,2)
 const paused=links.map(l=>({...l,paused:l.competitor_item_id===fixed.id}))
 assert.equal(buildAlertEvents(fixed,observe(90,'UYU',at,'item'),[own],[dynamic,fixed],paused,[rule],null).length,0)
 assert.equal(buildAlertEvents(dynamic,observe(90,'UYU',at,'catalog'),[own],[dynamic,fixed],paused,[rule],null).length,1)
})
test('catalog price change does not invent a price change for the unchanged fixed vendor',()=>{
 const other={...dynamic,observation:{...observe(75,'UYU',at,'catalog'),itemId:'MLU13'}}
 assert.equal(buildAlertEvents(other,observe(80,'UYU',at,'catalog'),[own],[other,fixed],links,[rule],null).length,1)
 assert.equal(buildAlertEvents(fixed,fixed.observation,[own],[other,fixed],links,[rule],null).length,0)
})
test('the 7270 USD prices are normalized and paused own products produce no events',()=>{
 const usd={...own,price:77,currency_id:'USD',fx_quote:{rate:40,source:'test',fetchedAt:at,publishedAt:null}}
 assert.equal(compare(usd,fixed,links).own.normalizedAmount,3080)
 assert.equal(buildAlertEvents(fixed,observe(90,'UYU',at,'item'),[{...usd,status:'paused'}],[fixed],links,[rule],usd.fx_quote).length,0)
})
test('fixed vendor can be proven through authorized catalog offers when competitor items are restricted',async()=>{
 const ctx=context({'/items/MLU12':403,'/products/MLU999/items?status=active&limit=20&offset=0':{results:[{item_id:'MLU12',seller_id:2,price:80,currency_id:'UYU'}],paging:{total:1}},'/users/2':{nickname:'FERROFERTASIMP'}})
 const value=await fetchTarget({kind:'item',id:'MLU12',catalogId:'MLU999',sellerId:2},ctx)
 assert.equal(value.observation.itemId,'MLU12');assert.equal(value.observation.sellerId,2);assert.equal(value.observation.catalogProductId,'MLU999')
 assert.equal(new URL(value.permalink).searchParams.get('pdp_filters'),'item_id:MLU12')
 assert.equal(isConfirmedSource404(new MlHttpError(404,value.observation.resolution!.resource),{kind:'item',id:'MLU12'},value.observation),false)
})
test('missing fixed offer or wrong seller does not masquerade as confirmed unavailable',async()=>{
 for(const rows of [[],[{item_id:'MLU12',seller_id:3,price:80,currency_id:'UYU'}]]){
  await assert.rejects(fetchTarget({kind:'item',id:'MLU12',catalogId:'MLU999',sellerId:2},context({'/items/MLU12':403,'/products/MLU999/items?status=active&limit=20&offset=0':{results:rows,paging:{total:rows.length}}})),/no apareció|no verificado/)
 }
})

test('events and ranking use source identity without MLU and ignore FX-only changes',()=>{
 const rival={...dynamic,id:'MLUU123',observation:{...observe(80,'USD',at,'user_product',{rate:1,source:'test',fetchedAt:at,publishedAt:null}),itemId:null,sellerId:2,sourceKind:'user_product' as const}}
 const link={...links[0],competitor_item_id:rival.id}
 const fx={rate:1,source:'test',fetchedAt:at,publishedAt:null}
 const events=buildAlertEvents(rival,observe(90,'USD',at,'user_product'),[own],[rival],[link],[rule],fx)
 assert.equal(events.length,1)
 const rows=(events[0].event_snapshot as EventSnapshot).rows
 assert.equal(rows.find(r=>!r.isOwn)!.mlu,null);assert.equal(rows.find(r=>!r.isOwn)!.id,rival.id)
 assert.equal(rows.filter(r=>!r.isOwn).length,1)
 assert.equal(buildAlertEvents(rival,observe(80,'USD',at,'user_product'),[own],[rival],[link],[rule],{...fx,rate:1.1}).length,0)
})

const noWinners=()=>Response.json({error:'not_found',message:'No winners found',access_token:'must-not-persist'},{status:404})
for(const kind of ['catalog','user_product'] as const)test(`recognized first-page absence produces non-comparable evidence (${kind})`,async()=>{
 const target=kind==='catalog'?{kind:'catalog' as const,id:'MLU999',sellerId:2}:upTarget
 const path=kind==='catalog'?'/products/MLU999/items?status=active&limit=20':offersPath
 const value=await fetchTarget(target,context({[path]:noWinners(),'/products/MLU999':403,'/users/2':{nickname:'Rival'}}))
 assert.equal(value.observation.state,'no_external_offers');assert.equal(value.observation.amount,null)
 assert.equal(value.observation.normalizedAmount,null);assert.equal(value.observation.sellerId,2)
 assert.equal(value.status,null);assert.equal(value.observation.itemId,null)
 assert.deepEqual(value.observation.availabilityEvidence,{httpStatus:404,apiCode:'not_found',message:'No winners found',resource:path,observedAt:at})
 assert.equal(JSON.stringify(value).includes('must-not-persist'),false)
 const result=compare(own,{...value,availability:'unavailable'},[{...links[0],competitor_item_id:target.id}])
 assert.equal(result.status,'no_external_offers');assert.equal(result.deltaPct,null)
})
for(const response of [Response.json({error:'not_found',message:'No winners found'},{status:403}),Response.json({error:'not_found',message:'Product not found'},{status:404}),Response.json({message:'No winners found'},{status:404}),new Response('invalid JSON',{status:404})])test(`unrecognized absence stays an error (${response.status})`,async()=>{
 await assert.rejects(fetchTarget(upTarget,context({[offersPath]:response})),e=>e instanceof MlHttpError&&e.status===response.status)
})
test('absence on a later page preserves observed offers and reports partial coverage',async()=>{
 const value=await fetchTarget(upTarget,context({[offersPath]:{results:[offer],paging:{total:2}},[offersPath+'&offset=1']:noWinners()}))
 assert.equal(value.observation.state,'observed');assert.equal(value.observation.amount,80)
 assert.equal(value.observation.coverage,'partial');assert.equal(value.observation.availabilityEvidence,undefined)
 assert.equal(value.observation.warnings?.length,1)
})
test('repeated absence retains a bounded historical observation without allowing ranking or events',()=>{
 const priced={...observe(80,'UYU',at,'user_product'),sellerId:2,itemId:'MLU12'}
 const empty={...observe(null,null,at,'user_product'),state:'no_external_offers' as const}
 let current=retainLastPricedObservation(empty,priced)
 for(let i=0;i<5;i++)current=retainLastPricedObservation(empty,current)
 assert.deepEqual(current.lastPricedObservation,priced)
 assert.equal('lastPricedObservation' in current.lastPricedObservation!,false)
 const rival={...dynamic,id:'MLUU123',observation:current,availability:'unavailable'}
 const link={...links[0],competitor_item_id:rival.id}
 assert.equal(buildAlertEvents(rival,priced,[own],[rival],[link],[rule],null).length,0)
 assert.equal(compare(own,rival,[link]).status,'no_external_offers')
 assert.equal(retainLastPricedObservation(priced,current).lastPricedObservation,undefined)
})
