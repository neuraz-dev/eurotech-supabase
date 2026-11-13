import { syncFailure, type SyncResult } from '../_shared/sync-report.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import {
  fetchAllItemIds,
  fetchAndUpsertItems,
  getValidToken,
  isAuthorized,
} from '../ml-sync/service.ts'
import { processManualQueue } from './worker.ts'
const client = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(20_000),
        }),
    },
  },
)
Deno.serve(async (req) => {
  if (!isAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }
  // The request is dispatched by pg_net, never owned by a browser connection.
  try {
    const result = await processManualQueue(client, {
      token: getValidToken,
      discover: async (token, seller) => {
        const failures: SyncResult[] = []
        const ids = await fetchAllItemIds(
          token,
          seller,
          (status, error) =>
            failures.push({
              entity_id: `$stage:${status}`,
              identity: {
                id: `$stage:${status}`,
                title: `No se pudo obtener el listado: ${status}`,
              },
              outcome: 'failed',
              ...syncFailure(error, 'descubrimiento'),
            }),
        )
        return { ids, failures }
      },
      update: fetchAndUpsertItems,
    }, {
      apiUrl: Deno.env.get('ML_API_BASE_URL'),
      fxUrl: Deno.env.get('MONITOR_FX_URL'),
    })
    await client.schema('ml').rpc('dispatch_manual_sync')
    return Response.json(result)
  } catch {
    return Response.json({
      error: 'La cola recuperará las tareas no confirmadas.',
    }, { status: 500 })
  }
})
