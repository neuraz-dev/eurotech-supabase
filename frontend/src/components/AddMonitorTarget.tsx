'use client'
import { useState } from 'react'
import MonitorDialog from './MonitorDialog'
import { normalizeSku } from '@/lib/monitoring'
import type { ObservedTarget } from '@monitoring/ml-observation'
type Preview = {
  products?: {
    id: string
    title: string
    catalog_listing: boolean
    status: string
  }[]
  count?: number
  includesFuture?: boolean
  observed: ObservedTarget | null
  pending?: boolean
}
export default function AddMonitorTarget<T>({
  kind,
  productId,
  sku = '',
  skus = [],
  initialInput = '',
  resolveId,
  onClose,
  onSaved,
}: {
  kind: 'competitor' | 'tracking'
  initialInput?: string
  resolveId?: string
  productId?: string
  sku?: string
  skus?: string[]
  onClose: () => void
  onSaved: (item: T) => void
}) {
  const [candidate,setCandidate]=useState('')
  const [input, setInput] = useState(initialInput),
    [mode, setMode] = useState(''),
    [scope, setScope] = useState('publication'),
    [ownSku, setOwnSku] = useState(normalizeSku(sku) ?? '')
  const [preview, setPreview] = useState<{ key: string; data: Preview } | null>(
      null,
    ),
    [loading, setLoading] = useState(false),
    [error, setError] = useState<string | null>(null)
  const catalog = /\/(p|up)\//i.test(input)||/^ML[AU]U\d+$/i.test(input)
  const userProduct=/\/(?:p|up)\/ML[AU]U\d+/i.test(input)||/^ML[AU]U\d+$/i.test(input)
  const key = JSON.stringify([input, mode, scope, ownSku, productId,candidate])
  const validPreview = preview?.key === key ? preview.data : null
  const endpoint =
    kind === 'competitor' ? '/api/competitors' : '/api/tracked-items'
  async function showPreview() {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        input,
        fixedItemId:candidate.trim().toUpperCase(),
        targetKind: catalog ? mode : 'item',
        scope,
        productId: productId ?? '',
        sku: ownSku,
      })
      const response = await fetch(`${endpoint}/preview?${params}`, {
          signal: AbortSignal.timeout(90_000),
        }),
        data = await response.json()
      if (!response.ok)
        throw new Error(data.error ?? 'No se pudo previsualizar')
      setPreview({ key, data })
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Error de red. Reintentá.',
      )
    } finally {
      setLoading(false)
    }
  }
  async function save() {
    if (!validPreview) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(
        resolveId ? `${endpoint}/${resolveId}` : endpoint,
        {
          signal: AbortSignal.timeout(90_000),
          method: resolveId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resolveIdentity: !!resolveId,
            itemIdOrUrl: input,
            url: input,
            ourProductId: scope === 'publication' ? productId : null,
            ourSku: ownSku || null,
            linkMode: scope === 'sku' ? 'sku' : 'mlu',
            targetKind: catalog ? mode : 'item',
            fixedItemId:
              catalog
                ? validPreview.observed?.observation.itemId??undefined
                : undefined,
          }),
        },
      )
      const data = await response.json()
      if (!response.ok || !data.ok || !data.item)
        throw new Error(data.error ?? 'No se pudo guardar')
      onSaved(data.item)
      onClose()
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Error de red. Reintentá.',
      )
    } finally {
      setLoading(false)
    }
  }
  return (
    <MonitorDialog
      title={
        kind === 'competitor'
          ? 'Agregar rival y asociación'
          : 'Agregar seguimiento'
      }
      onClose={onClose}
    >
      <div className="space-y-4">
        <label className="block text-sm">
          URL o ID de Mercado Libre
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-300 p-2.5"
          />
        </label>
        {catalog && (
          <fieldset className="rounded-lg bg-slate-50 p-3">
            <legend className="text-sm font-semibold">
              Objeto que se observará
            </legend>
            <label className="block text-sm">
              <input
                type="radio"
                name="target-kind"
                checked={mode === 'catalog'}
                onChange={() => setMode('catalog')}
              />{' '}
              {userProduct?'Producto del vendedor: seguir este User Product y verificar su MLU':'Catálogo dinámico: el vendedor y la MLU pueden cambiar'}
            </label>
            <label className="mt-2 block text-sm">
              <input
                type="radio"
                name="target-kind"
                checked={mode === 'item'}
                onChange={() => setMode('item')}
              />{' '}
              Publicación fija: conservar la MLU previsualizada
            </label>
          </fieldset>
        )}
        {userProduct&&<label className="block text-sm">MLU candidata (opcional, si la API no puede resolver el producto)
          <input value={candidate} onChange={e=>setCandidate(e.target.value)} placeholder="MLU…" className="mt-1 block w-full rounded-lg border border-slate-300 p-2.5"/>
          <span className="text-xs text-slate-500">Se verificará que pertenezca al mismo producto y vendedor antes de guardar.</span>
        </label>}
        {kind === 'competitor' && (
          <fieldset>
            <legend className="mb-1 text-sm font-semibold">
              Alcance de la asociación
            </legend>
            <label className="block text-sm">
              <input
                type="radio"
                name="association-scope"
                checked={scope === 'publication'}
                onChange={() => setScope('publication')}
              />{' '}
              Solo esta publicación ({productId})
            </label>
            <label className="mt-2 block text-sm">
              <input
                type="radio"
                name="association-scope"
                checked={scope === 'sku'}
                disabled={!sku}
                onChange={() => setScope('sku')}
              />{' '}
              Todas las publicaciones del SKU, incluidas las futuras
            </label>
          </fieldset>
        )}
        {(kind === 'tracking' || scope === 'sku') && (
          <label className="block text-sm">
            SKU propio
            {kind === 'tracking'
              ? ' (opcional; asociarlo no activa alertas)'
              : ''}
            <select
              className="mt-1 block w-full rounded-lg border p-2"
              value={ownSku}
              onChange={(e) => setOwnSku(e.target.value)}
            >
              <option value="">Sin SKU</option>
              {[
                ...new Map(
                  skus.map((s) => [normalizeSku(s) ?? '', s.trim()]),
                ).entries(),
              ]
                .filter(([value]) => value)
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
        )}
        {validPreview && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm">
            {validPreview.products && (
              <>
                <p className="font-semibold">
                  {validPreview.count} publicaciones afectadas
                </p>
                <ul className="mt-2 max-h-40 overflow-y-auto">
                  {validPreview.products.map((p) => (
                    <li key={p.id}>
                      {p.id} · {p.catalog_listing ? 'Catálogo' : 'Tradicional'}{' '}
                      · {p.status}
                    </li>
                  ))}
                </ul>
                {validPreview.includesFuture && (
                  <p className="mt-2">
                    También se aplicará a las futuras publicaciones de este SKU.
                  </p>
                )}
              </>
            )}
            {validPreview.observed ? (
              <>
                <p className="mt-2">
                  {validPreview.observed.title ?? 'Sin título'} ·{' '}
                  {validPreview.observed.target.kind === 'catalog'
                    ? 'Catálogo dinámico'
                    : 'MLU fija'}
                  : {validPreview.observed.target.id}
                </p>
                <p>
                  Vendedor observado:{' '}
                  {validPreview.observed.observation.sellerName ?? 'Sin dato'} ·
                  MLU:{' '}
                  {validPreview.observed.observation.itemId ??
                    'Sin oferta rival'}
                </p>
                <p>
                  {validPreview.observed.observation.state ===
                  'no_external_offers'
                    ? 'Sin ofertas rivales observadas'
                    : 'El mínimo consultado no verifica adjudicación.'}
                </p>
              </>
            ) : (
              <p>
                Precio pendiente de consulta; no se incluirá en comparaciones.
              </p>
            )}
            {kind === 'competitor' && (
              <p className="mt-2">
                La asociación quedará pendiente de revisión de equivalencia.
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {loading && (
          <p role="status" className="text-sm">
            {validPreview ? 'Guardando…' : 'Consultando…'}
          </p>
        )}
        <div className="flex gap-3">
          <button
            disabled={
              loading ||
              !input.trim() ||
              (catalog && !mode) ||
              (kind === 'competitor' && scope === 'sku' && !ownSku)
            }
            onClick={showPreview}
            className="rounded-lg border px-4 py-2 text-sm disabled:opacity-40"
          >
            Previsualizar
          </button>
          <button
            disabled={loading || !validPreview}
            onClick={save}
            className="rounded-lg bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            Confirmar y guardar
          </button>
        </div>
      </div>
    </MonitorDialog>
  )
}
