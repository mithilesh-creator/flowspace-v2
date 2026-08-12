import crypto from 'node:crypto';

import { Router } from 'express';

import { env } from '../config/env.js';
import { HttpError, asyncRoute, fromPostgrestError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMember, requireOrgRole } from '../middleware/tenant.js';
import { emitToOrg } from '../realtime/emitter.js';

const INVITE_TTL_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITABLE_ROLES = ['owner', 'admin', 'member', 'client'];

const INVITE_COLUMNS =
  'id, org_id, email, role, invited_by, expires_at, accepted_at, created_at';

/**
 * Must match accept_invitation() in migration 0006 exactly:
 * encode(sha256(convert_to(p_token, 'utf8')), 'hex').
 *
 * The raw token is generated here, returned to the caller once, and then
 * forgotten. Only the hash is stored, so a database leak yields no
 * working invitations.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// ---------------------------------------------------------------------
// Org-scoped: managing invitations. Admins only.
// ---------------------------------------------------------------------

export const invitationsRouter = Router({ mergeParams: true });

invitationsRouter.use(
  requireAuth,
  requireOrgMember,
  requireOrgRole('owner', 'admin')
);

/** GET /api/orgs/:orgId/invitations */
invitationsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { data, error } = await req.supabase
      .from('invitations')
      .select(INVITE_COLUMNS)
      .eq('org_id', req.orgId)
      .order('created_at', { ascending: false });

    if (error) throw fromPostgrestError(error, 'Could not load invitations');

    res.json({ invitations: data });
  })
);

/**
 * POST /api/orgs/:orgId/invitations
 *
 * Returns the raw token exactly once. There is no endpoint to read it
 * back — if the admin loses the link before sending it, the invitation
 * has to be revoked and reissued. That is the cost of not storing it.
 */
invitationsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const role = typeof req.body?.role === 'string' ? req.body.role : 'member';

    if (!EMAIL_RE.test(email)) {
      throw new HttpError(400, 'A valid email address is required');
    }
    if (!INVITABLE_ROLES.includes(role)) {
      throw new HttpError(400, `Role must be one of: ${INVITABLE_ROLES.join(', ')}`);
    }
    // Belt-and-braces next to the RLS policy, which also refuses this.
    if (role === 'owner' && req.orgRole !== 'owner') {
      throw new HttpError(403, 'Only an owner can invite another owner');
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

    const { data, error } = await req.supabase
      .from('invitations')
      .insert({
        org_id: req.orgId,
        email,
        role,
        token_hash: hashToken(token),
        invited_by: req.user.id,
        expires_at: expiresAt.toISOString(),
      })
      .select(INVITE_COLUMNS)
      .single();

    if (error) {
      // The partial unique index only covers unaccepted rows, so this
      // means a live invitation already exists for this address.
      if (error.code === '23505') {
        throw new HttpError(409, 'That email already has a pending invitation');
      }
      throw fromPostgrestError(error, 'Could not create invitation');
    }

    res.status(201).json({
      invitation: data,
      token,
      inviteUrl: `${env.appUrl}/accept-invite?token=${encodeURIComponent(token)}`,
    });
  })
);

/** DELETE /api/orgs/:orgId/invitations/:invitationId — revoke. */
invitationsRouter.delete(
  '/:invitationId',
  asyncRoute(async (req, res) => {
    const { data, error } = await req.supabase
      .from('invitations')
      .delete()
      .eq('id', req.params.invitationId)
      .eq('org_id', req.orgId)
      .select('id')
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not revoke invitation');
    if (!data) throw new HttpError(404, 'Invitation not found');

    res.status(204).end();
  })
);

// ---------------------------------------------------------------------
// Redemption. NOT org-scoped, and deliberately so.
//
// The invitee is by definition not yet a member, so requireOrgMember
// would reject them before they ever reached the handler. The org is
// derived from the token inside accept_invitation(), never supplied by
// the caller.
// ---------------------------------------------------------------------

export const invitationRedemptionRouter = Router();

invitationRedemptionRouter.use(requireAuth);

/** POST /api/invitations/accept */
invitationRedemptionRouter.post(
  '/accept',
  asyncRoute(async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) throw new HttpError(400, 'An invitation token is required');

    const { data, error } = await req.supabase.rpc('accept_invitation', {
      p_token: token,
    });

    if (error) throw fromPostgrestError(error, 'Could not accept invitation');

    // Let the workspace see the new arrival without a refresh. Emitted
    // after the fact, so a failure here cannot roll back the membership.
    try {
      emitToOrg(data.org_id, 'member:joined', {
        membership: data,
        profile: { id: req.user.id, email: req.user.email },
      });
    } catch {
      // Realtime is best-effort; the membership is already committed.
    }

    res.status(201).json({ membership: data });
  })
);
