import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy frontend/.env.example to frontend/.env.'
  );
}

/**
 * The browser client. Carries the anon key, which is public by design —
 * it identifies the project, it does not grant access. What a signed-in
 * user can actually read is decided by RLS against their own JWT.
 *
 * The service-role key must never appear in this directory. Anything
 * VITE_-prefixed is compiled into the bundle and shipped to every
 * visitor.
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
