import { HttpError } from '../lib/errors.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Look up the caller's role in an org.
 *
 * Goes through the current_org_role() RPC rather than selecting from
 * memberships, so the answer comes from the same SECURITY DEFINER
 * function the policies use. One definition of "what role am I", shared
 * by the database and the API.
 *
 * @returns {Promise<'owner'|'admin'|'member'|'client'|null>}
 */
export async function getOrgRole(supabase, orgId) {
  const { data, error } = await supabase.rpc('current_org_role', {
    p_org: orgId,
  });

  if (error) {
    throw new HttpError(500, 'Could not resolve organization membership');
  }

  return data ?? null;
}

/**
 * Resolves :orgId, confirms membership, and attaches req.orgId /
 * req.orgRole. Must run after requireAuth.
 *
 * Non-members get 404, not 403: telling an outsider "this org exists but
 * you cannot see it" is itself a small leak — it turns the org list into
 * something enumerable. From outside the tenant, it does not exist.
 */
export async function requireOrgMember(req, _res, next) {
  try {
    const orgId = req.params.orgId ?? req.get('x-org-id');

    if (!orgId || !UUID_RE.test(orgId)) {
      throw new HttpError(400, 'A valid organization id is required');
    }

    const role = await getOrgRole(req.supabase, orgId);
    if (!role) {
      throw new HttpError(404, 'Organization not found');
    }

    req.orgId = orgId;
    req.orgRole = role;

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Role gate for routes that need more than membership.
 *
 * This is a convenience for returning a clean 403 early — it is NOT the
 * security boundary. RLS is. If this check were deleted the database
 * would still refuse the write; the user would just get a less friendly
 * error. Keep it that way round.
 */
export function requireOrgRole(...allowed) {
  return (req, _res, next) => {
    if (!req.orgRole || !allowed.includes(req.orgRole)) {
      next(new HttpError(403, 'Your role does not permit this action'));
      return;
    }
    next();
  };
}
