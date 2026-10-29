'use client'

import { useMemo, useState } from 'react'
import type { AlertRule, PublicationAlert } from '@/lib/price-alerts'
import RulesSection from './RulesSection'
import HistorySection from './HistorySection'
import SyncButton from '../productos/SyncButton'

type Props = { rules: AlertRule[]; initialAlerts: PublicationAlert[]; skus: { sku: string; title: string }[] }

export default function AlertasLayout({ rules, initialAlerts, skus }: Props) {
  const [alerts, setAlerts] = useState(initialAlerts)
  // Adopt refreshed server data without preserving stale read/deleted rows.
  const [previousAlerts, setPreviousAlerts] = useState(initialAlerts)
  if (previousAlerts !== initialAlerts) {
    setPreviousAlerts(initialAlerts)
    setAlerts(initialAlerts)
  }
  const unreadCount = alerts.filter(alert => !alert.read_at).length
  const [showRules, setShowRules] = useState(false)

  const stats = useMemo(() => {
    let cheaper = 0
    let pricier = 0
    let changed = 0
    for (const a of alerts) {
      const t = a.ml_price_alert_rules?.rule_type ?? ''
      if (t === 'competitor_cheaper' || t === 'price_diff_pct_above') cheaper++
      else if (t === 'competitor_pricier' || t === 'price_diff_pct_below') pricier++
      else changed++
    }
    return { total: alerts.length, cheaper, pricier, changed }
  }, [alerts])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <h1 className="text-2xl font-bold text-gray-900">Alertas de precio</h1>
            {unreadCount > 0 && (
              <span className="inline-flex items-center gap-1.5 bg-red-50 text-red-600 text-xs font-semibold px-2.5 py-1 rounded-full border border-red-100">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                {unreadCount} sin leer
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500">
            Movimientos de precio detectados en competidores
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <SyncButton />
          <button
            onClick={() => setShowRules(true)}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-colors shadow-sm"
          >
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Reglas
            {rules.length > 0 && (
              <span className="ml-0.5 bg-gray-100 text-gray-600 text-xs font-semibold px-1.5 py-0.5 rounded">{rules.length}</span>
            )}
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatChip label="Total" value={stats.total} tone="neutral" />
        <StatChip label="Competidor más barato" value={stats.cheaper} tone="red" />
        <StatChip label="Competidor más caro" value={stats.pricier} tone="blue" />
        <StatChip label="Cambios" value={stats.changed} tone="amber" />
      </div>

      {/* History */}
      <HistorySection
        alerts={alerts}
        setAlerts={setAlerts}
        skus={skus}
        rules={rules.map((r: { id: string; name: string }) => ({ id: r.id, name: r.name }))}
      />

      {/* Rules panel */}
      {showRules && (
        <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]" onClick={() => setShowRules(false)}>
          <div
            className="absolute top-0 right-0 h-full w-full max-w-lg bg-white shadow-2xl flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
              <h2 className="text-base font-semibold text-gray-900">Reglas de alerta</h2>
              <button
                onClick={() => setShowRules(false)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <RulesSection initialRules={rules} skus={skus} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatChip({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'red' | 'blue' | 'amber' }) {
  const toneStyles = {
    neutral: { dot: 'bg-gray-400', value: 'text-gray-900' },
    red: { dot: 'bg-red-500', value: 'text-red-600' },
    blue: { dot: 'bg-blue-500', value: 'text-blue-600' },
    amber: { dot: 'bg-amber-500', value: 'text-amber-600' },
  }[tone]
  return (
    <div className="bg-white border border-gray-100 rounded-xl px-4 py-3 flex items-center gap-3">
      <span className={`w-2 h-2 rounded-full ${toneStyles.dot} shrink-0`} />
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-wider text-gray-400 font-medium">{label}</p>
        <p className={`text-xl font-bold ${toneStyles.value} leading-tight`}>{value}</p>
      </div>
    </div>
  )
}
