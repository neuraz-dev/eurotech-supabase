import {test,expect,type Page} from '@playwright/test'
import type {AlertEvent,EventSnapshot} from '../../src/lib/price-alerts'
const at='2026-11-09T12:30:00.000Z'
function event(index:number):AlertEvent{
  const snapshot:EventSnapshot={version:2,legacy:false,detectedAt:at,relativePct:-20,
    own:{id:'MLU100',sku:'3528',title:`Evento ${index}`,catalog_listing:true},
    rival:{id:'MLU200',title:'Rival guardado',sellerName:'NTHERRAMIENTASYMAQUINARIAS'},
    rows:[{id:'MLU200',isOwn:false,title:'Rival guardado',mlu:'MLU200',sellerName:'Vendedor del evento',price:80,relativePct:-20,permalink:'https://articulo.mercadolibre.com.uy/MLU-200-_JM',observation:null,position:1,reasons:[]},
      {id:'MLU100',isOwn:true,title:'Precio propio al dispararse',mlu:'MLU100',sellerName:null,price:100,relativePct:0,permalink:null,observation:null,position:2,reasons:[]}],
  }
  return {id:`00000000-0000-0000-0000-${String(index+1).padStart(12,'0')}`,fired_at:new Date(Date.parse(at)-index*60000).toISOString(),
    read_at:index%3===0?at:null,archived_at:index>=62?at:null,archive_reason:index>=62?'own_inactive':null,our_product_id:'MLU100',competitor_item_id:'MLU200',our_sku:'3528',is_legacy:false,event_snapshot:snapshot,matched_rules:[]}
}
async function mock(page:Page,{failRead=false,restoreBlocked=false,recovery=false}={}){
  const rows=Array.from({length:64},(_,i)=>event(i)), batch='11111111-1111-1111-1111-111111111111'
  if(recovery){rows[0].our_sku='7270';rows[0].event_snapshot.own.sku='7270'}
  let fail=failRead,lastQuery=new URLSearchParams(),batchIds:string[]=[]
  const selected=(q:URLSearchParams)=>rows.filter(r=>(q.get('scope')==='history'?!!r.archived_at:!r.archived_at)
    &&(!q.get('sku')||r.our_sku===q.get('sku'))&&(!q.get('from')||r.fired_at>=q.get('from')!)&&(!q.get('to')||r.fired_at<q.get('to')!))
  await page.route('**/api/alert-history**',async route=>{
    const request=route.request(),url=new URL(request.url()),id=url.pathname.split('/')[3]
    const reply=(data:unknown,status=200)=>route.fulfill({status,json:data})
    if(id){
      const row=rows.find(r=>r.id===id)!
      if(request.method()==='GET')return reply({item:row,current:{product:{id:'MLU100',sku:'3528',price:500,sale_price:null,catalog_price:null,currency_id:'UYU',status:'active',synced_at:at},competitors:[]}})
      if(request.method()==='DELETE'){row.archived_at=at;row.archive_reason='manual';return reply({ok:true,item:row})}
      const body=request.postDataJSON()
      if(body.restore){
        if(restoreBlocked)return reply({error:'La publicación ya no está disponible'},409)
        row.archived_at=null;row.archive_reason=null
      }else{
        if(fail){fail=false;return reply({error:'Guardado de lectura fallido'},500)}
        row.read_at=body.read?at:null
      }
      return reply({ok:true,item:row})
    }
    lastQuery=url.searchParams
    if(request.method()==='GET'){
      let base=selected(url.searchParams)
      if(url.searchParams.get('impact'))return reply({count:base.filter(r=>r.read_at).length})
      const counts={all:base.length,read:base.filter(r=>r.read_at).length,unread:base.filter(r=>!r.read_at).length,total:0,advantage:0,disadvantage:0,tie:0}
      if(url.searchParams.get('read')==='read')base=base.filter(r=>r.read_at)
      if(url.searchParams.get('read')==='unread')base=base.filter(r=>!r.read_at)
      counts.total=base.length;counts.disadvantage=base.length
      const offset=url.searchParams.get('cursor')?50:0
      return reply({items:base.slice(offset,offset+50),nextCursor:base.length>offset+50?'page-two':null,counts})
    }
    if(request.method()==='DELETE'){
      const matches=selected(url.searchParams).filter(r=>r.read_at)
      batchIds=matches.map(r=>r.id);for(const r of matches){r.archived_at=at;r.archive_reason='manual'}
      return reply({ok:true,count:matches.length,batchId:batch})
    }
    const body=request.postDataJSON()
    if(body.action==='restore_batch'){
      for(const r of rows.filter(r=>batchIds.includes(r.id))){r.archived_at=null;r.archive_reason=null}
      return reply({ok:true,count:batchIds.length,blocked:0})
    }
    for(const r of selected(url.searchParams))r.read_at=at
    return reply({ok:true,count:rows.length})
  })
  await page.goto('/dashboard/alertas')
  await expect(page.getByRole('article',{name:'Alerta de Evento 1',exact:true})).toBeVisible()
  return {rows,query:()=>lastQuery}
}
test('cards use event dates, pagination and separate non-overlapping actions',async({page})=>{
  await mock(page)
  const cards=page.getByRole('article')
  await expect(cards).toHaveCount(50)
  const first=cards.first()
  await expect(first).toContainText('Evento 0')
  await expect(first.locator('h2')).toContainText('3528Evento 0')
  await expect(first.locator('time')).toHaveText('Nov 09, 2026 · 7:30 am')
  await expect(first).not.toContainText('Fecha de alerta:')
  await expect(first).not.toContainText('· No leída')
  await expect(first).toContainText('Rival −20 % · Desventaja')
  const body=await first.getByRole('button').first().boundingBox(),action=await first.getByRole('button',{name:'Archivar alerta'}).boundingBox()
  expect(body!.x+body!.width).toBeLessThanOrEqual(action!.x)
  await page.getByRole('button',{name:'Siguiente →'}).click()
  await expect(cards).toHaveCount(12)
  await expect(cards.first()).toContainText('Evento 50')
})
test('failed read preserves the event and allows persisted retry and read filtering',async({page})=>{
  await mock(page,{failRead:true})
  const card=page.getByRole('article',{name:'Alerta de Evento 1',exact:true})
  await card.getByRole('button',{name:'Marcar como leída',exact:true}).click()
  await expect(page.getByRole('alert').filter({hasText:'Guardado de lectura fallido'})).toBeVisible()
  await expect(card.getByRole('button',{name:'Marcar como leída',exact:true})).toBeEnabled()
  await card.getByRole('button',{name:'Marcar como leída',exact:true}).click()
  await expect(card.getByRole('button',{name:'Marcar como no leída',exact:true})).toBeVisible()
  await page.getByRole('tab',{name:/^Leídas/}).click()
  await expect(card).toBeVisible()
})
test('archive survives reload, appears in History, and Undo restores it',async({page})=>{
  await mock(page)
  const card=page.getByRole('article',{name:'Alerta de Evento 0',exact:true})
  await card.getByRole('button',{name:'Archivar alerta'}).click()
  await expect(card).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('article',{name:'Alerta de Evento 1',exact:true})).toBeVisible()
  await expect(card).toHaveCount(0)
  await page.getByRole('tab',{name:'Historial',exact:true}).click()
  await expect(card).toContainText('Archivada por el operador')
  await page.getByRole('tab',{name:'Alertas',exact:true}).click()
  await page.getByRole('article',{name:'Alerta de Evento 1',exact:true}).getByRole('button',{name:'Archivar alerta'}).click()
  await page.getByRole('button',{name:'Deshacer',exact:true}).click()
  await expect(page.getByRole('article',{name:'Alerta de Evento 1',exact:true})).toBeVisible()
})
test('unavailable publication remains archived when Undo fails',async({page})=>{
  await mock(page,{restoreBlocked:true})
  const card=page.getByRole('article',{name:'Alerta de Evento 1',exact:true})
  await card.getByRole('button',{name:'Archivar alerta'}).click()
  await page.getByRole('button',{name:'Deshacer',exact:true}).click()
  await expect(page.getByRole('alert').filter({hasText:'ya no está disponible'})).toBeVisible()
  await expect(card).toHaveCount(0)
})
test('modal opens frozen List, separates current Details, and supports keyboard focus',async({page})=>{
  await mock(page)
  const open=page.getByRole('article',{name:'Alerta de Evento 0',exact:true}).getByRole('button').first()
  await open.click()
  const dialog=page.getByRole('dialog',{name:'Detalle de alerta'})
  await expect(dialog.getByRole('tab',{name:'Lista',exact:true})).toHaveAttribute('aria-selected','true')
  await expect(dialog.getByText('Catálogo',{exact:true})).toBeVisible()
  await expect(dialog.locator('time')).toHaveText('Nov 09, 2026 · 7:30 am')
  await expect(dialog.getByText(/Precios guardados cuando se detectó/)).toHaveCount(0)
  await expect(dialog.getByRole('link',{name:'Ver en Mercado Libre: Rival guardado'})).toBeVisible()
  await expect(dialog.getByText('Precio propio al dispararse')).toBeVisible()
  await expect(dialog.getByText(/500,00/)).toHaveCount(0)
  await dialog.getByRole('tab',{name:'Lista',exact:true}).focus()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('tab',{name:'Detalles',exact:true})).toBeFocused()
  await expect(dialog.getByText('Últimos datos consultados — separados del evento')).toBeVisible()
  await expect(dialog.getByText(/500,00/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(open).toBeFocused()
})
test('inclusive browser-local date range is sent as an exclusive UTC upper bound',async({page})=>{
  const state=await mock(page)
  await page.getByLabel('Desde',{exact:true}).fill('2026-11-09')
  await page.getByLabel('Hasta',{exact:true}).fill('2026-11-09')
  await expect.poll(()=>state.query().get('to')).toBe('2026-11-10T05:00:00.000Z')
  expect(state.query().get('from')).toBe('2026-11-09T05:00:00.000Z')
  await expect(page.getByText(/America\/Bogota · Hasta incluye/)).toBeVisible()
})
test('bulk read archive is reversible and leaves earlier automatic history alone',async({page})=>{
  const state=await mock(page)
  page.on('dialog',dialog=>dialog.accept())
  await page.getByRole('button',{name:'Archivar leídas',exact:true}).click()
  await expect(page.getByRole('button',{name:'Deshacer',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Deshacer',exact:true}).click()
  await expect(page.getByText('Archivo deshecho.',{exact:true})).toBeVisible()
  expect(state.rows[62].archive_reason).toBe('own_inactive')
})
test('authenticated real API is bounded and rejects malformed filters without writes',async({request,playwright})=>{
  const anonymous=await playwright.request.newContext({baseURL:'http://127.0.0.1:3000',storageState:{cookies:[],origins:[]}})
  expect((await anonymous.get('/api/alert-history')).status()).toBe(401)
  await anonymous.dispose()
  expect((await request.get('/api/alert-history?scope=invalid')).status()).toBe(400)
  expect((await request.get('/api/alert-history?cursor=invalid')).status()).toBe(400)
  const response=await request.get('/api/alert-history?scope=history'),data=await response.json()
  expect(response.status()).toBe(200)
  expect(data.items.length).toBeLessThanOrEqual(50)
  expect(data.counts.total).toBeGreaterThanOrEqual(data.items.length)
  expect(data.nextCursor).toBeTruthy()
  const detail=await request.get('/api/alert-history/'+data.items[0].id)
  expect(detail.status()).toBe(200)
  expect((await detail.json()).item.event_snapshot.detectedAt).toBeTruthy()
  const rule=data.items.flatMap((item:AlertEvent)=>item.matched_rules)[0]
  if(rule){
    const impact=await request.get('/api/alert-rules/'+rule.id)
    expect(impact.status()).toBe(200)
    expect((await impact.json()).count).toBeGreaterThan(0)
  }
})

test('fixed-vendor recovery preserves candidates on failure and refreshes only after persisted success',async({page})=>{
 let resolved=false,attempt=0
 await page.route('**/api/monitor-repairs**',async route=>{
  if(route.request().method()==='POST'){
   attempt++
   if(attempt===1)return route.fulfill({status:422,json:{error:'Permiso de API insuficiente'}})
   resolved=true;return route.fulfill({json:{ok:true,resolved:true}})
  }
  return route.fulfill({json:{items:resolved?[]:[{key:'legacy-fixed:7270:255754420',status:'pending',last_error:null,candidates:[
   {id:'MLU806560888',title:'Ferro 72 USD',price:72.8,currency_id:'USD',permalink:'https://www.mercadolibre.com.uy/p/MLU2081534097?pdp_filters=item_id%3AMLU806560888'},
   {id:'MLU640087141',title:'Ferro en pesos',price:3030.81,currency_id:'UYU',permalink:null},
  ]}]}})
 })
 await mock(page,{recovery:true})
 await page.getByRole('article',{name:'Alerta de Evento 0',exact:true}).getByRole('button').first().click()
 const dialog=page.getByRole('dialog')
 await dialog.getByRole('tab',{name:'Detalles',exact:true}).click()
 const panel=dialog.getByRole('complementary',{name:'Recuperación de rival original'})
 await expect(panel.getByText('Ferro 72 USD · MLU806560888')).toBeVisible()
 await panel.getByRole('button',{name:'Elegir y verificar',exact:true}).first().click()
 await expect(panel.getByRole('alert')).toContainText('Permiso de API insuficiente')
 await expect(panel.getByRole('button',{name:'Elegir y verificar',exact:true}).first()).toBeEnabled()
 await panel.getByRole('button',{name:'Elegir y verificar',exact:true}).first().click()
 await expect(panel).toHaveCount(0)
 await dialog.getByRole('tab',{name:'Lista',exact:true}).click()
 await expect(dialog.getByText('Precio propio al dispararse')).toBeVisible()
})
