import assert from 'node:assert/strict'
import {test} from 'node:test'
import {buildAlertEvents,originalPriceChanged,relativeLabel,type EventSnapshot,type EventRule} from '../../supabase/functions/_shared/alert-events.ts'
import {observe,compare,type CompetitorLink} from '../../supabase/functions/_shared/monitoring.ts'
import {dateBounds,marketplaceLink} from '../src/lib/price-alerts.ts'
const old='2020-01-01T00:00:00Z'
const own={id:'MLU100',sku:'sku',title:'Propio',status:'active',price:100,sale_price:null,catalog_price:null,currency_id:'UYU',synced_at:old,catalog_listing:false}
const link:CompetitorLink={id:'link',competitor_item_id:'MLU200',scope:'publication',our_product_id:own.id,our_sku:null,equivalence:'accepted',paused:false,removed_at:null}
const rival={id:'MLU200',target_kind:'item' as const,status:'active',title:'Rival',seller_name:'Vendedor',observation:{...observe(80,'UYU',old,'item'),itemId:'MLU200'}}
const rules:EventRule[]=[1,5,20].map((threshold_pct,i)=>({id:'rule'+i,name:'Regla '+i,rule_type:'price_diff_pct_above',threshold_pct,enabled:true,sku:null,compare_catalog_price:true}))
const previous=observe(90,'UYU',old,'item')
const build=()=>buildAlertEvents(rival,previous,[own],[rival],[link],rules,null)
test('multiple matching rules produce one event per own/rival pair',()=>{
 const events=build();assert.equal(events.length,1);assert.equal((events[0].matched_rules as unknown[]).length,3)
 assert.equal(events[0].diff_pct,20)
 const snapshot=events[0].event_snapshot as EventSnapshot
 assert.equal(snapshot.relativePct,-20);assert.equal(snapshot.detectedAt,old)
})
test('initial observation, repeated price and own-only price changes do not create an event',()=>{
 assert.deepEqual(buildAlertEvents(rival,null,[own],[rival],[link],rules,null),[])
 assert.deepEqual(buildAlertEvents(rival,rival.observation,[{...own,price:300}],[rival],[link],rules,null),[])
 assert.equal(originalPriceChanged(previous,rival.observation),true)
})
test('old observations remain comparable without four-hour expiration',()=>{
 assert.equal(compare(own,rival,[link]).status,'comparable');assert.equal(build().length,1)
})
test('FX-only changes do not create an event; changed raw prices share one evaluation quote',()=>{
 const before=observe(2,'USD',old,'item',{rate:40,source:'test',fetchedAt:old,publishedAt:null})
 const fx={rate:42,source:'test',fetchedAt:old,publishedAt:null}
 const next={...rival,observation:observe(2,'USD',old,'item',fx)}
 assert.equal(originalPriceChanged(before,next.observation),false)
 assert.deepEqual(buildAlertEvents(next,before,[own],[next],[link],rules,fx),[])
 next.observation=observe(1.5,'USD',old,'item',fx)
 const events=buildAlertEvents(next,before,[own],[next],[link],rules,fx)
 assert.equal(events.length,1);assert.equal(events[0].competitor_price_after,63)
})
test('missing conversion, rejected equivalence and unavailable rival do not produce events',()=>{
 assert.deepEqual(buildAlertEvents({...rival,observation:observe(2,'USD',old,'item')},previous,[own],[rival],[link],rules,null),[])
 assert.deepEqual(buildAlertEvents(rival,previous,[own],[rival],[{...link,equivalence:'rejected'}],rules,null),[])
 assert.deepEqual(buildAlertEvents({...rival,availability:'unavailable'},previous,[own],[rival],[link],rules,null),[])
})
for(const status of ['paused','under_review','closed','inactive'])test(`own ${status} does not generate active events`,()=>{
 assert.deepEqual(buildAlertEvents(rival,previous,[{...own,status}],[rival],[link],rules,null),[])
})
test('snapshot is independent of later edits to prices and identities',()=>{
 const events=build(), snapshot=events[0].event_snapshot as EventSnapshot
 const saved=structuredClone(snapshot)
 previous.amount=91
 assert.deepEqual(snapshot,saved)
 previous.amount=90
})
test('ranking identifies the own row and shares positions on equal prices',()=>{
 const another={...rival,id:'MLU201',observation:{...observe(100,'UYU',old,'item'),itemId:'MLU201'}}
 const events=buildAlertEvents(rival,previous,[own],[rival,another],[link,{...link,id:'other',competitor_item_id:another.id}],rules,null)
 const rows=(events[0].event_snapshot as EventSnapshot).rows
 assert.deepEqual(rows.map(row=>row.position),[1,2,2]);assert.ok(rows.find(row=>row.isOwn)?.price===100)
})
test('rule-specific references remain stored while the card uses the standard reference',()=>{
 const product={...own,catalog_price:150,catalog_item_id:own.id,catalog_currency_id:'UYU',catalog_observed_at:old}
 const changed={...rival,observation:observe(120,'UYU',old,'item')}
 const applicable=[rules[0],{...rules[1],rule_type:'competitor_pricier',compare_catalog_price:false}]
 const event=buildAlertEvents(changed,previous,[product],[changed],[link],applicable,null)[0]
 assert.equal((event.matched_rules as unknown[]).length,2)
 assert.equal((event.event_snapshot as EventSnapshot).relativePct,-20)
})
test('percentages use the rival price sign and retain explicit advantage/tie labels',()=>{
 assert.equal(relativeLabel(-10),'Rival −10 % · Desventaja')
 assert.equal(relativeLabel(10),'Rival +10 % · Ventaja')
 assert.equal(relativeLabel(0),'Rival 0 % · Empate')
 assert.equal(relativeLabel(null),'Rival — · Sin comparación')
})
test('date end includes a full local day, including a DST boundary',()=>{
 const before=process.env.TZ;process.env.TZ='America/New_York'
 try{
  const range=dateBounds('2026-03-08','2026-03-08')
  assert.equal(Date.parse(range.to)-Date.parse(range.from),23*3600000)
  assert.throws(()=>dateBounds('2026-02-31',''))
  assert.throws(()=>dateBounds('2026-03-10','2026-03-09'))
 }finally{if(before===undefined)delete process.env.TZ;else process.env.TZ=before}
})
test('marketplace links reject executable and unrelated URLs',()=>{
 assert.equal(marketplaceLink('javascript:alert(1)'),null)
 assert.equal(marketplaceLink('https://example.com'),null)
 assert.equal(marketplaceLink('http://www.mercadolibre.com.uy/p/MLU1'),'https://www.mercadolibre.com.uy/p/MLU1')
})
test('price-change rules also require a usable own price and a shared conversion',()=>{
 const changeRule={...rules[0],rule_type:'price_changed'}
 assert.deepEqual(buildAlertEvents(rival,previous,[{...own,price:0}],[rival],[link],[changeRule],null),[])
 assert.deepEqual(buildAlertEvents(rival,previous,[{...own,currency_id:'USD'}],[rival],[link],[changeRule],null),[])
 const changedCurrency={...rival,observation:observe(80,'USD',old,'item')}
 const fx={rate:40,source:'test',fetchedAt:old,publishedAt:null}
 assert.equal(buildAlertEvents(changedCurrency,previous,[own],[changedCurrency],[link],[changeRule],fx).length,1)
})
