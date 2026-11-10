import { withMonitorAuth } from '@/lib/monitoring/server'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

const ML_API = 'https://api.mercadolibre.com'

type Attribute = {
  id?: string
  name?: string
  value_name?: string | null
}

type ProductRow = {
  id: string
  title: string | null
  subtitle: string | null
  sku: string | null
  descriptions: unknown
  attributes: Attribute[] | null
  category_id: string | null
  domain_id: string | null
  price: number | null
  sale_price: number | null
  catalog_price: number | null
  currency_id: string | null
}

type RivalCandidate = {
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

type MlResolvedProduct = {
  id: string
  title: string | null
  price: number | null
  currency_id: string | null
  thumbnail: string | null
  permalink: string | null
  seller_id: number | null
  seller_name: string | null
}

const MIN_RIVAL_CONFIDENCE = 0.76
const GENERIC_MATCH_TOKENS = new Set([
  'a',
  'al',
  'con',
  'de',
  'del',
  'el',
  'en',
  'eurotech',
  'juego',
  'kit',
  'la',
  'las',
  'libre',
  'los',
  'mercado',
  'ml',
  'mlu',
  'nuevo',
  'nueva',
  'o',
  'pack',
  'para',
  'por',
  'set',
  'sin',
  'un',
  'una',
  'uno',
  'uruguay',
  'x',
  'y',
])

function compactText(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[|()[\]{}.,;:_+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function uniqueValues(values: string[]) {
  return [...new Set(values)]
}

function extractMeaningfulTokens(value: string) {
  const tokens =
    normalizeSearchText(value).match(/[a-z0-9]+(?:\/[0-9]+)?/g) ?? []
  return uniqueValues(
    tokens.filter((token) => {
      if (token.length <= 1) return false
      if (GENERIC_MATCH_TOKENS.has(token)) return false
      return true
    }),
  )
}

function extractSpecs(value: string) {
  const specs =
    normalizeSearchText(value).match(/\bm?\d+(?:[.,]\d+)?(?:\/\d+)?\b/g) ?? []
  return uniqueValues(specs.map((spec) => spec.replace(',', '.')))
}

function getSharedValues(left: string[], right: string[]) {
  const rightSet = new Set(right)
  return left.filter((value) => rightSet.has(value))
}

function isExactCompetitorCandidate(
  productTitle: string,
  productDescription: string,
  candidate: RivalCandidate,
) {
  if (candidate.confidence < MIN_RIVAL_CONFIDENCE) return false

  const productText = `${productTitle} ${productDescription}`
  const candidateText = [
    candidate.title,
    candidate.reason,
    candidate.matched_terms.join(' '),
  ].join(' ')

  const productTokens = extractMeaningfulTokens(productText)
  const candidateTokens = extractMeaningfulTokens(candidateText)
  const sharedTokens = getSharedValues(productTokens, candidateTokens)
  const titleTokens = extractMeaningfulTokens(productTitle)
  const titleSharedTokens = getSharedValues(titleTokens, candidateTokens)
  const productSpecs = extractSpecs(productTitle)
  const candidateSpecs = extractSpecs(candidateText)
  const sharedSpecs = getSharedValues(productSpecs, candidateSpecs)
  const overlapBase = Math.max(1, Math.min(titleTokens.length, 7))
  const titleOverlapRatio = titleSharedTokens.length / overlapBase

  if (titleSharedTokens.length >= 3) return true
  if (titleSharedTokens.length >= 2 && titleOverlapRatio >= 0.28) return true
  if (titleSharedTokens.length >= 1 && sharedSpecs.length >= 2) return true
  if (sharedTokens.length >= 2 && sharedSpecs.length >= 1) return true

  return false
}

function attributesToText(attributes: Attribute[] | null) {
  if (!Array.isArray(attributes)) return null
  const parts = attributes
    .map((attr) => {
      const name = attr.name ?? attr.id
      const value = attr.value_name
      if (!name || !value) return null
      return `${name}: ${value}`
    })
    .filter(Boolean)
    .slice(0, 20)

  return parts.length > 0 ? parts.join('; ') : null
}

function descriptionsToText(descriptions: unknown): string | null {
  if (!descriptions) return null
  if (typeof descriptions === 'string') return compactText(descriptions)

  if (Array.isArray(descriptions)) {
    const text = descriptions
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const maybeText = item as {
          plain_text?: unknown
          text?: unknown
          id?: unknown
        }
        if (typeof maybeText.plain_text === 'string')
          return maybeText.plain_text
        if (typeof maybeText.text === 'string') return maybeText.text
        if (typeof maybeText.id === 'string') return maybeText.id
        return null
      })
      .filter(Boolean)
      .join(' ')
    return text ? compactText(text) : null
  }

  if (typeof descriptions === 'object') {
    const maybeText = descriptions as { plain_text?: unknown; text?: unknown }
    if (typeof maybeText.plain_text === 'string')
      return compactText(maybeText.plain_text)
    if (typeof maybeText.text === 'string') return compactText(maybeText.text)
  }

  return null
}

async function fetchMlDescription(itemId: string, accessToken?: string | null) {
  const headers = accessToken
    ? { Authorization: `Bearer ${accessToken}` }
    : undefined

  async function request(withAuth: boolean) {
    const res = await fetch(`${ML_API}/items/${itemId}/description`, {
      headers: withAuth ? headers : undefined,
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const data = await res.json()
    const text =
      typeof data.plain_text === 'string'
        ? data.plain_text
        : typeof data.text === 'string'
          ? data.text
          : null
    return text ? compactText(text).slice(0, 3500) : null
  }

  return (accessToken ? await request(true) : null) ?? (await request(false))
}

function parseMlInput(input: string): {
  catalogId: string | null
  itemId: string | null
} {
  const trimmed = input.trim()
  let catalogId: string | null = null
  let itemId: string | null = null

  try {
    const url = new URL(trimmed)
    const catalogMatch = url.pathname.match(/\/(?:p|up)\/(ML[A-Z]+\d+)/i)
    if (catalogMatch) catalogId = catalogMatch[1].toUpperCase()

    const widMatch = url.hash.match(/[?&]wid=(ML[A-Z]+\d+)/i)
    if (widMatch && !catalogId) itemId = widMatch[1].toUpperCase()

    const articleMatch = url.pathname.match(/\/(ML[A-Z]+)-?(\d+)/i)
    if (!catalogId && !itemId && articleMatch) {
      itemId = (articleMatch[1] + articleMatch[2]).toUpperCase()
    }
  } catch {
    // Not a URL.
  }

  if (!catalogId && !itemId) {
    const match = trimmed.match(/ML[A-Z]+\d+/i)
    if (match) {
      const id = match[0].toUpperCase()
      if (/^ML[A-Z]{2,}\d+/.test(id)) catalogId = id
      else itemId = id
    }
  }

  return { catalogId, itemId }
}

async function fetchSellerName(
  sellerId: number,
  accessToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${ML_API}/users/${sellerId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data.nickname === 'string' ? data.nickname : null
  } catch {
    return null
  }
}

async function resolveMlItem(
  itemId: string,
  accessToken: string,
): Promise<MlResolvedProduct | null> {
  try {
    const res = await fetch(`${ML_API}/items/${itemId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!data || typeof data !== 'object' || !data.id) return null

    const sellerId = typeof data.seller_id === 'number' ? data.seller_id : null
    const sellerName = sellerId
      ? await fetchSellerName(sellerId, accessToken)
      : null
    return {
      id: String(data.id),
      title: typeof data.title === 'string' ? data.title : null,
      price: typeof data.price === 'number' ? data.price : null,
      currency_id:
        typeof data.currency_id === 'string' ? data.currency_id : null,
      thumbnail: typeof data.thumbnail === 'string' ? data.thumbnail : null,
      permalink: typeof data.permalink === 'string' ? data.permalink : null,
      seller_id: sellerId,
      seller_name: sellerName,
    }
  } catch {
    return null
  }
}

async function resolveMlCatalog(
  catalogId: string,
  accessToken: string,
  ourSellerId: number | null,
): Promise<MlResolvedProduct | null> {
  const headers = { Authorization: `Bearer ${accessToken}` }
  const permalink = /^ML[A-Z]{2,}\d+/i.test(catalogId)
    ? `https://www.mercadolibre.com.uy/up/${catalogId}`
    : `https://www.mercadolibre.com.uy/p/${catalogId}`

  let productData: Record<string, unknown> = {}
  try {
    const productRes = await fetch(`${ML_API}/products/${catalogId}`, {
      headers,
    })
    if (productRes.ok) productData = await productRes.json()
  } catch {
    // Keep item-list fallback.
  }

  try {
    const itemsRes = await fetch(
      `${ML_API}/products/${catalogId}/items?limit=20`,
      { headers },
    )
    if (!itemsRes.ok) return null
    const itemsData = await itemsRes.json()
    const results: Array<{
      item_id?: string
      seller_id?: number
      price?: number
      currency_id?: string
    }> = Array.isArray(itemsData.results) ? itemsData.results : []
    if (results.length === 0) return null

    const competitorResults = ourSellerId
      ? results.filter((r) => r.seller_id !== ourSellerId)
      : results
    const best = (
      competitorResults.length > 0 ? competitorResults : results
    ).reduce((a, b) => ((a.price ?? Infinity) <= (b.price ?? Infinity) ? a : b))
    const pictures = Array.isArray(productData.pictures)
      ? (productData.pictures as Array<{ url?: string; secure_url?: string }>)
      : []
    const sellerName = best.seller_id
      ? await fetchSellerName(best.seller_id, accessToken)
      : null
    const itemFallback = best.item_id
      ? await resolveMlItem(best.item_id, accessToken)
      : null

    return {
      id: catalogId,
      title:
        (typeof productData.name === 'string' ? productData.name : null) ??
        itemFallback?.title ??
        null,
      price:
        (typeof best.price === 'number' ? best.price : null) ??
        itemFallback?.price ??
        null,
      currency_id:
        (typeof best.currency_id === 'string' ? best.currency_id : null) ??
        itemFallback?.currency_id ??
        null,
      thumbnail:
        pictures[0]?.secure_url ??
        pictures[0]?.url ??
        itemFallback?.thumbnail ??
        null,
      permalink,
      seller_id: typeof best.seller_id === 'number' ? best.seller_id : null,
      seller_name: sellerName ?? itemFallback?.seller_name ?? null,
    }
  } catch {
    return null
  }
}

async function enrichCandidates(
  candidates: RivalCandidate[],
  accessToken: string | null | undefined,
  ourSellerId: number | null,
) {
  if (!accessToken || candidates.length === 0) return candidates

  return await Promise.all(
    candidates.map(async (candidate) => {
      const parsed = parseMlInput(candidate.url || candidate.item_id || '')
      const resolved = parsed.catalogId
        ? await resolveMlCatalog(parsed.catalogId, accessToken, ourSellerId)
        : parsed.itemId
          ? await resolveMlItem(parsed.itemId, accessToken)
          : null

      if (!resolved) return candidate

      return {
        ...candidate,
        title: resolved.title ?? candidate.title,
        url: resolved.permalink ?? candidate.url,
        item_id: resolved.id ?? candidate.item_id,
        seller_name: resolved.seller_name ?? candidate.seller_name,
        price: resolved.price ?? candidate.price,
        currency_id: resolved.currency_id ?? candidate.currency_id,
        thumbnail: resolved.thumbnail ?? candidate.thumbnail,
      }
    }),
  )
}

async function POSTImpl(req: NextRequest) {
  const { productId, limit } = await req.json()
  if (typeof productId !== 'string' || !productId.trim()) {
    return NextResponse.json(
      { error: 'productId es requerido' },
      { status: 400 },
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SECRET_KEY
  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json(
      { error: 'Faltan variables de Supabase en el servidor' },
      { status: 500 },
    )
  }

  const admin = createAdminClient()
  const { data: product, error: productError } = await admin
    .schema('ml')
    .from('ml_products')
    .select(
      `id, title, subtitle, sku, descriptions, attributes,
       category_id, domain_id, price, sale_price, catalog_price, currency_id`,
    )
    .eq('id', productId.trim())
    .maybeSingle<ProductRow>()

  if (productError)
    return NextResponse.json({ error: productError.message }, { status: 500 })
  if (!product)
    return NextResponse.json(
      { error: 'Producto no encontrado' },
      { status: 404 },
    )
  if (!product.title)
    return NextResponse.json(
      { error: 'El producto no tiene titulo' },
      { status: 400 },
    )

  const productTitle = product.title
  const skuKey = product.sku ?? product.id

  const [tokenResult, competitorsResult] = await Promise.all([
    admin
      .schema('ml')
      .from('ml_tokens')
      .select('access_token, user_id')
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ access_token: string; user_id: number }>(),
    admin
      .schema('ml')
      .from('ml_competitor_items')
      .select('id, permalink')
      .eq('our_sku', skuKey),
  ])

  const mlDescription = await fetchMlDescription(
    product.id,
    tokenResult.data?.access_token,
  )
  const localDescription = [
    product.subtitle,
    descriptionsToText(product.descriptions),
    attributesToText(product.attributes),
  ]
    .filter(Boolean)
    .join(' | ')

  const edgeRes = await fetch(`${supabaseUrl}/functions/v1/ml-search-rivals`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'x-rival-search-secret': serviceKey,
    },
    body: JSON.stringify({
      productId: product.id,
      sku: skuKey,
      title: product.title,
      description: mlDescription ?? (localDescription || null),
      categoryId: product.category_id,
      domainId: product.domain_id,
      price: product.sale_price ?? product.catalog_price ?? product.price,
      currencyId: product.currency_id,
      existingCompetitorIds: (competitorsResult.data ?? [])
        .map((item) => item.id)
        .filter(Boolean),
      existingCompetitorUrls: (competitorsResult.data ?? [])
        .map((item) => item.permalink)
        .filter(Boolean),
      limit: typeof limit === 'number' ? limit : 5,
    }),
  })

  const text = await edgeRes.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = { error: text }
  }

  if (!edgeRes.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : body && typeof body === 'object' && 'message' in body
          ? String((body as { message: unknown }).message)
          : 'No se pudo buscar rivales'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  if (
    body &&
    typeof body === 'object' &&
    'candidates' in body &&
    Array.isArray((body as { candidates: unknown }).candidates)
  ) {
    const enrichedCandidates = (
      await enrichCandidates(
        (body as { candidates: RivalCandidate[] }).candidates,
        tokenResult.data?.access_token,
        typeof tokenResult.data?.user_id === 'number'
          ? tokenResult.data.user_id
          : null,
      )
    ).filter((candidate) =>
      isExactCompetitorCandidate(productTitle, localDescription, candidate),
    )
    return NextResponse.json({
      ...body,
      candidates: enrichedCandidates,
      summary:
        enrichedCandidates.length > 0
          ? (body as { summary?: unknown }).summary
          : 'No se encontraron competidores exactos con suficiente confianza.',
      cost_estimate_usd: '~0.01-0.03',
    })
  }

  return NextResponse.json(body)
}

export const POST = withMonitorAuth(POSTImpl)
