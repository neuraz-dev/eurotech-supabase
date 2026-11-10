'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { jumpPage, paginationItems } from '@/lib/pagination'

const buttonClass = 'inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-40'

function PageJump({ totalPages, position, onClose, onGo }: {
  totalPages: number
  position: { left: number; top: number }
  onClose: () => void
  onGo: (page: number) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = dialog.current!
    node.showModal()
    input.current?.focus()
    return () => { node.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={dialog} aria-labelledby={`${id}-title`}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    style={{ left: position.left, top: position.top }}
    className="fixed right-auto bottom-auto m-0 w-80 max-w-[calc(100vw-24px)] rounded-xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl backdrop:bg-black/10">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id={`${id}-title`} className="text-sm font-semibold">Ir a una página</h2>
      <button type="button" aria-label="Cerrar salto de página" onClick={onClose} className="rounded px-2 text-lg text-slate-500 focus-visible:outline-2">×</button>
    </div>
    <form noValidate onSubmit={event => {
      event.preventDefault()
      const page = jumpPage(value, totalPages)
      if (page == null) { setError(true); input.current?.focus(); return }
      onGo(page)
      onClose()
    }}>
      <label htmlFor={id} className="text-xs text-slate-600">Número de página (1–{totalPages})</label>
      <div className="mt-2 flex gap-2">
        <input ref={input} id={id} type="number" inputMode="numeric" min={1} max={totalPages} step={1} required value={value}
          onChange={event => { setValue(event.target.value); setError(false) }}
          aria-invalid={error} aria-describedby={error ? `${id}-error` : undefined}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-blue-600" />
        <button type="submit" className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-blue-600">Ir a</button>
      </div>
      {error && <p id={`${id}-error`} role="alert" className="mt-2 text-xs text-red-700">Ingresá un número entero entre 1 y {totalPages}.</p>}
    </form>
  </dialog>
}

export default function Pagination({ currentPage, totalPages, onPageChange, disabled = false, label = 'Paginación' }: {
  currentPage: number
  totalPages: number
  onPageChange: (page: number) => void
  disabled?: boolean
  label?: string
}) {
  const total = Math.max(1, Math.trunc(totalPages))
  const current = Math.max(1, Math.min(total, currentPage))
  const [jump, setJump] = useState<{ left: number; top: number } | null>(null)
  return <nav aria-label={label} className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
    <button type="button" disabled={disabled || current === 1} onClick={() => onPageChange(current - 1)} className={buttonClass}>← Anterior</button>
    {paginationItems(current, total).map(item => typeof item === 'number'
      ? <button key={item} type="button" aria-label={`Página ${item}`} aria-current={item === current ? 'page' : undefined}
          disabled={disabled} onClick={() => { if (item !== current) onPageChange(item) }}
          className={item === current ? `${buttonClass} !border-slate-900 !bg-slate-900 !text-white` : buttonClass}>{item}</button>
      : <button key={item} type="button" aria-label={item === 'gap-before' ? 'Ir a una página anterior' : 'Ir a una página siguiente'} aria-haspopup="dialog" disabled={disabled}
          onClick={event => {
            const bounds = event.currentTarget.closest('nav')!.getBoundingClientRect()
            const width = Math.min(320, window.innerWidth - 24)
            setJump({ left: Math.max(12, Math.min(window.innerWidth - width - 12, bounds.left + bounds.width / 2 - width / 2)), top: Math.max(12, bounds.top - 190) })
          }} className={buttonClass}>...</button>)}
    <button type="button" disabled={disabled || current === total} onClick={() => onPageChange(current + 1)} className={buttonClass}>Siguiente →</button>
    {jump && <PageJump position={jump} totalPages={total} onClose={() => setJump(null)} onGo={page => { if (!disabled) onPageChange(page) }} />}
  </nav>
}
