'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import {
  type ManualSyncAction,
  type ManualSyncRun,
  startManualSync,
  syncIsActive,
  syncMessage,
  syncUrl,
} from '@/lib/manual-sync'

export function SyncNotice({ run }: { run: ManualSyncRun }) {
  const color = run.status === 'failed' || run.status === 'partial'
    ? 'text-red-700'
    : run.status === 'warnings'
    ? 'text-amber-800'
    : syncIsActive(run)
    ? 'text-slate-500'
    : 'text-emerald-700'
  return (
    <span role='status' className={`text-xs ${color}`}>
      {syncMessage(run)} ·{' '}
      <Link className='underline underline-offset-2' href={syncUrl(run.id)}>
        {syncIsActive(run) ? 'Ver progreso' : 'Ver log'}
      </Link>
    </span>
  )
}
export default function ManualSyncControl(
  {
    action = 'all',
    origin = 'general',
    targetId,
    label = 'Actualizar propios y rivales',
    onComplete,
    compact = false,
  }: {
    action?: ManualSyncAction
    origin?: string
    targetId?: string
    label?: string
    onComplete?: (run: ManualSyncRun) => void | Promise<void>
    compact?: boolean
  },
) {
  const [run, setRun] = useState<ManualSyncRun | null>(null),
    [starting, setStarting] = useState(false),
    [error, setError] = useState<string | null>(null)
  const callback = useRef(onComplete),
    notified = useRef<string | null>(null),
    startingRef = useRef(false),
    requestRef = useRef<string | null>(null),
    generation = useRef(0)
  const storageKey = `monitor:manual-sync:${action}:${targetId ?? ''}`
  useEffect(() => {
    callback.current = onComplete
  }, [onComplete])
  useEffect(() => {
    const controller = new AbortController()
    const observedGeneration = generation.current
    async function restore() {
      try {
        const id = localStorage.getItem(storageKey)
        if (!id) return
        const response = await fetch(`/api/manual-sync/${id}?summary=1`, {
          signal: controller.signal,
          cache: 'no-store',
        })
        const data = await response.json()
        if (
          response.ok && data.run?.id &&
          observedGeneration === generation.current
        ) {
          setRun(data.run)
          if (!syncIsActive(data.run) && notified.current !== data.run.id) {
            notified.current = data.run.id
            await callback.current?.(data.run)
          }
        }
      } catch {
        /* The history page remains available if local storage is disabled. */
      }
    }
    void restore()
    return () => controller.abort()
  }, [storageKey])
  const runId = run?.id
  const active = !!run && syncIsActive(run)
  useEffect(() => {
    if (!runId || !active) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const response = await fetch(`/api/manual-sync/${runId}?summary=1`, {
          signal: controller.signal,
          cache: 'no-store',
        })
        const data = await response.json()
        if (!response.ok || !data.run?.id) {
          throw new Error(
            'No se pudo consultar el progreso. La actualización continúa; revisá el log.',
          )
        }
        if (controller.signal.aborted) return
        const next = data.run as ManualSyncRun
        setRun(next)
        setError(null)
        if (!syncIsActive(next)) {
          if (notified.current !== next.id) {
            notified.current = next.id
            await callback.current?.(next)
          }
          return
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(
            e instanceof Error ? e.message : 'No se pudo consultar el progreso',
          )
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1000)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [runId, active]) // Each observer follows one run; workers live on the server.
  async function start() {
    if (startingRef.current || active) return
    startingRef.current = true
    generation.current++
    setStarting(true)
    setError(null)
    try {
      if (!requestRef.current) {
        try {
          requestRef.current = localStorage.getItem(storageKey + ':request')
        } catch { /* optional */ }
        requestRef.current ??= crypto.randomUUID()
        try {
          localStorage.setItem(storageKey + ':request', requestRef.current)
        } catch { /* optional */ }
      }
      const next = await startManualSync(
        action,
        origin,
        targetId,
        requestRef.current,
      )
      requestRef.current = null
      setRun(next)
      try {
        localStorage.setItem(storageKey, next.id)
        localStorage.removeItem(storageKey + ':request')
      } catch { /* optional browser bookmark */ }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'No se pudo iniciar la actualización',
      )
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }
  return (
    <div
      className={`flex min-w-0 flex-wrap items-center gap-2 ${
        compact ? '' : 'justify-end'
      }`}
    >
      <div className='min-w-0 max-w-sm'>
        {run && <SyncNotice run={run} />}{' '}
        {error && <p role='alert' className='text-xs text-red-700'>{error}</p>}
      </div>
      <button
        type='button'
        onClick={start}
        disabled={starting || active}
        aria-label={label}
        title={label}
        className='inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50'
      >
        <svg
          aria-hidden='true'
          className={`h-4 w-4 shrink-0 ${
            starting || active ? 'animate-spin' : ''
          }`}
          fill='none'
          stroke='currentColor'
          viewBox='0 0 24 24'
        >
          <path
            strokeLinecap='round'
            strokeLinejoin='round'
            strokeWidth={1.8}
            d='M4 4v5h5m11 11v-5h-5M4.6 9a8 8 0 0113.2-4M19.4 15a8 8 0 01-13.2 4'
          />
        </svg>
        {!compact && (starting || active ? 'Actualizando…' : label)}
      </button>
    </div>
  )
}
