import { createClient } from 'npm:@supabase/supabase-js@2'
import { createTrackedHandler } from './handler.ts'
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const client = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey)
Deno.serve(
  createTrackedHandler(client, {
    serviceKey,
    syncSecrets: [
      Deno.env.get('SUPABASE_SECRET_KEY'),
      Deno.env.get('SYNC_OWN_SECRET'),
    ].filter((v): v is string => !!v),
    apiUrl: Deno.env.get('ML_API_BASE_URL'),
    fxUrl: Deno.env.get('MONITOR_FX_URL'),
  }),
)
