'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Select from '@/components/Select'
import RuleTypeBadge from './RuleTypeBadge'

const RULE_LABELS: Record<string, string> = {
  price_changed: 'Cambio de precio',
  competitor_cheaper: 'Competidor más barato',
  competitor_pricier: 'Competidor más caro',
  price_diff_pct_above: 'Competidor más barato por %',
  price_diff_pct_below: 'Competidor más caro por %',
}

type Rule = {
  id: string
  name: string
  rule_type: string
  sku: string | null
  threshold_pct: number | null
  compare_catalog_price: boolean
  enabled: boolean
  created_at: string
  ml_price_alerts: [{ count: number }] | []
}

type Sku = { sku: string; title: string }

function RuleForm({
  title,
  skus,
  initial,
  saving,
  error,
  onSubmit,
  onCancel,
}: {
  title: string
  skus: Sku[]
  initial: { name: string; ruleType: string; sku: string; threshold: string; compareCatalog: boolean }
  saving: boolean
  error: string | null
  onSubmit: (values: { name: string; ruleType: string; sku: string; threshold: string; compareCatalog: boolean }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial.name)
  const [ruleType, setRuleType] = useState(initial.ruleType)
  const [selectedSku, setSelectedSku] = useState(initial.sku)
  const [threshold, setThreshold] = useState(initial.threshold)
  const [compareCatalog, setCompareCatalog] = useState(initial.compareCatalog)
  const needsThreshold = ['price_diff_pct_above', 'price_diff_pct_below'].includes(ruleType)

  return (
    <form
      onSubmit={e => { e.preventDefault(); onSubmit({ name, ruleType, sku: selectedSku, threshold, compareCatalog }) }}
      className="bg-white border border-blue-200 rounded-xl p-5 mb-4 space-y-4"
    >
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 sm:col-span-1">
          <label className="block text-xs text-gray-500 mb-1">Nombre</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            required
            placeholder="Ej: Competidor más barato"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Tipo de regla</label>
          <Select
            aria-label="Tipo de regla"
            variant="form"
            value={ruleType}
            onValueChange={value => setRuleType(value)}
            options={Object.entries(RULE_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">SKU (opcional — vacío = global)</label>
          <Select
            aria-label="SKU de la regla"
            variant="form"
            value={selectedSku}
            onValueChange={value => setSelectedSku(value)}
            options={[{ value: '', label: 'Todos los productos' }, ...skus.map(s => ({ value: s.sku, label: `${s.sku} — ${s.title}` }))]}
          />
        </div>
        {needsThreshold && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">Umbral (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={threshold}
              onChange={e => setThreshold(e.target.value)}
              required
              placeholder="Ej: 5"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
        )}
        <div className="col-span-2 flex items-center gap-2 pt-1">
          <input
            id="compare-catalog"
            type="checkbox"
            checked={compareCatalog}
            onChange={e => setCompareCatalog(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
          />
          <label htmlFor="compare-catalog" className="text-xs text-gray-600 select-none cursor-pointer">
            Comparar contra precio catálogo <span className="text-gray-400">(la oferta activa siempre tiene prioridad)</span>
          </label>
        </div>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Guardando...' : 'Guardar'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Cancelar
        </button>
      </div>
    </form>
  )
}

export default function RulesSection({
  initialRules,
  skus,
}: {
  initialRules: Rule[]
  skus: Sku[]
}) {
  const router = useRouter()
  const [rules, setRules] = useState<Rule[]>(initialRules)
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  async function handleCreate(values: { name: string; ruleType: string; sku: string; threshold: string; compareCatalog: boolean }) {
    setCreating(true)
    setCreateError(null)
    const needsThreshold = ['price_diff_pct_above', 'price_diff_pct_below'].includes(values.ruleType)
    try {
      const res = await fetch('/api/alert-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          rule_type: values.ruleType,
          sku: values.sku || null,
          threshold_pct: needsThreshold ? Number(values.threshold) : null,
          compare_catalog_price: values.compareCatalog,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setRules(prev => [{ ...data, compare_catalog_price: values.compareCatalog, ml_price_alerts: [] }, ...prev])
      setShowCreate(false)
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Error')
    } finally {
      setCreating(false)
    }
  }

  async function handleEdit(id: string, values: { name: string; ruleType: string; sku: string; threshold: string; compareCatalog: boolean }) {
    setEditSaving(true)
    setEditError(null)
    const needsThreshold = ['price_diff_pct_above', 'price_diff_pct_below'].includes(values.ruleType)
    try {
      const res = await fetch(`/api/alert-rules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          rule_type: values.ruleType,
          sku: values.sku || null,
          threshold_pct: needsThreshold ? Number(values.threshold) : null,
          compare_catalog_price: values.compareCatalog,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setRules(prev => prev.map(r => r.id === id ? {
        ...r,
        name: values.name,
        rule_type: values.ruleType,
        sku: values.sku || null,
        threshold_pct: needsThreshold ? Number(values.threshold) : null,
        compare_catalog_price: values.compareCatalog,
      } : r))
      setEditingId(null)
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Error')
    } finally {
      setEditSaving(false)
    }
  }

  async function handleToggle(rule: Rule) {
    const next = !rule.enabled
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, enabled: next } : r))
    await fetch(`/api/alert-rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
    router.refresh()
  }

  async function handleDelete(id: string) {
    setRules(prev => prev.filter(r => r.id !== id))
    setConfirmDeleteId(null)
    await fetch(`/api/alert-rules/${id}`, { method: 'DELETE' })
    router.refresh()
  }

  return (
    <section>
      {!showCreate && !editingId && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 text-sm font-medium bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
          >
            <span className="text-base leading-none">+</span> Nueva regla
          </button>
        </div>
      )}

      {showCreate && (
        <RuleForm
          title="Nueva regla de alerta"
          skus={skus}
          initial={{ name: '', ruleType: 'competitor_cheaper', sku: '', threshold: '', compareCatalog: true }}
          saving={creating}
          error={createError}
          onSubmit={handleCreate}
          onCancel={() => { setShowCreate(false); setCreateError(null) }}
        />
      )}

      {rules.length === 0 ? (
        <div className="bg-white border border-gray-100 rounded-xl p-8 text-center text-gray-400 text-sm">
          No hay reglas configuradas. Creá una para empezar a recibir alertas.
        </div>
      ) : (
        <div className="bg-white border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-50">
          {rules.map(rule => {
            const count = Array.isArray(rule.ml_price_alerts) && rule.ml_price_alerts[0]
              ? (rule.ml_price_alerts[0] as { count: number }).count
              : 0
            const isEditing = editingId === rule.id
            const isConfirmingDelete = confirmDeleteId === rule.id

            return (
              <div key={rule.id} className={!rule.enabled ? 'opacity-50' : ''}>
                {/* Rule row */}
                <div className="flex items-center gap-3 px-4 py-3 flex-wrap">
                  {/* Type badge + name */}
                  <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap">
                    <RuleTypeBadge ruleType={rule.rule_type} thresholdPct={rule.threshold_pct} />
                    <span className="text-sm font-medium text-gray-900">{rule.name}</span>
                    {rule.sku ? (
                      <span className="font-mono text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{rule.sku}</span>
                    ) : (
                      <span className="text-xs text-gray-400">Global</span>
                    )}
                  </div>

                  {/* Fires count */}
                  <div className="shrink-0">
                    {count > 0 ? (
                      <span className="bg-orange-100 text-orange-700 text-xs font-semibold px-2 py-0.5 rounded-full">{count} disparos</span>
                    ) : (
                      <span className="text-xs text-gray-300">0 disparos</span>
                    )}
                  </div>

                  {/* Toggle */}
                  <button
                    onClick={() => handleToggle(rule)}
                    className={`relative inline-flex h-5 w-9 rounded-full transition-colors shrink-0 ${rule.enabled ? 'bg-blue-600' : 'bg-gray-200'}`}
                  >
                    <span className={`inline-block h-4 w-4 mt-0.5 rounded-full bg-white shadow transition-transform ${rule.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>

                  {/* Actions */}
                  {isConfirmingDelete ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-gray-500">¿Eliminar?</span>
                      <button
                        onClick={() => handleDelete(rule.id)}
                        className="text-xs font-medium text-white bg-red-500 hover:bg-red-600 px-2 py-1 rounded-lg transition-colors"
                      >
                        Sí, eliminar
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-xs font-medium text-gray-500 border border-gray-200 hover:bg-gray-50 px-2 py-1 rounded-lg transition-colors"
                      >
                        Cancelar
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => { setEditingId(isEditing ? null : rule.id); setEditError(null) }}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        title="Editar regla"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(rule.id)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        title="Eliminar regla"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>

                {/* Edit form */}
                {isEditing && (
                  <div className="px-4 pb-4">
                    <RuleForm
                      title="Editar regla"
                      skus={skus}
                      initial={{
                        name: rule.name,
                        ruleType: rule.rule_type,
                        sku: rule.sku ?? '',
                        threshold: rule.threshold_pct?.toString() ?? '',
                        compareCatalog: rule.compare_catalog_price ?? true,
                      }}
                      saving={editSaving}
                      error={editError}
                      onSubmit={values => handleEdit(rule.id, values)}
                      onCancel={() => { setEditingId(null); setEditError(null) }}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
