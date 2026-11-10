import {
  identityOf,
  syncFailure,
  type SyncResult,
} from '../_shared/sync-report.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { extractPromoAmount, type MLPricesResponse } from './promo.ts'
import { fetchFx } from '../_shared/ml-observation.ts'
import type { FxQuote } from '../_shared/monitoring.ts'

const ML_API = Deno.env.get('ML_API_BASE_URL') ?? 'https://api.mercadolibre.com'
const nativeFetch = globalThis.fetch
const fetch: typeof globalThis.fetch = (input, init) =>
  nativeFetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  })
const ML_OAUTH = 'https://api.mercadolibre.com/oauth/token'

export const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
export const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ML_CLIENT_ID = Deno.env.get('ML_CLIENT_ID')!
const ML_CLIENT_SECRET = Deno.env.get('ML_CLIENT_SECRET')!
export const SYNC_PAGE_SIZE = 100

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  global: { fetch },
})

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

export function isAuthorized(req: Request): boolean {
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
    allowed.some((secret) => constantTimeEqual(candidate, secret))
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

export async function getValidToken(): Promise<TokenRow> {
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
    await res.text()
    throw Object.assign(new Error(`Mercado Libre HTTP ${res.status}`), {
      status: res.status,
      resource: path,
    })
  }
  return res.json() as T
}

interface SearchResult {
  results: string[]
  paging: { total: number; offset: number; limit: number }
  scroll_id?: string
}

export async function fetchAllItemIds(
  token: string,
  userId: number,
  onFailure?: (status: string, error: unknown) => void,
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
          `/users/${userId}/items/search?search_type=scan&limit=${limit}&status=${status}&scroll_id=${
            encodeURIComponent(data.scroll_id)
          }`,
          token,
        )
        if (data.results.length === 0) break
        for (const id of data.results) allIds.add(id)
        console.log(`[${status}] IDs obtenidos: ${allIds.size} / ${total}`)
      }
    } catch (err) {
      onFailure?.(status, err)
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
  id: string
  code: number
  body: MLItem | null
  error?: Error
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
  const directSku = extractSkuFromAttributes(item.attributes) ??
    cleanSku(item.seller_custom_field)

  if (directSku) return directSku

  if (!Array.isArray(item.variations)) return null

  for (const variation of item.variations) {
    const variationSku = cleanSku(variation.seller_custom_field) ??
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
    non_mercado_pago_payment_methods: item.non_mercado_pago_payment_methods ??
      null,
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

function ownHttpError(status: number, resource: string, payload: unknown) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  // Keep only a recognized API code, never arbitrary response bodies/messages.
  const candidate = body.error ?? body.code
  const apiCode = typeof candidate === 'string' && [
      'ResourceDeprecated',
      'access_denied',
      'forbidden',
      'unauthorized',
      'not_found',
      'too_many_requests',
      'internal_error',
      'bad_request',
    ].includes(candidate)
    ? candidate
    : undefined
  return Object.assign(
    new Error(
      apiCode === 'ResourceDeprecated'
        ? `Recurso deprecado (ResourceDeprecated) · HTTP ${status}`
        : `Publicación HTTP ${status}${apiCode ? ` (${apiCode})` : ''}`,
    ),
    {
      status,
      resource,
      apiCode,
    },
  )
}

async function fetchItemsBatch(
  ids: string[],
  token: string,
): Promise<MLBatchItemResult[]> {
  const resource = `/items/bulk?ids=${ids.join(',')}`
  const res = await fetch(`${ML_API}${resource}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    payload = null
  }
  if (!res.ok) throw ownHttpError(res.status, resource, payload)
  if (!Array.isArray(payload)) {
    throw Object.assign(
      new Error(
        'Respuesta bulk inválida: se esperaba una lista de publicaciones.',
      ),
      { status: res.status, resource },
    )
  }
  const byId = new Map<string, Record<string, unknown>[]>()
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const id = entry.id
    if (typeof id !== 'string' || !ids.includes(id)) continue
    byId.set(id, [...(byId.get(id) ?? []), entry])
  }
  return ids.map((id) => {
    const entries = byId.get(id) ?? []
    const invalid = (reason: string): MLBatchItemResult => ({
      id,
      code: 200,
      body: null,
      error: Object.assign(
        new Error(`Respuesta bulk inválida para ${id}: ${reason}.`),
        { status: res.status, resource },
      ),
    })
    if (entries.length === 0) {
      return invalid('la publicación no aparece en la respuesta')
    }
    if (entries.length !== 1) return invalid('el identificador está duplicado')
    const entry = entries[0], code = entry.status_code
    if (
      typeof code !== 'number' || !Number.isInteger(code) || code < 100 ||
      code > 599
    ) {
      return invalid('falta un status_code válido')
    }
    if (code !== 200) {
      return {
        id,
        code,
        body: null,
        error: ownHttpError(code, resource, entry.body),
      }
    }
    const body = entry.body
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return invalid('el cuerpo no es un objeto válido')
    }
    const item = body as Record<string, unknown>
    if (item.id !== id) {
      return invalid('la identidad del cuerpo no coincide con la solicitada')
    }
    if (
      typeof item.title !== 'string' || !item.title.trim() ||
      typeof item.price !== 'number' || !Number.isFinite(item.price) ||
      item.price <= 0 ||
      typeof item.currency_id !== 'string' || !item.currency_id.trim()
    ) {
      return invalid('faltan datos válidos de título, precio o moneda')
    }
    return { id, code, body: body as MLItem }
  })
}

async function fetchItemPrices(
  id: string,
  token: string,
  failure?: (error: unknown) => void,
): Promise<MLPricesResponse | null> {
  try {
    const res = await fetch(`${ML_API}/items/${id}/prices`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      let payload: unknown
      try {
        payload = await res.json()
      } catch {
        payload = null
      }
      failure?.(ownHttpError(res.status, `/items/${id}/prices`, payload))
      if (res.status !== 404) console.warn(`[items/${id}/prices] ${res.status}`)
      return null
    }
    const payload = await res.json()
    if (
      !payload || !Array.isArray(payload.prices) ||
      !payload.prices.every((entry: unknown) =>
        entry && typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).amount === 'number' &&
        Number.isFinite((entry as Record<string, unknown>).amount) &&
        Number((entry as Record<string, unknown>).amount) > 0
      ) ||
      (payload.id != null && payload.id !== id)
    ) {
      throw Object.assign(
        new Error(
          'Respuesta de precios inválida; no se confirmó la promoción actual.',
        ),
        { status: 200, resource: `/items/${id}/prices` },
      )
    }
    return payload as MLPricesResponse
  } catch (err) {
    failure?.(err)
    console.warn(
      `[items/${id}/prices] fetch error:`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

export async function fetchAndUpsertItems(
  ids: string[],
  token: string,
): Promise<{ upserted: number; results: SyncResult[] }> {
  let upserted = 0
  const results: SyncResult[] = []
  const failed = (
    id: string,
    error: unknown,
    operation = 'consulta',
    row: Record<string, unknown> = { id },
  ) =>
    results.push({
      entity_id: id,
      identity: identityOf(row),
      outcome: 'failed',
      ...syncFailure(error, operation),
    })
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
        `Error fetching batch ${batch.join(',')}: ${
          err instanceof Error ? err.message : err
        }`,
      )
      for (const id of batch) failed(id, err, 'publicación')
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
    const promoCandidates = batchResults.filter((entry) =>
      !entry.error && entry.body
    ).map((entry) => entry.id)

    const promoPrices = new Map<string, number | null>()
    const priceErrors = new Map<string, unknown>()
    // Keep the promotion endpoint below Mercado Libre's burst limits. Its
    // response is authoritative; the sale_price embedded in /items can lag.
    const promoBatchSize = 8
    for (const promoBatch of chunk(promoCandidates, promoBatchSize)) {
      await Promise.all(
        promoBatch.map(async (id) => {
          const pricesResp = await fetchItemPrices(
            id,
            token,
            (error) => priceErrors.set(id, error),
          )
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

    const mapped = batch.map((id) => {
      const item = resultsById.get(id)?.body ?? null
      const entry = resultsById.get(id)
      if (!item || entry?.error || entry?.code !== 200) {
        failed(
          id,
          entry?.error ?? new Error('Respuesta bulk incompleta'),
          'publicación',
        )
        return null
      }

      if (!promoPrices.has(id)) {
        failed(
          id,
          priceErrors.get(id) ?? new Error('Precios no disponibles'),
          'precios',
          item as unknown as Record<string, unknown>,
        )
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
    const rows = mapped.filter(
      (r): r is ReturnType<typeof mapItemToRow> => r !== null,
    )

    if (rows.length === 0) continue

    for (const upsertBatch of chunk(rows, UPSERT_BATCH_SIZE)) {
      let lastError: string | null = null

      for (let attempt = 0; attempt <= UPSERT_RETRIES; attempt++) {
        const { data: persisted, error } = await supabase
          .schema('ml')
          .from('ml_products')
          .upsert(upsertBatch, { onConflict: 'id' }).select('id')

        if (
          !error && persisted?.length === upsertBatch.length &&
          upsertBatch.every((row) =>
            persisted.some((saved) => saved.id === row.id)
          )
        ) {
          upserted += upsertBatch.length
          for (const row of upsertBatch) {
            results.push({
              entity_id: row.id,
              identity: identityOf(row),
              outcome: row.currency_id !== 'UYU' && !fx ? 'warning' : 'updated',
              message: row.currency_id !== 'UYU' && !fx
                ? 'Precio guardado; la cotización no está disponible.'
                : 'Publicación y precios guardados.',
              operation: 'persistencia',
              resource: `/items/${row.id}/prices`,
              attempts: attempt + 1,
            })
          }
          lastError = null
          break
        }

        lastError = error?.message ??
          'La base no confirmó todas las publicaciones guardadas'
        if (attempt < UPSERT_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * (attempt + 1))
          )
        }
      }

      if (lastError) {
        for (const row of upsertBatch) {
          failed(
            row.id,
            new Error(`Error al guardar después de reintentos: ${lastError}`),
            'persistencia',
            row,
          )
        }
      }
    }
  }

  return { upserted, results }
}

// ─── Handler ─────────────────────────────────────────────────────────────────
