import { createClient } from '@supabase/supabase-js';

import { env } from '../config/env.js';

const clientOptions = {
  auth: {
    // The server holds no session of its own. Every request carries the
    // caller's token and nothing is persisted between them.
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};

/**
 * A client acting as the calling user.
 *
 * This is the one that matters. Because the request carries the user's
 * access token, Postgres sees `auth.uid()` as that user and every policy
 * in migration 0005 applies to the query. The API therefore inherits the
 * exact same tenant isolation as the database — there is no second,
 * hand-written permission layer in Express that can drift out of sync
 * with the policies.
 */
export function userClient(accessToken) {
  if (!accessToken) {
    throw new Error('userClient() requires an access token');
  }

  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    ...clientOptions,
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  });
}

/**
 * A client with no user attached, used only to validate a token against
 * Supabase Auth. It carries the anon key, so it cannot read tenant data.
 */
export function anonClient() {
  return createClient(env.supabaseUrl, env.supabaseAnonKey, clientOptions);
}

let cachedAdminClient = null;

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Reserved for work that has no user session behind it — Stripe webhooks,
 * scheduled jobs. Never use it to serve a user request: doing so silently
 * removes tenant isolation from that code path, which is exactly the
 * failure mode the whole architecture is built to prevent.
 */
export function adminClient() {
  if (!env.supabaseServiceRoleKey) {
    throw new Error(
      'adminClient() requires SUPABASE_SERVICE_ROLE_KEY to be set'
    );
  }

  if (!cachedAdminClient) {
    cachedAdminClient = createClient(
      env.supabaseUrl,
      env.supabaseServiceRoleKey,
      clientOptions
    );
  }

  return cachedAdminClient;
}
