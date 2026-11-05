// Type-only bridge for Node tests importing the Deno handler.
declare module 'npm:@supabase/supabase-js@2' {
  export type { SupabaseClient } from '@supabase/supabase-js'
}
