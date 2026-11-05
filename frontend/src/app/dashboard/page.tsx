import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function formatSyncDate(dateStr: string | null | undefined): string {
  if (!dateStr) return 'Nunca'
  const date = new Date(dateStr)
  return new Intl.DateTimeFormat('es-UY', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function freshness(dateStr: string | null | undefined): 'fresh' | 'stale' | 'never' {
  if (!dateStr) return 'never'
  const age = Date.now() - new Date(dateStr).getTime()
  return age < 3 * 60 * 60 * 1000 ? 'fresh' : 'stale'
}

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const admin = createAdminClient()

  const [
    { count: totalProducts },
    { count: activeProducts },
    alertasResult,
    lastProductSyncResult,
    lastCompetitorSyncResult,
  ] = await Promise.all([
    admin.schema('ml').from('ml_products').select('*', { count: 'exact', head: true }),
    admin.schema('ml').from('ml_products').select('*', { count: 'exact', head: true }).eq('status', 'active'),
    admin.schema('ml').from('ml_price_alerts').select('*', { count: 'exact', head: true }),
    admin.schema('ml').from('ml_products').select('synced_at').order('synced_at', { ascending: false }).limit(1).single(),
    admin.schema('ml').from('ml_competitor_items').select('synced_at').order('synced_at', { ascending: false }).limit(1).single(),
  ])
  const totalAlertas = alertasResult.error ? null : alertasResult.count
  const lastProductSync = lastProductSyncResult.data?.synced_at ?? null
  const lastCompetitorSync = lastCompetitorSyncResult.data?.synced_at ?? null

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-[var(--brand-900)]">Dashboard global</h1>
        <p className="text-sm text-[rgba(42,31,29,0.62)] mt-0.5">Bienvenido, {user?.email}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label="Total publicaciones"
          value={totalProducts != null ? String(totalProducts) : '—'}
          description="En MercadoLibre"
          tone="neutral"
        />
        <StatCard
          label="Publicaciones activas"
          value={activeProducts != null ? String(activeProducts) : '—'}
          description="Con stock disponible"
          tone="green"
        />
        <StatCard
          label="Alertas de precio"
          value={totalAlertas != null ? String(totalAlertas) : '—'}
          description="Configuradas"
          tone="blue"
        />
      </div>

      <div>
        <h2 className="text-xs font-semibold text-[rgba(42,31,29,0.55)] uppercase tracking-wider mb-3">Última actualización de datos</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <SyncCard
            title="Productos propios"
            description="ml-sync · cada 2 horas"
            lastSync={formatSyncDate(lastProductSync)}
            status={freshness(lastProductSync)}
          />
          <SyncCard
            title="Productos de la competencia"
            description="ml-sync-competitor · cada 2 horas"
            lastSync={formatSyncDate(lastCompetitorSync)}
            status={freshness(lastCompetitorSync)}
          />
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, description, tone }: { label: string; value: string; description: string; tone: 'neutral' | 'green' | 'blue' }) {
  const valueColor = { neutral: 'text-[var(--brand-900)]', green: 'text-[var(--brand-800)]', blue: 'text-[var(--brand-700)]' }[tone]
  const dotColor = { neutral: 'bg-[rgba(42,31,29,0.30)]', green: 'bg-[rgba(185,11,8,0.45)]', blue: 'bg-[rgba(185,11,8,0.68)]' }[tone]
  return (
    <div className="bg-white rounded-xl p-5 border border-[rgba(185,11,8,0.12)] hover:border-[rgba(185,11,8,0.20)] hover:shadow-sm transition-all">
      <div className="flex items-center gap-2 mb-3">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <p className="text-xs font-medium text-[rgba(42,31,29,0.55)] uppercase tracking-wider">{label}</p>
      </div>
      <p className={`text-3xl font-bold ${valueColor} leading-none`}>{value}</p>
      <p className="text-xs text-[rgba(42,31,29,0.42)] mt-2">{description}</p>
    </div>
  )
}

function SyncCard({ title, description, lastSync, status }: { title: string; description: string; lastSync: string; status: 'fresh' | 'stale' | 'never' }) {
  const dotColor = { fresh: 'bg-[rgba(185,11,8,0.55)]', stale: 'bg-[rgba(185,11,8,0.28)]', never: 'bg-[rgba(42,31,29,0.30)]' }[status]
  const dotAnim = status === 'fresh' ? 'animate-pulse' : ''
  return (
    <div className="bg-white rounded-xl p-4 border border-[rgba(185,11,8,0.12)] flex items-center gap-3">
      <div className="relative shrink-0">
        <span className={`block w-2.5 h-2.5 rounded-full ${dotColor} ${dotAnim}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--brand-900)]">{title}</p>
        <p className="text-xs text-[rgba(42,31,29,0.42)] mt-0.5">{description}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs text-[rgba(42,31,29,0.65)] font-medium">{lastSync}</p>
      </div>
    </div>
  )
}
