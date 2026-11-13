export type ProjectId = 'ml-monitor'

export type ProjectView = {
  href: string
  label: string
  icon: 'home' | 'box' | 'bell' | 'trend' | 'users'
}

export type ProjectConfig = {
  id: ProjectId
  name: string
  shortName: string
  eyebrow: string
  basePath: string
  accent: string
  views: ProjectView[]
}

export const projects: ProjectConfig[] = [
  {
    id: 'ml-monitor',
    name: 'Eurotech Monitor',
    shortName: 'EM',
    eyebrow: 'Eurotech',
    basePath: '/dashboard',
    accent: 'from-blue-500 to-cyan-500',
    views: [
      { href: '/dashboard/alertas', label: 'Alertas de precios', icon: 'bell' },
      { href: '/dashboard/productos', label: 'Agregar precios rivales', icon: 'box' },
      { href: '/dashboard/seguimiento', label: 'Seguimiento', icon: 'trend' },
      { href: '/dashboard/sincronizaciones', label: 'Sincronizaciones', icon: 'trend' },
      { href: '/dashboard/usuarios', label: 'Usuarios', icon: 'users' },
    ],
  },
]

export function getProjectByPath(pathname: string): ProjectConfig {
  return (
    projects
      .filter(project => pathname === project.basePath || pathname.startsWith(`${project.basePath}/`))
      .sort((a, b) => b.basePath.length - a.basePath.length)[0] ?? projects[0]
  )
}
