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
 * The target list of a create or a move, as this caller can see it, or
 * null when they cannot see it at all.
 *
 * Deliberately does not throw on the wrong-board case — the caller decides
 * what that means and, more importantly, decides in what order. Two
 * different failures hide behind "we cannot see that list":
 *
 * - **A list in this tenant, on a different board.** Refused twice over
 *   since migration 0012: the card's foreign key is
 *   (list_id, board_id, org_id) → lists, so pointing a card on board X at
 *   a list on board Y no longer resolves and comes back 23503 → 400. The
 *   route still checks, because 404 "List not found on this board" is a
 *   far better answer than "referenced record does not exist" and because
 *   this is the one refusal a client can trigger by accident. The
 *   difference from before is that the check is now the polish and the
 *   schema is the enforcement, rather than the check being the only thing
 *   standing there.
 *
 * - **A list in another tenant.** RLS means we cannot see it at all, so it
 *   is indistinguishable from a mistyped uuid and we should not pretend
 *   otherwise. The write goes ahead with org_id set to the authorised org,
 *   the foreign key finds no matching list, and it comes back 23503 → 400.
 *   Structurally refused rather than checked — which is the entire reason
 *   the key is composite.
 */
async function loadTargetList(req, listId) {
  const { data, error } = await req.supabase
    .from('lists')
    .select('id, board_id')
    .eq('id', listId)
    .eq('org_id', req.orgId)
    .maybeSingle();

  if (error) throw fromPostgrestError(error, 'Could not load list');
  return data;
}

/** 404 unless the list we resolved is on the board that authorised us. */
function assertListOnBoard(targetList, boardId) {
  if (targetList && targetList.board_id !== boardId) {
    throw new HttpError(404, 'List not found on this board');
  }
}

/**
 * The card named in the URL, if it is on the board named in the URL.
 * Returns null otherwise — including when RLS hid it.
 *
 * Since 0012 this is three equality filters on the primary key, not the
 * embedded to-one join through lists it used to need. Only `move` still
 * calls it, and only because the broadcast has to say which list the card
 * left; PATCH and DELETE fold the same check into their own WHERE clause
 * and pay nothing for it.
 */
async function loadCardOnBoard(req, boardId, cardId, columns) {
  const { data, error } = await req.supabase
    .from('cards')
    .select(columns)
    .eq('id', cardId)
    .eq('board_id', boardId)
    .eq('org_id', req.orgId)
    .maybeSingle();

  if (error) throw fromPostgrestError(error, 'Could not load card');
  return data;
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

    const targetList = await loadTargetList(req, listId);
    assertListOnBoard(targetList, boardId);

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

    // board_id comes from the authorised route param, exactly like org_id,
    // and the foreign key then insists the named list actually lives there.
    const { data, error } = await req.supabase
      .from('cards')
      .insert({
        org_id: req.orgId,
        board_id: boardId,
        list_id: listId,
        title,
        description,
        position,
      })
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
 *
 * `assigneeId` is shape-checked here and membership-checked by the
 * database: since migration 0011 the pair (org_id, assignee_id) has to
 * resolve to a real membership of this org, so assigning a card to someone
 * outside the tenant comes back 23503 → 400 rather than quietly
 * succeeding. Not re-implemented in Express — same rule as everywhere
 * else, one copy of it, and that copy lives in the schema.
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

    // No pre-read: board_id is a column on cards now, so "is this card on
    // the board that authorised me" is one more equality in the WHERE
    // clause. No match means either it does not exist, RLS hid it, or it
    // is on another board — all of which are 404 to this caller, which is
    // precisely what the extra read used to conclude.
    const { data, error } = await req.supabase
      .from('cards')
      .update(patch)
      .eq('id', cardId)
      .eq('board_id', boardId)
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

    const { data, error } = await req.supabase
      .from('cards')
      .delete()
      .eq('id', cardId)
      .eq('board_id', boardId)
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

    // Two reads that do not depend on each other, so they go together
    // rather than one after the other — this is the path a drag runs, and
    // it is now two round trips instead of three. The results are checked
    // in the old order so the error a caller gets does not depend on which
    // query happened to finish first.
    //
    // The card read survives H2 for one reason only: the broadcast has to
    // carry the list the card *left*, and after the UPDATE that value is
    // gone. The board check itself has moved into the WHERE clause below.
    const [card, targetList] = await Promise.all([
      loadCardOnBoard(req, boardId, cardId, 'list_id'),
      loadTargetList(req, listId),
    ]);

    if (!card) throw new HttpError(404, 'Card not found');
    assertListOnBoard(targetList, boardId);

    const { data, error } = await req.supabase
      .from('cards')
      .update({ list_id: listId, position })
      .eq('id', cardId)
      .eq('board_id', boardId)
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
