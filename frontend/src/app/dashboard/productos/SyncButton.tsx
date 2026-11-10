'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { runMonitorSync } from '@/lib/monitor-sync'

export default function SyncButton() {
  const router = useRouter()
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>(
    'idle',
  )
  const [msg, setMsg] = useState<string | null>(null)

  async function handleSync() {
    setState('running')
    setMsg(null)
    try {
      const result = await runMonitorSync(fetch, setMsg)
      setMsg(result.message)
      setState(result.success ? 'done' : 'error')
      // Refresh persisted rows even after partial success, keeping the summary.
      router.refresh()
    } catch (err) {
      if (err instanceof Error) {
        setMsg(`Error: ${err.message}`)
      } else {
        setMsg('Error de red')
      }
      setState('error')
    }
  }

  const isRunning = state === 'running'

  return (
    <div className="flex items-center gap-3">
      {msg && (
        <span
          role={state === 'error' ? 'alert' : 'status'}
          className={`text-xs whitespace-pre-line ${state === 'error' ? 'text-red-500' : 'text-gray-400'}`}
        >
          {msg}
        </span>
      )}
      <button
        onClick={handleSync}
        disabled={isRunning}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:border-gray-300 disabled:opacity-50 transition-colors shadow-sm"
      >
        <svg
          className={`w-4 h-4 ${isRunning ? 'animate-spin' : ''}`}
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
        {isRunning ? 'Sincronizando...' : 'Actualizar propios y rivales'}
      </button>
    </div>
  )
}
