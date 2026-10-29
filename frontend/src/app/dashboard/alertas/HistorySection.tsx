'use client'

import { useState, useEffect, type Dispatch, type SetStateAction } from 'react'
import Image from 'next/image'
import RuleTypeBadge from './RuleTypeBadge'
import { competitorName, filterPublicationAlerts, removeAlerts, updateAlertReadAt, type PublicationAlert } from '@/lib/price-alerts'

type Rule = { id: string; name: string }
type Sku = { sku: string; title: string }

type PanelData = {
  product: {
    id: string
    title: string
    sku: string | null
    price: number | null
    sale_price: number | null
    buybox_price: number | null
    status: string | null
    thumbnail: string | null
    permalink: string | null
    currency_id: string | null
    available_quantity: number | null
    pictures: { secure_url?: string; url?: string }[] | null
  } | null
  competitors: {
    id: string
    title: string | null
    price: number | null
    currency_id: string | null
    usd_price: number | null
    thumbnail: string | null
    permalink: string | null
    seller_name: string | null
    status: string | null
    paused: boolean | null
  }[]
}

function formatPrice(price: number | null, currency?: string | null) {
  if (price == null) return '—'
  return new Intl.NumberFormat('es-UY', {
    style: 'currency',
    currency: currency ?? 'UYU',
    maximumFractionDigits: 0,
  }).format(price)
}

function formatRelative(dateStr: string) {
  const d = new Date(dateStr)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'ahora'
  if (mins < 60) return `hace ${mins} min`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `hace ${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `hace ${days}d`
  return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }).format(d)
}

function imgUrl(thumbnail: string | null) {
  if (!thumbnail) return null
  return thumbnail.replace('http://', 'https://').replace(/-I\.jpg$/, '-F.jpg')
}

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  closed: 'bg-gray-100 text-gray-600',
}
const STATUS_LABEL: Record<string, string> = {
  active: 'Activo', paused: 'Pausado', closed: 'Cerrado', under_review: 'En revisión', inactive: 'Inactivo',
}

export default function HistorySection({
  alerts,
  setAlerts,
  skus,
  rules,
}: {
  alerts: PublicationAlert[]
  setAlerts: Dispatch<SetStateAction<PublicationAlert[]>>
  skus: Sku[]
  rules: Rule[]
}) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [filterStatus, setFilterStatus] = useState<'all' | 'active'>('all')
  const [actionError, setActionError] = useState<string | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [filterSku, setFilterSku] = useState('')
  const [filterRule, setFilterRule] = useState('')
  const [filterCompetitor, setFilterCompetitor] = useState('')
  const [deletingRead, setDeletingRead] = useState(false)
  const [panelTarget, setPanelTarget] = useState<string | null>(null)
  const [panelData, setPanelData] = useState<PanelData | null>(null)
  const [panelLoading, setPanelLoading] = useState(false)

  const competitorOptions = Array.from(new Set(
    alerts
      .map(competitorName)
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, 'es'))

  function getAlertPanelTarget(alert: PublicationAlert) {
    return alert.owner_product_id
  }

  const visible = filterPublicationAlerts(alerts, {
    read: filter, sku: filterSku, rule: filterRule, competitor: filterCompetitor, status: filterStatus,
  })
  const unreadCount = alerts.filter(a => !a.read_at).length
  const hasActiveFilters = filter !== 'all' || filterStatus !== 'all' || !!filterSku || !!filterRule || !!filterCompetitor

  useEffect(() => {
    if (!panelTarget) return
    const controller = new AbortController()
    fetch(`/api/product-panel/${encodeURIComponent(panelTarget)}`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? 'No se pudo cargar la publicación.')
        return data
      })
      .then(data => { if (!controller.signal.aborted) setPanelData(data) })
      .catch(error => { if (!controller.signal.aborted) setPanelError(error instanceof Error ? error.message : 'No se pudo cargar la publicación.') })
      .finally(() => { if (!controller.signal.aborted) setPanelLoading(false) })
    return () => controller.abort()
  }, [panelTarget])

  function openPanel(target: string | null) {
    setPanelData(null)
    setPanelError(null)
    setPanelLoading(!!target)
    setPanelTarget(target)
  }

  async function requestAction(url: string, method: string) {
    const response = await fetch(url, { method })
    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error ?? 'No se pudo guardar el cambio.')
    }
  }

  async function markRead(id: string) {
    setActionError(null)
    try {
      await requestAction(`/api/alert-history/${id}`, 'PATCH')
      setAlerts(prev => updateAlertReadAt(prev, new Set([id]), new Date().toISOString()))
    } catch (error) { setActionError(error instanceof Error ? error.message : 'No se pudo marcar la alerta.') }
  }

  async function markAllRead() {
    setActionError(null)
    const ids = [...new Set(visible.filter(a => !a.read_at).map(a => a.id))]
    const results = await Promise.allSettled(ids.map(id => requestAction(`/api/alert-history/${id}`, 'PATCH')))
    const saved = new Set(ids.filter((_, index) => results[index].status === 'fulfilled'))
    setAlerts(prev => updateAlertReadAt(prev, saved, new Date().toISOString()))
    if (saved.size !== ids.length) setActionError('No se pudieron marcar todas las alertas. Volvé a intentarlo.')
  }

  async function deleteRead() {
    if (!confirm('¿Eliminar todas las alertas leídas?')) return
    setDeletingRead(true)
    setActionError(null)
    try {
      await requestAction('/api/alert-history', 'DELETE')
      setAlerts(prev => prev.filter(a => !a.read_at))
    } catch (error) { setActionError(error instanceof Error ? error.message : 'No se pudieron eliminar las alertas.') }
    finally { setDeletingRead(false) }
  }

  async function deleteAlert(id: string) {
    setActionError(null)
    try {
      await requestAction(`/api/alert-history/${id}`, 'DELETE')
      setAlerts(prev => removeAlerts(prev, new Set([id])))
    } catch (error) { setActionError(error instanceof Error ? error.message : 'No se pudo eliminar la alerta.') }
  }

  function resetFilters() {
    setFilter('all')
    setFilterStatus('all')
    setFilterSku('')
    setFilterRule('')
    setFilterCompetitor('')
  }

  // Build sorted price list for panel
  const panelEntries = (() => {
    if (!panelData?.product) return []
    const { price: pubPrice, sale_price: salePrice, currency_id } = panelData.product
    type Entry = { key: string; label: string; price: number; isOurs: boolean; oursType?: 'pub' | 'sale'; usd_price?: number | null; thumbnail?: string | null; permalink?: string | null; seller?: string | null }
    const entries: Entry[] = []
    if (salePrice != null) entries.push({ key: 'our-sale', label: 'Mi precio oferta', price: salePrice, isOurs: true, oursType: 'sale' })
    else if (pubPrice != null) entries.push({ key: 'our-pub', label: 'Mi precio', price: pubPrice, isOurs: true, oursType: 'pub' })
    for (const c of panelData.competitors) {
      if (c.price != null && !c.paused && !['paused', 'closed'].includes(c.status ?? '')) {
        entries.push({ key: c.id, label: c.seller_name ?? c.title ?? c.id, price: c.price, isOurs: false, usd_price: c.usd_price, thumbnail: c.thumbnail, permalink: c.permalink, seller: c.seller_name })
      }
    }
    const refPrice = salePrice ?? pubPrice
    return entries
      .sort((a, b) => a.price - b.price)
      .map(e => ({
        ...e,
        diff: refPrice && !e.isOurs ? ((e.price - refPrice) / refPrice) * 100 : null,
        currency: currency_id,
      }))
  })()

  return (
    <section>
      {actionError && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{actionError}</p>}
      {/* Toolbar */}
      <div className="bg-white border border-gray-100 rounded-xl mb-4 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-gray-100">
          {/* Read/all segmented toggle */}
          <div className="flex rounded-lg bg-gray-50 p-0.5 shrink-0">
            <button
              onClick={() => setFilter('unread')}
              className={`relative px-3 py-1 text-xs font-medium rounded-md transition-all ${filter === 'unread' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              No leídas
              {unreadCount > 0 && (
                <span className={`ml-1.5 text-[10px] font-semibold px-1.5 rounded ${filter === 'unread' ? 'bg-red-100 text-red-600' : 'bg-gray-200 text-gray-500'}`}>{unreadCount}</span>
              )}
            </button>
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${filter === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Todas
            </button>
          </div>

          <div className="h-5 w-px bg-gray-200 mx-1 shrink-0" />

          <select
            aria-label="Estado de la publicación"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value as 'all' | 'active')}
            className="bg-transparent border-0 text-xs text-gray-700 font-medium focus:outline-none focus:ring-0 pr-7 py-1 cursor-pointer"
          >
            <option value="all">Todos los estados</option>
            <option value="active">Activos</option>
          </select>

          {rules.length > 0 && (
            <select
              aria-label="Regla de alerta"
              value={filterRule}
              onChange={e => setFilterRule(e.target.value)}
              className="bg-transparent border-0 text-xs text-gray-700 font-medium focus:outline-none focus:ring-0 pr-7 py-1 cursor-pointer hover:text-gray-900"
            >
              <option value="">Todas las reglas</option>
              {rules.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}

          <select
            aria-label="SKU"
            value={filterSku}
            onChange={e => setFilterSku(e.target.value)}
            className="bg-transparent border-0 text-xs text-gray-700 font-medium focus:outline-none focus:ring-0 pr-7 py-1 cursor-pointer hover:text-gray-900"
          >
            <option value="">Todos los SKU</option>
            {skus.map(s => <option key={s.sku} value={s.sku}>{s.sku}</option>)}
          </select>

          {competitorOptions.length > 0 && (
            <select
              aria-label="Competidor"
              value={filterCompetitor}
              onChange={e => setFilterCompetitor(e.target.value)}
              className="bg-transparent border-0 text-xs text-gray-700 font-medium focus:outline-none focus:ring-0 pr-7 py-1 cursor-pointer hover:text-gray-900"
            >
              <option value="">Todos los competidores</option>
              {competitorOptions.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          )}

          <div className="flex-1" />

          {hasActiveFilters && (
            <button
              onClick={resetFilters}
              className="text-[11px] text-gray-400 hover:text-gray-700 font-medium px-2 py-1 rounded hover:bg-gray-50"
            >
              Limpiar filtros
            </button>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 bg-gray-50/50 text-xs text-gray-500">
          <span>
            {visible.length} {visible.length === 1 ? 'alerta' : 'alertas'}
            {visible.length !== alerts.length && (
              <span className="text-gray-400"> de {alerts.length}</span>
            )}
          </span>
          <div className="flex items-center gap-3">
            {visible.some(a => !a.read_at) && (
              <button onClick={markAllRead} className="text-blue-600 hover:text-blue-800 font-medium">
                Marcar todas leídas
              </button>
            )}
            {alerts.some(a => a.read_at) && (
              <button onClick={deleteRead} disabled={deletingRead} className="text-gray-400 hover:text-red-500 transition-colors">
                Limpiar leídas
              </button>
            )}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-xl p-16 text-center">
          <div className="w-12 h-12 rounded-full bg-gray-50 mx-auto mb-3 flex items-center justify-center">
            <svg className="w-6 h-6 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-700">
            {filter === 'unread' ? 'Todo al día' : 'Sin alertas registradas'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {filter === 'unread' ? 'No hay alertas sin leer.' : 'Cuando se disparen alertas aparecerán aquí.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(alert => {
            const isRead = !!alert.read_at
            const priceWentDown = alert.competitor_price_after != null && alert.competitor_price_before != null
              && alert.competitor_price_after < alert.competitor_price_before
            const diff = alert.diff_pct
            const panelLookup = getAlertPanelTarget(alert)
            const isActive = panelTarget === panelLookup
            const ruleType = alert.ml_price_alert_rules?.rule_type ?? ''
            const isCheaper = ruleType === 'competitor_cheaper' || ruleType === 'price_diff_pct_above'
            const isPricier = ruleType === 'competitor_pricier' || ruleType === 'price_diff_pct_below'

            const tone = isRead ? 'read' : isCheaper ? 'cheaper' : isPricier ? 'pricier' : 'changed'
            const toneConfig = {
              read: { border: 'border-l-gray-200', badge: 'bg-gray-50 text-gray-400', accent: 'text-gray-500' },
              cheaper: { border: 'border-l-red-500', badge: 'bg-red-50 text-red-600', accent: 'text-red-600' },
              pricier: { border: 'border-l-blue-500', badge: 'bg-blue-50 text-blue-600', accent: 'text-blue-600' },
              changed: { border: 'border-l-amber-500', badge: 'bg-amber-50 text-amber-600', accent: 'text-amber-600' },
            }[tone]

            const thumb = imgUrl(alert.ml_competitor_items?.thumbnail ?? null)

            return (
              <div
                key={alert.row_key}
                onClick={() => openPanel(isActive ? null : panelLookup)}
                className={`group relative bg-white border border-gray-100 border-l-4 ${toneConfig.border} rounded-xl transition-all cursor-pointer hover:shadow-md hover:border-gray-200 ${isActive ? 'ring-2 ring-blue-400 ring-offset-1' : ''} ${isRead ? 'opacity-70' : ''}`}
              >
                <div className="flex gap-3 p-4">
                  {/* Thumb or indicator */}
                  <div className="shrink-0">
                    {thumb ? (
                      <div className="relative w-12 h-12 rounded-lg overflow-hidden bg-gray-50 border border-gray-100">
                        <Image src={thumb} alt="" fill className="object-contain" unoptimized />
                      </div>
                    ) : (
                      <div className={`w-12 h-12 rounded-lg flex items-center justify-center ${toneConfig.badge}`}>
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          {isCheaper && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 4v16m0 0l-5-5m5 5l5-5" />}
                          {isPricier && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 20V4m0 0l-5 5m5-5l5 5" />}
                          {!isCheaper && !isPricier && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />}
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    {/* Row 1: SKU + Title + time */}
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="font-mono text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded shrink-0">{alert.owner_sku?.trim() || 'Sin SKU'}</span>
                      <h3 className="text-sm font-semibold text-gray-900 truncate flex-1">
                        {alert.owner_title}
                      </h3>
                      <span className="text-[11px] text-gray-400 shrink-0">{formatRelative(alert.fired_at)}</span>
                    </div>

                    <div className="flex items-center gap-2 mt-1 text-[10px]">
                      <span className="font-mono text-gray-500">{alert.owner_product_id}</span>
                      <span className={`px-1.5 py-0.5 rounded ${STATUS_COLOR[alert.owner_status ?? ''] ?? 'bg-gray-100 text-gray-600'}`}>
                        {STATUS_LABEL[alert.owner_status ?? ''] ?? alert.owner_status ?? 'Sin estado'}
                      </span>
                    </div>

                    {/* Row 2: rule + competitor */}
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      {alert.ml_price_alert_rules && (
                        <RuleTypeBadge
                          ruleType={alert.ml_price_alert_rules.rule_type}
                          thresholdPct={alert.diff_pct != null ? Math.abs(alert.diff_pct) : null}
                        />
                      )}
                      {(alert.ml_competitor_items?.seller_name || alert.ml_competitor_items?.title) && (
                        <span className="inline-flex items-center gap-1 text-xs text-gray-600">
                          <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          <span className="truncate max-w-55">{alert.ml_competitor_items?.seller_name ?? alert.ml_competitor_items?.title}</span>
                        </span>
                      )}
                    </div>

                    {/* Row 3: Prices */}
                    <div className="flex items-end gap-6 mt-3 flex-wrap">
                      {/* Competitor price block */}
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-0.5">Competidor</p>
                        <div className="flex items-baseline gap-2">
                          {alert.competitor_price_before != null && (
                            <span className="text-gray-400 line-through text-xs">{formatPrice(alert.competitor_price_before)}</span>
                          )}
                          <span className={`text-base font-bold ${priceWentDown ? 'text-red-600' : 'text-green-600'}`}>
                            {formatPrice(alert.competitor_price_after)}
                          </span>
                        </div>
                      </div>

                      {/* Our price */}
                      {alert.our_price != null && (
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-gray-400 font-medium mb-0.5">Nuestro</p>
                          <span className="text-base font-semibold text-gray-700">{formatPrice(alert.our_price)}</span>
                        </div>
                      )}

                      {/* Diff pill */}
                      {diff != null && (
                        <div className="ml-auto">
                          <span className={`inline-flex items-center gap-1 text-sm font-bold px-2.5 py-1 rounded-lg ${diff < 0 ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                            {diff < 0 ? (
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
                            ) : (
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 10l7-7m0 0l7 7m-7-7v18" /></svg>
                            )}
                            {diff < 0 ? `${diff.toFixed(1)}%` : `+${diff.toFixed(1)}%`}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Hover actions (top-right) */}
                <div
                  className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={e => e.stopPropagation()}
                >
                  {!isRead && (
                    <button
                      onClick={() => markRead(alert.id)}
                      className="p-1.5 rounded-md bg-white border border-gray-200 text-gray-500 hover:text-blue-600 hover:border-blue-300 hover:bg-blue-50 transition-all shadow-sm"
                      title="Marcar como leída"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => deleteAlert(alert.id)}
                    className="p-1.5 rounded-md bg-white border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-300 hover:bg-red-50 transition-all shadow-sm"
                    title="Eliminar"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Product panel — slides in from the right */}
      {panelTarget && (
        <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]" onClick={() => openPanel(null)}>
          <div
            className="absolute top-0 right-0 h-full w-full md:w-130 bg-white shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {panelLoading || !panelData ? (
              <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
                {panelLoading ? 'Cargando...' : panelError ?? 'Sin datos'}
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-3 border-b border-gray-100 shrink-0">
                  <div className="min-w-0 flex-1 pr-3">
                    <p className="text-xs text-gray-400 mb-0.5 font-mono">{panelTarget}</p>
                    <h2 className="font-semibold text-gray-900 leading-snug line-clamp-2 text-sm">
                      {panelData.product?.title ?? visible.find(a => getAlertPanelTarget(a) === panelTarget)?.owner_title ?? panelTarget}
                    </h2>
                  </div>
                  <button onClick={() => openPanel(null)} className="text-gray-400 hover:text-gray-700 text-2xl leading-none shrink-0">×</button>
                </div>

                {/* Image + key info */}
                {panelData.product && (
                  <div className="flex border-b border-gray-100 shrink-0">
                    <div className="w-36 shrink-0 bg-gray-50 flex items-center justify-center p-3 border-r border-gray-100">
                      {panelData.product.thumbnail ? (
                        <Image
                          src={imgUrl(panelData.product.thumbnail)!}
                          alt={panelData.product.title}
                          width={120}
                          height={120}
                          className="object-contain"
                          style={{ width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: '120px' }}
                          unoptimized
                        />
                      ) : (
                        <div className="w-full h-28 bg-gray-100 rounded" />
                      )}
                    </div>
                    <div className="flex-1 p-4 space-y-2">
                      <div className="flex gap-3 text-xs">
                        <div>
                          <p className="text-gray-400 uppercase tracking-wide font-medium">MLU</p>
                          <p className="font-mono text-gray-900 font-semibold">{panelData.product.id}</p>
                        </div>
                        {panelData.product.sku && (
                          <div>
                            <p className="text-gray-400 uppercase tracking-wide font-medium">SKU</p>
                            <p className="font-mono text-gray-900 font-semibold">{panelData.product.sku}</p>
                          </div>
                        )}
                      </div>
                      <div className="border-t border-gray-50 pt-2 space-y-1">
                        {panelData.product.sale_price != null ? (
                          <div className="flex items-baseline justify-between">
                            <span className="text-xs text-emerald-600 font-medium">Oferta</span>
                            <span className="text-lg font-bold text-emerald-600">{formatPrice(panelData.product.sale_price, panelData.product.currency_id)}</span>
                          </div>
                        ) : panelData.product.price != null ? (
                          <div className="flex items-baseline justify-between">
                            <span className="text-xs text-gray-400">Precio</span>
                            <span className="text-lg font-bold text-gray-900">{formatPrice(panelData.product.price, panelData.product.currency_id)}</span>
                          </div>
                        ) : null}
                        {panelData.product.sale_price != null && panelData.product.price != null && panelData.product.sale_price !== panelData.product.price && (
                          <div className="flex items-baseline justify-between">
                            <span className="text-xs text-gray-300">Lista</span>
                            <span className="text-xs text-gray-400 line-through">{formatPrice(panelData.product.price, panelData.product.currency_id)}</span>
                          </div>
                        )}
                        {panelData.product.buybox_price != null && (
                          <div className="flex items-baseline justify-between">
                            <span className="text-xs text-gray-400">Buy-box rival</span>
                            <span className="text-base font-semibold text-orange-500">{formatPrice(panelData.product.buybox_price, panelData.product.currency_id)}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[panelData.product.status ?? ''] ?? 'bg-gray-100 text-gray-600'}`}>
                          {STATUS_LABEL[panelData.product.status ?? ''] ?? panelData.product.status ?? '—'}
                        </span>
                        {panelData.product.permalink && (
                          <a href={panelData.product.permalink} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:text-blue-700 font-medium">
                            Ver en ML →
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Price comparison */}
                <div className="flex-1 overflow-y-auto p-4">
                  {panelEntries.length === 0 ? (
                    <p className="text-center text-gray-400 text-sm py-8">Sin datos de precios</p>
                  ) : (
                    <div className="space-y-2">
                      <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-3">Comparación de precios</p>
                      {panelEntries.map((entry, idx) => {
                        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : null
                        const isCheaper = entry.diff != null && entry.diff < 0
                        return (
                          <div key={entry.key} className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${entry.isOurs ? (entry.oursType === 'sale' ? 'bg-emerald-50 border-emerald-300 shadow-sm' : 'bg-gray-50 border-gray-300 shadow-sm') : 'bg-white border-gray-100'}`}>
                            <div className="w-7 text-center shrink-0">
                              {medal ? <span className="text-xl">{medal}</span> : <span className="text-sm font-bold text-gray-400">{idx + 1}</span>}
                            </div>
                            {entry.isOurs ? (
                              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${entry.oursType === 'sale' ? 'bg-emerald-200' : 'bg-gray-200'}`}>
                                <svg className={`w-4 h-4 ${entry.oursType === 'sale' ? 'text-emerald-700' : 'text-gray-500'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                              </div>
                            ) : entry.thumbnail ? (
                              <Image src={imgUrl(entry.thumbnail)!} alt="" width={36} height={36} className="w-9 h-9 rounded-lg object-contain bg-gray-50 shrink-0" unoptimized />
                            ) : (
                              <div className="w-9 h-9 rounded-lg bg-gray-100 shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className={`text-sm font-medium line-clamp-1 ${entry.isOurs ? (entry.oursType === 'sale' ? 'text-emerald-700' : 'text-gray-600') : 'text-gray-900'}`}>{entry.label}</p>
                              <p className="text-xs text-gray-400">{entry.isOurs ? (entry.oursType === 'sale' ? 'Nuestro — oferta' : 'Nuestro') : entry.seller ?? 'Competidor'}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <p className="text-base font-bold text-gray-900">{formatPrice(entry.price, entry.currency)}</p>
                              {!entry.isOurs && entry.usd_price != null && (
                                <p className="text-xs text-gray-400 mt-0.5">
                                  USD {entry.usd_price.toLocaleString('es-UY', { maximumFractionDigits: 0 })}
                                </p>
                              )}
                              {entry.diff != null && (
                                <p className={`text-xs font-semibold mt-0.5 ${isCheaper ? 'text-red-500' : 'text-green-600'}`}>
                                  {isCheaper ? `${entry.diff.toFixed(0)}%` : `+${entry.diff.toFixed(0)}%`}
                                </p>
                              )}
                            </div>
                            {entry.permalink && (
                              <a href={entry.permalink} target="_blank" rel="noopener noreferrer" className="text-gray-300 hover:text-blue-500 transition-colors shrink-0" onClick={e => e.stopPropagation()}>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                              </a>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
