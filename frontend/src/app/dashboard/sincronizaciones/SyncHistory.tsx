'use client'
import Link from 'next/link'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import Select from '@/components/Select'
import {
  dateBounds,
  formatAlertDate,
  marketplaceLink,
} from '@/lib/price-alerts'
import {
  type ManualSyncResult,
  type ManualSyncRun,
  syncIsActive,
  syncLabels,
  syncStatusLabels,
  syncUrl,
} from '@/lib/manual-sync'

type Stage = {
  stage: string
  pending: number
  updated: number
  failed: number
  skipped: number
  warning: number
}
type PageData = {
  run?: ManualSyncRun
  items: ManualSyncRun[] | ManualSyncResult[]
  count: number
  stages?: Stage[]
}
const outcomeLabels: Record<string, string> = {
  failed: 'Fallidos',
  warning: 'Con advertencias',
  updated: 'Actualizados',
  skipped: 'Omitidos',
}
const categoryLabels: Record<string, string> = {
  authentication: 'Autenticación',
  permissions: 'Permisos',
  resource_deprecated: 'Recurso deprecado',
  resolution: 'Resolución de identidad',
  availability: 'Disponibilidad',
  rate_limit: 'Límite de consultas',
  server: 'Servicio externo',
  network: 'Red o tiempo de espera',
  persistence: 'Guardado',
  interrupted: 'Interrupción',
  validation: 'Validación',
  not_applicable: 'No aplica',
}
const subscribeZone = () => () => {}
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const serverZone = () => 'UTC'
const surface = 'rounded-xl border border-slate-200 bg-white p-4'
function duration(run: ManualSyncRun) {
  if (!run.started_at) return '—'
  const seconds = Math.max(
    0,
    Math.floor(
      ((run.finished_at ? Date.parse(run.finished_at) : Date.now()) -
        Date.parse(run.started_at)) / 1000,
    ),
  )
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}
function Status({ run }: { run: ManualSyncRun }) {
  const color = run.status === 'partial' || run.status === 'failed'
    ? 'bg-red-50 text-red-700'
    : run.status === 'warnings'
    ? 'bg-amber-50 text-amber-800'
    : syncIsActive(run)
    ? 'bg-blue-50 text-blue-700'
    : 'bg-emerald-50 text-emerald-700'
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${color}`}
    >
      {syncStatusLabels[run.status]}
    </span>
  )
}
function Counts({ run }: { run: ManualSyncRun }) {
  return (
    <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
      {[
        [run.updated_count, 'Actualizados', 'text-emerald-700'],
        [run.failed_count, 'Fallidos', 'text-red-700'],
        [run.warning_count, 'Con advertencias', 'text-amber-700'],
        [run.skipped_count, 'Omitidos', 'text-slate-600'],
      ].map(([count, label, color]) => (
        <div key={label} className={surface}>
          <p className='text-xs text-slate-500'>{label}</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>
            {count}
          </p>
        </div>
      ))}
    </div>
  )
}
export default function SyncHistory({ id }: { id?: string }) {
  const [data, setData] = useState<PageData | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true)
  const [action, setAction] = useState(''),
    [status, setStatus] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('')
  const [outcome, setOutcome] = useState('failed'),
    [stage, setStage] = useState(''),
    [page, setPage] = useState(1),
    [revision, setRevision] = useState(0)
  const initialFilter = useRef(false)
  const zone = useSyncExternalStore(subscribeZone, browserZone, serverZone)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const params = new URLSearchParams({ page: String(page) })
        if (id) {
          if (outcome) params.set('outcome', outcome)
          if (stage) params.set('stage', stage)
        } else {
          if (action) params.set('action', action)
          if (status) params.set('status', status)
          const bounds = dateBounds(from, to)
          if (bounds.from) params.set('from', bounds.from)
          if (bounds.to) params.set('until', bounds.to)
        }
        const response = await fetch(
          `/api/manual-sync${id ? `/${id}` : ''}?${params}`,
          { signal: controller.signal, cache: 'no-store' },
        )
        const fresh = await response.json()
        if (!response.ok) {
          throw new Error(
            fresh.error ?? 'No se pudieron cargar las sincronizaciones',
          )
        }
        if (controller.signal.aborted) return
        if (id && !initialFilter.current) {
          initialFilter.current = true
          if (fresh.run.failed_count === 0) {
            setOutcome(fresh.run.warning_count > 0 ? 'warning' : '')
          }
        }
        setData(fresh)
        setError(null)
        setLoading(false)
        if (!id || fresh.run && syncIsActive(fresh.run)) {
          timer = setTimeout(load, 5000)
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Error de consulta')
          setLoading(false)
          timer = setTimeout(load, 5000)
        }
      }
    }
    void load()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [id, action, status, from, to, outcome, stage, page, revision])
  function filter(setter: (value: string) => void, value: string) {
    initialFilter.current = true
    setter(value)
    setPage(1)
    setLoading(true)
    setRevision((v) => v + 1)
  }
  const run = data?.run
  return (
    <div className='space-y-5'>
      <header className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          {id && (
            <Link
              href='/dashboard/sincronizaciones'
              className='text-xs text-blue-700 hover:underline'
            >
              ← Sincronizaciones
            </Link>
          )}
          <h1 className='mt-1 text-2xl font-bold tracking-tight text-slate-900'>
            {id ? 'Detalle de sincronización' : 'Sincronizaciones'}
          </h1>
          <p className='mt-1 text-sm text-slate-500'>
            {id
              ? 'Resultados guardados de esta actualización manual.'
              : 'Historial de las actualizaciones manuales del Monitor.'}
          </p>
        </div>
        <button
          onClick={() => setRevision((v) => v + 1)}
          className='rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50'
        >
          Actualizar resultados
        </button>
      </header>
      {error && (
        <p
          role='alert'
          className='rounded-xl bg-red-50 p-3 text-sm text-red-700'
        >
          {error}{' '}
          <button
            className='underline'
            onClick={() => setRevision((v) => v + 1)}
          >
            Reintentar
          </button>
        </p>
      )}
      {run && (
        <>
          <section
            className={`${surface} space-y-3`}
            aria-label='Resumen de ejecución'
          >
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <h2 className='font-semibold'>
                {syncLabels[run.action]}
                {run.target_id ? ` · ${run.target_id}` : ''}
              </h2>
              <Status run={run} />
            </div>
            <dl className='grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4'>
              <div>
                <dt className='text-xs text-slate-500'>Solicitada</dt>
                <dd>{formatAlertDate(run.created_at, zone)}</dd>
              </div>
              <div>
                <dt className='text-xs text-slate-500'>Usuario</dt>
                <dd className='break-all'>{run.requested_by_label}</dd>
              </div>
              <div>
                <dt className='text-xs text-slate-500'>Duración</dt>
                <dd>{duration(run)}</dd>
              </div>
              <div>
                <dt className='text-xs text-slate-500'>
                  Resultados registrados
                </dt>
                <dd>
                  {run.completed_count} de {run.total_count}
                  {syncIsActive(run) ? ' identificados' : ''}
                </dd>
              </div>
            </dl>
            {syncIsActive(run) && (
              <p role='status' className='text-sm text-blue-700'>
                La actualización continúa en el servidor. Podés salir de esta
                página.
              </p>
            )}
          </section>
          <Counts run={run} />
          <div className='grid gap-3 sm:grid-cols-3'>
            {data.stages?.map((s) => (
              <section key={s.stage} className={surface}>
                <h3 className='text-sm font-semibold'>{syncLabels[s.stage]}</h3>
                <p className='mt-1 text-xs text-slate-500'>
                  {s.pending ? 'En proceso o pendiente' : 'Finalizada'} ·{' '}
                  {s.updated} actualizados · {s.failed} fallidos · {s.warning}
                  {' '}
                  advertencias · {s.skipped} omitidos
                </p>
              </section>
            ))}
          </div>
        </>
      )}
      <section
        className={`${surface} grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4`}
        aria-label='Filtros de sincronización'
      >
        {id
          ? (
            <>
              <label className='space-y-1 text-xs text-slate-600'>
                <span>Resultado</span>
                <Select
                  aria-label='Resultado'
                  value={outcome}
                  onValueChange={(v) => filter(setOutcome, v)}
                  options={[
                    { value: '', label: 'Todos los resultados' },
                    ...Object.entries(outcomeLabels).map(([value, label]) => ({
                      value,
                      label,
                    })),
                  ]}
                />
              </label>
              <label className='space-y-1 text-xs text-slate-600'>
                <span>Etapa</span>
                <Select
                  aria-label='Etapa'
                  value={stage}
                  onValueChange={(v) => filter(setStage, v)}
                  options={[
                    { value: '', label: 'Todas las etapas' },
                    ...['own', 'catalog', 'rivals', 'tracked'].map((value) => ({
                      value,
                      label: syncLabels[value],
                    })),
                  ]}
                />
              </label>
            </>
          )
          : (
            <>
              <label className='space-y-1 text-xs text-slate-600'>
                <span>Desde</span>
                <input
                  type='date'
                  value={from}
                  onChange={(e) => filter(setFrom, e.target.value)}
                  className='block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm'
                />
              </label>
              <label className='space-y-1 text-xs text-slate-600'>
                <span>Hasta</span>
                <input
                  type='date'
                  value={to}
                  onChange={(e) => filter(setTo, e.target.value)}
                  className='block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm'
                />
              </label>
              <label className='space-y-1 text-xs text-slate-600'>
                <span>Acción</span>
                <Select
                  searchable
                  aria-label='Acción'
                  value={action}
                  onValueChange={(v) => filter(setAction, v)}
                  options={[
                    { value: '', label: 'Todas las acciones' },
                    ...Object.entries(syncLabels).filter(([key]) =>
                      key !== 'product'
                    ).map(([value, label]) => ({ value, label })),
                    { value: 'product', label: syncLabels.product },
                  ]}
                />
              </label>
              <label className='space-y-1 text-xs text-slate-600'>
                <span>Estado</span>
                <Select
                  searchable
                  aria-label='Estado'
                  value={status}
                  onValueChange={(v) => filter(setStatus, v)}
                  options={[
                    { value: '', label: 'Todos los estados' },
                    ...Object.entries(syncStatusLabels).map((
                      [value, label],
                    ) => ({ value, label })),
                  ]}
                />
              </label>
            </>
          )}
        <p className='text-xs text-slate-500 sm:col-span-2 lg:col-span-4'>
          Zona horaria: {zone}
          {!id ? ' · Hasta incluye el día completo.' : ''}
        </p>
      </section>
      <div aria-live='polite' aria-busy={loading} className='space-y-3'>
        <p className='text-xs text-slate-500'>
          {loading
            ? 'Consultando resultados…'
            : `${data?.count ?? 0} ${id ? 'resultados' : 'ejecuciones'} · ${
              id ? '50 por página' : 'más recientes primero'
            }`}
        </p>
        {!loading && data?.count === 0 && (
          <p className={`${surface} text-sm text-slate-500`}>
            {id
              ? 'No hay resultados que coincidan con estos filtros.'
              : 'Todavía no hay sincronizaciones manuales que coincidan con estos filtros.'}
          </p>
        )}
        {!id
          ? (data?.items as ManualSyncRun[] ?? []).map((item) => (
            <article
              key={item.id}
              className={`${surface} flex flex-wrap items-center justify-between gap-3`}
            >
              <div className='min-w-0'>
                <Link
                  className='font-semibold text-slate-900 hover:text-blue-700'
                  href={syncUrl(item.id)}
                >
                  {syncLabels[item.action]}
                  {item.target_id ? ` · ${item.target_id}` : ''}
                </Link>
                <p className='mt-1 text-xs text-slate-500'>
                  {formatAlertDate(item.created_at, zone)} · {duration(item)}
                </p>
                <p className='mt-1 break-all text-xs text-slate-500'>
                  {item.requested_by_label}
                </p>
                <p className='mt-2 text-sm text-slate-600'>
                  {item.updated_count} actualizados ·{' '}
                  <span className={item.failed_count ? 'text-red-700' : ''}>
                    {item.failed_count} fallidos
                  </span>{' '}
                  · {item.warning_count} advertencias · {item.skipped_count}
                  {' '}
                  omitidos
                </p>
              </div>
              <div className='flex flex-wrap items-center gap-3'>
                <Status run={item} />
                <Link
                  href={syncUrl(item.id)}
                  className='text-sm text-blue-700 underline'
                >
                  Ver log
                </Link>
              </div>
            </article>
          ))
          : (data?.items as ManualSyncResult[] ?? []).map((result) => {
            const url = marketplaceLink(result.identity.url)
            const color = result.outcome === 'failed'
              ? 'border-red-200'
              : result.outcome === 'warning'
              ? 'border-amber-200'
              : 'border-slate-200'
            return (
              <article
                key={result.id}
                className={`rounded-xl border bg-white p-4 ${color}`}
              >
                <div className='flex items-start justify-between gap-3'>
                  <div className='min-w-0'>
                    <p className='text-xs font-medium text-slate-500'>
                      {syncLabels[result.stage]} ·{' '}
                      {outcomeLabels[result.outcome]}
                      {result.identity.sku
                        ? ` · SKU ${result.identity.sku}`
                        : ''}
                    </p>
                    <h3 className='mt-1 break-words font-semibold text-slate-900'>
                      {result.identity.title ??
                        (result.entity_id.startsWith('$stage')
                          ? 'Fallo de etapa'
                          : result.entity_id)}
                    </h3>
                  </div>
                  {url && (
                    <a
                      href={url}
                      target='_blank'
                      rel='noopener noreferrer'
                      aria-label={`Abrir ${
                        result.identity.title ?? result.entity_id
                      } en Mercado Libre`}
                      className='shrink-0 rounded-lg border border-slate-200 px-2 py-1 text-blue-700'
                    >
                      ↗
                    </a>
                  )}
                </div>
                <p className='mt-1 break-all text-xs text-slate-500'>
                  {!result.entity_id.startsWith('$stage') && (
                    <>
                      {result.identity.itemId ?? result.entity_id}
                      {result.identity.sourceId &&
                          result.identity.sourceId !== result.identity.itemId
                        ? ` · Origen ${result.identity.sourceId}`
                        : ''}
                    </>
                  )}
                  {result.identity.seller ? ` · ${result.identity.seller}` : ''}
                </p>
                <p
                  className={`mt-3 text-sm ${
                    result.outcome === 'failed'
                      ? 'text-red-800'
                      : 'text-slate-700'
                  }`}
                >
                  {result.message}
                </p>
                <p className='mt-2 text-xs text-slate-500'>
                  {categoryLabels[result.category ?? ''] ?? result.operation}
                  {result.http_status ? ` · HTTP ${result.http_status}` : ''} ·
                  {' '}
                  {result.attempts} intento{result.attempts === 1 ? '' : 's'} ·
                  {' '}
                  {formatAlertDate(result.recorded_at, zone)}
                </p>
                {result.resource && (
                  <p className='mt-1 break-all font-mono text-xs text-slate-500'>
                    {result.resource}
                  </p>
                )}
              </article>
            )
          })}
      </div>
      <nav
        aria-label='Paginación'
        className='flex items-center justify-between gap-3'
      >
        <button
          disabled={page === 1 || loading}
          onClick={() => {
            setPage((v) => v - 1)
            setLoading(true)
          }}
          className='rounded-lg border px-3 py-2 text-sm disabled:opacity-40'
        >
          ← Anterior
        </button>
        <span className='text-xs text-slate-500'>Página {page}</span>
        <button
          disabled={loading || page * 50 >= (data?.count ?? 0)}
          onClick={() => {
            setPage((v) => v + 1)
            setLoading(true)
          }}
          className='rounded-lg border px-3 py-2 text-sm disabled:opacity-40'
        >
          Siguiente →
        </button>
      </nav>
    </div>
  )
}
