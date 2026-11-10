import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectCatalogOffers } from '../../supabase/functions/_shared/catalog-offers.ts'
import { catalogRanking, isSameCatalogRival } from '../../supabase/functions/_shared/catalog.ts'
import { observe } from '../../supabase/functions/_shared/monitoring.ts'

const fx = { rate: 40, source: 'test', fetchedAt: new Date().toISOString(), publishedAt: null }
const own = { id: 'MLU1', catalog_product_id: 'MLU100', catalog_listing: true, title: 'Propio' }
const row = (id: number, price = id) => ({ item_id: `MLU${id}`, seller_id: id === 1 ? 1 : 2, price, currency_id: 'UYU' })
function upstream(rows: ReturnType<typeof row>[], evidence: Record<string, unknown> = {}) {
  const calls: string[] = []
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url.pathname + url.search)
    if (url.pathname === '/products/MLU100/items') {
      const start = Number(url.searchParams.get('offset'))
      return Response.json({results:rows.slice(start,start+20),paging:{total:rows.length}})
    }
    if (url.pathname === '/items') return Response.json(url.searchParams.get('ids')!.split(',').map(id => ({code:200,body:{id,title:`Título ${id}`,seller_id:id==='MLU1'?1:2,catalog_product_id:'MLU100',permalink:`https://articulo.mercadolibre.com.uy/${id}`}})))
    if (url.pathname.startsWith('/users/')) return Response.json({id:Number(url.pathname.split('/').pop()),nickname:'Vendedor'})
    if (url.pathname.endsWith('/price_to_win')) return Response.json({item_id:'MLU1',catalog_product_id:'MLU100',status:'competing',winner:{item_id:'MLU3'},...evidence})
    throw new Error(`Unexpected ${url}`)
  }
  return { calls, context: {token:'test',sellerId:1,fx,apiUrl:'https://ml.test',fetcher} }
}
test('all active catalog pages, metadata and sellers are collected; winner is independent of price rank', async () => {
  const source = upstream(Array.from({length:45},(_,index)=>row(index+1)))
  const {snapshot} = await collectCatalogOffers('MLU100',[own],source.context)
  assert.equal(snapshot.offers.length,45)
  assert.equal(snapshot.coverage,'complete')
  assert.equal(source.calls.filter(path=>path.startsWith('/products/')).length,3)
  assert.equal(source.calls.filter(path=>path.startsWith('/users/')).length,2)
  assert.equal(snapshot.offers[1].title,'Título MLU2')
  assert.equal(snapshot.offers[1].sellerName,'Vendedor')
  assert.equal(snapshot.buyBox.state,'verified')
  assert.equal(snapshot.buyBox.winnerId,'MLU3')
  assert.equal(catalogRanking(snapshot,'MLU1').find(offer=>offer.itemId==='MLU3')!.position,3)
})
test('ties share price position; unknown conversion has neither position nor percentage', async () => {
  const source=upstream([row(1,10),row(2,10),row(3,20)])
  const {snapshot}=await collectCatalogOffers('MLU100',[own],source.context)
  snapshot.offers.push({...snapshot.offers[0],itemId:'MLU99',observation:observe(3,'EUR',snapshot.observedAt,'catalog',fx)})
  const ranked=catalogRanking(snapshot,'MLU1')
  assert.deepEqual(ranked.map(offer=>offer.position),[1,1,3,null])
  assert.deepEqual(ranked.map(offer=>offer.relativePct),[0,0,100,null])
})
test('inconsistent and shared buy-box evidence never implies a unique cheapest winner', async () => {
  for (const evidence of [{consistent:false},{item_id:'MLU999'},{catalog_product_id:'MLU999'}]) {
    const {context}=upstream([row(1),row(2)],evidence)
    assert.equal((await collectCatalogOffers('MLU100',[own],context)).snapshot.buyBox.state,'not_verified')
  }
  const {context}=upstream([row(1),row(2)],{status:'sharing_first_place',winner:null})
  const result=await collectCatalogOffers('MLU100',[own],context)
  assert.equal(result.snapshot.buyBox.state,'shared')
  assert.equal(result.snapshot.buyBox.winnerId,null)
})
test('fixed and dynamic rivals from this catalog are classified without mutating inherited associations', async () => {
  const {context}=upstream([row(1),row(2)])
  const {snapshot}=await collectCatalogOffers('MLU100',[own],context)
  const links=[{scope:'sku',our_sku:'X'}]
  const observation={...snapshot.offers[1].observation,itemId:'MLU2'}
  const rival={id:'MLUU90',source_kind:'user_product',observation,links}
  const before=structuredClone(rival)
  assert.equal(isSameCatalogRival(rival,'MLU100',snapshot),true)
  assert.deepEqual(rival,before)
  assert.equal(isSameCatalogRival({id:'MLU100',source_kind:'catalog'},'MLU100',null),true)
  assert.equal(isSameCatalogRival({id:'MLU99'},'MLU100',snapshot),false)
})
test('duplicate pages are deduplicated and never claim complete coverage', async () => {
  const {context}=upstream([row(1),row(1),row(2)])
  const {snapshot}=await collectCatalogOffers('MLU100',[own],context)
  assert.equal(snapshot.offers.length,2)
  assert.equal(snapshot.coverage,'partial')
})
test('a failed later page rejects instead of replacing the successful snapshot with incomplete offers', async () => {
  const {context}=upstream(Array.from({length:25},(_,i)=>row(i+1)))
  const base=context.fetcher
  context.fetcher=async (input,init)=>String(input).includes('offset=20')?new Response(null,{status:503}):base(input,init)
  await assert.rejects(()=>collectCatalogOffers('MLU100',[own],context),/HTTP 503/)
})
test('metadata failures retain offer prices and declare missing details', async () => {
  const {context}=upstream([row(1),row(2)])
  const base=context.fetcher
  context.fetcher=async (input,init)=>String(input).includes('/items?ids=')?new Response(null,{status:403}):base(input,init)
  const {snapshot}=await collectCatalogOffers('MLU100',[own],context)
  assert.equal(snapshot.offers.length,2)
  assert.equal(snapshot.offers[1].observation.normalizedAmount,2)
  assert.ok(snapshot.offers[1].detailsError)
  assert.ok(snapshot.warnings.some(warning=>warning.includes('detalles')))
})
