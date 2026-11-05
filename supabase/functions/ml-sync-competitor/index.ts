import { createClient } from "npm:@supabase/supabase-js@2";
import { createCompetitorHandler } from "./handler.ts";

const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

Deno.serve(createCompetitorHandler(supabase, {
  serviceKey,
  syncSecrets: [Deno.env.get("SYNC_OWN_SECRET"), Deno.env.get("ML_SYNC_TRIGGER_SECRET"), Deno.env.get("SUPABASE_SECRET_KEY")],
  clientId: Deno.env.get("ML_CLIENT_ID"),
  clientSecret: Deno.env.get("ML_CLIENT_SECRET"),
}));
