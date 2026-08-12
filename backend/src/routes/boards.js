import { Router } from 'express';

import { HttpError, asyncRoute, fromPostgrestError } from '../lib/errors.js';
import { emitToOrg } from '../realtime/emitter.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMember, requireOrgRole } from '../middleware/tenant.js';
import { cardsRouter } from './cards.js';
import { listsRouter } from './lists.js';

// mergeParams so :orgId from the parent mount is visible here.
export const boardsRouter = Router({ mergeParams: true });

boardsRouter.use(requireAuth, requireOrgMember);

const BOARD_COLUMNS = 'id, org_id, title, created_by, created_at, updated_at';

/**
 * The socket id of the client making this request, if it sent one.
 * Used to suppress the echo of a change back to its originator, which has
 * already applied it optimistically.
 */
function originSocketId(req) {
  const id = req.get('x-socket-id');
  return id && id.trim() ? id.trim() : null;
}

function readTitle(req) {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) throw new HttpError(400, 'Board title is required');
  if (title.length > 120) throw new HttpError(400, 'Board title is too long (max 120)');
  return title;
}

/** GET /api/orgs/:orgId/boards */
boardsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const { data, error } = await req.supabase
      .from('boards')
      .select(BOARD_COLUMNS)
      .eq('org_id', req.orgId)
      .order('created_at', { ascending: false });

    if (error) throw fromPostgrestError(error, 'Could not load boards');

    res.json({ boards: data });
  })
);

/**
 * POST /api/orgs/:orgId/boards
 *
 * org_id is taken from the authorised route param, never from the body.
 * If a client could name the org in the payload, the RLS policy would
 * still stop the write — but the request would have got further than it
 * ever needed to.
 */
boardsRouter.post(
  '/',
  requireOrgRole('owner', 'admin', 'member'),
  asyncRoute(async (req, res) => {
    const title = readTitle(req);

    const { data, error } = await req.supabase
      .from('boards')
      .insert({ org_id: req.orgId, title, created_by: req.user.id })
      .select(BOARD_COLUMNS)
      .single();

    if (error) throw fromPostgrestError(error, 'Could not create board');

    emitToOrg(req.orgId, 'board:created', { board: data }, originSocketId(req));
    res.status(201).json({ board: data });
  })
);

/** PATCH /api/orgs/:orgId/boards/:boardId */
boardsRouter.patch(
  '/:boardId',
  requireOrgRole('owner', 'admin', 'member'),
  asyncRoute(async (req, res) => {
    const title = readTitle(req);

    // The .eq('org_id') is belt-and-braces next to RLS, but it also turns
    // "board in another tenant" into a clean 404 instead of relying on
    // the policy to produce an empty result.
    const { data, error } = await req.supabase
      .from('boards')
      .update({ title })
      .eq('id', req.params.boardId)
      .eq('org_id', req.orgId)
      .select(BOARD_COLUMNS)
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not update board');
    if (!data) throw new HttpError(404, 'Board not found');

    emitToOrg(req.orgId, 'board:updated', { board: data }, originSocketId(req));
    res.json({ board: data });
  })
);

/** DELETE /api/orgs/:orgId/boards/:boardId */
boardsRouter.delete(
  '/:boardId',
  requireOrgRole('owner', 'admin'),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.supabase
      .from('boards')
      .delete()
      .eq('id', req.params.boardId)
      .eq('org_id', req.orgId)
      .select('id')
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not delete board');
    if (!data) throw new HttpError(404, 'Board not found');

    emitToOrg(
      req.orgId,
      'board:deleted',
      { boardId: data.id },
      originSocketId(req)
    );
    res.status(204).end();
  })
);

/**
 * Phase 2 — lists and cards hang off a board.
 *
 * Mounted here rather than beside boardsRouter in index.js, for the reason
 * index.js already documents one level up: a Router's `.use()` middleware
 * runs for every path beneath its mount point. Two sibling mounts under
 * /api/orgs/:orgId/boards would mean every card drag ran requireAuth and a
 * current_org_role() round trip twice — once on the way through this
 * router, once inside the one that finally matched. Nesting them makes the
 * boardsRouter.use() above the single place either happens.
 *
 * Last in the file, and cards before lists, so the more specific path wins
 * first: this router's own PATCH/DELETE /:boardId still match ahead of
 * listsRouter's mount at /:boardId, and /:boardId/cards never has to fall
 * through listsRouter to get where it is going.
 */
boardsRouter.use('/:boardId/cards', cardsRouter);
boardsRouter.use('/:boardId', listsRouter);
