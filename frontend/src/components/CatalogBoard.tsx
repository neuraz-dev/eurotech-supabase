'use client'

import { useState } from 'react'
import { catalogOfferUrl } from '@monitoring/source-links'
import { catalogRanking, type CatalogPanel } from '@/lib/catalog'
import { formatAlertDate, relativeLabel } from '@/lib/price-alerts'
import ManualSyncControl from './ManualSyncControl'
import { MarketplaceButton, money } from './ComparisonBoard'

type CatalogProduct = { id: string; title: string; catalog_product_id: string | null }
const date = (value: string) => formatAlertDate(value, Intl.DateTimeFormat().resolvedOptions().timeZone)

export default function CatalogBoard({ product, data, loading, error, onRetry, onChanged }: {
  product: CatalogProduct
  data: CatalogPanel | null
  loading: boolean
  error: string | null
  onRetry: () => void
  onChanged: () => Promise<void>
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const snapshot = data?.snapshot
  const diagnosis = snapshot?.diagnosis
  const publication = diagnosis?.publications[product.id]
  const historical = snapshot?.lastPricedSnapshot
  const buyBox = snapshot?.buyBox
  const winner = buyBox?.winner
  const rows = snapshot ? catalogRanking(snapshot, product.id) : []
  return <section aria-label="Ofertas del catálogo" className="space-y-4 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs font-medium text-slate-500">Catálogo {product.catalog_product_id ?? 'sin identificar'}</p>
      {product.catalog_product_id && <ManualSyncControl action="catalog" origin="panel-catalogo" targetId={product.id} label="Actualizar catálogo" onComplete={onChanged} />}
    </div>
    {loading && <p role="status" className="text-sm text-slate-500">Cargando ofertas del catálogo…</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error} <button onClick={onRetry} className="font-semibold underline">Reintentar</button></p>}
    {data?.lastError && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p>La última actualización falló: {data.lastError}</p>
      {snapshot && <p className="mt-1 text-xs">Se conserva la consulta de {date(snapshot.observedAt)}.</p>}
      {!snapshot && <button onClick={onRetry} className="mt-2 font-semibold underline">Reintentar lectura</button>}
    </div>}
    {!loading && !snapshot && !error && <p className="rounded-xl border border-slate-200 p-4 text-sm text-slate-600">
      {product.catalog_product_id ? 'Catálogo pendiente de actualización. Usá «Actualizar catálogo» para consultar sus ofertas activas.' : 'Esta publicación no tiene un catálogo identificado.'}
    </p>}
    {diagnosis&&<div role="status" className={`space-y-2 rounded-xl border p-3 text-sm ${diagnosis.kind==='no_offers'&&!publication?.warning?'border-slate-200 bg-slate-50':'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <p className="font-semibold">{diagnosis.message}</p>
      <p>Publicación propia: {publication?.message??'Estado no verificable'}</p>
      {publication?.warning&&<p>{publication.warning}</p>}
      {!!diagnosis.childrenIds.length&&<p className="break-words text-xs">Productos hijos informados: {diagnosis.childrenIds.join(', ')}. Revisá la asociación de esta publicación.</p>}
      <p className="text-xs">Verificación: {date(diagnosis.observedAt)} · Ofertas HTTP {diagnosis.evidence.httpStatus} {diagnosis.evidence.message?`· ${diagnosis.evidence.message}`:''} · Catálogo HTTP {diagnosis.evidence.metadataHttpStatus}</p>
      {publication&&<p className="text-xs">Estado propio consultado: {date(publication.observedAt)} · HTTP {publication.httpStatus??'sin respuesta'}</p>}
    </div>}
    {historical&&<details className="rounded-xl border border-slate-200 p-3 text-sm text-slate-600">
      <summary className="cursor-pointer font-semibold">Última información con precios (histórica) · {date(historical.observedAt)}</summary>
      <p className="mt-2 text-xs">Estos precios no forman parte de la comparación actual.</p>
      <ul className="mt-2 space-y-1">{historical.offers.map(offer=><li key={offer.itemId}>{offer.title??offer.itemId} · {offer.sellerName??'Vendedor sin identificar'} · {money(offer.observation.amount,offer.observation.currency)}</li>)}</ul>
    </details>}
    {!!snapshot?.lastRecordedPrices?.length&&<details className="rounded-xl border border-slate-200 p-3 text-sm text-slate-600">
      <summary className="cursor-pointer font-semibold">Valores anteriores registrados (históricos)</summary>
      <p className="mt-2 text-xs">Importes conservados del registro anterior; no representan ofertas actuales verificadas.</p>
      <ul className="mt-2 space-y-1">{snapshot.lastRecordedPrices.map(value=><li key={value.publicationId}>{value.publicationId} · {value.currency?money(value.amount,value.currency):`${value.amount.toLocaleString('es-UY')} · moneda no registrada`} · {value.observedAt?date(value.observedAt):'Fecha de consulta no registrada'}</li>)}</ul>
    </details>}
    {snapshot && <>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">{buyBox?.state === 'shared' ? 'Buy-box · Primer lugar compartido' : buyBox?.state === 'verified' ? 'Ganador del buy-box' : 'Buy-box no verificado'}</h3>
            {buyBox?.state !== 'not_verified' && buyBox?.winnerId && <>
              <p className="mt-1 text-sm text-slate-800">{winner?.title ?? buyBox.winnerId}</p>
              <p className="mt-1 text-xs text-slate-600">{buyBox.winnerId} · {winner?.sellerName ?? 'Vendedor sin identificar'}</p>
              {!winner && <p className="mt-1 text-xs text-amber-800">La publicación indicada por Mercado Libre no aparece entre las ofertas consultadas.</p>}
            </>}
            {buyBox?.observedAt && <p className="mt-2 text-xs text-slate-500">Consulta del buy-box: {date(buyBox.observedAt)}</p>}
          </div>
          {buyBox?.state !== 'not_verified' && buyBox?.winnerId && <MarketplaceButton url={winner?.permalink ?? catalogOfferUrl(snapshot.catalogId, buyBox.winnerId)} title={winner?.title ?? buyBox.winnerId} />}
        </div>
      </div>
      <div className="space-y-1 text-xs text-slate-500">
        <p>{diagnosis&&diagnosis.kind!=='no_offers'?'Sin cobertura de ofertas verificable':snapshot.coverage === 'complete' ? `${rows.length} ofertas activas · Cobertura completa` : `${rows.length} ofertas consultadas de ${snapshot.total ?? 'total desconocido'} · Cobertura ${snapshot.coverage === 'partial' ? 'parcial' : 'desconocida'}`}</p>
        <p>Consulta: {date(snapshot.observedAt)} · Posición por precio</p>
        {snapshot.warnings.map(warning => <p key={warning} className="text-amber-800">{warning}</p>)}
      </div>
      {!rows.length && <p className="text-sm text-slate-600">No se encontraron ofertas activas en esta consulta.</p>}
      {!!rows.length && <ol aria-label="Ofertas activas por precio de menor a mayor" className="space-y-3">
        {rows.map(offer => {
          const isOwn = offer.itemId === product.id
          const isWinner = buyBox?.state !== 'not_verified' && offer.itemId === buyBox?.winnerId
          const open = !!expanded[offer.itemId]
          return <li key={offer.itemId} className={`rounded-xl border p-3 ${isOwn ? 'border-2 border-blue-500 bg-blue-50 text-slate-900' : 'border-slate-200 bg-white'}`}>
            <div className="flex gap-3">
              <span aria-label={`Posición${isOwn ? ' propia' : ''}`} className={`min-w-8 text-2xl font-bold tabular-nums ${isOwn ? 'text-blue-800' : 'text-slate-800'}`}>{offer.position ?? '—'}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className={`text-sm font-semibold ${isOwn ? 'text-blue-800' : 'text-slate-900'}`}>{isOwn ? 'Tu publicación' : offer.title ?? offer.itemId}</h3>
                    {isWinner && <span className="mt-1 inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{buyBox?.state === 'shared' ? 'Primer lugar compartido' : 'Ganador del buy-box'}</span>}
                  </div>
                  <MarketplaceButton url={offer.permalink} title={offer.title ?? offer.itemId} />
                </div>
                <p className="mt-1 text-xs text-slate-600">{offer.itemId} · {offer.sellerName ?? 'Vendedor sin identificar'}</p>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="text-2xl font-bold tabular-nums">{money(offer.observation.normalizedAmount ?? offer.observation.amount, offer.observation.normalizedCurrency ?? offer.observation.currency)}</p>
                  {!isOwn && offer.relativePct != null && <p className={`rounded-lg px-2 py-1 text-xs font-semibold ${offer.relativePct < 0 ? 'bg-red-50 text-red-700' : offer.relativePct > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'}`}>{relativeLabel(offer.relativePct)}</p>}
                </div>
                <button type="button" aria-expanded={open} aria-controls={`catalog-details-${offer.itemId}`} onClick={() => setExpanded(previous => ({ ...previous, [offer.itemId]: !open }))} className="mt-2 rounded text-xs font-semibold text-blue-700 hover:underline focus-visible:outline-2 focus-visible:outline-blue-600">{open ? 'cerrar detalles' : 'ver detalles'}</button>
                <div id={`catalog-details-${offer.itemId}`} hidden={!open} className="mt-3 space-y-1 border-t border-slate-200 pt-3 text-xs text-slate-600">
                  <p>Consulta: {date(offer.observation.observedAt ?? snapshot.observedAt)}</p>
                  <p>Vendedor: {offer.sellerName ?? 'Sin identificar'} · ID {offer.sellerId}</p>
                  {offer.position == null && <p className="text-amber-800">Sin posición: precio o conversión a UYU no disponible.</p>}
                  {offer.observation.currency !== 'UYU' && <p>Precio original: {money(offer.observation.amount, offer.observation.currency)} · Cotización: {snapshot.fx?.rate ?? 'no disponible'}</p>}
                  {offer.detailsError && <p className="text-amber-800">{offer.detailsError}</p>}
                </div>
              </div>
            </div>
          </li>
        })}
      </ol>}
    </>}
  </section>
}
