import { anonClient } from './supabase.js';

/**
 * Verifying a token means asking Supabase Auth about it, which is a
 * network round trip. Doing that on every REST call and every socket
 * event would make the auth check the slowest part of the request.
 *
 * So verified tokens are cached until shortly before they expire. The
 * cache is keyed by the token itself, which means a revoked-then-reused
 * token could stay valid for up to the remaining life of that token
 * (Supabase default: one hour). That is an accepted trade for Phase 1 and
 * matches how PostgREST treats the same JWT. If sign-out needs to be
 * instant later, the fix is a revocation list checked here — not a
 * shorter cache.
 */
const cache = new Map();
const MAX_ENTRIES = 5000;
const EXPIRY_SKEW_MS = 30_000;

function readExpiry(accessToken) {
  try {
    const [, payload] = accessToken.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function prune() {
  const now = Date.now();
  for (const [token, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(token);
  }

  // Hard cap so a flood of distinct tokens cannot grow this without
  // bound. Map preserves insertion order, so this drops the oldest.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * @returns {Promise<{id: string, email: string|null}|null>} the
 *   authenticated user, or null if the token is missing/invalid/expired.
 */
export async function verifyAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') return null;

  const cached = cache.get(accessToken);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }
  if (cached) cache.delete(accessToken);

  const { data, error } = await anonClient().auth.getUser(accessToken);
  if (error || !data?.user) return null;

  const user = { id: data.user.id, email: data.user.email ?? null };

  const tokenExpiry = readExpiry(accessToken);
  const expiresAt = tokenExpiry
    ? tokenExpiry - EXPIRY_SKEW_MS
    : Date.now() + 60_000;

  if (expiresAt > Date.now()) {
    cache.set(accessToken, { user, expiresAt });
    prune();
  }

  return user;
}

export function forgetToken(accessToken) {
  cache.delete(accessToken);
}
