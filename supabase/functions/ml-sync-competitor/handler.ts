import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

import { syncCompetitors } from '../_shared/monitor-service.ts'
const ML_OAUTH = 'https://api.mercadolibre.com/oauth/token'

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0)
  }
  return difference === 0
}

export function createCompetitorHandler(
  supabase: SupabaseClient,
  options: {
    serviceKey: string
    syncSecrets?: (string | undefined)[]
    clientId?: string
    clientSecret?: string
    apiUrl?: string
    fxUrl?: string
  },
): (req: Request) => Promise<Response> {
  // ─── Token Management ────────────────────────────────────────────────────────

  interface TokenRow {
    id: number
    access_token: string
    refresh_token: string | null
    expires_at: string
    user_id: number
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
    if (!Number.isFinite(expiresAt.getTime()))
      throw new Error('Invalid ML token expiry')
    const now = new Date()
    const bufferMs = 30 * 60 * 1000

    if (expiresAt.getTime() - now.getTime() > bufferMs) {
      return data
    }

    if (!data.refresh_token && expiresAt.getTime() > now.getTime()) return data

    console.log('Token próximo a expirar, intentando renovar...')
    try {
      const newAccessToken = await refreshToken(data)
      return { ...data, access_token: newAccessToken }
    } catch (err) {
      console.warn(
        'No se pudo renovar token:',
        err instanceof Error ? err.message : err,
      )
      if (expiresAt.getTime() <= Date.now())
        throw new Error('ML token expired; a valid token is required')
      return data
    }
  }

  async function refreshToken(tokenRow: TokenRow): Promise<string> {
    if (!tokenRow.refresh_token) {
      throw new Error('No hay refresh_token almacenado.')
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: options.clientId ?? '',
      client_secret: options.clientSecret ?? '',
      refresh_token: tokenRow.refresh_token,
    })

    const res = await fetch(ML_OAUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!res.ok) {
      throw new Error(`Error renovando token ML: HTTP ${res.status}`)
    }

    const newToken = await res.json()
    const expiresAt = new Date(
      Date.now() + (newToken.expires_in ?? 21600) * 1000,
    )

    const { error: saveError } = await supabase
      .schema('ml')
      .from('ml_tokens')
      .update({
        access_token: newToken.access_token,
        refresh_token: newToken.refresh_token ?? tokenRow.refresh_token,
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', tokenRow.id)

    if (saveError)
      throw new Error(`Error guardando token renovado: ${saveError.message}`)

    console.log(`Token renovado. Expira: ${expiresAt.toISOString()}`)
    return newToken.access_token
  }

  return async (req: Request): Promise<Response> => {
    const bearer = req.headers
      .get('authorization')
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
    const supplied = [
      req.headers.get('apikey'),
      bearer,
      req.headers.get('x-sync-secret'),
    ]
    const allowed = [options.serviceKey, ...(options.syncSecrets ?? [])].filter(
      (key): key is string => Boolean(key),
    )
    if (
      !supplied.some(
        (key) =>
          key && allowed.some((secret) => constantTimeEqual(key, secret)),
      )
    )
      return Response.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      )
    if (req.method !== 'POST')
      return new Response('Method not allowed', { status: 405 })
    try {
      const token = await getValidToken()
      const result = await syncCompetitors(supabase, {
        token: token.access_token,
        sellerId: token.user_id,
        apiUrl: options.apiUrl,
        fxUrl: options.fxUrl,
      })
      return Response.json(result, { status: result.success ? 200 : 500 })
    } catch (error) {
      return Response.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : 'Error de sincronización',
        },
        { status: 500 },
      )
    }
  }
}
