'use client'

import ManualSyncControl from '@/components/ManualSyncControl'
import {
  Fragment,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from 'react'
import Image from 'next/image'
import Select from '@/components/Select'
import ComparisonBoard, {
  money,
  type BoardRival,
} from '@/components/ComparisonBoard'
import AddMonitorTarget from '@/components/AddMonitorTarget'
import {
  linksForProduct,
  referencePrice,
  type OwnProduct,
} from '@/lib/monitoring'

function Accordion({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="text-sm font-semibold text-gray-700">{title}</span>
        <span
          className={`text-gray-400 text-lg leading-none transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        >
          ›
        </span>
      </button>
      {open && (
        <div className="px-5 pb-4 border-t border-gray-100">{children}</div>
      )}
    </div>
  )
}

type Product = OwnProduct & {
  id: string
  title: string
  subtitle: string | null
  sku: string | null
  price: number | null
  sale_price: number | null
  catalog_price: number | null
  buybox_price: number | null
  buybox_seller_id: number | null
  base_price: number | null
  original_price: number | null
  currency_id: string | null
  available_quantity: number | null
  sold_quantity: number | null
  initial_quantity: number | null
  status: string | null
  condition: string | null
  listing_type_id: string | null
  buying_mode: string | null
  thumbnail: string | null
  permalink: string | null
  category_id: string | null
  domain_id: string | null
  catalog_product_id: string | null
  parent_item_id: string | null
  family_id: string | null
  family_name: string | null
  user_product_id: string | null
  inventory_id: string | null
  seller_custom_field: string | null
  warranty: string | null
  health: number | null
  automatic_relist: boolean | null
  catalog_listing: boolean | null
  date_created: string | null
  last_updated: string | null
  synced_at: string | null
  start_time: string | null
  stop_time: string | null
  shipping?: Record<string, unknown> | null
  tags?: unknown[] | null
  attributes?: unknown[] | null
  pictures?: { secure_url?: string; url?: string }[] | null
  descriptions?: unknown | null
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Activo',
  paused: 'Pausado',
  closed: 'Cerrado',
  under_review: 'En revisión',
}

const STATUS_COLOR: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  closed: 'bg-gray-100 text-gray-600',
  under_review: 'bg-blue-100 text-blue-700',
}

// ML thumbnail suffix -I = tiny, -O = original (up to 1200px)
function imgUrl(thumbnail: string | null, size: 'thumb' | 'full' = 'thumb') {
  if (!thumbnail) return null
  const https = thumbnail.replace('http://', 'https://')
  if (size === 'full')
    return https.replace(/-I\.jpg$/, '-O.jpg').replace(/-[A-Z]\.jpg$/, '-O.jpg')
  // For lists/grid use -F (medium, ~500px) instead of -I (tiny)
  return https.replace(/-I\.jpg$/, '-F.jpg')
}

function formatPrice(price: number | null, currency: string | null) {
  return money(price, currency)
}
function formatOwnPrice(product: OwnProduct) {
  const { observation } = referencePrice(product)
  return formatPrice(
    observation.normalizedAmount ?? observation.amount,
    observation.normalizedCurrency ?? observation.currency,
  )
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(dateStr))
}

function formatRelative(dateStr: string | null) {
  if (!dateStr) return null
  const diff = Date.now() - new Date(dateStr).getTime()
  const hours = diff / 1000 / 3600
  if (hours < 1) return 'hace minutos'
  if (hours < 24) return `hace ${Math.floor(hours)}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `hace ${days}d`
  return `hace ${Math.floor(days / 30)} meses`
}

function isStale(dateStr: string | null) {
  if (!dateStr) return true
  return Date.now() - new Date(dateStr).getTime() > 7 * 24 * 3600 * 1000
}

function normalizeDescriptionText(value: string) {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function descriptionsToText(descriptions: unknown): string | null {
  if (!descriptions) return null
  if (typeof descriptions === 'string') {
    const text = normalizeDescriptionText(descriptions)
    return text || null
  }

  if (Array.isArray(descriptions)) {
    const text = descriptions
      .map((item) => descriptionsToText(item))
      .filter(Boolean)
      .join('\n\n')
    return text || null
  }

  if (typeof descriptions === 'object') {
    const maybeText = descriptions as {
      plain_text?: unknown
      text?: unknown
      description?: unknown
    }
    const value =
      typeof maybeText.plain_text === 'string'
        ? maybeText.plain_text
        : typeof maybeText.text === 'string'
          ? maybeText.text
          : typeof maybeText.description === 'string'
            ? maybeText.description
            : null
    if (value) {
      const text = normalizeDescriptionText(value)
      return text || null
    }
  }

  return null
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === '' || value === '—') return null
  return (
    <div className="flex justify-between gap-4 py-3 border-b border-gray-50 last:border-0">
      <span className="text-sm text-gray-400 shrink-0">{label}</span>
      <span className="text-sm text-gray-900 text-right font-medium break-all">
        {value}
      </span>
    </div>
  )
}

type Competitor = BoardRival & {
  our_sku: string | null
  our_product_id?: string | null
  usd_price: number | null
  thumbnail: string | null
  seller_id: number | null
  synced_at: string | null
  paused: boolean
}

type RivalSuggestion = {
  title: string
  url: string
  item_id: string | null
  seller_name: string | null
  price: number | null
  currency_id: string | null
  thumbnail: string | null
  confidence: number
  reason: string
  matched_terms: string[]
}

type RivalSearchCacheEntry = {
  candidates: RivalSuggestion[]
  summary: string
  costEstimate: string
  searchedAt: string
}

const RIVAL_SEARCH_STORAGE_KEY = 'ml-rival-search-results-v1'
const PRODUCT_FAVORITES_STORAGE_KEY = 'ml-product-favorites-v1'
const RIVAL_SEARCH_COST_ESTIMATE = '~US$0.01-0.03'

function CompetitorDot({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-600 text-xs font-medium">
      <span className="w-1.5 h-1.5 rounded-full bg-orange-500 inline-block" />
      {count}
    </span>
  )
}

type ViewMode = 'tabla' | 'listado' | 'grid'
type CompetitorFilter = 'all' | 'with' | 'without'
type GroupMode = 'none' | 'related'
type PublicationFilter = 'all' | 'traditional' | 'catalog'
function indexCompetitorsByOwner(source: Record<string, Competitor[]>) {
  return {
    all: [
      ...new Map(
        Object.values(source)
          .flat()
          .map((rival) => [rival.id, rival]),
      ).values(),
    ],
  }
}
type RelatedGroup = {
  key: string
  label: string
  detail: string
  source:
    | 'catalog'
    | 'user_product'
    | 'parent'
    | 'family'
    | 'inventory'
    | 'standalone'
}

function getRelatedGroup(product: Product): RelatedGroup {
  if (product.catalog_product_id)
    return {
      key: `catalog:${product.catalog_product_id}`,
      label: 'Catalogo ML',
      detail: product.catalog_product_id,
      source: 'catalog',
    }
  if (product.user_product_id)
    return {
      key: `user_product:${product.user_product_id}`,
      label: 'User product ML',
      detail: product.user_product_id,
      source: 'user_product',
    }
  if (product.parent_item_id)
    return {
      key: `parent:${product.parent_item_id}`,
      label: 'Publicacion padre',
      detail: product.parent_item_id,
      source: 'parent',
    }
  if (product.family_id)
    return {
      key: `family:${product.family_id}`,
      label: product.family_name
        ? `Familia ${product.family_name}`
        : 'Familia ML',
      detail: product.family_id,
      source: 'family',
    }
  if (product.inventory_id)
    return {
      key: `inventory:${product.inventory_id}`,
      label: 'Inventario ML',
      detail: product.inventory_id,
      source: 'inventory',
    }
  return {
    key: `single:${product.id}`,
    label: 'Sin relacion',
    detail: product.id,
    source: 'standalone',
  }
}

function getPublicationType(product: Product): 'catalog' | 'traditional' {
  if (product.catalog_listing === true) return 'catalog'
  return 'traditional'
}

function getPublicationTypeLabel(product: Product) {
  return getPublicationType(product) === 'catalog' ? 'Catálogo' : 'Tradicional'
}

function getPublicationTypeClasses(product: Product) {
  return getPublicationType(product) === 'catalog'
    ? 'bg-blue-100 text-blue-700'
    : 'bg-slate-100 text-slate-700'
}

function PublicationTypeBadge({ product }: { product: Product }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getPublicationTypeClasses(product)}`}
    >
      {getPublicationTypeLabel(product)}
    </span>
  )
}

function getRelatedProducts(
  product: Product,
  relationGroupByKey: Map<string, Product[]>,
) {
  const relation = getRelatedGroup(product)
  const related = relationGroupByKey.get(relation.key) ?? []
  return related.filter((candidate) => candidate.id !== product.id)
}

function formatRelatedProductLabel(product: Product) {
  return `${product.id} · ${getPublicationTypeLabel(product)}`
}

function StarButton({
  active,
  onClick,
  className = '',
}: {
  active: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors ${
        active
          ? 'border-amber-300 bg-amber-50 text-amber-500 hover:bg-amber-100'
          : 'border-gray-200 bg-white text-gray-300 hover:border-amber-200 hover:text-amber-400'
      } ${className}`}
      title={active ? 'Quitar destacado' : 'Destacar producto'}
      aria-label={active ? 'Quitar destacado' : 'Destacar producto'}
    >
      <svg
        className="h-4 w-4"
        viewBox="0 0 24 24"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M11.48 3.5a.56.56 0 011.04 0l2.12 5.39a.56.56 0 00.48.35l5.77.43a.56.56 0 01.32.99l-4.4 3.7a.56.56 0 00-.18.56l1.38 5.62a.56.56 0 01-.84.61L12.3 18.1a.56.56 0 00-.6 0l-4.87 3.06a.56.56 0 01-.84-.61l1.38-5.62a.56.56 0 00-.18-.56l-4.4-3.7a.56.56 0 01.32-.99l5.77-.43a.56.56 0 00.48-.35l2.12-5.39z"
        />
      </svg>
    </button>
  )
}

function RelationButton({
  product,
  relationGroupByKey,
  onOpenRelated,
}: {
  product: Product
  relationGroupByKey: Map<string, Product[]>
  onOpenRelated: (product: Product) => void
}) {
  const related = getRelatedProducts(product, relationGroupByKey)
  if (related.length === 0) return null

  const relatedLabel =
    related.length === 1
      ? formatRelatedProductLabel(related[0])
      : `${formatRelatedProductLabel(related[0])} +${related.length - 1}`

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onOpenRelated(related[0])
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50/80 px-2.5 py-1 text-xs font-medium text-emerald-700 transition-colors hover:border-emerald-300 hover:bg-emerald-100"
      title={related.map(formatRelatedProductLabel).join(', ')}
    >
      <svg
        className="h-3.5 w-3.5 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M17 1l4 4-4 4"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M3 11V9a4 4 0 014-4h14"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M7 23l-4-4 4-4"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M21 13v2a4 4 0 01-4 4H3"
        />
      </svg>
      <span className="truncate">Sync: {relatedLabel}</span>
      <svg
        className="h-3.5 w-3.5 shrink-0 opacity-70"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 5l7 7-7 7"
        />
      </svg>
    </button>
  )
}

function IconTable() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 10h18M3 6h18M3 14h18M3 18h18"
      />
    </svg>
  )
}
function IconList() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 6h16M4 12h16M4 18h7"
      />
    </svg>
  )
}
function IconGrid() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
      />
    </svg>
  )
}

export default function ProductsTable({
  initialProducts,
  totalCount,
  competitorsBySku,
  categoryMap,
}: {
  initialProducts: Product[]
  totalCount: number
  competitorsBySku: Record<string, Competitor[]>
  categoryMap: Record<string, string>
}) {
  const PAGE_SIZE = 50

  const [products, setProducts] = useState<Product[]>(initialProducts)
  const [isLoadingMore, setIsLoadingMore] = useState(
    initialProducts.length < totalCount,
  )
  const [selected, setSelected] = useState<Product | null>(null)
  type ProductMedia = {
    attributes: unknown[] | null
    pictures: Product['pictures']
    shipping: Product['shipping']
    descriptions: Product['descriptions']
  }
  // Heavy JSONB fields fetched on-demand when the panel opens (kept out of the
  // list query for perf). Keyed by product id so we don't refetch on re-select.
  const [mediaById, setMediaById] = useState<Record<string, ProductMedia>>({})

  useEffect(() => {
    if (!selected || mediaById[selected.id]) return
    let cancelled = false
    fetch(`/api/product-media/${selected.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        setMediaById((prev) => ({
          ...prev,
          [selected.id]: {
            attributes: data?.attributes ?? null,
            pictures: data?.pictures ?? null,
            shipping: data?.shipping ?? null,
            descriptions: data?.descriptions ?? null,
          },
        }))
      })
      .catch(() => {
        if (cancelled) return
        setMediaById((prev) => ({
          ...prev,
          [selected.id]: {
            attributes: null,
            pictures: null,
            shipping: null,
            descriptions: null,
          },
        }))
      })
    return () => {
      cancelled = true
    }
  }, [selected, mediaById])

  useEffect(() => {
    if (initialProducts.length >= totalCount) {
      startTransition(() => setIsLoadingMore(false))
      return
    }

    let cancelled = false
    const pageSize = 250

    async function loadRemainingProducts() {
      setIsLoadingMore(true)
      let from = initialProducts.length

      while (!cancelled && from < totalCount) {
        const res = await fetch(
          `/api/products-page?from=${from}&limit=${pageSize}`,
        )
        const data = await res.json()
        if (!res.ok) break

        const nextProducts = Array.isArray(data.products)
          ? (data.products as Product[])
          : []
        if (nextProducts.length === 0) break

        startTransition(() => {
          setProducts((prev) => {
            const seen = new Set(prev.map((product) => product.id))
            const merged = [...prev]
            for (const product of nextProducts) {
              if (!seen.has(product.id)) merged.push(product)
            }
            return merged
          })
        })

        from =
          typeof data.nextFrom === 'number'
            ? data.nextFrom
            : from + nextProducts.length
        if (!data.hasMore) break
      }

      if (!cancelled) setIsLoadingMore(false)
    }

    loadRemainingProducts().catch(() => {
      if (!cancelled) setIsLoadingMore(false)
    })

    return () => {
      cancelled = true
    }
  }, [initialProducts.length, totalCount])

  const selectedMedia = selected ? mediaById[selected.id] : undefined
  const selectedPictures = selectedMedia?.pictures ?? selected?.pictures ?? null
  const selectedShipping = selectedMedia?.shipping ?? selected?.shipping ?? null
  const selectedDescriptions =
    selectedMedia?.descriptions ?? selected?.descriptions ?? null
  const selectedDescriptionText = descriptionsToText(selectedDescriptions)
  const selectedDescriptionLoading = selected ? !selectedMedia : false
  const [view, setView] = useState<ViewMode>('grid')
  const [localCompetitors, setLocalCompetitors] = useState<
    Record<string, Competitor[]>
  >(() => indexCompetitorsByOwner(competitorsBySku))
  const [showAddModal, setShowAddModal] = useState(false)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [competitorFilter, setCompetitorFilter] =
    useState<CompetitorFilter>('all')
  const [competitorNameFilter, setCompetitorNameFilter] = useState('')
  const [groupMode, setGroupMode] = useState<GroupMode>('none')
  const [publicationFilter, setPublicationFilter] =
    useState<PublicationFilter>('all')
  const [showPaused, setShowPaused] = useState(false)
  const [panelTab, setPanelTab] = useState<'competitors' | 'details'>(
    'competitors',
  )
  const [currentPage, setCurrentPage] = useState(0)
  const [rivalSuggestions, setRivalSuggestions] = useState<
    Record<string, RivalSuggestion[]>
  >({})
  const [rivalSearchSummary, setRivalSearchSummary] = useState<
    Record<string, string>
  >({})
  const [rivalSearchCost, setRivalSearchCost] = useState<
    Record<string, string>
  >({})
  const [rivalResultsCollapsed, setRivalResultsCollapsed] = useState<
    Record<string, boolean>
  >({})
  const [rivalSearchLoadingId, setRivalSearchLoadingId] = useState<
    string | null
  >(null)
  const [rivalSearchError, setRivalSearchError] = useState<string | null>(null)
  const [suggestedInput, setSuggestedInput] = useState('')
  const [favoriteProductIds, setFavoriteProductIds] = useState<string[]>([])

  const getCompetitorsForProduct = useCallback(
    (product: Product) => {
      return [
        ...new Map(
          Object.values(localCompetitors)
            .flat()
            .map((rival) => [rival.id, rival]),
        ).values(),
      ]
        .map((rival) => {
          const links = linksForProduct(rival.links ?? [], product)
          return { ...rival, links, paused: links.every((link) => link.paused) }
        })
        .filter((rival) => rival.links.length > 0)
    },
    [localCompetitors],
  )

  async function reloadCompetitors() {
    const response = await fetch('/api/competitors')
    const data = await response.json()
    if (!response.ok || !Array.isArray(data))
      throw new Error(data.error ?? 'No se pudieron cargar los rivales')
    setLocalCompetitors({ all: data })
  }

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RIVAL_SEARCH_STORAGE_KEY)
      if (!raw) return
      const cache = JSON.parse(raw) as Record<string, RivalSearchCacheEntry>
      const suggestions: Record<string, RivalSuggestion[]> = {}
      const summaries: Record<string, string> = {}
      const costs: Record<string, string> = {}

      for (const [productId, entry] of Object.entries(cache)) {
        if (!entry || !Array.isArray(entry.candidates)) continue
        suggestions[productId] = entry.candidates
        summaries[productId] = entry.summary ?? ''
        costs[productId] = entry.costEstimate ?? RIVAL_SEARCH_COST_ESTIMATE
      }

      startTransition(() => {
        setRivalSuggestions(suggestions)
        setRivalSearchSummary(summaries)
        setRivalSearchCost(costs)
      })
    } catch {
      window.localStorage.removeItem(RIVAL_SEARCH_STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PRODUCT_FAVORITES_STORAGE_KEY)
      if (!raw) return
      const ids = JSON.parse(raw)
      if (Array.isArray(ids)) {
        startTransition(() =>
          setFavoriteProductIds(
            ids.filter((value): value is string => typeof value === 'string'),
          ),
        )
      }
    } catch {
      window.localStorage.removeItem(PRODUCT_FAVORITES_STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    startTransition(() => setRivalSearchError(null))
  }, [selected?.id])

  function persistRivalSearch(
    productId: string,
    entry: RivalSearchCacheEntry | null,
  ) {
    try {
      const raw = window.localStorage.getItem(RIVAL_SEARCH_STORAGE_KEY)
      const cache = raw
        ? (JSON.parse(raw) as Record<string, RivalSearchCacheEntry>)
        : {}
      if (entry) cache[productId] = entry
      else delete cache[productId]
      window.localStorage.setItem(
        RIVAL_SEARCH_STORAGE_KEY,
        JSON.stringify(cache),
      )
    } catch {
      // Local storage is best-effort only.
    }
  }

  function persistFavorites(nextIds: string[]) {
    try {
      window.localStorage.setItem(
        PRODUCT_FAVORITES_STORAGE_KEY,
        JSON.stringify(nextIds),
      )
    } catch {
      // Local storage is best-effort only.
    }
  }

  async function handleSyncProduct(productId: string) {
    try {
      const res = await fetch(`/api/sync-product?id=${productId}`, {cache:'no-store'})
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error')
      // Update selected product in state with fresh prices
      setSelected((prev) => (prev ? { ...prev, ...data } : prev))
      setProducts((previous) =>
        previous.map((product) =>
          product.id === productId ? { ...product, ...data } : product,
        ),
      )
      if (data.descriptions !== undefined) {
        setMediaById((prev) => {
          const current = prev[productId]
          if (!current) return prev
          return {
            ...prev,
            [productId]: {
              ...current,
              descriptions: data.descriptions ?? current.descriptions,
            },
          }
        })
      }
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'No se pudo refrescar la publicación')
    }
  }

  function handleSelect(p: Product) {
    setSelected(selected?.id === p.id ? null : p)
  }

  function handleOpenRelatedProduct(product: Product) {
    setSelected(product)
    setPanelTab('details')
  }

  function toggleFavorite(productId: string) {
    setFavoriteProductIds((prev) => {
      const nextIds = prev.includes(productId)
        ? prev.filter((id) => id !== productId)
        : [productId, ...prev]
      persistFavorites(nextIds)
      return nextIds
    })
  }

  function handleAdded(rival: Competitor) {
    setLocalCompetitors((previous) => ({
      all: [
        ...new Map(
          [...Object.values(previous).flat(), rival].map((item) => [
            item.id,
            item,
          ]),
        ).values(),
      ],
    }))
  }

  async function handleSearchRivals(product: Product) {
    setRivalSearchLoadingId(product.id)
    setRivalSearchError(null)
    setRivalSearchCost((prev) => ({
      ...prev,
      [product.id]: RIVAL_SEARCH_COST_ESTIMATE,
    }))
    setRivalResultsCollapsed((prev) => ({ ...prev, [product.id]: false }))
    try {
      const res = await fetch('/api/rival-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id, limit: 5 }),
      })
      const data = await res.json()
      if (!res.ok)
        throw new Error(data.error ?? 'No se pudieron buscar rivales')
      const candidates = Array.isArray(data.candidates) ? data.candidates : []
      const summary = typeof data.summary === 'string' ? data.summary : ''
      const costEstimate =
        typeof data.cost_estimate_usd === 'string'
          ? data.cost_estimate_usd
          : RIVAL_SEARCH_COST_ESTIMATE
      setRivalSuggestions((prev) => ({
        ...prev,
        [product.id]: candidates,
      }))
      setRivalSearchSummary((prev) => ({
        ...prev,
        [product.id]: summary,
      }))
      setRivalSearchCost((prev) => ({ ...prev, [product.id]: costEstimate }))
      persistRivalSearch(product.id, {
        candidates,
        summary,
        costEstimate,
        searchedAt: new Date().toISOString(),
      })
    } catch (e) {
      setRivalSearchError(
        e instanceof Error ? e.message : 'No se pudieron buscar rivales',
      )
    } finally {
      setRivalSearchLoadingId(null)
    }
  }

  function handleAddSuggestedCompetitor(suggestion: RivalSuggestion) {
    setSuggestedInput(suggestion.url)
    setShowAddModal(true)
  }

  function handleDeleteRivalSearch(productId: string) {
    setRivalSuggestions((prev) => {
      const next = { ...prev }
      delete next[productId]
      return next
    })
    setRivalSearchSummary((prev) => {
      const next = { ...prev }
      delete next[productId]
      return next
    })
    setRivalSearchCost((prev) => {
      const next = { ...prev }
      delete next[productId]
      return next
    })
    setRivalResultsCollapsed((prev) => {
      const next = { ...prev }
      delete next[productId]
      return next
    })
    persistRivalSearch(productId, null)
  }

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const categoriesWithNames = useMemo(() => {
    const categories = Array.from(
      new Set(products.map((p) => p.category_id).filter(Boolean)),
    ) as string[]
    return categories
      .map((id) => ({ id, name: categoryMap[id] ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [products, categoryMap])
  const competitorNameOptions = useMemo(
    () =>
      Array.from(
        new Set(
          Object.values(localCompetitors)
            .flat()
            .map((c) => c.seller_name?.trim() || c.title?.trim() || '')
            .filter(Boolean),
        ),
      ).sort((a, b) => a.localeCompare(b, 'es')),
    [localCompetitors],
  )

  const relationGroupByKey = useMemo(() => {
    const grouped = new Map<string, Product[]>()
    for (const product of products) {
      const relation = getRelatedGroup(product)
      if (!grouped.has(relation.key)) grouped.set(relation.key, [])
      grouped.get(relation.key)!.push(product)
    }
    return grouped
  }, [products])
  const favoriteProductIdSet = useMemo(
    () => new Set(favoriteProductIds),
    [favoriteProductIds],
  )

  function resetPage() {
    setCurrentPage(0)
  }

  const pausedCount = useMemo(
    () => products.filter((p) => p.status === 'paused').length,
    [products],
  )
  const trimmedSearch = deferredSearch.trim()
  const hasSearch = trimmedSearch.length > 0

  const filteredProducts = useMemo(() => {
    const normalizedQuery = hasSearch ? trimmedSearch.toLowerCase() : null

    return products
      .filter((p) => {
        if (p.status === 'under_review') return false
        if (!showPaused && p.status === 'paused') return false
        if (
          publicationFilter === 'catalog' &&
          getPublicationType(p) !== 'catalog'
        )
          return false
        if (
          publicationFilter === 'traditional' &&
          getPublicationType(p) !== 'traditional'
        )
          return false
        if (normalizedQuery) {
          if (
            !p.title?.toLowerCase().includes(normalizedQuery) &&
            !p.sku?.toLowerCase().includes(normalizedQuery) &&
            !p.seller_custom_field?.toLowerCase().includes(normalizedQuery) &&
            !p.id.toLowerCase().includes(normalizedQuery)
          )
            return false
        }
        const competitorItems = getCompetitorsForProduct(p).filter(
          (c) => showPaused || !c.paused,
        )
        const competitorCount = competitorItems.length
        if (competitorFilter === 'with' && competitorCount === 0) return false
        if (competitorFilter === 'without' && competitorCount > 0) return false
        if (competitorNameFilter) {
          const hasCompetitor = competitorItems.some(
            (c) =>
              (c.seller_name?.trim() || c.title?.trim() || '') ===
              competitorNameFilter,
          )
          if (!hasCompetitor) return false
        }
        if (selectedCategory && p.category_id !== selectedCategory) return false
        return true
      })
      .sort((a, b) => {
        const aFavorite = favoriteProductIdSet.has(a.id) ? 0 : 1
        const bFavorite = favoriteProductIdSet.has(b.id) ? 0 : 1
        if (aFavorite !== bFavorite) return aFavorite - bFavorite
        if (groupMode === 'related') {
          const aGroup = getRelatedGroup(a)
          const bGroup = getRelatedGroup(b)
          if (aGroup.key !== bGroup.key) {
            const aSize = relationGroupByKey.get(aGroup.key)?.length ?? 1
            const bSize = relationGroupByKey.get(bGroup.key)?.length ?? 1
            if (aSize !== bSize) return bSize - aSize
            return `${aGroup.label} ${aGroup.detail}`.localeCompare(
              `${bGroup.label} ${bGroup.detail}`,
              'es',
            )
          }
        }
        const aLosing = 0
        const bLosing = 0
        if (aLosing !== bLosing) return aLosing - bLosing
        const aHas = getCompetitorsForProduct(a).length > 0 ? 0 : 1
        const bHas = getCompetitorsForProduct(b).length > 0 ? 0 : 1
        if (aHas !== bHas) return aHas - bHas
        return 0
      })
  }, [
    products,
    showPaused,
    publicationFilter,
    hasSearch,
    trimmedSearch,
    competitorFilter,
    competitorNameFilter,
    selectedCategory,
    groupMode,
    relationGroupByKey,
    getCompetitorsForProduct,
    favoriteProductIdSet,
  ])

  const totalPages = Math.ceil(filteredProducts.length / PAGE_SIZE)
  const pagedProducts = useMemo(
    () =>
      filteredProducts.slice(
        currentPage * PAGE_SIZE,
        (currentPage + 1) * PAGE_SIZE,
      ),
    [filteredProducts, currentPage],
  )
  const hiddenFilterLabels = [
    competitorFilter === 'with' ? 'con rivales' : null,
    competitorFilter === 'without' ? 'sin rivales' : null,
    competitorNameFilter ? `competidor: ${competitorNameFilter}` : null,
    selectedCategory ? 'categoria' : null,
    publicationFilter === 'catalog' ? 'solo catalogo' : null,
    publicationFilter === 'traditional' ? 'solo tradicionales' : null,
    !showPaused ? 'sin pausados' : null,
    groupMode === 'related' ? 'agrupado por relacion ML' : null,
  ].filter(Boolean)

  function clearFilters() {
    setCompetitorFilter('all')
    setCompetitorNameFilter('')
    setSelectedCategory(null)
    setPublicationFilter('all')
    setShowPaused(false)
    setGroupMode('none')
    resetPage()
  }

  const catalogCount = useMemo(
    () => products.filter((p) => getPublicationType(p) === 'catalog').length,
    [products],
  )
  const traditionalCount = products.length - catalogCount

  const groupMetaByKey = useMemo(() => {
    const meta = new Map<
      string,
      { title: string; count: number; related: boolean }
    >()
    for (const [key, groupedProducts] of relationGroupByKey.entries()) {
      const relation = getRelatedGroup(groupedProducts[0])
      meta.set(key, {
        title: `${relation.label}: ${relation.detail}`,
        count: groupedProducts.length,
        related: groupedProducts.length > 1 && relation.source !== 'standalone',
      })
    }
    return meta
  }, [relationGroupByKey])

  const emptyProductsState = (
    <div className="bg-white rounded-xl border border-gray-100 px-6 py-12 text-center">
      <p className="text-sm font-medium text-gray-900">
        No hay productos para mostrar
      </p>
      <p className="text-sm text-gray-400 mt-1">
        {hasSearch
          ? `No encontramos "${trimmedSearch}" con los filtros activos.`
          : hiddenFilterLabels.length > 0
            ? `Filtros activos: ${hiddenFilterLabels.join(', ')}.`
            : 'No hay productos para esta vista.'}
      </p>
      {(competitorFilter !== 'all' ||
        competitorNameFilter ||
        selectedCategory ||
        groupMode !== 'none') && (
        <button
          onClick={clearFilters}
          className="mt-4 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Limpiar filtros
        </button>
      )}
    </div>
  )

  const orphanedLinks = Object.values(localCompetitors)
    .flat()
    .flatMap((rival) =>
      (rival.links ?? [])
        .filter((link) => link.orphaned)
        .map((link) => ({ ...link, rivalId: rival.id })),
    )
  return (
    <div className="relative">
      {orphanedLinks.length > 0 && (
        <details className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <summary>
            {orphanedLinks.length} asociaciones sin destino actual
          </summary>
          <ul>
            {orphanedLinks.map((link) => (
              <li key={link.id}>
                {link.rivalId} → {link.our_product_id ?? link.our_sku} ·
                Equivalencia pendiente de revisión
              </li>
            ))}
          </ul>
          <p>
            Se conservan sus vínculos e historial. Agregá la asociación correcta
            desde la publicación correspondiente.
          </p>
        </details>
      )}
      {isLoadingMore && (
        <p role="status" className="mb-2 text-xs text-slate-500">
          Cargando publicaciones restantes…
        </p>
      )}
      {/* Backdrop */}
      {selected && (
        <div
          className="fixed inset-0 bg-black/20 z-30"
          onClick={() => setSelected(null)}
        />
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Search */}
        <div className="relative flex-[1.3] min-w-[20rem]">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              resetPage()
            }}
            placeholder="Buscar por título, SKU o ID..."
            className="w-full pl-9 pr-4 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          />
        </div>

        {/* Category filter */}
        <Select
          aria-label="Categoría"
          variant="form"
          value={selectedCategory ?? ''}
          onValueChange={(value) => {
            setSelectedCategory(value || null)
            resetPage()
          }}
          options={[
            { value: '', label: 'Todas las categorías' },
            ...categoriesWithNames.map(({ id, name }) => ({
              value: id,
              label: name,
            })),
          ]}
          className="!w-[11rem] !py-1.5"
        />

        {competitorNameOptions.length > 0 && (
          <Select
            aria-label="Competidor"
            variant="form"
            value={competitorNameFilter}
            onValueChange={(value) => {
              setCompetitorNameFilter(value)
              resetPage()
            }}
            options={[
              { value: '', label: 'Todos los competidores' },
              ...competitorNameOptions.map((name) => ({
                value: name,
                label: name,
              })),
            ]}
            className="!w-auto !py-1.5"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {/* Competitors filter */}
        <div className="inline-flex items-center rounded-lg border border-gray-200 bg-white p-0.5">
          {(
            [
              ['all', 'Todos'],
              ['with', 'Con rivales'],
              ['without', 'Sin rivales'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setCompetitorFilter(value)
                resetPage()
              }}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                competitorFilter === value
                  ? 'bg-gray-900 text-white shadow-sm'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="inline-flex items-center rounded-lg border border-gray-200 bg-white p-0.5">
          {(
            [
              ['none', 'Sin agrupar'],
              ['related', 'Agrupar relacionados'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setGroupMode(value)
                resetPage()
              }}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                groupMode === value
                  ? 'bg-gray-900 text-white shadow-sm'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="inline-flex items-center rounded-lg border border-gray-200 bg-white p-0.5">
          {(
            [
              ['all', `Todos (${products.length})`],
              ['traditional', `Tradicionales (${traditionalCount})`],
              ['catalog', `Catálogo (${catalogCount})`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setPublicationFilter(value)
                resetPage()
              }}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                publicationFilter === value
                  ? 'bg-gray-900 text-white shadow-sm'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {pausedCount > 0 && (
          <button
            onClick={() => {
              setShowPaused((v) => !v)
              resetPage()
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
              showPaused
                ? 'bg-yellow-50 border-yellow-300 text-yellow-700'
                : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />
            Pausados ({pausedCount})
          </button>
        )}

        {/* View switcher */}
        <div className="flex gap-1 ml-auto">
          {(
            [
              ['tabla', <IconTable key="t" />],
              ['listado', <IconList key="l" />],
              ['grid', <IconGrid key="g" />],
            ] as [ViewMode, React.ReactNode][]
          ).map(([mode, icon]) => (
            <button
              key={mode}
              onClick={() => startTransition(() => setView(mode))}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize ${
                view === mode
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-500 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              {icon} {mode}
            </button>
          ))}
        </div>
      </div>

      {filteredProducts.length === 0 ? (
        emptyProductsState
      ) : (
        <>
          {/* Vista: Tabla */}
          {view === 'tabla' && (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden w-full">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-gray-500 text-xs uppercase tracking-wide">
                    <th className="px-4 py-3 font-medium w-20"></th>
                    <th className="px-4 py-3 font-medium">Producto</th>
                    <th className="px-4 py-3 font-medium">SKU</th>
                    <th className="px-4 py-3 font-medium text-right">Precio</th>
                    <th className="px-4 py-3 font-medium text-right">Cat.</th>
                    <th className="px-4 py-3 font-medium text-right">Stock</th>
                    <th className="px-4 py-3 font-medium text-right">
                      Vendidos
                    </th>
                    <th className="px-4 py-3 font-medium">Estado</th>
                    <th className="px-4 py-3 font-medium">Actualizado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {pagedProducts.map((p, index) => {
                    const compCount = getCompetitorsForProduct(p).length
                    const isFavorite = favoriteProductIdSet.has(p.id)
                    const relation = getRelatedGroup(p)
                    const previousRelation =
                      index > 0
                        ? getRelatedGroup(pagedProducts[index - 1])
                        : null
                    const groupInfo = groupMetaByKey.get(relation.key)
                    return (
                      <Fragment key={p.id}>
                        {groupMode === 'related' &&
                          groupInfo &&
                          (!previousRelation ||
                            previousRelation.key !== relation.key) && (
                            <tr className="bg-gray-50/80 border-b border-gray-100">
                              <td colSpan={9} className="px-4 py-2.5 text-xs">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-semibold text-gray-700">
                                    {groupInfo.title}
                                  </span>
                                  <span
                                    className={`px-2 py-0.5 rounded-full font-medium ${groupInfo.related ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-600'}`}
                                  >
                                    {groupInfo.related
                                      ? `${groupInfo.count} relacionados`
                                      : 'individual'}
                                  </span>
                                </div>
                              </td>
                            </tr>
                          )}
                        <tr
                          onClick={() => handleSelect(p)}
                          className={`cursor-pointer transition-colors ${
                            selected?.id === p.id
                              ? 'bg-blue-50'
                              : isFavorite
                                ? 'bg-amber-50/60 hover:bg-amber-50'
                                : compCount > 0
                                  ? 'hover:bg-orange-50/30'
                                  : 'hover:bg-gray-50'
                          }`}
                        >
                          <td className="px-4 py-2">
                            <div className="relative w-16 h-16">
                              {p.thumbnail ? (
                                <Image
                                  src={imgUrl(p.thumbnail)!}
                                  alt={p.title}
                                  width={64}
                                  height={64}
                                  className="rounded object-contain w-16 h-16"
                                  unoptimized
                                />
                              ) : (
                                <div className="w-16 h-16 bg-gray-100 rounded" />
                              )}
                              <StarButton
                                active={isFavorite}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  toggleFavorite(p.id)
                                }}
                                className="absolute -top-2 -right-2 h-6 w-6"
                              />
                            </div>
                          </td>
                          <td className="px-4 py-3 max-w-xs">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                aria-label={`Abrir ${p.id}`}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  setSelected(p)
                                }}
                                className="text-left text-sm font-medium text-gray-900 focus-visible:outline-2"
                              >
                                {p.title}
                              </button>
                              <CompetitorDot count={compCount} />
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              <PublicationTypeBadge product={p} />
                              <RelationButton
                                product={p}
                                relationGroupByKey={relationGroupByKey}
                                onOpenRelated={handleOpenRelatedProduct}
                              />
                            </div>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {p.condition === 'new' ? 'Nuevo' : 'Usado'} ·{' '}
                              {p.id}
                            </p>
                          </td>
                          <td className="px-4 py-3 text-xs font-mono text-gray-600">
                            {p.sku ?? '—'}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <p
                              className={`text-xs font-medium ${p.sale_price != null ? 'text-emerald-600' : 'text-gray-700'}`}
                            >
                              {formatOwnPrice(p)}
                            </p>
                            {p.sale_price != null &&
                              p.price != null &&
                              p.sale_price !== p.price && (
                                <p className="text-xs text-gray-400 line-through">
                                  {formatPrice(p.price, p.currency_id)}
                                </p>
                              )}
                            {p.sale_price == null &&
                              p.catalog_price != null &&
                              p.price != null &&
                              p.catalog_price !== p.price && (
                                <p className="text-xs text-gray-400">
                                  pub. {formatPrice(p.price, p.currency_id)}
                                </p>
                              )}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {p.catalog_price != null ? (
                              <span
                                className={
                                  p.catalog_price < (p.price ?? 0)
                                    ? 'text-blue-600 font-medium'
                                    : 'text-gray-700'
                                }
                              >
                                {formatPrice(
                                  p.catalog_price,
                                  p.catalog_item_id === p.id
                                    ? (p.catalog_currency_id ?? null)
                                    : null,
                                )}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700">
                            {p.available_quantity ?? '—'}
                          </td>
                          <td className="px-4 py-3 text-right text-gray-700">
                            {p.sold_quantity ?? '—'}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[p.status ?? ''] ?? 'bg-gray-100 text-gray-600'}`}
                            >
                              {STATUS_LABEL[p.status ?? ''] ?? p.status ?? '—'}
                            </span>
                          </td>
                          <td
                            className="px-4 py-3 text-xs whitespace-nowrap"
                            suppressHydrationWarning
                          >
                            <span
                              className={
                                isStale(p.last_updated)
                                  ? 'text-amber-500 font-medium'
                                  : 'text-gray-400'
                              }
                              suppressHydrationWarning
                            >
                              {formatRelative(p.last_updated)}
                            </span>
                          </td>
                        </tr>
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Vista: Listado */}
          {view === 'listado' && (
            <div className="space-y-2">
              {pagedProducts.map((p, index) => {
                const compCount = getCompetitorsForProduct(p).length
                const isFavorite = favoriteProductIdSet.has(p.id)
                const losingBuybox = false
                const relation = getRelatedGroup(p)
                const previousRelation =
                  index > 0 ? getRelatedGroup(pagedProducts[index - 1]) : null
                const groupInfo = groupMetaByKey.get(relation.key)
                return (
                  <Fragment key={p.id}>
                    {groupMode === 'related' &&
                      groupInfo &&
                      (!previousRelation ||
                        previousRelation.key !== relation.key) && (
                        <div className="px-1 pb-1 pt-2 text-xs flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-gray-700">
                            {groupInfo.title}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full font-medium ${groupInfo.related ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-600'}`}
                          >
                            {groupInfo.related
                              ? `${groupInfo.count} relacionados`
                              : 'individual'}
                          </span>
                        </div>
                      )}
                    <div
                      onClick={() => handleSelect(p)}
                      className={`flex items-center gap-4 bg-white rounded-xl border px-4 py-3 cursor-pointer transition-colors ${
                        selected?.id === p.id
                          ? 'border-blue-300 bg-blue-50'
                          : isFavorite
                            ? 'border-amber-200 bg-amber-50/60 hover:bg-amber-50'
                            : losingBuybox
                              ? 'border-red-200 hover:bg-red-50/20'
                              : compCount > 0
                                ? 'border-orange-100 hover:bg-orange-50/20'
                                : 'border-gray-100 hover:bg-gray-50'
                      }`}
                    >
                      <div className="relative shrink-0">
                        {p.thumbnail ? (
                          <Image
                            src={imgUrl(p.thumbnail)!}
                            alt={p.title}
                            width={72}
                            height={72}
                            className="rounded object-contain w-18 h-18"
                            unoptimized
                          />
                        ) : (
                          <div className="w-18 h-18 bg-gray-100 rounded" />
                        )}
                        <StarButton
                          active={isFavorite}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleFavorite(p.id)
                          }}
                          className="absolute -top-1.5 -right-1.5 h-6 w-6"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-label={`Abrir ${p.id}`}
                            onClick={(event) => {
                              event.stopPropagation()
                              setSelected(p)
                            }}
                            className="text-left text-sm font-medium text-gray-900 focus-visible:outline-2"
                          >
                            {p.title}
                          </button>
                          <CompetitorDot count={compCount} />
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <PublicationTypeBadge product={p} />
                          <RelationButton
                            product={p}
                            relationGroupByKey={relationGroupByKey}
                            onOpenRelated={handleOpenRelatedProduct}
                          />
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 font-mono">
                          {p.sku ?? p.id}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p
                          className={`text-sm font-medium ${p.sale_price != null ? 'text-emerald-600' : 'text-gray-700'}`}
                        >
                          {formatOwnPrice(p)}
                        </p>
                        {p.sale_price != null &&
                          p.price != null &&
                          p.sale_price !== p.price && (
                            <p className="text-xs text-gray-400 line-through">
                              {formatPrice(p.price, p.currency_id)}
                            </p>
                          )}
                        {p.sale_price == null &&
                          p.catalog_price != null &&
                          p.price != null &&
                          p.catalog_price !== p.price && (
                            <p className="text-xs text-gray-400">
                              pub. {formatPrice(p.price, p.currency_id)}
                            </p>
                          )}
                        {losingBuybox && p.buybox_price != null && (
                          <p className="text-xs text-red-500 font-medium">
                            menor observado:{' '}
                            {formatPrice(p.buybox_price, p.currency_id)}
                          </p>
                        )}
                        <p className="text-xs text-gray-400 mt-0.5">
                          Stock: {p.available_quantity ?? '—'}
                        </p>
                        <p
                          className={`text-xs mt-0.5 ${isStale(p.last_updated) ? 'text-amber-500 font-medium' : 'text-gray-400'}`}
                          suppressHydrationWarning
                        >
                          {formatRelative(p.last_updated)}
                        </p>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${STATUS_COLOR[p.status ?? ''] ?? 'bg-gray-100 text-gray-600'}`}
                      >
                        {STATUS_LABEL[p.status ?? ''] ?? p.status ?? '—'}
                      </span>
                    </div>
                  </Fragment>
                )
              })}
            </div>
          )}

          {/* Vista: Grid */}
          {view === 'grid' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {pagedProducts.map((p, index) => {
                const compCount = getCompetitorsForProduct(p).length
                const isFavorite = favoriteProductIdSet.has(p.id)
                const losingBuybox = false
                const relation = getRelatedGroup(p)
                const previousRelation =
                  index > 0 ? getRelatedGroup(pagedProducts[index - 1]) : null
                const groupInfo = groupMetaByKey.get(relation.key)
                return (
                  <Fragment key={p.id}>
                    {groupMode === 'related' &&
                      groupInfo &&
                      (!previousRelation ||
                        previousRelation.key !== relation.key) && (
                        <div className="col-span-full flex items-center gap-2 flex-wrap pt-2">
                          <span className="text-xs font-semibold text-gray-700">
                            {groupInfo.title}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${groupInfo.related ? 'bg-blue-100 text-blue-700' : 'bg-gray-200 text-gray-600'}`}
                          >
                            {groupInfo.related
                              ? `${groupInfo.count} relacionados`
                              : 'individual'}
                          </span>
                        </div>
                      )}
                    <div
                      onClick={() => handleSelect(p)}
                      className={`bg-white rounded-xl border overflow-hidden cursor-pointer transition-colors relative ${
                        selected?.id === p.id
                          ? 'border-blue-300 bg-blue-50'
                          : isFavorite
                            ? 'border-amber-300 bg-amber-50/50 hover:border-amber-400'
                            : losingBuybox
                              ? 'border-red-300 hover:border-red-400'
                              : compCount > 0
                                ? 'border-orange-200 hover:border-orange-300'
                                : 'border-gray-100 hover:border-gray-300'
                      }`}
                    >
                      {/* Top-right competitor count */}
                      {compCount > 0 && (
                        <div className="absolute top-2 right-2 z-10">
                          <CompetitorDot count={compCount} />
                        </div>
                      )}
                      <div className="absolute bottom-2 right-2 z-10">
                        <StarButton
                          active={isFavorite}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleFavorite(p.id)
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-center bg-gray-50 h-40">
                        {p.thumbnail ? (
                          <Image
                            src={imgUrl(p.thumbnail)!}
                            alt={p.title}
                            width={140}
                            height={140}
                            className="object-contain w-full h-full p-3"
                            unoptimized
                          />
                        ) : (
                          <div className="w-full h-full bg-gray-100" />
                        )}
                      </div>
                      <div className="p-3">
                        <button
                          type="button"
                          aria-label={`Abrir ${p.id}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelected(p)
                          }}
                          className="text-left text-sm font-medium text-gray-900 focus-visible:outline-2"
                        >
                          {p.title}
                        </button>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <PublicationTypeBadge product={p} />
                          <RelationButton
                            product={p}
                            relationGroupByKey={relationGroupByKey}
                            onOpenRelated={handleOpenRelatedProduct}
                          />
                        </div>
                        {p.sku && (
                          <p className="text-xs text-gray-400 font-mono mt-1">
                            {p.sku}
                          </p>
                        )}
                        <div className="mt-2 flex items-center justify-between gap-1">
                          <div>
                            <span
                              className={`text-xs font-medium ${p.sale_price != null ? 'text-emerald-600' : 'text-gray-700'}`}
                            >
                              {formatOwnPrice(p)}
                            </span>
                            {losingBuybox && p.buybox_price != null ? (
                              <span
                                className="ml-1.5 text-xs text-red-500 font-medium"
                                title="Buy-box ganado por rival"
                              >
                                rival:{' '}
                                {formatPrice(p.buybox_price, p.currency_id)}
                              </span>
                            ) : null}
                            {p.sale_price != null &&
                              p.price != null &&
                              p.sale_price !== p.price && (
                                <p className="text-xs text-gray-400 mt-0.5 line-through">
                                  {formatPrice(p.price, p.currency_id)}
                                </p>
                              )}
                            {p.sale_price == null &&
                              p.catalog_price != null &&
                              p.price != null &&
                              p.catalog_price !== p.price && (
                                <p className="text-xs text-gray-400 mt-0.5">
                                  pub. {formatPrice(p.price, p.currency_id)}
                                </p>
                              )}
                          </div>
                          <span
                            className={`px-1.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[p.status ?? ''] ?? 'bg-gray-100 text-gray-600'}`}
                          >
                            {STATUS_LABEL[p.status ?? ''] ?? p.status ?? '—'}
                          </span>
                        </div>
                        <p
                          className={`text-xs mt-1 ${isStale(p.last_updated) ? 'text-amber-500 font-medium' : 'text-gray-400'}`}
                          suppressHydrationWarning
                        >
                          {formatRelative(p.last_updated)}
                        </p>
                      </div>
                    </div>
                  </Fragment>
                )
              })}
            </div>
          )}

          {/* Paginador */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 px-1">
              <p className="text-sm text-gray-400">
                {currentPage * PAGE_SIZE + 1}–
                {Math.min(
                  (currentPage + 1) * PAGE_SIZE,
                  filteredProducts.length,
                )}{' '}
                de {filteredProducts.length}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                  disabled={currentPage === 0}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  ← Anterior
                </button>
                {Array.from({ length: totalPages }, (_, i) => i).map((i) => (
                  <button
                    key={i}
                    onClick={() => setCurrentPage(i)}
                    className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${i === currentPage ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                  >
                    {i + 1}
                  </button>
                ))}
                <button
                  onClick={() =>
                    setCurrentPage((p) => Math.min(totalPages - 1, p + 1))
                  }
                  disabled={currentPage === totalPages - 1}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Siguiente →
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Detail panel — slides in from the right */}
      {(() => {
        const comps = selected ? getCompetitorsForProduct(selected) : []
        const compCount = comps.length
        const suggestions = selected
          ? (rivalSuggestions[selected.id] ?? [])
          : []
        const hasSearchedRivals = selected
          ? Object.prototype.hasOwnProperty.call(rivalSuggestions, selected.id)
          : false
        const rivalSearchLoading = selected
          ? rivalSearchLoadingId === selected.id
          : false
        const rivalSearchCollapsed = selected
          ? (rivalResultsCollapsed[selected.id] ?? false)
          : false
        const relatedProducts = selected
          ? getRelatedProducts(selected, relationGroupByKey)
          : []
        const selectedIsFavorite = selected
          ? favoriteProductIdSet.has(selected.id)
          : false
        const currentCostEstimate = selected
          ? (rivalSearchCost[selected.id] ?? RIVAL_SEARCH_COST_ESTIMATE)
          : RIVAL_SEARCH_COST_ESTIMATE
        return (
          <div
            className={`fixed top-0 right-0 h-full w-full md:w-[600px] bg-white shadow-2xl z-40 flex flex-col transition-transform duration-300 ease-in-out ${selected ? 'translate-x-0' : 'translate-x-full'}`}
          >
            {selected && (
              <>
                {/* Header */}
                <div className="flex items-start justify-between px-5 py-3 border-b border-gray-100 shrink-0">
                  <h2 className="font-semibold text-gray-900 leading-snug line-clamp-2 text-sm flex-1 min-w-0 pr-3">
                    {selected.title}
                  </h2>
                  <div className="flex items-center gap-2 shrink-0">
                    {selected && (
                      <StarButton
                        active={selectedIsFavorite}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggleFavorite(selected.id)
                        }}
                      />
                    )}
                    <ManualSyncControl key={selected.id} action="product" targetId={selected.id} origin="panel-producto" label="Actualizar esta publicación" compact onComplete={()=>handleSyncProduct(selected.id)}/>
                    <button
                      onClick={() => setSelected(null)}
                      className="text-gray-400 hover:text-gray-700 text-2xl leading-none"
                    >
                      ×
                    </button>
                  </div>
                </div>

                {/* Top 2-col: image + key info */}
                <div className="flex border-b border-gray-100 shrink-0">
                  <div className="w-40 shrink-0 bg-gray-50 flex items-center justify-center p-2 border-r border-gray-100">
                    {selectedPictures?.[0]?.secure_url || selected.thumbnail ? (
                      <Image
                        src={
                          selectedPictures?.[0]?.secure_url ??
                          imgUrl(selected.thumbnail, 'full')!
                        }
                        alt={selected.title}
                        width={144}
                        height={144}
                        className="object-contain w-full h-full"
                        style={{
                          width: 'auto',
                          height: 'auto',
                          maxWidth: '100%',
                          maxHeight: '144px',
                        }}
                        unoptimized
                      />
                    ) : (
                      <div className="w-full h-36 bg-gray-100 rounded" />
                    )}
                  </div>
                  <div className="flex-1 p-4 min-w-0">
                    <p className="font-mono text-xs text-slate-500">
                      {selected.id} · {selected.sku ?? 'Sin SKU'}
                    </p>
                    <p className="mt-2 text-xl font-semibold">
                      {formatPrice(
                        referencePrice(selected).observation.normalizedAmount ??
                          referencePrice(selected).observation.amount,
                        referencePrice(selected).observation
                          .normalizedCurrency ??
                          referencePrice(selected).observation.currency,
                      )}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Referencia:{' '}
                      {referencePrice(selected).reference === 'sale'
                        ? 'Oferta'
                        : referencePrice(selected).reference === 'catalog'
                          ? 'Catálogo de esta MLU'
                          : 'Publicación'}
                    </p>
                    <span className="mt-2 inline-block text-xs">
                      {STATUS_LABEL[selected.status ?? ''] ??
                        selected.status ??
                        '—'}
                    </span>
                    {selected.permalink && (
                      <a
                        href={selected.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 block text-xs text-blue-700 underline"
                      >
                        Ver en Mercado Libre
                      </a>
                    )}
                  </div>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-gray-100 shrink-0">
                  <button
                    onClick={() => setPanelTab('competitors')}
                    className={`flex-1 py-2.5 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${panelTab === 'competitors' ? 'border-b-2 border-blue-600 text-blue-700 bg-blue-50/40' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                      />
                    </svg>
                    Precios Competidores
                    {compCount > 0 && (
                      <span className="bg-orange-500 text-white text-xs px-1.5 py-0.5 rounded-full font-bold min-w-[20px] text-center">
                        {compCount}
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => setPanelTab('details')}
                    className={`flex-1 py-2.5 text-sm font-medium transition-colors ${panelTab === 'details' ? 'border-b-2 border-blue-600 text-blue-700 bg-blue-50/40' : 'text-gray-400 hover:text-gray-600'}`}
                  >
                    Detalles del producto
                  </button>
                </div>

                {/* Tab body */}
                <div className="overflow-y-auto flex-1">
                  {/* ── Competitors tab ── */}
                  {panelTab === 'competitors' && (
                    <div className="p-4 space-y-4">
                      {/* Toolbar */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex flex-col items-start gap-1">
                          <button
                            onClick={() => handleSearchRivals(selected)}
                            disabled={rivalSearchLoading}
                            className="flex items-center gap-2 text-xs font-medium bg-gray-900 text-white px-3 py-1.5 rounded-lg hover:bg-gray-800 disabled:opacity-70 transition-colors"
                          >
                            <span className="relative flex h-4 w-4 items-center justify-center">
                              {rivalSearchLoading && (
                                <>
                                  <span className="absolute h-4 w-4 rounded-full border border-white/50 animate-ping" />
                                  <span className="absolute h-2 w-2 rounded-full bg-white/30 animate-pulse" />
                                </>
                              )}
                              <svg
                                className="relative z-10 w-3.5 h-3.5"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M11 4l1.8 4.2L17 10l-4.2 1.8L11 16l-1.8-4.2L5 10l4.2-1.8L11 4z"
                                />
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M18 14l.9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14z"
                                />
                              </svg>
                            </span>
                            {rivalSearchLoading
                              ? 'Buscando con IA...'
                              : 'Buscar rivales con IA'}
                          </button>
                          {(rivalSearchLoading || hasSearchedRivals) && (
                            <span className="text-[11px] text-gray-400 px-1">
                              Costo estimado: {currentCostEstimate}
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => {
                            setSuggestedInput('')
                            setShowAddModal(true)
                          }}
                          className="flex items-center gap-1 text-xs font-medium bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
                        >
                          <span className="text-base leading-none">+</span>{' '}
                          Agregar rival
                        </button>
                      </div>

                      {(rivalSearchLoading ||
                        rivalSearchError ||
                        hasSearchedRivals) && (
                        <div className="border border-blue-100 bg-blue-50/70 rounded-xl p-3 space-y-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-xs font-semibold text-blue-900">
                                Sugerencias de búsqueda
                              </p>
                              {rivalSearchSummary[selected.id] && (
                                <p className="text-xs text-blue-700/70 mt-0.5">
                                  {rivalSearchSummary[selected.id]}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {suggestions.length > 0 && (
                                <span className="text-[11px] font-semibold text-blue-700 bg-white border border-blue-100 px-2 py-0.5 rounded-full">
                                  {suggestions.length}
                                </span>
                              )}
                              {hasSearchedRivals && (
                                <>
                                  <button
                                    onClick={() =>
                                      setRivalResultsCollapsed((prev) => ({
                                        ...prev,
                                        [selected.id]: !rivalSearchCollapsed,
                                      }))
                                    }
                                    className="w-7 h-7 rounded-full bg-white border border-blue-100 text-blue-600 hover:bg-blue-50 transition-colors"
                                    title={
                                      rivalSearchCollapsed
                                        ? 'Desplegar resultados'
                                        : 'Plegar resultados'
                                    }
                                  >
                                    {rivalSearchCollapsed ? '+' : '−'}
                                  </button>
                                  <button
                                    onClick={() =>
                                      handleDeleteRivalSearch(selected.id)
                                    }
                                    className="w-7 h-7 rounded-full bg-white border border-red-100 text-red-500 hover:bg-red-50 transition-colors"
                                    title="Eliminar resultados guardados"
                                  >
                                    ×
                                  </button>
                                </>
                              )}
                            </div>
                          </div>

                          {!rivalSearchCollapsed && rivalSearchError && (
                            <p className="text-sm text-red-600 bg-white border border-red-100 rounded-lg px-3 py-2">
                              {rivalSearchError}
                            </p>
                          )}

                          {!rivalSearchCollapsed &&
                            rivalSearchLoading &&
                            suggestions.length === 0 && (
                              <div className="space-y-2">
                                {[0, 1, 2].map((i) => (
                                  <div
                                    key={i}
                                    className="h-16 bg-white/70 border border-blue-100 rounded-lg animate-pulse"
                                  />
                                ))}
                              </div>
                            )}

                          {!rivalSearchCollapsed &&
                            !rivalSearchLoading &&
                            hasSearchedRivals &&
                            suggestions.length === 0 &&
                            !rivalSearchError && (
                              <p className="text-sm text-blue-700/70 bg-white border border-blue-100 rounded-lg px-3 py-2">
                                No aparecieron rivales nuevos para este
                                producto.
                              </p>
                            )}

                          {!rivalSearchCollapsed && suggestions.length > 0 && (
                            <div className="space-y-2">
                              {suggestions.map((suggestion) => {
                                const suggestionKey =
                                  suggestion.item_id ?? suggestion.url
                                const alreadyLinked = comps.some(
                                  (c) =>
                                    c.id === suggestion.item_id ||
                                    (!!suggestion.url &&
                                      c.permalink === suggestion.url),
                                )
                                return (
                                  <div
                                    key={suggestionKey}
                                    className="flex gap-3 bg-white border border-blue-100 rounded-lg p-2.5"
                                  >
                                    {suggestion.thumbnail ? (
                                      <Image
                                        src={imgUrl(suggestion.thumbnail)!}
                                        alt=""
                                        width={48}
                                        height={48}
                                        className="w-12 h-12 rounded-md object-contain bg-gray-50 shrink-0"
                                        unoptimized
                                      />
                                    ) : (
                                      <div className="w-12 h-12 rounded-md bg-gray-100 shrink-0" />
                                    )}
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-start gap-2">
                                        <div className="min-w-0 flex-1">
                                          <a
                                            href={suggestion.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-sm font-medium text-gray-900 hover:text-blue-700 line-clamp-2"
                                          >
                                            {suggestion.title}
                                          </a>
                                          <p className="text-xs text-gray-400 mt-0.5">
                                            {suggestion.seller_name ??
                                              'Vendedor sin identificar'}
                                            {suggestion.item_id
                                              ? ` · ${suggestion.item_id}`
                                              : ''}
                                          </p>
                                        </div>
                                        <span className="text-[11px] font-semibold text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">
                                          {Math.round(
                                            suggestion.confidence * 100,
                                          )}
                                          %
                                        </span>
                                      </div>
                                      <div className="mt-2 flex items-end justify-between gap-3">
                                        <div className="min-w-0">
                                          <p className="text-sm font-semibold text-gray-900">
                                            {formatPrice(
                                              suggestion.price,
                                              suggestion.currency_id ??
                                                selected.currency_id,
                                            )}
                                          </p>
                                          <p className="text-xs text-gray-500 line-clamp-2">
                                            {suggestion.reason}
                                          </p>
                                        </div>
                                        <div className="shrink-0 flex flex-col gap-1.5">
                                          <a
                                            href={suggestion.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="px-3 py-1.5 rounded-lg border border-blue-200 text-blue-700 text-xs font-medium hover:bg-blue-50 transition-colors text-center"
                                          >
                                            Abrir
                                          </a>
                                          <button
                                            onClick={() =>
                                              handleAddSuggestedCompetitor(
                                                suggestion,
                                              )
                                            }
                                            disabled={alreadyLinked}
                                            className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                                          >
                                            {alreadyLinked
                                              ? 'Agregado'
                                              : 'Revisar y agregar'}
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )}

                      <ComparisonBoard
                        product={{
                          ...selected,
                          attributes:
                            mediaById[selected.id]?.attributes ?? null,
                        }}
                        rivals={comps}
                        onChanged={reloadCompetitors}
                      />
                    </div>
                  )}

                  {/* ── Details tab ── */}
                  {panelTab === 'details' && (
                    <div className="p-4 space-y-2">
                      <Accordion title="Descripción" defaultOpen>
                        {selectedDescriptionText ? (
                          <p className="pt-4 text-sm leading-6 text-gray-700 whitespace-pre-line break-words">
                            {selectedDescriptionText}
                          </p>
                        ) : selectedDescriptionLoading ? (
                          <p className="pt-4 text-sm text-gray-400">
                            Cargando descripción...
                          </p>
                        ) : (
                          <p className="pt-4 text-sm text-gray-400">
                            Sin descripción sincronizada.
                          </p>
                        )}
                      </Accordion>
                      <Accordion title="General" defaultOpen>
                        <InfoRow label="ID ML" value={selected.id} />
                        <InfoRow label="SKU" value={selected.sku} />
                        <InfoRow
                          label="Campo vendedor"
                          value={selected.seller_custom_field}
                        />
                        <InfoRow
                          label="Sincronizado con"
                          value={
                            relatedProducts.length > 0
                              ? relatedProducts
                                  .map(formatRelatedProductLabel)
                                  .join(', ')
                              : null
                          }
                        />
                        <InfoRow
                          label="ID catálogo"
                          value={selected.catalog_product_id}
                        />
                        <InfoRow
                          label="Parent item"
                          value={selected.parent_item_id}
                        />
                        <InfoRow
                          label="User product"
                          value={selected.user_product_id}
                        />
                        <InfoRow label="Family ID" value={selected.family_id} />
                        <InfoRow
                          label="Family name"
                          value={selected.family_name}
                        />
                        <InfoRow
                          label="Inventory ID"
                          value={selected.inventory_id}
                        />
                        <InfoRow
                          label="Categoría"
                          value={selected.category_id}
                        />
                        <InfoRow label="Dominio" value={selected.domain_id} />
                        <InfoRow
                          label="Precio publicación"
                          value={formatPrice(
                            selected.price,
                            selected.currency_id,
                          )}
                        />
                        {selected.sale_price != null && (
                          <div className="flex justify-between gap-4 py-3 border-b border-gray-50">
                            <span className="text-sm text-gray-400 shrink-0">
                              Precio oferta ML
                            </span>
                            <span className="text-sm font-medium text-right">
                              <span className="text-emerald-600">
                                {formatPrice(
                                  selected.sale_price,
                                  selected.currency_id,
                                )}
                              </span>
                              {selected.price != null &&
                                selected.sale_price < selected.price && (
                                  <span className="ml-1.5 text-xs text-emerald-500">
                                    (−
                                    {(
                                      ((selected.price - selected.sale_price) /
                                        selected.price) *
                                      100
                                    ).toFixed(1)}
                                    %)
                                  </span>
                                )}
                            </span>
                          </div>
                        )}
                        {selected.catalog_price != null &&
                          selected.catalog_item_id === selected.id && (
                            <div className="flex justify-between gap-4 py-3 border-b border-gray-50">
                              <span className="text-sm text-gray-400 shrink-0">
                                Precio catálogo ML
                              </span>
                              <span className="text-sm font-medium text-right">
                                <span
                                  className={
                                    selected.catalog_price <
                                    (selected.price ?? 0)
                                      ? 'text-blue-600'
                                      : 'text-gray-900'
                                  }
                                >
                                  {formatPrice(
                                    selected.catalog_price,
                                    selected.catalog_currency_id ?? null,
                                  )}
                                </span>
                              </span>
                            </div>
                          )}
                        <InfoRow
                          label="Precio base"
                          value={formatPrice(
                            selected.base_price,
                            selected.currency_id,
                          )}
                        />
                        <InfoRow
                          label="Precio original"
                          value={formatPrice(
                            selected.original_price,
                            selected.currency_id,
                          )}
                        />
                        <InfoRow label="Moneda" value={selected.currency_id} />
                      </Accordion>
                      {relatedProducts.length > 0 && (
                        <Accordion
                          title="Publicaciones sincronizadas"
                          defaultOpen
                        >
                          <div className="pt-4 space-y-3">
                            {relatedProducts.map((product) => (
                              <button
                                key={product.id}
                                type="button"
                                onClick={() =>
                                  handleOpenRelatedProduct(product)
                                }
                                className="w-full rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-left transition-colors hover:bg-emerald-50"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-sm font-semibold text-gray-900">
                                        {product.id}
                                      </span>
                                      <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-emerald-700">
                                        {getPublicationTypeLabel(product)}
                                      </span>
                                    </div>
                                    <p className="mt-1 line-clamp-2 text-sm text-gray-700">
                                      {product.title}
                                    </p>
                                    <p className="mt-1 text-xs font-mono text-gray-500">
                                      {product.sku ?? 'Sin SKU'}
                                    </p>
                                  </div>
                                  <span className="shrink-0 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700">
                                    Abrir
                                  </span>
                                </div>
                              </button>
                            ))}
                          </div>
                        </Accordion>
                      )}
                      <Accordion title="Stock y ventas">
                        <InfoRow
                          label="Stock disponible"
                          value={selected.available_quantity}
                        />
                        <InfoRow
                          label="Stock inicial"
                          value={selected.initial_quantity}
                        />
                        <InfoRow
                          label="Vendidos"
                          value={selected.sold_quantity}
                        />
                      </Accordion>
                      <Accordion title="Publicación">
                        <InfoRow
                          label="Estado"
                          value={
                            STATUS_LABEL[selected.status ?? ''] ??
                            selected.status
                          }
                        />
                        <InfoRow
                          label="Condición"
                          value={
                            selected.condition === 'new'
                              ? 'Nuevo'
                              : selected.condition === 'used'
                                ? 'Usado'
                                : selected.condition
                          }
                        />
                        <InfoRow
                          label="Tipo de publicación"
                          value={selected.listing_type_id}
                        />
                        <InfoRow
                          label="Modo de compra"
                          value={selected.buying_mode}
                        />
                        <InfoRow label="Garantía" value={selected.warranty} />
                        <InfoRow
                          label="Salud"
                          value={
                            selected.health != null
                              ? `${(selected.health * 100).toFixed(0)}%`
                              : null
                          }
                        />
                        <InfoRow
                          label="Relisting automático"
                          value={
                            selected.automatic_relist != null
                              ? selected.automatic_relist
                                ? 'Sí'
                                : 'No'
                              : null
                          }
                        />
                        <InfoRow
                          label="En catálogo"
                          value={
                            selected.catalog_listing != null
                              ? selected.catalog_listing
                                ? 'Sí'
                                : 'No'
                              : null
                          }
                        />
                      </Accordion>
                      {selectedShipping && (
                        <Accordion title="Envío">
                          {Object.entries(selectedShipping).map(
                            ([key, val]) => (
                              <InfoRow
                                key={key}
                                label={key}
                                value={
                                  typeof val === 'object'
                                    ? JSON.stringify(val)
                                    : String(val)
                                }
                              />
                            ),
                          )}
                        </Accordion>
                      )}
                      <Accordion title="Fechas">
                        <InfoRow
                          label="Creado"
                          value={formatDate(selected.date_created)}
                        />
                        <InfoRow
                          label="Actualizado"
                          value={formatDate(selected.last_updated)}
                        />
                        <InfoRow
                          label="Inicio"
                          value={formatDate(selected.start_time)}
                        />
                        <InfoRow
                          label="Fin"
                          value={formatDate(selected.stop_time)}
                        />
                        <InfoRow
                          label="Sincronizado"
                          value={formatDate(selected.synced_at)}
                        />
                      </Accordion>
                      {selected.permalink && (
                        <a
                          href={selected.permalink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 w-full text-sm text-blue-600 border border-blue-200 rounded-xl py-3 hover:bg-blue-50 transition-colors font-medium"
                        >
                          Ver en MercadoLibre →
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )
      })()}

      {/* Add competitor modal */}
      {showAddModal && selected && (
        <AddMonitorTarget<Competitor>
          kind="competitor"
          initialInput={suggestedInput}
          productId={selected.id}
          sku={selected.sku ?? ''}
          skus={
            Array.from(
              new Set(products.map((p) => p.sku).filter(Boolean)),
            ) as string[]
          }
          onClose={() => setShowAddModal(false)}
          onSaved={handleAdded}
        />
      )}
    </div>
  )
}
