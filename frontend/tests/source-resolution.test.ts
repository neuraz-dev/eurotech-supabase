import assert from 'node:assert/strict'
import {test} from 'node:test'
import {fetchTarget,parseTarget,MlHttpError,type MlContext} from '../../supabase/functions/_shared/ml-observation.ts'
import {safeMarketplaceUrl,sourceIdentity} from '../../supabase/functions/_shared/source-links.ts'
import {fixedCandidates,isConfirmedSource404,type Recovery} from '../../supabase/functions/_shared/source-recovery.ts'
import {buildAlertEvents,type EventRule,type EventSnapshot} from '../../supabase/functions/_shared/alert-events.ts'
import {observe,type CompetitorLink,compare} from '../../supabase/functions/_shared/monitoring.ts'
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
test('User Product reuses a candidate only after validating identity and seller, never /products',async()=>{
 const calls:string[]=[]
 const value=await fetchTarget({...parseTarget('https://www.mercadolibre.com.uy/up/MLUU123'),itemId:'MLU12',sellerId:2},context({'/items/MLU12':item},calls))
 assert.equal(value.observation.itemId,'MLU12');assert.equal(value.observation.resolution?.sourceId,'MLUU123')
 assert.equal(value.permalink,'https://www.mercadolibre.com.uy/up/MLUU123')
 assert.equal(value.observation.itemPermalink,item.permalink);assert.deepEqual(calls,['/items/MLU12'])
})
test('wrong candidate is not silently adopted; official User Product discovery must prove membership',async()=>{
 const value=await fetchTarget({...parseTarget('https://www.mercadolibre.com.uy/up/MLUU123'),itemId:'MLU11'},context({
 '/items/MLU11':{...item,id:'MLU11',user_product_id:'MLUU444'},'/user-products/MLUU123':{id:'MLUU123',user_id:2},
 '/users/2/items/search?user_product_id=MLUU123&limit=100':{results:['MLU12'],paging:{total:1}},'/items/MLU12':item,
 }))
 assert.equal(value.observation.itemId,'MLU12')
})
test('ambiguous User Product remains unresolved',async()=>{
 await assert.rejects(fetchTarget(parseTarget('https://www.mercadolibre.com.uy/up/MLUU123'),context({
 '/user-products/MLUU123':{id:'MLUU123',user_id:2},'/users/2/items/search?user_product_id=MLUU123&limit=100':{results:['MLU12','MLU13'],paging:{total:2}},
 '/items/MLU12':item,'/items/MLU13':{...item,id:'MLU13'},
 })),/Varias publicaciones/)
})
for(const status of [401,403,429,500])test(`User Product HTTP ${status} retains a technical error`,async()=>{
 await assert.rejects(fetchTarget({...parseTarget('https://www.mercadolibre.com.uy/up/MLUU123'),itemId:'MLU12'},context({'/items/MLU12':status})),e=>e instanceof MlHttpError&&e.status===status)
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
