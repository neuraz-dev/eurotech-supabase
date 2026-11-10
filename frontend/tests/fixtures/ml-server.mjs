import { createServer } from 'node:http'
// Synthetic upstream used only by local tests. No proxying to real services.
let version = 1,
  fail = false,
  onlyOwn = false
const own = {
  item_id: 'MLU101',
  seller_id: 1,
  price: 1000,
  currency_id: 'UYU',
  status: 'active',
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/control') {
    if (req.method === 'POST') {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const data = JSON.parse(raw || '{}')
      version = data.version ?? 1
      fail = data.fail ?? false
      onlyOwn = data.onlyOwn ?? false
    }
    return send({ version, fail, onlyOwn })
  }
  if (url.pathname === '/fx')
    return send({
      rates: { UYU: 40 },
      time_last_update_utc: new Date().toUTCString(),
    })
  if (fail) return send({ error: 'synthetic_failure' }, 503)
  if (url.pathname.endsWith('/price_to_win'))
    return send({
      item_id: url.pathname.split('/')[2],
      status: 'winning',
      consistent: true,
      winner: { item_id: 'MLU101' },
    })
  if (url.pathname.startsWith('/products/') && url.pathname.endsWith('/items'))
    return send({
      paging: { total: 25 },
      results: [
        own,
        ...(onlyOwn
          ? []
          : [
              {
                item_id: version === 1 ? 'MLU200' : 'MLU202',
                seller_id: version === 1 ? 2 : 3,
                price: 900,
                currency_id: 'UYU',
                condition: 'new',
                status: 'active',
              },
              {
                item_id: 'MLU203',
                seller_id: 4,
                price: 30,
                currency_id: 'USD',
                condition: 'new',
                status: 'active',
              },
            ]),
      ],
    })
  if (url.pathname.startsWith('/products/'))
    return send({ name: 'Catálogo de prueba', pictures: [] })
  if (url.pathname.endsWith('/items/search')) return send({results:url.searchParams.get('status')==='active'?['MLU100','MLU101','MLU102']:[],paging:{total:3,offset:0,limit:100}})
  if (url.pathname.startsWith('/users/'))
    return send({ nickname: `Vendedor ${url.pathname.split('/').pop()}` })
  if (url.pathname.startsWith('/categories/'))
    return send({ name: 'Prueba', path_from_root: [] })
  if (url.pathname.endsWith('/prices')) return send({ prices: [] })
  if (url.pathname === '/items')
    return send(
      (url.searchParams.get('ids') ?? '').split(',').map((id) => ({
        code: 200,
        body: {
          id,
          title: id==='MLU100'?'Producto de prueba':id==='MLU101'?'Producto de prueba catálogo':'Producto sin SKU',
          price: id==='MLU101'?1100:id==='MLU102'?500:1000,
          site_id:'MLU',
          attributes:id==='MLU102'?[]:[{id:'SELLER_SKU',value_name:'sku-test'}],
          catalog_product_id:id==='MLU101'?'MLU900':null,
          catalog_listing:id==='MLU101',
          currency_id: 'UYU',
          seller_id: 1,
          status: 'active',
        },
      })),
    )
  if(url.pathname.endsWith('/description'))return send({plain_text:'Descripción sintética'})
  if (url.pathname.startsWith('/items/')) {
    const id = url.pathname.split('/')[2]
    return send({
      id,
      title: `Rival ${id}`,
      price: 900,
      currency_id: 'UYU',
      seller_id: id === 'MLU202' ? 3 : 2,
      status: 'active',
      condition: 'new',
      available_quantity: 10,
      sold_quantity: 20,
      permalink: `https://articulo.mercadolibre.com.uy/MLU-${id.slice(3)}-_JM`,
    })
  }
  return send({ error: 'not_found' }, 404)
})
server.listen(55430, '0.0.0.0', () =>
  process.stdout.write('Synthetic Mercado Libre: 55430\n'),
)
