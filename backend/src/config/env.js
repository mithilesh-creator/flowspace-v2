import dotenv from 'dotenv';

dotenv.config();

/**
 * Fail fast at boot rather than at the first request. A backend that
 * starts up healthy and then 500s on every call because a key is missing
 * is much harder to diagnose on Railway than one that refuses to boot.
 */
function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value.trim();
}

function optional(name, fallback = null) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

const nodeEnv = optional('NODE_ENV', 'development');

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  port: Number(optional('PORT', '4000')),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseAnonKey: required('SUPABASE_ANON_KEY'),

  // Optional in Phase 1. Nothing here needs to bypass RLS yet — it exists
  // for Stripe webhooks and admin jobs later, which have no user session
  // to act on behalf of. adminClient() throws if it is used before this
  // is set, so its absence can never silently degrade into a leak.
  supabaseServiceRoleKey: optional('SUPABASE_SERVICE_ROLE_KEY'),

  corsOrigins: optional('CORS_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};

// Where invitation links point. Defaults to the first allowed origin,
// which is right in every environment we have — but it is a separate
// setting because an invite URL is emailed to a human and outlives the
// request, so it must never accidentally inherit a localhost origin in
// production.
env.appUrl = optional('APP_URL', env.corsOrigins[0] ?? 'http://localhost:5173').replace(
  /\/+$/,
  ''
);

if (env.isProduction && env.corsOrigins.includes('*')) {
  throw new Error('CORS_ORIGINS must not be "*" in production.');
}
