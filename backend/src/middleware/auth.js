import { HttpError } from '../lib/errors.js';
import { userClient } from '../lib/supabase.js';
import { verifyAccessToken } from '../lib/verify-token.js';

function bearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;

  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;

  return token.trim();
}

/**
 * Populates req.user, req.accessToken and req.supabase.
 *
 * req.supabase is scoped to the caller, so every query a route makes is
 * filtered by RLS. Routes should never import a client directly.
 */
export async function requireAuth(req, _res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      throw new HttpError(401, 'Missing bearer token');
    }

    const user = await verifyAccessToken(token);
    if (!user) {
      throw new HttpError(401, 'Invalid or expired session');
    }

    req.user = user;
    req.accessToken = token;
    req.supabase = userClient(token);

    next();
  } catch (error) {
    next(error);
  }
}
