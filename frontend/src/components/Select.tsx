'use client'

import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

export type SelectOption = { value: string; label: string }

type Props = {
  options: SelectOption[]
  value: string
  onValueChange: (value: string) => void
  'aria-label': string
  id?: string
  disabled?: boolean
  variant?: 'filter' | 'form'
  className?: string
}

const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

export default function Select({ options, value, onValueChange, 'aria-label': label, id, disabled = false, variant = 'form', className = '' }: Props) {
  const generatedId = useId()
  const listId = `${generatedId}-list`
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', time: 0 })
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const searchable = options.length > 7
  const visibleOptions = useMemo(() => {
    const normalizedQuery = normalize(query)
    return options.filter(option => normalize(option.label).includes(normalizedQuery))
  }, [options, query])
  const selected = options.find(option => option.value === value)
  const activeOption = visibleOptions[activeIndex]
  const expanded = open && !disabled

  const close = useCallback((restoreFocus = false) => {
    setOpen(false)
    setQuery('')
    typeahead.current = { text: '', time: 0 }
    if (restoreFocus) trigger.current?.focus()
  }, [])

  function show(last = false) {
    const selectedIndex = options.findIndex(option => option.value === value)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : options.length ? (last ? options.length - 1 : 0) : -1)
    setQuery('')
    setOpen(true)
  }

  function choose(option: SelectOption) {
    onValueChange(option.value)
    close(true)
  }

  useLayoutEffect(() => {
    if (!expanded) return
    const anchor = trigger.current
    const panel = popup.current
    if (!anchor || !panel) return

    const position = () => {
      const rect = anchor.getBoundingClientRect()
      const viewport = window.visualViewport
      const offsetX = viewport?.offsetLeft ?? 0
      const offsetY = viewport?.offsetTop ?? 0
      const width = viewport?.width ?? window.innerWidth
      const height = viewport?.height ?? window.innerHeight
      const below = offsetY + height - rect.bottom - 12
      const above = rect.top - offsetY - 12
      const upwards = below < 240 && above > below
      const available = Math.max(0, upwards ? above : below)
      const panelWidth = Math.min(Math.max(rect.width, variant === 'form' ? 400 : 240), width - 16)
      panel.style.width = `${panelWidth}px`
      panel.style.left = `${Math.max(offsetX + 8, Math.min(rect.left, offsetX + width - panelWidth - 8))}px`
      panel.style.maxHeight = `${Math.min(360, available)}px`
      panel.style.top = upwards ? 'auto' : `${rect.bottom + 4}px`
      panel.style.bottom = upwards ? `${window.innerHeight - rect.top + 4}px` : 'auto'
    }
    const onScroll = (event: Event) => {
      if (!panel.contains(event.target as Node)) position()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!anchor.contains(event.target as Node) && !panel.contains(event.target as Node)) close()
    }
    const onFocus = (event: FocusEvent) => {
      if (!anchor.contains(event.target as Node) && !panel.contains(event.target as Node)) close()
    }
    position()
    if (searchable) search.current?.focus({ preventScroll: true })
    else list.current?.focus({ preventScroll: true })
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', onScroll, true)
    window.visualViewport?.addEventListener('resize', position)
    window.visualViewport?.addEventListener('scroll', position)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('focusin', onFocus)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', onScroll, true)
      window.visualViewport?.removeEventListener('resize', position)
      window.visualViewport?.removeEventListener('scroll', position)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('focusin', onFocus)
    }
  }, [expanded, searchable, close, variant])

  useLayoutEffect(() => {
    if (expanded && activeIndex >= 0) {
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, expanded, listId, query])

  function handleKeyDown(event: KeyboardEvent) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') {
      // Resume the form's tab order from the trigger, rather than the body portal.
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(index => visibleOptions.length ? (index + direction + visibleOptions.length) % visibleOptions.length : -1)
    } else if (event.key === 'Enter' || (!searchable && event.key === ' ')) {
      event.preventDefault()
      if (activeOption) choose(activeOption)
    } else if (!searchable && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault()
      setActiveIndex(event.key === 'Home' ? 0 : visibleOptions.length - 1)
    } else if (!searchable && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const now = Date.now()
      const text = (now - typeahead.current.time < 700 ? typeahead.current.text : '') + event.key
      typeahead.current = { text, time: now }
      const index = visibleOptions.findIndex(option => normalize(option.label).startsWith(normalize(text)))
      if (index >= 0) setActiveIndex(index)
    }
  }

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        aria-label={label}
        title={selected?.label}
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        disabled={disabled}
        onClick={() => expanded ? close(true) : show()}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show(event.key === 'ArrowUp')
          }
        }}
        className={`inline-flex min-w-0 max-w-full items-center justify-between gap-2 text-left cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${variant === 'filter' ? 'rounded-lg bg-transparent border-0 py-1 text-xs font-medium text-gray-700 hover:text-gray-900' : 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900'} ${className}`}
      >
        <span className="truncate">{selected?.label ?? 'Seleccionar…'}</span>
        <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="m6 9 6 6 6-6" /></svg>
      </button>
      {expanded && createPortal(
        <div
          ref={popup}
          className="fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-sm text-gray-900 shadow-xl"
          onClick={event => event.stopPropagation()}
          onPointerDown={event => event.stopPropagation()}
          onKeyDown={handleKeyDown}
        >
          {searchable && (
            <div className="shrink-0 border-b border-gray-100 p-2">
              <input
                ref={search}
                role="combobox"
                aria-label={`Buscar en ${label}`}
                aria-expanded={true}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={activeOption ? `${listId}-${activeIndex}` : undefined}
                value={query}
                onChange={event => { setQuery(event.target.value); setActiveIndex(0) }}
                placeholder="Buscar…"
                autoComplete="off"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none placeholder:text-gray-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
              />
            </div>
          )}
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-activedescendant={!searchable && activeOption ? `${listId}-${activeIndex}` : undefined}
            tabIndex={-1}
            className="min-h-0 overflow-y-auto overscroll-contain p-1 outline-none"
          >
            {visibleOptions.map((option, index) => (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                onPointerMove={event => { if (event.pointerType === 'mouse') setActiveIndex(index) }}
                onMouseDown={event => event.preventDefault()}
                onClick={() => choose(option)}
                className={`flex cursor-pointer items-start justify-between gap-3 rounded-lg px-3 py-2 break-words ${index === activeIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-700'} ${option.value === value ? 'font-medium' : ''}`}
              >
                <span className="min-w-0">{option.label}</span>
                <span aria-hidden="true" className="w-4 shrink-0 text-blue-600">{option.value === value ? '✓' : ''}</span>
              </div>
            ))}
          </div>
          {visibleOptions.length === 0 && <p role="status" className="px-4 py-3 text-sm text-gray-500">Sin resultados</p>}
        </div>, document.body,
      )}
    </>
  )
}
