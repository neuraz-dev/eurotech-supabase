import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import type { CatalogPanel, CatalogOffer, CatalogSnapshot } from '../../src/lib/catalog'
import { observe } from '../../../supabase/functions/_shared/monitoring.ts'

type Product = { id: string; title: string; catalog_listing: boolean; catalog_product_id: string }
async function products(request: APIRequestContext) {
  const response = await request.get('/api/products-page?limit=200')
  expect(response.ok()).toBeTruthy()
  return (await response.json()).products as Product[]
}
async function open(page: Page, id: string) {
  if (!page.url().endsWith('/dashboard/productos')) await page.goto('/dashboard/productos')
  const close = page.getByRole('button', { name: '×', exact: true })
  if (await close.isVisible()) await close.click()
  await page.getByPlaceholder('Buscar por título, SKU o ID...').fill(id)
  await page.getByRole('button', {name:`Abrir ${id}`,exact:true}).click()
}
function snapshot(product: Product, externalId='MLU990001'): CatalogSnapshot {
  const at = '2026-11-09T15:30:00.000Z'
  const offer = (id: string, price: number, title: string, currency='UYU'): CatalogOffer => ({
    itemId:id,title,sellerId:id===product.id?1:2,sellerName:id===product.id?'Eurotech':'Vendedor de catálogo',
    permalink:`https://articulo.mercadolibre.com.uy/${id}`,
    observation:{...observe(price,currency,at,'catalog',null),itemId:id,catalogProductId:product.catalog_product_id},
  })
  const offers=[offer(product.id,100,product.title),offer(externalId,80,'Oferta menor'),offer('MLU990002',80,'Oferta empatada'),offer('MLU990003',120,'Ganador más caro'),offer('MLU990004',2,'Sin conversión','EUR')]
  return {catalogId:product.catalog_product_id,offers,total:5,coverage:'complete',observedAt:at,fx:null,
    buyBox:{state:'verified',winnerId:'MLU990003',winner:offers[3],observedAt:at,sourceItemId:product.id,source:'price_to_win'},warnings:[]}
}
test('catalog opens first, ranks ties by price, keeps buy-box independent and hides inherited catalog rivals', async ({page,request}) => {
  const product=(await products(request)).find(product=>product.catalog_listing&&product.catalog_product_id)!
  expect(product).toBeTruthy()
  const response=await request.get(`/api/product-panel/${product.id}`)
  const original=await response.json()
  const rival=original.competitors[0]
  const externalId=rival?.observation?.itemId??(/^ML[AU]\d+$/.test(rival?.id??'')?rival.id:undefined)
  const saved=snapshot(product,externalId)
  const catalog:CatalogPanel={status:'ready',catalogId:product.catalog_product_id,snapshot:saved,lastAttemptAt:saved.observedAt,lastError:null}
  await page.route(`**/api/product-panel/${product.id}`,route=>route.fulfill({json:{...original,catalog}}))
  await open(page,product.id)
  const board=page.getByRole('region',{name:'Ofertas del catálogo'})
  await expect(board).toBeVisible()
  const cards=board.getByRole('listitem')
  await expect(cards).toHaveCount(5)
  await expect(cards.nth(0)).toContainText('Oferta menor')
  await expect(cards.nth(0).getByLabel('Posición',{exact:true})).toHaveText('1')
  await expect(cards.nth(1).getByLabel('Posición',{exact:true})).toHaveText('1')
  await expect(cards.nth(2).getByLabel('Posición propia')).toHaveText('3')
  await expect(cards.nth(3)).toContainText('Ganador del buy-box')
  await expect(cards.nth(3).getByLabel('Posición',{exact:true})).toHaveText('4')
  await expect(cards.nth(4).getByLabel('Posición',{exact:true})).toHaveText('—')
  await expect(cards.nth(4)).not.toContainText('Rival ')
  await expect(cards.nth(0)).toContainText('Rival −20 % · Desventaja')
  await cards.nth(0).getByRole('button',{name:'ver detalles',exact:true}).click()
  await expect(cards.nth(0).getByRole('button',{name:'cerrar detalles',exact:true})).toBeVisible()
  await cards.nth(0).getByRole('button',{name:'cerrar detalles',exact:true}).click()
  await expect(cards.nth(0).getByText('Consulta:',{exact:false})).toBeHidden()
  await page.getByRole('button',{name:/Precios Competidores/}).click()
  await expect(board).toBeHidden()
  if(externalId&&rival) await expect(page.getByRole('region',{name:'Comparación de precios'}).getByRole('heading',{name:rival.title??rival.id,exact:true})).toHaveCount(0)
  await page.getByRole('button',{name:'Catálogo',exact:true}).click()
  await expect(board).toBeVisible()
  await page.screenshot({path:'/tmp/eurotech-catalog-desktop.png',fullPage:false})
  await page.setViewportSize({width:390,height:844})
  await expect(board.getByRole('heading',{name:'Tu publicación',exact:true})).toBeVisible()
  const bounds=await cards.nth(0).boundingBox()
  expect(bounds!.width).toBeLessThanOrEqual(390)
  await page.screenshot({path:'/tmp/eurotech-catalog-mobile.png',fullPage:false})
})
test('traditional publications retain two tabs; pending and failed catalog states can retry',async({page,request})=>{
  const list=await products(request)
  const traditional=list.find(product=>!product.catalog_listing)!
  await open(page,traditional.id)
  await expect(page.getByRole('region',{name:'Comparación de precios'})).toBeVisible()
  await expect(page.getByRole('button',{name:'Catálogo',exact:true})).toHaveCount(0)
  const product=list.find(product=>product.catalog_listing&&product.catalog_product_id)!
  const original=await (await request.get(`/api/product-panel/${product.id}`)).json()
  let fail=true
  let refreshed=false
  await page.route(`**/api/product-panel/${product.id}`,route=>fail?route.fulfill({status:503,json:{error:'Lectura de prueba no disponible'}}):route.fulfill({json:{...original,catalog:refreshed?{status:'ready',catalogId:product.catalog_product_id,snapshot:snapshot(product),lastAttemptAt:null,lastError:null}:{status:'pending',catalogId:product.catalog_product_id,snapshot:null,lastAttemptAt:null,lastError:null}}}))
  await open(page,product.id)
  const board=page.getByRole('region',{name:'Ofertas del catálogo'})
  await expect(board.getByRole('alert')).toContainText('Lectura de prueba no disponible')
  fail=false
  await board.getByRole('button',{name:'Reintentar',exact:true}).click()
  await expect(board).toContainText('Catálogo pendiente de actualización')
  const runId='77777777-7777-4777-8777-777777777777'
  await page.route('**/api/manual-sync**',async route=>{
    if(route.request().method()==='POST') {
      expect(route.request().postDataJSON()).toMatchObject({action:'catalog',targetId:product.id,origin:'panel-catalogo'})
      await route.fulfill({status:202,json:{run:{id:runId,status:'queued'}}})
    } else {
      refreshed=true
      await route.fulfill({json:{run:{id:runId,status:'completed'}}})
    }
  })
  await board.getByRole('button',{name:'Actualizar catálogo',exact:true}).click()
  await expect(board.getByRole('listitem')).toHaveCount(5)
  await expect(board).toContainText('Actualización finalizada')
})

test('a failed refresh preserves a partial snapshot and reports shared buy-box explicitly',async({page,request})=>{
  const product=(await products(request)).find(product=>product.catalog_listing&&product.catalog_product_id)!
  const original=await (await request.get(`/api/product-panel/${product.id}`)).json()
  const saved=snapshot(product)
  saved.coverage='partial'
  saved.total=30
  saved.buyBox={...saved.buyBox,state:'shared',winnerId:null,winner:null}
  await page.route(`**/api/product-panel/${product.id}`,route=>route.fulfill({json:{...original,catalog:{status:'ready',catalogId:product.catalog_product_id,snapshot:saved,lastAttemptAt:saved.observedAt,lastError:'Catálogo HTTP 503'}}}))
  await open(page,product.id)
  const board=page.getByRole('region',{name:'Ofertas del catálogo'})
  await expect(board.getByRole('alert')).toContainText('Se conserva la consulta')
  await expect(board).toContainText('5 ofertas consultadas de 30 · Cobertura parcial')
  await expect(board.getByRole('heading',{name:'Buy-box · Primer lugar compartido',exact:true})).toBeVisible()
  await expect(board.getByRole('listitem')).toHaveCount(5)
})

for(const kind of ['no_offers','inactive_parent','catalog_not_found'] as const)test(`catalog diagnosis ${kind} separates history from the current ranking`,async({page,request})=>{
  const product=(await products(request)).find(p=>p.catalog_listing&&p.catalog_product_id)!
  const original=await(await request.get(`/api/product-panel/${product.id}`)).json()
  const previous=snapshot(product),saved=snapshot(product)
  saved.offers=[];saved.total=kind==='no_offers'?0:null;saved.coverage=kind==='no_offers'?'complete':'unknown'
  saved.buyBox={state:'not_verified',winnerId:null,winner:null,observedAt:null,sourceItemId:null,source:'price_to_win'}
  saved.lastPricedSnapshot=previous
  saved.lastRecordedPrices=[{publicationId:product.id,amount:77,currency:null,observedAt:null,source:'stored_record'}]
  saved.diagnosis={kind,message:kind==='no_offers'?'Sin ofertas de catálogo observadas':kind==='inactive_parent'?'Catálogo padre inactivo; asociación por revisar':'Catálogo no encontrado; asociación por revisar',catalogStatus:kind==='catalog_not_found'?null:kind==='inactive_parent'?'inactive':'active',childrenIds:kind==='inactive_parent'?['MLU123']:[],observedAt:saved.observedAt,
    evidence:{httpStatus:404,resource:`/products/${product.catalog_product_id}/items`,metadataResource:`/products/${product.catalog_product_id}`,metadataHttpStatus:kind==='catalog_not_found'?404:200,apiCode:'not_found',message:'No winners found'},
    publications:{[product.id]:{status:'paused',subStatus:['out_of_stock'],message:'Sin stock',observedAt:saved.observedAt,resource:`/items/bulk?ids=${product.id}`,httpStatus:200}}}
  await page.route(`**/api/product-panel/${product.id}`,route=>route.fulfill({json:{...original,catalog:{status:'ready',catalogId:product.catalog_product_id,snapshot:saved,lastAttemptAt:saved.observedAt,lastError:null}}}))
  await open(page,product.id)
  const board=page.getByRole('region',{name:'Ofertas del catálogo'})
  await expect(board.getByRole('status')).toContainText(saved.diagnosis.message)
  await expect(board.getByRole('status')).toContainText('Publicación propia: Sin stock')
  await expect(board.getByRole('alert')).toHaveCount(0)
  await expect(board.getByRole('list',{name:'Ofertas activas por precio de menor a mayor'})).toHaveCount(0)
  await expect(board.getByText('Oferta menor',{exact:false})).toBeHidden()
  const summary=board.getByText(/Última información con precios \(histórica\)/)
  await summary.focus();await page.keyboard.press('Enter')
  await expect(board.getByText('Oferta menor',{exact:false})).toBeVisible()
  await expect(board).toContainText('Estos precios no forman parte de la comparación actual')
  await board.getByText('Valores anteriores registrados (históricos)',{exact:true}).click()
  await expect(board.getByText(/moneda no registrada/)).toBeVisible()
  await expect(board.getByText(/Fecha de consulta no registrada/)).toBeVisible()
  await page.setViewportSize({width:390,height:844})
  await expect(board.getByRole('status')).toBeVisible()
  if(kind==='inactive_parent')await page.screenshot({path:'/tmp/monitor-catalog-diagnosis.png',fullPage:false})
})
