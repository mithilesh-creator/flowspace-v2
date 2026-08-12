import { Router } from 'express';

import { HttpError, asyncRoute, fromPostgrestError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMember } from '../middleware/tenant.js';

export const orgsRouter = Router();

orgsRouter.use(requireAuth);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/**
 * GET /api/orgs — the orgs this user belongs to.
 *
 * No `where` clause on org membership anywhere in this query. It is not
 * missing: RLS adds it. Writing one here as well would be a second copy
 * of the rule that can rot independently of the policy.
 */
orgsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { data, error } = await req.supabase
      .from('memberships')
      .select('role, created_at, organization:organizations(id, name, slug, created_at)')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: true });

    if (error) throw fromPostgrestError(error, 'Could not load organizations');

    res.json({
      organizations: data
        .filter((row) => row.organization)
        .map((row) => ({ ...row.organization, role: row.role })),
    });
  })
);

/**
 * POST /api/orgs — create a tenant.
 *
 * Delegates to the create_organization RPC because the org row and the
 * creator's owner membership have to land in one transaction. Doing it as
 * two API calls would leave a window where a crash strands an org with no
 * members and therefore no one who can see or delete it.
 */
orgsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const rawSlug = typeof req.body?.slug === 'string' ? req.body.slug : '';
    const slug = rawSlug.trim().toLowerCase() || slugify(name);

    if (!name) throw new HttpError(400, 'Organization name is required');
    if (!SLUG_RE.test(slug)) {
      throw new HttpError(
        400,
        'Slug must be lowercase letters, numbers and hyphens, and start and end with a letter or number'
      );
    }

    const { data, error } = await req.supabase.rpc('create_organization', {
      p_name: name,
      p_slug: slug,
    });

    if (error) throw fromPostgrestError(error, 'Could not create organization');

    res.status(201).json({ organization: { ...data, role: 'owner' } });
  })
);

/** GET /api/orgs/:orgId — one org, plus the caller's role in it. */
orgsRouter.get(
  '/:orgId',
  requireOrgMember,
  asyncRoute(async (req, res) => {
    const { data, error } = await req.supabase
      .from('organizations')
      .select('id, name, slug, created_at')
      .eq('id', req.orgId)
      .single();

    if (error) throw fromPostgrestError(error, 'Could not load organization');

    res.json({ organization: { ...data, role: req.orgRole } });
  })
);

/** GET /api/orgs/:orgId/members */
orgsRouter.get(
  '/:orgId/members',
  requireOrgMember,
  asyncRoute(async (req, res) => {
    const { data, error } = await req.supabase
      .from('memberships')
      .select('id, role, created_at, profile:profiles(id, email, full_name, avatar_url)')
      .eq('org_id', req.orgId)
      .order('created_at', { ascending: true });

    if (error) throw fromPostgrestError(error, 'Could not load members');

    res.json({ members: data });
  })
);

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
}
