import { createClient } from 'npm:@supabase/supabase-js@2'
import { extractPromoAmount, type MLPricesResponse } from './promo.ts'
import { fetchFx } from '../_shared/ml-observation.ts'
import type { FxQuote } from '../_shared/monitoring.ts'

const ML_API = Deno.env.get('ML_API_BASE_URL') ?? 'https://api.mercadolibre.com'
const ML_OAUTH = 'https://api.mercadolibre.com/oauth/token'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ML_CLIENT_ID = Deno.env.get('ML_CLIENT_ID')!
const ML_CLIENT_SECRET = Deno.env.get('ML_CLIENT_SECRET')!
const SYNC_PAGE_SIZE = 100

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// ─── Request Auth ───────────────────────────────────────────────────────────

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  const length = Math.max(left.length, right.length)
  let diff = left.length ^ right.length

  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  }

  return diff === 0
}

function isAuthorized(req: Request): boolean {
  const authHeader = req.headers.get('Authorization') ?? ''
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
  const apiKey = req.headers.get('apikey')
  const syncSecret = req.headers.get('x-sync-secret')
  const provided = [bearer, apiKey, syncSecret].filter(
    (value): value is string => Boolean(value),
  )
  const allowed = [
    Deno.env.get('SYNC_OWN_SECRET'),
    Deno.env.get('ML_SYNC_TRIGGER_SECRET'),
    Deno.env.get('SUPABASE_SECRET_KEY'),
    Deno.env.get('SUPABASE_SECRET_KEYS'),
    SUPABASE_SERVICE_KEY,
  ].filter((value): value is string => Boolean(value))

  return provided.some((candidate) =>
    allowed.some((secret) => constantTimeEqual(candidate, secret)),
  )
}

// ─── Token Management ────────────────────────────────────────────────────────

interface TokenRow {
  id: number
  access_token: string
  refresh_token: string | null
  expires_at: string
  user_id: number // usado también para las búsquedas en la API de ML
}

async function getValidToken(): Promise<TokenRow> {
  const { data, error } = await supabase
    .schema('ml')
    .from('ml_tokens')
    .select('*')
    .order('id', { ascending: false })
    .limit(1)
    .single<TokenRow>()

  if (error || !data) {
    throw new Error(`No token found in database: ${error?.message}`)
  }

  const expiresAt = new Date(data.expires_at)
  const now = new Date()
  const bufferMs = 30 * 60 * 1000 // renovar 30 min antes de expirar

  if (expiresAt.getTime() - now.getTime() > bufferMs) {
    console.log('Token vigente, usando existente.')
    return data
  }

  // Token próximo a vencer — intentar refrescar, si falla usar el actual
  console.log('Token próximo a expirar, intentando renovar...')
  try {
    const newAccessToken = await refreshToken(data)
    return { ...data, access_token: newAccessToken }
  } catch (err) {
    console.warn(
      'No se pudo renovar el token automáticamente:',
      err instanceof Error ? err.message : err,
    )
    console.warn('Usando token actual. Actualizar via ml-update-token.')
    return data
  }
}

async function refreshToken(tokenRow: TokenRow): Promise<string> {
  if (!tokenRow.refresh_token) {
    throw new Error(
      'No hay refresh_token almacenado. Por favor renueva el token manualmente.',
    )
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET,
    refresh_token: tokenRow.refresh_token,
  })

  const res = await fetch(ML_OAUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Error renovando token ML: ${res.status} ${err}`)
  }

  const newToken = await res.json()
  const expiresAt = new Date(Date.now() + (newToken.expires_in ?? 21600) * 1000)

  await supabase
    .schema('ml')
    .from('ml_tokens')
    .update({
      access_token: newToken.access_token,
      refresh_token: newToken.refresh_token ?? tokenRow.refresh_token,
      expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', tokenRow.id)

  console.log(`Token renovado. Expira: ${expiresAt.toISOString()}`)
  return newToken.access_token
}

// ─── MercadoLibre API ────────────────────────────────────────────────────────

async function mlFetch<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${ML_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ML API ${path} → ${res.status}: ${err}`)
  }
  return res.json() as T
}

interface SearchResult {
  results: string[]
  paging: { total: number; offset: number; limit: number }
  scroll_id?: string
}

async function fetchAllItemIds(
  token: string,
  userId: number,
): Promise<string[]> {
  const allIds = new Set<string>()
  const limit = 100
  // Fetch items for each status to avoid the default "active-only" filter
  const statuses = ['active', 'paused', 'closed', 'under_review', 'inactive']

  for (const status of statuses) {
    try {
      let data = await mlFetch<SearchResult>(
        `/users/${userId}/items/search?search_type=scan&limit=${limit}&status=${status}`,
        token,
      )
      for (const id of data.results) allIds.add(id)
      const total = data.paging.total
      console.log(`[${status}] IDs obtenidos: ${allIds.size} / ${total}`)

      while (data.scroll_id && data.results.length > 0) {
        data = await mlFetch<SearchResult>(
          `/users/${userId}/items/search?search_type=scan&limit=${limit}&status=${status}&scroll_id=${encodeURIComponent(data.scroll_id)}`,
          token,
        )
        if (data.results.length === 0) break
        for (const id of data.results) allIds.add(id)
        console.log(`[${status}] IDs obtenidos: ${allIds.size} / ${total}`)
      }
    } catch (err) {
      console.warn(
        `[${status}] no se pudieron obtener IDs:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return [...allIds]
}

// Divide array en chunks
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

interface MLItem {
  id: string
  site_id?: string
  catalog_product_id?: string
  parent_item_id?: string
  seller_custom_field?: string
  domain_id?: string
  title?: string
  subtitle?: string
  condition?: string
  listing_type_id?: string
  buying_mode?: string
  status?: string
  sub_status?: unknown
  tags?: unknown
  listing_source?: string
  international_delivery_mode?: string
  price?: number
  base_price?: number
  original_price?: number
  sale_price?: { amount?: number | null; price_id?: string | null } | null
  currency_id?: string
  initial_quantity?: number
  available_quantity?: number
  sold_quantity?: number
  seller_id?: number
  official_store_id?: number
  category_id?: string
  permalink?: string
  thumbnail?: string
  thumbnail_id?: string
  video_id?: string
  pictures?: unknown
  start_time?: string
  stop_time?: string
  end_time?: string
  expiration_time?: string
  date_created?: string
  last_updated?: string
  accepts_mercadopago?: boolean
  non_mercado_pago_payment_methods?: unknown
  shipping?: unknown
  attributes?: MLAttribute[]
  variations?: MLVariation[]
  sale_terms?: unknown
  descriptions?: unknown
  warranty?: string
  seller_address?: unknown
  location?: unknown
  geolocation?: unknown
  coverage_areas?: unknown
  health?: number
  catalog_listing?: boolean
  automatic_relist?: boolean
  differential_pricing?: unknown
  deal_ids?: unknown
  family_name?: string
  family_id?: string
  user_product_id?: string
  inventory_id?: string
  seller_contact?: unknown
  warnings?: unknown
  item_relations?: unknown
  channels?: unknown
}

interface MLAttribute {
  id?: string
  value_name?: string | null
  values?: { name?: string | null }[]
}

interface MLVariation {
  seller_custom_field?: string | null
  attributes?: MLAttribute[]
  attribute_combinations?: MLAttribute[]
}

interface MLDescription {
  text?: string | null
  plain_text?: string | null
  date_created?: string | null
  last_updated?: string | null
  snapshot?: unknown
}

interface MLBatchItemResult {
  id?: string
  code: number
  body: MLItem | null
}

function cleanSku(value: unknown): string | null {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function extractSkuFromAttributes(attributes: unknown): string | null {
  if (!Array.isArray(attributes)) return null
  const attr = attributes.find((a) => a?.id === 'SELLER_SKU') as
    | MLAttribute
    | undefined
  return cleanSku(attr?.value_name) ?? cleanSku(attr?.values?.[0]?.name)
}

function extractSku(item: MLItem): string | null {
  const directSku =
    extractSkuFromAttributes(item.attributes) ??
    cleanSku(item.seller_custom_field)

  if (directSku) return directSku

  if (!Array.isArray(item.variations)) return null

  for (const variation of item.variations) {
    const variationSku =
      cleanSku(variation.seller_custom_field) ??
      extractSkuFromAttributes(variation.attributes) ??
      extractSkuFromAttributes(variation.attribute_combinations)

    if (variationSku) return variationSku
  }

  return null
}

function mapItemToRow(item: MLItem, description: MLDescription | null = null) {
  return {
    id: item.id,
    sku: extractSku(item),
    site_id: item.site_id ?? null,
    catalog_product_id: item.catalog_product_id ?? null,
    parent_item_id: item.parent_item_id ?? null,
    seller_custom_field: item.seller_custom_field ?? null,
    domain_id: item.domain_id ?? null,
    title: item.title ?? null,
    subtitle: item.subtitle ?? null,
    condition: item.condition ?? null,
    listing_type_id: item.listing_type_id ?? null,
    buying_mode: item.buying_mode ?? null,
    status: item.status ?? null,
    sub_status: item.sub_status ?? null,
    tags: item.tags ?? null,
    listing_source: item.listing_source ?? null,
    international_delivery_mode: item.international_delivery_mode ?? null,
    price: item.price ?? null,
    base_price: item.base_price ?? null,
    original_price: item.original_price ?? null,
    sale_price: item.sale_price?.amount ?? null,
    fx_quote: null as FxQuote | null,
    currency_id: item.currency_id ?? null,
    initial_quantity: item.initial_quantity ?? null,
    available_quantity: item.available_quantity ?? null,
    sold_quantity: item.sold_quantity ?? null,
    seller_id: item.seller_id ?? null,
    official_store_id: item.official_store_id ?? null,
    category_id: item.category_id ?? null,
    permalink: item.permalink ?? null,
    thumbnail: item.thumbnail ?? null,
    thumbnail_id: item.thumbnail_id ?? null,
    video_id: item.video_id ?? null,
    pictures: item.pictures ?? null,
    start_time: item.start_time ?? null,
    stop_time: item.stop_time ?? null,
    end_time: item.end_time ?? null,
    expiration_time: item.expiration_time ?? null,
    date_created: item.date_created ?? null,
    last_updated: item.last_updated ?? null,
    accepts_mercadopago: item.accepts_mercadopago ?? null,
    non_mercado_pago_payment_methods:
      item.non_mercado_pago_payment_methods ?? null,
    shipping: item.shipping ?? null,
    attributes: item.attributes ?? null,
    variations: item.variations ?? null,
    sale_terms: item.sale_terms ?? null,
    descriptions: description ?? item.descriptions ?? null,
    warranty: item.warranty ?? null,
    seller_address: item.seller_address ?? null,
    location: item.location ?? null,
    geolocation: item.geolocation ?? null,
    coverage_areas: item.coverage_areas ?? null,
    health: item.health ?? null,
    catalog_listing: item.catalog_listing ?? null,
    automatic_relist: item.automatic_relist ?? null,
    differential_pricing: item.differential_pricing ?? null,
    deal_ids: item.deal_ids ?? null,
    family_name: item.family_name ?? null,
    family_id: item.family_id ?? null,
    user_product_id: item.user_product_id ?? null,
    inventory_id: item.inventory_id ?? null,
    seller_contact: item.seller_contact ?? null,
    warnings: item.warnings ?? null,
    item_relations: item.item_relations ?? null,
    channels: item.channels ?? null,
    synced_at: new Date().toISOString(),
    raw_data: item,
  }
}

async function fetchItem(id: string, token: string): Promise<MLItem | null> {
  try {
    const res = await fetch(`${ML_API}/items/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      console.warn(`[items/${id}] ${res.status}`)
      return null
    }
    return (await res.json()) as MLItem
  } catch (err) {
    console.warn(
      `[items/${id}] fetch error:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

async function fetchItemDescription(
  id: string,
  token: string,
): Promise<MLDescription | null> {
  try {
    const res = await fetch(`${ML_API}/items/${id}/description`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      if (res.status !== 404)
        console.warn(`[items/${id}/description] ${res.status}`)
      return null
    }
    return (await res.json()) as MLDescription
  } catch (err) {
    console.warn(
      `[items/${id}/description] fetch error:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

async function fetchItemsBatch(
  ids: string[],
  token: string,
): Promise<MLBatchItemResult[]> {
  const res = await fetch(`${ML_API}/items?ids=${ids.join(',')}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ML API /items batch → ${res.status}: ${err}`)
  }
  return res.json() as Promise<MLBatchItemResult[]>
}

async function fetchItemPrices(
  id: string,
  token: string,
): Promise<MLPricesResponse | null> {
  try {
    const res = await fetch(`${ML_API}/items/${id}/prices`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      if (res.status !== 404) console.warn(`[items/${id}/prices] ${res.status}`)
      return null
    }
    return (await res.json()) as MLPricesResponse
  } catch (err) {
    console.warn(
      `[items/${id}/prices] fetch error:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

async function fetchAndUpsertItems(
  ids: string[],
  token: string,
): Promise<number> {
  let upserted = 0
  const fx = await fetchFx(fetch, Deno.env.get('MONITOR_FX_URL'))
  const CONCURRENCY = 20
  const UPSERT_BATCH_SIZE = 5
  const UPSERT_RETRIES = 2

  // Fetch the item payload in batches to reduce round-trips.
  // Promos are still resolved per item when the main payload doesn't include sale_price.
  for (const batch of chunk(ids, CONCURRENCY)) {
    let batchResults: MLBatchItemResult[]
    try {
      batchResults = await fetchItemsBatch(batch, token)
    } catch (err) {
      console.error(
        `Error fetching batch ${batch.join(',')}: ${err instanceof Error ? err.message : err}`,
      )
      continue
    }

    const resultsById = new Map<string, MLBatchItemResult>()
    for (const entry of batchResults) {
      const itemId = entry.body?.id ?? entry.id
      if (itemId) resultsById.set(itemId, entry)
    }
    // The /items endpoint can return a stale sale_price while /prices already
    // exposes the active promotion. Refresh the prices endpoint for every
    // item so an old promotion cannot survive in ml_products.
    const promoCandidates = batch

    const promoPrices = new Map<string, number | null>()
    // Keep the promotion endpoint below Mercado Libre's burst limits. Its
    // response is authoritative; the sale_price embedded in /items can lag.
    const promoBatchSize = 8
    for (const promoBatch of chunk(promoCandidates, promoBatchSize)) {
      await Promise.all(
        promoBatch.map(async (id) => {
          const pricesResp = await fetchItemPrices(id, token)
          // A successful response with no promotion deliberately stores null,
          // clearing a stale sale_price. A missing response is kept absent from
          // the map so this item can be retried instead of persisting /items'
          // potentially stale sale_price.
          if (pricesResp) {
            promoPrices.set(id, extractPromoAmount(pricesResp))
          }
        }),
      )
    }

    const results = batch.map((id) => {
      const item = resultsById.get(id)?.body ?? null
      if (!item) return null

      if (!promoPrices.has(id)) {
        console.warn(
          `[items/${id}] skipping upsert because the authoritative /prices response is unavailable`,
        )
        return null
      }

      const row = mapItemToRow(item, null)
      row.sale_price = promoPrices.get(id) ?? null
      row.fx_quote = fx
      return row
    })
    const rows = results.filter(
      (r): r is ReturnType<typeof mapItemToRow> => r !== null,
    )

    if (rows.length === 0) continue

    for (const upsertBatch of chunk(rows, UPSERT_BATCH_SIZE)) {
      let lastError: string | null = null

      for (let attempt = 0; attempt <= UPSERT_RETRIES; attempt++) {
        const { error } = await supabase
          .schema('ml')
          .from('ml_products')
          .upsert(upsertBatch, { onConflict: 'id' })

        if (!error) {
          upserted += upsertBatch.length
          lastError = null
          break
        }

        lastError = error.message
        if (attempt < UPSERT_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1)),
          )
        }
      }

      if (lastError) {
        throw new Error(`Error upserting batch after retries: ${lastError}`)
      }
    }
  }

  return upserted
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Sólo POST o llamadas internas
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 })
  }

  if (!isAuthorized(req)) {
    return Response.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    )
  }

  try {
    console.log('=== ML Sync iniciado ===')

    let page = 0
    let requestedIds: string[] | null = null
    try {
      const body = await req.json()
      if (Number.isInteger(body?.page) && body.page >= 0) page = body.page
      if (Array.isArray(body?.ids)) {
        const ids = body.ids.filter(
          (id: unknown): id is string =>
            typeof id === 'string' && id.trim().length > 0,
        )
        requestedIds = Array.from(new Set(ids))
      }
    } catch {
      // Empty cron body: start from the first page.
    }

    const tokenRow = await getValidToken()
    const ids =
      requestedIds ??
      (await fetchAllItemIds(tokenRow.access_token, tokenRow.user_id))
    const start = page * SYNC_PAGE_SIZE
    const pageIds = ids.slice(start, start + SYNC_PAGE_SIZE)
    const totalPages = Math.ceil(ids.length / SYNC_PAGE_SIZE)
    console.log(
      `Total productos: ${ids.length} (user_id: ${tokenRow.user_id}), página ${page + 1}/${totalPages}`,
    )
    const upserted = await fetchAndUpsertItems(pageIds, tokenRow.access_token)
    const hasMore = start + pageIds.length < ids.length

    if (hasMore) {
      const nextPage = page + 1
      console.log(`Disparando página siguiente: ${nextPage + 1}/${totalPages}`)
      fetch(`${SUPABASE_URL}/functions/v1/ml-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
        body: JSON.stringify({ page: nextPage }),
      }).catch((error) =>
        console.error('Error disparando página siguiente:', error),
      )
    }

    const result = {
      success: true,
      total_ids: ids.length,
      page,
      total_pages: totalPages,
      upserted,
      synced_at: new Date().toISOString(),
      has_more: hasMore,
    }

    console.log('=== ML Sync finalizado ===', result)
    return Response.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('ML Sync error:', message)
    return Response.json({ success: false, error: message }, { status: 500 })
  }
})
