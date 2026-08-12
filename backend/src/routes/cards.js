import { Router } from 'express';

import { HttpError, asyncRoute, fromPostgrestError } from '../lib/errors.js';
import { emitToOrg } from '../realtime/emitter.js';
import { requireOrgRole } from '../middleware/tenant.js';
import {
  CARD_COLUMNS,
  appendPosition,
  originSocketId,
  readPosition,
  readTitle,
  readUuidParam,
} from './lists.js';

/**
 * Cards.
 *
 * Mounted inside boardsRouter at `/:boardId/cards` — see the comment at
 * the bottom of routes/boards.js. requireAuth and requireOrgMember have
 * already run; req.orgId, req.orgRole and req.supabase are populated.
 *
 * Deleting a card is ordinary work, so unlike lists it stays in the
 * owner|admin|member bucket.
 */
export const cardsRouter = Router({ mergeParams: true });

const staff = requireOrgRole('owner', 'admin', 'member');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_DESCRIPTION = 8000;

function readBodyListId(req) {
  const listId = req.body?.listId;
  if (typeof listId !== 'string' || !UUID_RE.test(listId)) {
    throw new HttpError(400, 'A valid listId is required');
  }
  return listId;
}

function readDescription(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'Description must be a string or null');
  }
  if (value.length > MAX_DESCRIPTION) {
    throw new HttpError(400, `Description is too long (max ${MAX_DESCRIPTION})`);
  }
  return value;
}

function readAssigneeId(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(400, 'assigneeId must be a uuid or null');
  }
  return value;
}

/**
 * Accepts null or anything Date can parse, and stores the normalised ISO
 * form. Passing the client's string straight through would let '2026-13-45'
 * reach Postgres and come back as 22008, which fromPostgrestError has no
 * case for — a 500 for a typo.
 */
function readDueDate(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'dueDate must be an ISO timestamp or null');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, 'dueDate must be an ISO timestamp or null');
  }
  return parsed.toISOString();
}

/**
 * Resolve the target list of a create or a move.
 *
 * Two different failures hide behind "we cannot see that list", and
 * collapsing them would lose the interesting one:
 *
 * - **A list in this tenant, on a different board.** The composite FK is
 *   perfectly happy with that — (list_id, org_id) still resolves — so
 *   there is no database backstop, and this check is the only thing
 *   keeping a card inside the board whose URL authorised the request.
 *   404, decided here.
 *
 * - **A list in another tenant.** RLS means we cannot see it at all, so it
 *   is indistinguishable from a mistyped uuid and we should not pretend
 *   otherwise. The write goes ahead with org_id set to the authorised org,
 *   the composite FK looks for lists(id, org_id) and finds nothing, and it
 *   comes back 23503 → 400. Structurally refused rather than checked —
 *   which is the entire reason the key is composite.
 */
async function resolveTargetList(req, boardId, listId) {
  const { data, error } = await req.supabase
    .from('lists')
    .select('id, board_id')
    .eq('id', listId)
    .eq('org_id', req.orgId)
    .maybeSingle();

  if (error) throw fromPostgrestError(error, 'Could not load list');
  if (data && data.board_id !== boardId) {
    throw new HttpError(404, 'List not found on this board');
  }

  return data;
}

/**
 * The card named in the URL, confirmed to sit on the board named in the
 * URL. Cards carry no board_id of their own — the board is reached through
 * the list — so the check is a to-one embed rather than a column filter.
 */
async function requireCardOnBoard(req, boardId, cardId) {
  const { data, error } = await req.supabase
    .from('cards')
    .select(`${CARD_COLUMNS}, list:lists(board_id)`)
    .eq('id', cardId)
    .eq('org_id', req.orgId)
    .maybeSingle();

  if (error) throw fromPostgrestError(error, 'Could not load card');
  if (!data || data.list?.board_id !== boardId) {
    throw new HttpError(404, 'Card not found');
  }

  const { list: _list, ...card } = data;
  return card;
}

/**
 * POST /api/orgs/:orgId/boards/:boardId/cards
 *
 * Body names the list; org_id still comes from the authorised route param
 * and never from the client. New cards append to the end of their list.
 */
cardsRouter.post(
  '/',
  staff,
  asyncRoute(async (req, res) => {
    const boardId = readUuidParam(req.params.boardId, 'Board');
    const listId = readBodyListId(req);
    const title = readTitle(req, 'Card');
    const description =
      req.body?.description === undefined ? null : readDescription(req.body.description);

    const targetList = await resolveTargetList(req, boardId, listId);

    // If the list is invisible to us the tail query returns nothing and
    // the position is meaningless — the insert is about to be refused by
    // the foreign key regardless. Skip the round trip.
    let position = 1;
    if (targetList) {
      const { data: tail, error: tailError } = await req.supabase
        .from('cards')
        .select('position')
        .eq('list_id', listId)
        .eq('org_id', req.orgId)
        .order('position', { ascending: false })
        .limit(1);

      if (tailError) throw fromPostgrestError(tailError, 'Could not create card');
      position = appendPosition(tail);
    }

    const { data, error } = await req.supabase
      .from('cards')
      .insert({ org_id: req.orgId, list_id: listId, title, description, position })
      .select(CARD_COLUMNS)
      .single();

    if (error) throw fromPostgrestError(error, 'Could not create card');

    emitToOrg(req.orgId, 'card:created', { boardId, card: data }, originSocketId(req));
    res.status(201).json({ card: data });
  })
);

/**
 * PATCH /api/orgs/:orgId/boards/:boardId/cards/:cardId
 *
 * Content only. Moving a card between lists or positions goes through
 * /move, so a drag cannot arrive here and quietly skip the same-board
 * check on the target list.
 */
cardsRouter.patch(
  '/:cardId',
  staff,
  asyncRoute(async (req, res) => {
    const boardId = readUuidParam(req.params.boardId, 'Board');
    const cardId = readUuidParam(req.params.cardId, 'Card');

    const patch = {};
    if (req.body?.title !== undefined) patch.title = readTitle(req, 'Card');
    if (req.body?.description !== undefined) {
      patch.description = readDescription(req.body.description);
    }
    if (req.body?.assigneeId !== undefined) {
      patch.assignee_id = readAssigneeId(req.body.assigneeId);
    }
    if (req.body?.dueDate !== undefined) patch.due_date = readDueDate(req.body.dueDate);

    if (Object.keys(patch).length === 0) {
      throw new HttpError(400, 'Nothing to update');
    }

    await requireCardOnBoard(req, boardId, cardId);

    const { data, error } = await req.supabase
      .from('cards')
      .update(patch)
      .eq('id', cardId)
      .eq('org_id', req.orgId)
      .select(CARD_COLUMNS)
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not update card');
    if (!data) throw new HttpError(404, 'Card not found');

    emitToOrg(req.orgId, 'card:updated', { boardId, card: data }, originSocketId(req));
    res.json({ card: data });
  })
);

/** DELETE /api/orgs/:orgId/boards/:boardId/cards/:cardId */
cardsRouter.delete(
  '/:cardId',
  staff,
  asyncRoute(async (req, res) => {
    const boardId = readUuidParam(req.params.boardId, 'Board');
    const cardId = readUuidParam(req.params.cardId, 'Card');

    await requireCardOnBoard(req, boardId, cardId);

    const { data, error } = await req.supabase
      .from('cards')
      .delete()
      .eq('id', cardId)
      .eq('org_id', req.orgId)
      .select('id')
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not delete card');
    if (!data) throw new HttpError(404, 'Card not found');

    emitToOrg(
      req.orgId,
      'card:deleted',
      { boardId, cardId: data.id },
      originSocketId(req)
    );
    res.status(204).end();
  })
);

/**
 * POST /api/orgs/:orgId/boards/:boardId/cards/:cardId/move
 *
 * The hot path — one call per drop. The position is computed by the client
 * that can see the neighbours; the server validates it and validates that
 * the destination list is on this board, and does not recompute ordering.
 *
 * `fromListId` rides along in the broadcast because a client that has the
 * card in the old column needs to know where to remove it from, and
 * hunting for it by id across every list is O(board) per event.
 */
cardsRouter.post(
  '/:cardId/move',
  staff,
  asyncRoute(async (req, res) => {
    const boardId = readUuidParam(req.params.boardId, 'Board');
    const cardId = readUuidParam(req.params.cardId, 'Card');
    const listId = readBodyListId(req);
    const position = readPosition(req);

    const card = await requireCardOnBoard(req, boardId, cardId);
    await resolveTargetList(req, boardId, listId);

    const { data, error } = await req.supabase
      .from('cards')
      .update({ list_id: listId, position })
      .eq('id', cardId)
      .eq('org_id', req.orgId)
      .select(CARD_COLUMNS)
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not move card');
    if (!data) throw new HttpError(404, 'Card not found');

    emitToOrg(
      req.orgId,
      'card:moved',
      { boardId, card: data, fromListId: card.list_id },
      originSocketId(req)
    );
    res.json({ card: data });
  })
);
