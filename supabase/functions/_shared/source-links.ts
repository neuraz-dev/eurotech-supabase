import type {MonitoringTarget,SourceKind} from './monitoring.ts'

export function safeMarketplaceUrl(value:string|null|undefined):string|null {
  if(!value)return null
  try{
    const url=new URL(value)
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!/(^|\.)mercadolibre\.com\.(uy|ar)$/i.test(url.hostname))return null
    url.protocol='https:'
    // User Products have their own route, including in legacy snapshots.
    url.pathname=url.pathname.replace(/\/p\/(ML[AU]U\d+)(?=\/|$)/i,'/up/$1')
    return url.toString()
  }catch{return null}
}
export function sourceIdentity(target:MonitoringTarget){
  const id=target.sourceId??target.id
  const kind:SourceKind=target.sourceKind??(target.kind==='item'?'item':/^ML[AU]U\d+$/i.test(id)?'user_product':'catalog')
  const given=safeMarketplaceUrl(target.sourceUrl)
  const country=id.startsWith('MLA')?'ar':'uy'
  const url=given??(kind==='item'?null:`https://www.mercadolibre.com.${country}/${kind==='user_product'?'up':'p'}/${id}`)
  return {kind,id,url}
}
export function observationLink(value:{itemPermalink?:string|null;sourceUrl?:string|null}|null|undefined,fallback:string|null|undefined){
  const item=safeMarketplaceUrl(value?.itemPermalink)
  return {url:item??safeMarketplaceUrl(value?.sourceUrl)??safeMarketplaceUrl(fallback),kind:item?'item' as const:'source' as const}
}
/** Official catalog navigation pinned to a validated offer, never the winner by accident. */
export function catalogOfferUrl(catalogId:string,itemId:string){
  if(!/^ML[AU]\d+$/.test(catalogId)||!/^ML[AU]\d+$/.test(itemId))return null
  const country=catalogId.startsWith('MLA')?'ar':'uy'
  const url=new URL(`https://www.mercadolibre.com.${country}/p/${catalogId}`)
  url.searchParams.set('pdp_filters','item_id:'+itemId)
  return url.toString()
}
