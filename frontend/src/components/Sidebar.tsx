'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { getProjectByPath, type ProjectView } from '@/lib/projects'
import { createClient } from '@/lib/supabase/client'
import BrandLogo from '@/components/BrandLogo'
import type { User } from '@supabase/supabase-js'
import type React from 'react'

type IconProps = { className?: string }

const HomeIcon = ({ className }: IconProps) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 12l9-9 9 9M5 10v10a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1V10" />
  </svg>
)
const BoxIcon = ({ className }: IconProps) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20 7L12 3 4 7m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
  </svg>
)
const BellIcon = ({ className }: IconProps) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0" />
  </svg>
)
const TrendIcon = ({ className }: IconProps) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 17l6-6 4 4 8-8m0 0h-5m5 0v5" />
  </svg>
)
const UsersIcon = ({ className }: IconProps) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6 5.87a4 4 0 10-6 0M16 3.13a4 4 0 010 7.75M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
  </svg>
)
const LogoutIcon = ({ className }: IconProps) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 16l4-4m0 0l-4-4m4 4H9m0-8H5a2 2 0 00-2 2v12a2 2 0 002 2h4" />
  </svg>
)
const iconMap: Record<ProjectView['icon'], (props: IconProps) => React.ReactNode> = {
  home: HomeIcon,
  box: BoxIcon,
  bell: BellIcon,
  trend: TrendIcon,
  users: UsersIcon,
}

const dashboardHome = { href: '/dashboard', label: 'Dashboard', icon: 'home' as const }

export default function Sidebar({ user }: { user: User }) {
  const pathname = usePathname()
  const router = useRouter()
  const project = getProjectByPath(pathname)
  const initial = (user.email ?? '?').charAt(0).toUpperCase()
  const navItems = [dashboardHome, ...project.views]

  async function handleLogout() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-5 lg:flex lg:h-[calc(100dvh-2.5rem)] lg:min-h-0 lg:w-[296px] lg:self-start">
      <div className="flex h-full w-full flex-col gap-3 px-4 pb-4 pt-4 sm:px-6 lg:rounded-[1.75rem] lg:border lg:border-[rgba(185,11,8,0.10)] lg:bg-[rgba(255,255,255,0.78)] lg:px-4 lg:py-4 lg:shadow-[0_24px_60px_rgba(42,31,29,0.08)] lg:backdrop-blur-sm">
        <div className="overflow-hidden rounded-[1.6rem] bg-[#050505] p-4 text-white sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <BrandLogo />
              <p className="mt-4 text-[11px] uppercase tracking-[0.34em] text-white/56">Eurotech Monitor</p>
            </div>
            <div className="rounded-full border border-white/10 bg-white/6 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.26em] text-white/76">
              Activo
            </div>
          </div>

          <div className="mt-5">
            <p className="text-2xl font-semibold tracking-tight text-white sm:text-[2rem]">Centro de control</p>
            <p className="mt-2 max-w-[15rem] text-sm leading-6 text-white/70">
              Accesos clave del monitor en una estructura compacta y clara.
            </p>
          </div>
        </div>

        <div className="rounded-[1.4rem] border border-[rgba(185,11,8,0.10)] bg-[rgba(255,255,255,0.78)] px-3 py-3 shadow-[0_10px_26px_rgba(185,11,8,0.05)] lg:flex lg:flex-col lg:flex-1 lg:min-h-0 lg:bg-transparent lg:px-0 lg:pt-3 lg:pb-0 lg:shadow-none">
          <div className="mb-3 flex items-center justify-between px-1 lg:px-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.28em] text-[rgba(185,11,8,0.62)]">Navegación</p>
              <p className="mt-1 text-sm font-medium text-[var(--brand-900)]">{project.name}</p>
            </div>
          </div>

          <nav className="flex gap-2 overflow-x-auto pb-1 lg:flex lg:flex-col lg:flex-1 lg:min-h-0 lg:gap-1.5 lg:overflow-y-auto lg:overflow-x-hidden lg:pb-0 lg:pr-1">
            {navItems.map(({ href, label, icon }) => {
              const Icon = iconMap[icon]
              const isActive = href === '/dashboard' ? pathname === href : pathname.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className={`group relative flex min-w-[158px] items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-medium transition-all lg:min-w-0 lg:px-4 ${
                    isActive
                      ? 'bg-[linear-gradient(135deg,rgba(185,11,8,0.14),rgba(217,58,52,0.08))] text-[var(--brand-900)] shadow-[inset_0_0_0_1px_rgba(185,11,8,0.10)]'
                      : 'text-[rgba(42,31,29,0.72)] hover:bg-[rgba(185,11,8,0.05)] hover:text-[var(--brand-900)]'
                  }`}
                >
                  {isActive && (
                    <span className="absolute bottom-2 left-2 top-2 hidden w-1 rounded-full bg-[linear-gradient(180deg,#B90B08_0%,#D93A34_100%)] lg:block" />
                  )}
                  <span className={`inline-flex h-9 w-9 items-center justify-center rounded-2xl border ${
                    isActive
                      ? 'border-[rgba(185,11,8,0.14)] bg-white text-[var(--brand-800)]'
                      : 'border-[rgba(42,31,29,0.08)] bg-[rgba(255,255,255,0.72)] text-[rgba(42,31,29,0.42)] group-hover:text-[rgba(42,31,29,0.62)]'
                  }`}>
                    <Icon className="h-4.5 w-4.5 shrink-0" />
                  </span>
                  <span className="truncate">{label}</span>
                </Link>
              )
            })}
          </nav>
        </div>

        <div className="mt-auto rounded-[1.4rem] border border-[rgba(185,11,8,0.10)] bg-[rgba(255,255,255,0.84)] px-4 py-4 shadow-[0_10px_26px_rgba(185,11,8,0.05)]">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#B90B08_0%,#D93A34_100%)] text-sm font-semibold text-white shadow-[0_3px_8px_rgba(185,11,8,0.14)]">
              {initial}
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.24em] text-[rgba(185,11,8,0.58)]">Sesión activa</p>
              <p className="mt-1 truncate text-sm font-medium text-[var(--brand-900)]">{user.email}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-[rgba(185,11,8,0.12)] bg-[rgba(185,11,8,0.05)] px-4 py-3 text-sm font-medium text-[var(--brand-900)] transition-colors hover:bg-[rgba(185,11,8,0.10)]"
          >
            <LogoutIcon className="h-4.5 w-4.5" />
            Cerrar sesión
          </button>
        </div>
      </div>
    </aside>
  )
}
