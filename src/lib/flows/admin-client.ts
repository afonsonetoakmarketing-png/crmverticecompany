import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isLocalHybridMode } from '@/lib/local-backend/mode'
import { createLocalAdminClient } from '@/lib/local-backend/server-client'

// Lazy, shared service-role client for the Flows engine.
// Mirrors src/lib/automations/admin-client.ts — same shape so anyone
// reading either file picks up the convention immediately.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = isLocalHybridMode()
      ? createLocalAdminClient()
      : createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
        )
  }
  return _adminClient
}
