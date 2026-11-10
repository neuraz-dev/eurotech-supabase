'use client'
import { useState } from 'react'
import {
  compare,
  comparisonText,
  linksForProduct,
  referencePrice,
  comparisonFx,
  adjudicationLabel,
  QUALITY_LABELS,
  type OwnProduct,
  type PriceObservation,
  type CompetitorLink,
} from '@/lib/monitoring'
import MonitorDialog from './MonitorDialog'
import SourceRecoveryPanel from './SourceRecoveryPanel'
import {safeMarketplaceUrl} from '@monitoring/source-links'
export type BoardRival = {
  id: string
  title: string | null
  price: number | null
  currency_id: string | null
  status: string | null
  permalink: string | null
  seller_name: string | null
  source_kind?:'item'|'catalog'|'user_product'
  source_url?:string|null
  target_kind: 'item' | 'catalog'
  observation: PriceObservation | null
  links: CompetitorLink[]
  condition?: string | null
  attributes?: unknown[] | null
  last_error?: string | null
}
export function money(amount: number | null, currency: string | null = 'UYU') {
  if (amount == null) return '—'
  if (!currency) return `${amount.toLocaleString('es-UY')} · moneda desconocida`
  try {
    return new Intl.NumberFormat('es-UY', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount} ${currency}`
  }
}
function attributesText(values: unknown[] | null | undefined) {
  return (
    (values ?? [])
      .filter(
        (
          value,
        ): value is { name: string; value_name?: string; value?: string } =>
          !!value && typeof value === 'object' && 'name' in value,
      )
      .map(
        (value) =>
          `${value.name}: ${value.value_name ?? value.value ?? 'sin dato'}`,
      )
      .join(' · ') || 'Sin atributos fiables disponibles'
  )
}
const scopeText = (link: CompetitorLink) =>
  link.scope === 'sku'
    ? `Todas las publicaciones del SKU ${link.our_sku}`
    : `Solo ${link.our_product_id}`
export default function ComparisonBoard({
  product,
  rivals,
  compareCatalog = true,
  onChanged,
}: {
  product: OwnProduct
  rivals: BoardRival[]
  compareCatalog?: boolean
  onChanged?: () => Promise<void>
}) {
  const [overrides, setOverrides] = useState<Record<string, CompetitorLink>>({})
  const [pending, setPending] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [undo, setUndo] = useState<CompetitorLink | null>(null)
  const [review, setReview] = useState<{
    rival: BoardRival
    link: CompetitorLink
  } | null>(null)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const fx = comparisonFx(product,rivals)
  const own = referencePrice({...product,fx_quote:fx}, compareCatalog)
  const rows = rivals
    .map((rival) => {
      const links = linksForProduct(
        rival.links.map((link) => overrides[link.id] ?? link),
        product,
      )
      return {
        rival,
        links,
        result: compare(product, rival, links, { compareCatalog, fx }),
      }
    })
    .filter((row) => row.links.length)
    .sort(
      (a, b) =>
        Number(b.result.status === 'comparable') -
          Number(a.result.status === 'comparable') ||
        (a.result.rival?.normalizedAmount ?? Infinity) -
          (b.result.rival?.normalizedAmount ?? Infinity),
    )
  const validPrices = rows
    .filter((row) => row.result.status === 'comparable')
    .map((row) => row.result.rival!.normalizedAmount!)
  if (rows.some((row) => row.result.status === 'comparable'))
    validPrices.push(own.observation.normalizedAmount!)
  async function mutate(
    link: CompetitorLink,
    changes: Record<string, unknown>,
    remove = false,
  ) {
    setPending(link.id)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/api/competitors', {
        signal: AbortSignal.timeout(30_000),
        method: remove ? 'DELETE' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ associationId: link.id, ...changes }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok || !data.association)
        throw new Error(data.error ?? 'No se pudo guardar')
      setOverrides((previous) => ({ ...previous, [link.id]: data.association }))
      if (remove) setUndo(link)
      if (changes.restore) setUndo(null)
      setMessage('Guardado')
      setReview(null)
      try {
        await onChanged?.()
        if (onChanged)
          setOverrides((previous) => {
            const next = { ...previous }
            delete next[link.id]
            return next
          })
      } catch {
        setError('Guardado. No se pudo refrescar el listado; volvé a cargarlo.')
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'No se pudo guardar. Reintentá.',
      )
    } finally {
      setPending(null)
    }
  }
  async function refreshRivals() {
    setPending('refresh')
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/api/sync-competitors', { method: 'POST' }),
        data = await response.json()
      await onChanged?.()
      if (!response.ok || !data.success)
        throw new Error(
          data.error ??
            'Consulta parcial: revisá los rivales con error y reintentá.',
        )
      setMessage(
        'Rivales consultados. Si la referencia propia está desactualizada, actualizá esta publicación desde su cabecera.',
      )
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'No se pudo consultar. Reintentá.',
      )
    } finally {
      setPending(null)
    }
  }
  return (
    <section aria-label="Comparación de precios" className="space-y-3">
      {product.sku?.trim()==='7270'&&onChanged&&<SourceRecoveryPanel sku="7270" onChanged={onChanged}/>}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-xs uppercase tracking-wide text-slate-500">
          Tu referencia ·{' '}
          {own.reference === 'sale'
            ? 'Oferta'
            : own.reference === 'catalog'
              ? 'Catálogo de esta MLU'
              : 'Publicación'}
        </p>
        <p className="mt-1 text-xl font-semibold">
          {money(
            own.observation.normalizedAmount ?? own.observation.amount,
            own.observation.normalizedCurrency ?? own.observation.currency,
          )}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Consulta:{' '}
          {own.observation.observedAt
            ? new Date(own.observation.observedAt).toLocaleString('es-UY')
            : 'Sin consulta válida'}{' '}

        </p>
        <p className="mt-1 text-xs text-slate-500">
          Comparación solo de precio. Envío y financiación no incluidos.
        </p>
        {product.catalog_listing && (
          <div className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-600">
            <p>
              Menor precio observado:{' '}
              {money(product.catalog_observation?.normalizedAmount ?? null)} ·{' '}
              {product.catalog_observation?.offersConsulted ?? 0} ofertas de{' '}
              {product.catalog_observation?.offersTotal ?? 'total desconocido'}{' '}
              · Cobertura{' '}
              {product.catalog_observation?.coverage ?? 'desconocida'}
            </p>
            <p>
              Consulta:{' '}
              {product.catalog_observation?.observedAt
                ? new Date(
                    product.catalog_observation.observedAt,
                  ).toLocaleString('es-UY')
                : 'Sin dato'}
              . Observación de catálogo; no asigna posición sin equivalencia
              revisada.
            </p>
            <p>
              Adjudicación:{' '}
              {adjudicationLabel(product)}
              {product.catalog_competition?.observedAt
                ? ` · ${new Date(product.catalog_competition.observedAt).toLocaleString('es-UY')}`
                : ''}
            </p>
          </div>
        )}
        {onChanged && (
          <button
            disabled={!!pending}
            onClick={refreshRivals}
            className="mt-2 text-xs font-semibold text-blue-700 underline"
          >
            Actualizar todos los rivales y conversión
          </button>
        )}
      </div>
      {!onChanged && (
        <p className="text-xs text-slate-500">
          Para recuperar datos, cerrá el panel y usá «Actualizar propios y
          rivales». La equivalencia se revisa desde Productos.
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-emerald-700">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {undo && (
        <div
          role="status"
          className="flex gap-3 rounded-lg bg-amber-50 p-3 text-sm"
        >
          <span>Asociación quitada; historial conservado.</span>
          <button
            disabled={!!pending}
            className="font-semibold underline"
            onClick={() => mutate(undo, { restore: true })}
          >
            Deshacer
          </button>
        </div>
      )}
      {!rows.length && (
        <p className="p-3 text-sm text-slate-500">
          Sin asociaciones para esta publicación.
        </p>
      )}
      {rows.map(({ rival, links, result }) => {
        const link =
          links.find((link) => link.id === choices[rival.id]) ?? links[0]
        const o = rival.observation
        return (
          <article
            key={rival.id}
            className="rounded-xl border border-slate-200 p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">
                  {rival.title ?? rival.id}
                </h3>
                <p className="text-xs text-slate-500">
                  {rival.target_kind === 'catalog'
                    ? (rival.source_kind==='user_product'?'Producto del vendedor · Seguimiento dinámico':'Catálogo dinámico · Menor precio observado')
                    : 'Publicación fija'}{' '}
                  · {rival.id}
                </p>
              </div>
              {result.status === 'comparable' && (
                <span className="text-xs text-slate-500">
                  Posición{' '}
                  {validPrices.filter(
                    (price) => price < result.rival!.normalizedAmount!,
                  ).length + 1}
                </span>
              )}
            </div>
            <p className="mt-2 text-lg font-semibold">
              {money(
                o?.normalizedAmount ?? o?.amount ?? null,
                o?.normalizedCurrency ?? o?.currency ?? null,
              )}
            </p>
            <p
              className={`text-sm font-medium ${result.meaning === 'disadvantage' ? 'text-red-700' : result.meaning === 'advantage' ? 'text-emerald-700' : 'text-slate-600'}`}
            >
              {comparisonText(result)}
            </p>
            {result.reasons.includes('incompatible_fx') && (
              <p className="text-xs text-amber-800">
                Actualizá propios y rivales para usar la misma cotización en
                ambos lados.
              </p>
            )}
            {result.reasons.length > 1 && (
              <p className="text-xs text-amber-800">
                {result.reasons
                  .map((reason) => QUALITY_LABELS[reason])
                  .join(' · ')}
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              {o?.sellerName ?? rival.seller_name ?? 'Vendedor sin identificar'}{' '}
              · MLU observada: {o?.itemId ?? '—'} ·{' '}
              {o?.observedAt
                ? new Date(o.observedAt).toLocaleString('es-UY')
                : 'Sin consulta exitosa'}
            </p>
            {o?.currency === 'USD' && (
              <p className="text-xs text-slate-500">
                Original: {money(o.amount, 'USD')} · Cotización{' '}
                {o.fx?.rate ?? 'no disponible'} · {o.fx?.source ?? '—'} ·{' '}
                {o.fx?.fetchedAt
                  ? new Date(o.fx.fetchedAt).toLocaleString('es-UY')
                  : '—'}
              </p>
            )}
            {rival.target_kind === 'catalog' && (
              <p className="text-xs text-slate-500">
                {o?.offersConsulted ?? 0} ofertas consultadas de{' '}
                {o?.offersTotal ?? 'total desconocido'} · Cobertura{' '}
                {o?.coverage === 'complete'
                  ? 'completa'
                  : o?.coverage === 'partial'
                    ? 'parcial'
                    : 'desconocida'}
                . Adjudicación: No verificado.
              </p>
            )}
            {rival.last_error && (
              <p className="text-xs text-amber-800">
                Último intento fallido: {rival.last_error}. La vigencia no se
                renovó.
              </p>
            )}
            <div className="mt-3 border-t border-slate-100 pt-2">
              {links.length > 1 ? (
                <label className="block text-xs text-slate-600">
                  Asociación a modificar
                  <select
                    aria-label={`Asociación de ${rival.id}`}
                    value={link.id}
                    onChange={(e) =>
                      setChoices((prev) => ({
                        ...prev,
                        [rival.id]: e.target.value,
                      }))
                    }
                    className="mt-1 block w-full rounded border p-2"
                  >
                    {links.map((link) => (
                      <option key={link.id} value={link.id}>
                        {scopeText(link)} ·{' '}
                        {link.equivalence === 'accepted'
                          ? 'Aceptada'
                          : 'Por revisar'}
                        {link.paused ? ' · Suspendida' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="text-xs text-slate-600">{scopeText(link)}</p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                {links.length > 1
                  ? 'Otra asociación puede mantener activa esta comparación. '
                  : ''}
                {link.scope === 'sku'
                  ? 'Incluye publicaciones futuras con este SKU. '
                  : ''}
                Suspender no detiene las consultas compartidas.
              </p>
              <p className="text-xs text-slate-500">
                Equivalencia:{' '}
                {link.equivalence === 'accepted'
                  ? 'Aceptada'
                  : link.equivalence === 'rejected'
                    ? 'Rechazada'
                    : 'Pendiente de revisión'}
                {link.reviewed_at
                  ? ` · ${new Date(link.reviewed_at).toLocaleString('es-UY')}`
                  : ''}
                {link.review_source === 'legacy_manual_assignment' &&
                  ' · Reconocida por asignación manual previa'}
              </p>
              {onChanged && (
                <div className="mt-2 flex flex-wrap gap-3 text-xs font-medium">
                  <button
                    disabled={!!pending}
                    onClick={() => setReview({ rival, link })}
                    className="text-blue-700 underline"
                  >
                    Revisar equivalencia
                  </button>
                  <button
                    disabled={!!pending}
                    onClick={() => mutate(link, { paused: !link.paused })}
                    className="text-slate-700 underline"
                  >
                    {link.paused
                      ? 'Reanudar comparación'
                      : 'Suspender comparación'}
                  </button>
                  <button
                    disabled={!!pending}
                    onClick={() => mutate(link, {}, true)}
                    className="text-red-700 underline"
                  >
                    Quitar esta asociación
                  </button>
                  {pending === link.id && <span role="status">Guardando…</span>}
                </div>
              )}
              {rival.permalink && (
                <a
                  className="mt-2 inline-block text-xs text-blue-700 underline"
                  href={safeMarketplaceUrl(rival.permalink)??undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Ver en Mercado Libre
                </a>
              )}
            </div>
          </article>
        )
      })}
      {review && (
        <MonitorDialog
          title="Revisar equivalencia comercial"
          onClose={() => setReview(null)}
        >
          <p className="text-sm">
            Publicación propia: {product.id} · Rival:{' '}
            {review.rival.title ?? review.rival.id}
          </p>
          <p className="mt-2 text-sm">
            Atributos propios: {attributesText(product.attributes)}
          </p>
          <p className="mt-2 text-sm">
            Atributos rivales: {attributesText(review.rival.attributes)}
          </p>
          <p className="mt-2 text-sm">Alcance: {scopeText(review.link)}</p>
          <p className="mt-2 text-sm">
            Condición rival:{' '}
            {review.rival.condition ??
              review.rival.observation?.condition ??
              'Sin dato fiable'}
            . Revisá marca, modelo, capacidad, variante y cantidad en ambas
            publicaciones antes de aceptar.
          </p>
          <p className="mt-2 text-sm">
            Se compara solo precio; la ausencia de atributos no acredita
            equivalencia.{' '}
            {review.link.scope === 'sku' &&
              'La confirmación se aplicará a las publicaciones actuales y futuras del SKU.'}
          </p>
          {error && (
            <p role="alert" className="mt-2 text-red-700">
              {error}
            </p>
          )}
          <div className="mt-5 flex gap-3">
            <button
              disabled={!!pending}
              className="rounded-lg bg-blue-700 px-4 py-2 text-white"
              onClick={() => mutate(review.link, { equivalence: 'accepted' })}
            >
              Confirmo equivalencia
            </button>
            <button
              disabled={!!pending}
              className="rounded-lg border px-4 py-2"
              onClick={() => mutate(review.link, { equivalence: 'rejected' })}
            >
              No es equivalente
            </button>
          </div>
        </MonitorDialog>
      )}
    </section>
  )
}
