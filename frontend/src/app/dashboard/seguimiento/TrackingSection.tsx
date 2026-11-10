'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import { skuKey } from '@/lib/sku'
import AddMonitorTarget from '@/components/AddMonitorTarget'
import { money } from '@/components/ComparisonBoard'
import {safeMarketplaceUrl} from '@monitoring/source-links'
import type { PriceObservation } from '@/lib/monitoring'

type Snapshot = {
  observation?: PriceObservation | null
  currency_id?: string | null
  selected_item_id?: string | null
  seller_id?: number | null
  seller_name?: string | null
  id: string
  tracked_item_id: string
  price: number | null
  original_price: number | null
  sale_price: number | null
  available_quantity: number | null
  sold_quantity: number | null
  status: string | null
  health: number | null
  scraped_at: string
}

type TrackedItem = {
  target_review_required?: boolean
  source_kind?:'item'|'catalog'|'user_product'
  target_kind: 'item' | 'catalog'
  target_id: string
  last_error: string | null
  id: string
  ml_item_id: string
  url: string | null
  title: string | null
  thumbnail: string | null
  seller_name: string | null
  seller_id: number | null
  our_sku: string | null
  active: boolean
  created_at: string
  last_scraped_at: string | null
  latest_snapshot: Snapshot | null
  prev_snapshot: Snapshot | null
}

type Sku = {
  sku: string
  title: string
  thumbnail: string | null
  price: number | null
  catalog_price: number | null
  currency_id: string | null
}

// Effective price = sale_price (ML campaign deal) > price (regular/seller discount)
function effectivePrice(
  snap: Pick<Snapshot, 'price' | 'sale_price'> | null | undefined,
): number | null {
  if (!snap) return null
  return snap.sale_price ?? snap.price
}

function formatPrice(price: number | null, currency: string | null = null) {
  return money(price, currency)
}
function samePublication(a: Snapshot | null, b: Snapshot | null) {
  return (
    !!a?.selected_item_id &&
    a.selected_item_id === b?.selected_item_id &&
    !!a.currency_id &&
    a.currency_id === b.currency_id
  )
}

function formatDate(d: string | null) {
  if (!d) return '—'
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(d))
}

function formatRelative(d: string | null) {
  if (!d) return null
  const diff = Date.now() - new Date(d).getTime()
  const h = diff / 3600000
  if (h < 1) return 'hace minutos'
  if (h < 24) return `hace ${Math.floor(h)}h`
  const days = Math.floor(h / 24)
  return days < 30 ? `hace ${days}d` : `hace ${Math.floor(days / 30)}m`
}

function imgUrl(t: string | null) {
  if (!t) return null
  return t.replace('http://', 'https://').replace(/-I\.jpg$/, '-F.jpg')
}

function Delta({
  curr,
  prev,
  format = 'number',
  currency = null,
}: {
  curr: number | null
  prev: number | null
  format?: 'number' | 'price'
  currency?: string | null
}) {
  if (curr == null || prev == null || curr === prev) return null
  const diff = curr - prev
  const up = diff > 0
  const fmt =
    format === 'price'
      ? formatPrice(Math.abs(diff), currency)
      : String(Math.abs(diff))
  return (
    <span
      className={`text-xs font-semibold ${up ? 'text-green-600' : 'text-red-500'}`}
    >
      {up ? '▲' : '▼'} {fmt}
    </span>
  )
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    paused: 'bg-yellow-100 text-yellow-700',
    closed: 'bg-gray-100 text-gray-500',
  }
  const label: Record<string, string> = {
    active: 'Activo',
    paused: 'Pausado',
    closed: 'Cerrado',
  }
  return (
    <span
      className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${map[status ?? ''] ?? 'bg-gray-100 text-gray-500'}`}
    >
      {label[status ?? ''] ?? status ?? '—'}
    </span>
  )
}

function ProductPickerModal({
  skus,
  selected,
  onSelect,
  onClose,
}: {
  skus: Sku[]
  selected: string
  onSelect: (sku: string) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const filtered = skus.filter(
    (s) =>
      !search.trim() ||
      s.title?.toLowerCase().includes(search.toLowerCase()) ||
      s.sku.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <h3 className="text-base font-semibold text-gray-900">
            Vincular a nuestro producto
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="px-4 py-3 border-b border-gray-100 shrink-0">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por título o SKU..."
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
        <div className="overflow-y-auto flex-1 p-3 space-y-1.5">
          <button
            onClick={() => {
              onSelect('')
              onClose()
            }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${!selected ? 'border-blue-300 bg-blue-50' : 'border-gray-100 hover:border-gray-200 hover:bg-gray-50'}`}
          >
            <div className="w-10 h-10 rounded-lg bg-gray-100 shrink-0 flex items-center justify-center">
              <svg
                className="w-5 h-5 text-gray-300"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <span className="text-sm text-gray-400">Sin vincular</span>
          </button>
          {filtered.map((s) => {
            const isSelected = skuKey(selected) === skuKey(s.sku)
            const thumb = s.thumbnail
              ? s.thumbnail
                  .replace('http://', 'https://')
                  .replace(/-I\.jpg$/, '-F.jpg')
              : null
            const price = s.catalog_price ?? s.price
            return (
              <button
                key={s.sku}
                onClick={() => {
                  onSelect(s.sku)
                  onClose()
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${isSelected ? 'border-blue-300 bg-blue-50' : 'border-gray-100 hover:border-gray-200 hover:bg-gray-50'}`}
              >
                {thumb ? (
                  <Image
                    src={thumb}
                    alt=""
                    width={40}
                    height={40}
                    className="w-10 h-10 rounded-lg object-contain bg-gray-50 shrink-0"
                    unoptimized
                  />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-gray-100 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 line-clamp-1">
                    {s.title}
                  </p>
                  <p className="text-xs text-gray-400 font-mono mt-0.5">
                    {s.sku}
                  </p>
                </div>
                {price != null && (
                  <span className="text-sm font-semibold text-gray-900 shrink-0">
                    {new Intl.NumberFormat('es-UY', {
                      style: 'currency',
                      currency: s.currency_id ?? 'UYU',
                      maximumFractionDigits: 0,
                    }).format(price)}
                  </span>
                )}
                {isSelected && (
                  <svg
                    className="w-4 h-4 text-blue-600 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function HistoryPanel({
  item,
  onClose,
  skus,
  onUpdated,
}: {
  item: TrackedItem
  onClose: () => void
  skus: Sku[]
  onUpdated: (item: TrackedItem) => void
}) {
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [linkSku, setLinkSku] = useState(item.our_sku ?? '')
  const [savingLink, setSavingLink] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(false)

  useEffect(() => {
    fetch(`/api/tracked-items/${item.id}/snapshots`)
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok || !Array.isArray(data))
          throw new Error(data.error ?? 'No se pudo cargar el historial')
        return data
      })
      .then((data) => {
        setSnapshots(data)
        setLoading(false)
      })
      .catch((error) => {
        setSaveError(
          error instanceof Error
            ? error.message
            : 'No se pudo cargar el historial',
        )
        setLoading(false)
      })
  }, [item.id])

  async function saveLink() {
    setSavingLink(true)
    setSaveError(null)
    setSaveStatus(null)
    try {
      const response = await fetch(`/api/tracked-items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ our_sku: linkSku || null }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok || !data.item)
        throw new Error(data.error ?? 'No se pudo guardar el vínculo')
      onUpdated(data.item)
      setSaveStatus('Guardado')
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Error de red')
    } finally {
      setSavingLink(false)
    }
  }

  const skuMap = new Map(skus.map((s) => [skuKey(s.sku), s]))

  return (
    <div className="fixed inset-0 z-40" onClick={onClose}>
      <div
        className="absolute top-0 right-0 h-full w-full max-w-xl bg-white shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {saveStatus && (
          <p role="status" className="px-5 pt-3 text-sm text-emerald-700">
            {saveStatus}
          </p>
        )}
        {saveError && (
          <p role="alert" className="px-5 pt-3 text-sm text-red-700">
            {saveError}
          </p>
        )}
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-start gap-3 min-w-0 flex-1 pr-3">
            {item.thumbnail && (
              <Image
                src={imgUrl(item.thumbnail)!}
                alt=""
                width={48}
                height={48}
                className="w-12 h-12 rounded-lg object-contain bg-gray-50 shrink-0"
                unoptimized
              />
            )}
            <div className="min-w-0">
              <p className="font-semibold text-gray-900 line-clamp-2 text-sm leading-snug">
                {item.title ?? item.ml_item_id}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {item.seller_name ?? '—'}
              </p>
              {item.url && (
                <a
                  href={safeMarketplaceUrl(item.url)??undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-500 hover:text-blue-700 font-medium"
                >
                  Ver en ML →
                </a>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none shrink-0"
          >
            ×
          </button>
        </div>

        {/* Link to SKU */}
        <div className="px-5 py-3 border-b border-gray-100 shrink-0">
          <p className="text-xs text-gray-500 mb-2">
            Vinculado a nuestro producto
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              className="flex-1 flex items-center gap-2.5 px-3 py-2 border border-gray-200 rounded-xl hover:border-gray-300 hover:bg-gray-50 transition-colors text-left"
            >
              {linkSku && skuMap.get(skuKey(linkSku)) ? (
                (() => {
                  const p = skuMap.get(skuKey(linkSku))!
                  const thumb = p.thumbnail
                    ? p.thumbnail
                        .replace('http://', 'https://')
                        .replace(/-I\.jpg$/, '-F.jpg')
                    : null
                  const price = p.catalog_price ?? p.price
                  return (
                    <>
                      {thumb ? (
                        <Image
                          src={thumb}
                          alt=""
                          width={32}
                          height={32}
                          className="w-8 h-8 rounded-lg object-contain bg-gray-50 shrink-0"
                          unoptimized
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-lg bg-gray-100 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-900 line-clamp-1">
                          {p.title}
                        </p>
                        <p className="text-xs text-gray-400 font-mono">
                          {p.sku}
                        </p>
                      </div>
                      {price != null && (
                        <span className="text-xs font-semibold text-gray-700 shrink-0">
                          {new Intl.NumberFormat('es-UY', {
                            style: 'currency',
                            currency: p.currency_id ?? 'UYU',
                            maximumFractionDigits: 0,
                          }).format(price)}
                        </span>
                      )}
                      <span className="text-xs text-blue-600 font-medium shrink-0">
                        Cambiar
                      </span>
                    </>
                  )
                })()
              ) : (
                <>
                  <div className="w-8 h-8 rounded-lg bg-gray-100 shrink-0 flex items-center justify-center">
                    <svg
                      className="w-3.5 h-3.5 text-gray-300"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </div>
                  <span className="text-sm text-gray-400">
                    Seleccionar producto...
                  </span>
                </>
              )}
            </button>
            <button
              onClick={saveLink}
              disabled={savingLink || linkSku === (item.our_sku ?? '')}
              className="px-3 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >
              {savingLink ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </div>

        {/* Snapshots table */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              Cargando...
            </div>
          ) : !snapshots || snapshots.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              Sin historial aún
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50 z-10">
                <tr className="text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100">
                  <th className="px-4 py-2.5 text-left font-medium">Fecha</th>
                  <th className="px-4 py-2.5 text-right font-medium">Precio</th>
                  <th className="px-4 py-2.5 text-right font-medium">Stock</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Vendidos
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {snapshots.map((snap, i) => {
                  const older = snapshots[i + 1]
                  const next = samePublication(snap, older) ? older : null
                  const priceChanged =
                    next && effectivePrice(snap) !== effectivePrice(next)
                  const stockChanged =
                    next && snap.available_quantity !== next.available_quantity
                  const soldChanged =
                    next && snap.sold_quantity !== next.sold_quantity
                  const anyChange =
                    priceChanged || stockChanged || soldChanged || !next

                  return (
                    <tr
                      key={snap.id}
                      className={`${anyChange ? '' : 'opacity-50'} hover:bg-gray-50`}
                    >
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                        {formatDate(snap.scraped_at)}
                        <p>
                          {snap.seller_name ?? 'Vendedor sin dato'} ·{' '}
                          {snap.selected_item_id ?? 'MLU sin resolver'}
                        </p>
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        {(() => {
                          const eff = effectivePrice(snap)
                          const effNext = effectivePrice(next)
                          const refPrice =
                            snap.original_price ??
                            (snap.sale_price != null ? snap.price : null)
                          const discountPct =
                            eff != null && refPrice != null && refPrice > eff
                              ? Math.round((1 - eff / refPrice) * 100)
                              : null
                          return (
                            <>
                              <span
                                className={`font-medium ${priceChanged && eff! < effNext! ? 'text-green-600' : priceChanged ? 'text-red-500' : 'text-gray-900'}`}
                              >
                                {formatPrice(eff, snap?.currency_id ?? null)}
                              </span>
                              {refPrice != null && discountPct != null && (
                                <div className="flex items-center justify-end gap-1 mt-0.5">
                                  <span className="text-xs text-gray-400 line-through">
                                    {formatPrice(
                                      refPrice,
                                      snap?.currency_id ?? null,
                                    )}
                                  </span>
                                  <span className="text-xs font-semibold text-green-600">
                                    -{discountPct}%
                                  </span>
                                </div>
                              )}
                              {priceChanged && effNext != null && (
                                <div className="text-xs text-gray-400 line-through mt-0.5">
                                  {formatPrice(
                                    effNext,
                                    next?.currency_id ?? null,
                                  )}
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <span
                          className={`font-medium ${stockChanged ? (snap.available_quantity! > next!.available_quantity! ? 'text-green-600' : 'text-red-500') : 'text-gray-700'}`}
                        >
                          {snap.available_quantity ?? '—'}
                        </span>
                        {stockChanged && (
                          <span
                            className={`ml-1 text-xs font-semibold ${snap.available_quantity! > next!.available_quantity! ? 'text-green-600' : 'text-red-500'}`}
                          >
                            {snap.available_quantity! >
                            next!.available_quantity!
                              ? '▲'
                              : '▼'}
                            {Math.abs(
                              snap.available_quantity! -
                                next!.available_quantity!,
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <span
                          className={`font-medium ${soldChanged ? 'text-blue-600' : 'text-gray-700'}`}
                        >
                          {snap.sold_quantity ?? '—'}
                        </span>
                        {soldChanged &&
                          snap.sold_quantity! > next!.sold_quantity! && (
                            <span className="ml-1 text-xs font-semibold text-blue-600">
                              +{snap.sold_quantity! - next!.sold_quantity!}
                            </span>
                          )}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={snap.status} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showPicker && (
        <ProductPickerModal
          skus={skus}
          selected={linkSku}
          onSelect={(sku) => {
            setLinkSku(sku)
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </div>
  )
}

export default function TrackingSection({
  initialItems,
  skus,
}: {
  initialItems: TrackedItem[]
  skus: Sku[]
}) {
  const [items, setItems] = useState<TrackedItem[]>(initialItems)
  const [showAdd, setShowAdd] = useState(false)
  const [resolveItem, setResolveItem] = useState<TrackedItem | null>(null)
  const [selected, setSelected] = useState<TrackedItem | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [undoItem, setUndoItem] = useState<TrackedItem | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  const skuMap = new Map(skus.map((s) => [skuKey(s.sku), s.title]))

  async function handleSync() {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const res = await fetch('/api/sync-tracked', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Error')
      setSyncMsg(`${data.snapshots_stored} cambios detectados`)
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : 'Error')
    } finally {
      // Always refresh items from DB after sync (success or partial)
      try {
        const fresh = await fetch('/api/tracked-items').then((r) => r.json())
        if (Array.isArray(fresh)) setItems(fresh)
      } catch {
        /* keep existing state */
      }
      setSyncing(false)
      setTimeout(() => setSyncMsg(null), 4000)
    }
  }

  async function handleDelete(id: string) {
    setPendingId(id)
    setActionError(null)
    try {
      const response = await fetch(`/api/tracked-items/${id}`, {
        method: 'DELETE',
      })
      const data = await response.json()
      if (!response.ok || !data.ok || !data.item)
        throw new Error(data.error ?? 'No se pudo dejar de seguir')
      setUndoItem(data.item)
      setItems((previous) => previous.filter((item) => item.id !== id))
      if (selected?.id === id) setSelected(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Error de red')
    } finally {
      setPendingId(null)
    }
  }
  async function restoreTracking() {
    if (!undoItem) return
    setPendingId(undoItem.id)
    setActionError(null)
    try {
      const response = await fetch(`/api/tracked-items/${undoItem.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok || !data.item)
        throw new Error(data.error ?? 'No se pudo recuperar')
      setItems((previous) => [
        data.item,
        ...previous.filter((item) => item.id !== data.item.id),
      ])
      setUndoItem(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Error de red')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div>
      {actionError && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {actionError}
        </p>
      )}
      {undoItem && (
        <div
          role="status"
          className="mb-3 flex gap-3 rounded-lg bg-amber-50 p-3 text-sm"
        >
          Seguimiento desactivado; historial conservado.
          <button
            disabled={!!pendingId}
            onClick={restoreTracking}
            className="font-semibold underline"
          >
            Deshacer
          </button>
        </div>
      )}
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <span className="text-base leading-none">+</span> Agregar
        </button>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 bg-white text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <svg
            className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          {syncing ? 'Sincronizando...' : 'Sincronizar'}
        </button>
        {syncMsg && <span className="text-sm text-gray-500">{syncMsg}</span>}
        <span className="ml-auto text-sm text-gray-400">
          {items.length} productos
        </span>
      </div>

      {/* Empty state */}
      {items.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-xl p-12 text-center">
          <p className="text-gray-400 text-sm mb-3">
            No hay productos bajo seguimiento.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium"
          >
            Agregar el primero →
          </button>
        </div>
      ) : (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-400 uppercase tracking-wide">
                <th className="px-4 py-3 font-medium w-14"></th>
                <th className="px-4 py-3 font-medium">Producto</th>
                <th className="px-4 py-3 font-medium">Vinculado</th>
                <th className="px-4 py-3 font-medium text-right">Precio</th>
                <th className="px-4 py-3 font-medium text-right">Stock</th>
                <th className="px-4 py-3 font-medium text-right">Vendidos</th>
                <th className="px-4 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 font-medium">Último sync</th>
                <th className="px-4 py-3 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map((item) => {
                const snap = item.latest_snapshot
                const prev = samePublication(
                  item.latest_snapshot,
                  item.prev_snapshot,
                )
                  ? item.prev_snapshot
                  : null
                const isSelected = selected?.id === item.id

                return (
                  <tr
                    key={item.id}
                    onClick={() => setSelected(isSelected ? null : item)}
                    className={`cursor-pointer transition-colors ${isSelected ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                  >
                    <td className="px-4 py-2.5">
                      {item.thumbnail ? (
                        <Image
                          src={imgUrl(item.thumbnail)!}
                          alt=""
                          width={48}
                          height={48}
                          className="w-12 h-12 rounded-lg object-contain bg-gray-50"
                          unoptimized
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-gray-100" />
                      )}
                    </td>
                    <td className="px-4 py-2.5 max-w-xs">
                      <p className="font-medium text-gray-900 line-clamp-2 text-sm leading-snug">
                        {item.title ?? item.ml_item_id}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {item.target_review_required
                          ? 'Identidad por revisar'
                          : item.target_kind === 'catalog'
                            ? (item.source_kind==='user_product'?'Producto del vendedor · Seguimiento dinámico':'Catálogo dinámico · Menor precio observado')
                            : 'Publicación fija'}{' '}
                        · {item.seller_name ?? '—'} ·{' '}
                        <span className="font-mono">{item.ml_item_id}</span>
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      {item.our_sku ? (
                        <div>
                          <span className="font-mono text-xs bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">
                            {item.our_sku}
                          </span>
                          {skuMap.get(skuKey(item.our_sku)) && (
                            <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
                              {skuMap.get(skuKey(item.our_sku))}
                            </p>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {(() => {
                        const eff = effectivePrice(snap)
                        const basePrice = snap?.price ?? null
                        // reference price for strikethrough: original_price (seller discount) or price (when sale_price exists)
                        const refPrice =
                          snap?.original_price ??
                          (snap?.sale_price != null ? basePrice : null)
                        const discountPct =
                          eff != null && refPrice != null && refPrice > eff
                            ? Math.round((1 - eff / refPrice) * 100)
                            : null
                        return (
                          <>
                            <span className="font-semibold text-gray-900">
                              {formatPrice(eff, snap?.currency_id ?? null)}
                            </span>
                            {refPrice != null && discountPct != null && (
                              <div className="flex items-center justify-end gap-1 mt-0.5">
                                <span className="text-xs text-gray-400 line-through">
                                  {formatPrice(
                                    refPrice,
                                    snap?.currency_id ?? null,
                                  )}
                                </span>
                                <span className="text-xs font-semibold text-green-600">
                                  -{discountPct}%
                                </span>
                              </div>
                            )}
                          </>
                        )
                      })()}
                      <div className="mt-0.5">
                        <Delta
                          curr={effectivePrice(snap)}
                          prev={effectivePrice(prev)}
                          format="price"
                          currency={snap?.currency_id ?? null}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <span className="font-medium text-gray-700">
                        {snap?.available_quantity ?? '—'}
                      </span>
                      <div className="mt-0.5">
                        <Delta
                          curr={snap?.available_quantity ?? null}
                          prev={prev?.available_quantity ?? null}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <span className="font-medium text-gray-700">
                        {snap?.sold_quantity ?? '—'}
                      </span>
                      <div className="mt-0.5">
                        {snap?.sold_quantity != null &&
                          prev?.sold_quantity != null &&
                          snap.sold_quantity > prev.sold_quantity && (
                            <span className="text-xs font-semibold text-blue-600">
                              +{snap.sold_quantity - prev.sold_quantity}
                            </span>
                          )}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={snap?.status ?? null} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-400 whitespace-nowrap">
                      {formatRelative(item.last_scraped_at)}
                      {item.last_error && (
                        <p className="text-amber-700">
                          Consulta fallida; dato anterior
                        </p>
                      )}
                    </td>
                    <td
                      className="px-4 py-2.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {item.target_review_required && (
                        <button
                          onClick={() => setResolveItem(item)}
                          className="mr-2 text-xs text-amber-800 underline"
                        >
                          Revisar objeto
                        </button>
                      )}
                      <button
                        disabled={!!pendingId}
                        onClick={() => handleDelete(item.id)}
                        className="text-gray-300 hover:text-red-400 transition-colors text-lg leading-none"
                        title="Dejar de seguir"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {resolveItem && (
        <AddMonitorTarget<TrackedItem>
          kind="tracking"
          initialInput={resolveItem.url ?? resolveItem.target_id}
          resolveId={resolveItem.id}
          skus={skus.map((sku) => sku.sku)}
          onClose={() => setResolveItem(null)}
          onSaved={(item) => {
            setItems((previous) =>
              previous.map((row) => (row.id === item.id ? item : row)),
            )
            setResolveItem(null)
          }}
        />
      )}
      {showAdd && (
        <AddMonitorTarget<TrackedItem>
          kind="tracking"
          skus={skus.map((sku) => sku.sku)}
          onClose={() => setShowAdd(false)}
          onSaved={(item) => {
            setUndoItem(null)
            setItems((prev) => [
              item,
              ...prev.filter((existing) => existing.id !== item.id),
            ])
            setShowAdd(false)
          }}
        />
      )}

      {selected && (
        <HistoryPanel
          item={selected}
          skus={skus}
          onUpdated={(item) => {
            setItems((previous) =>
              previous.map((row) => (row.id === item.id ? item : row)),
            )
            setSelected(item)
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
