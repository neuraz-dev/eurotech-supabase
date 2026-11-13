import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { syncTracked } from '../_shared/monitor-service.ts'
export function createTrackedHandler(
  client: SupabaseClient,
  options: {
    serviceKey: string
    syncSecrets?: string[]
    apiUrl?: string
    fxUrl?: string
  },
) {
  return async (req: Request) => {
    const supplied = [
      req.headers.get('apikey'),
      req.headers.get('x-sync-secret'),
      req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
    ]
    const allowed = [options.serviceKey, ...(options.syncSecrets ?? [])].filter(
      Boolean,
    )
    if (
      !supplied.some(
        (value) =>
          value &&
          allowed.some((key) => {
            let diff = value.length ^ key.length
            for (let i = 0; i < Math.max(value.length, key.length); i++)
              diff |= (value.charCodeAt(i) || 0) ^ (key.charCodeAt(i) || 0)
            return diff === 0
          }),
      )
    )
      return Response.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 },
      )
    if (req.method !== 'POST')
      return new Response('Method not allowed', { status: 405 })
    try {
      const { data, error } = await client
        .schema('ml')
        .from('ml_tokens')
        .select('access_token,user_id,expires_at')
        .order('expires_at', { ascending: false })
        .limit(1)
        .single()
      if (error || !data || Date.parse(data.expires_at) <= Date.now())
        throw new Error('No hay token vigente de Mercado Libre')
      const result = await syncTracked(client, {
        token: data.access_token,
        sellerId: Number(data.user_id),
        apiUrl: options.apiUrl,
        fxUrl: options.fxUrl,
      })
      return Response.json(result, { status: result.success ? 200 : 500 })
    } catch (error) {
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : 'Error',
        },
        { status: 500 },
      )
    }
  }
}
