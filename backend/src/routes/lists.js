import { Router } from 'express';

import { HttpError, asyncRoute, fromPostgrestError } from '../lib/errors.js';
import { emitToOrg } from '../realtime/emitter.js';
import { requireOrgRole } from '../middleware/tenant.js';

/**
 * Lists, plus the nested read of a whole board.
 *
 * Mounted *inside* boardsRouter at `/:boardId`, not as a sibling under
 * /api/orgs — see the comment at the bottom of routes/boards.js. That
 * means requireAuth and requireOrgMember have already run by the time
 * anything here does, and req.orgId / req.orgRole / req.supabase are
 * populated. This router only adds the role gate on writes.
 *
 * mergeParams so :orgId and :boardId from the parent mounts are visible.
 */
export const listsRouter = Router({ mergeParams: true });

const staff = requireOrgRole('owner', 'admin', 'member');
// Deleting a list cascades every card in it, so it matches the board
// delete gate rather than the ordinary write gate. RLS says the same
// thing in lists_delete_admins; this is just the early, readable 403.
const admins = requireOrgRole('owner', 'admin');

export const LIST_COLUMNS = 'id, org_id, board_id, title, position, created_at, updated_at';
// board_id joined this list in migration 0012. Cards used to reach their
// board through their list; now they carry it, and the foreign key
// (list_id, board_id, org_id) makes the two agree by construction.
export const CARD_COLUMNS =
  'id, org_id, board_id, list_id, title, description, position, assignee_id, due_date, created_at, updated_at';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The socket id of the client making this request, if it sent one.
 * Used to suppress the echo of a change back to its originator, which has
 * already applied it optimistically.
 */
export function originSocketId(req) {
  const id = req.get('x-socket-id');
  return id && id.trim() ? id.trim() : null;
}

/**
 * A path id that is not a uuid cannot name a row, so it is a 404 — not a
 * 500. Without this the value reaches Postgres and comes back as 22P02,
 * which `fromPostgrestError` has no case for and turns into "Internal
 * server error" for what is really a bad URL.
 */
export function readUuidParam(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(404, `${label} not found`);
  }
  return value;
}

export function readTitle(req, label) {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) throw new HttpError(400, `${label} title is required`);
  if (title.length > 120) throw new HttpError(400, `${label} title is too long (max 120)`);
  return title;
}

/**
 * Positions are client-computed: the browser knows what the card was
 * dropped between, the server does not. It is validated, not recomputed.
 *
 * Rejecting non-finite values matters because `numeric` accepts 'NaN' —
 * and a NaN position sorts unpredictably and poisons every subsequent
 * (prev + next) / 2 in that gap.
 */
export function readPosition(req) {
  const position = req.body?.position;
  if (typeof position !== 'number' || !Number.isFinite(position)) {
    throw new HttpError(400, 'A numeric position is required');
  }
  return position;
}

/**
 * Confirms the board named in the URL exists inside the authorised org.
 *
 * The composite FK would refuse a list attached to a board in another
 * tenant anyway, but it refuses it as 23503 → 400 "referenced record does
 * not exist". Resolving the board first turns that into the 404 the caller
 * deserves, and — as with every read here — the row only comes back at all
 * because RLS let it.
 */
export async function requireBoard(req) {
  const boardId = readUuidParam(req.params.boardId, 'Board');

  const { data, error } = await req.supabase
    .from('boards')
    .select('id')
    .eq('id', boardId)
    .eq('org_id', req.orgId)
    .maybeSingle();

  if (error) throw fromPostgrestError(error, 'Could not load board');
  if (!data) throw new HttpError(404, 'Board not found');

  return boardId;
}

/** The position an appended row should take: one past the current last. */
export function appendPosition(rows) {
  const last = rows?.[0]?.position;
  return typeof last === 'number' && Number.isFinite(last) ? last + 1 : 1;
}

/**
 * GET /api/orgs/:orgId/boards/:boardId
 *
 * The whole board in one round trip — lists nested under the board, cards
 * nested under their list, both ordered. One request rather than 1 + n
 * because the client resyncs this on every `org:joined` and reconnect
 * (broadcasts are at-most-once; see docs/architecture.md), so it runs far
 * more often than a page load would suggest.
 */
listsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const boardId = readUuidParam(req.params.boardId, 'Board');

    const { data, error } = await req.supabase
      .from('boards')
      .select(
        `id, org_id, title, created_by, created_at, updated_at,` +
          ` lists:lists(${LIST_COLUMNS}, cards:cards(${CARD_COLUMNS}))`
      )
      .eq('id', boardId)
      .eq('org_id', req.orgId)
      .order('position', { referencedTable: 'lists', ascending: true })
      .order('position', { referencedTable: 'lists.cards', ascending: true })
      // Cards deliberately have no unique constraint on (list_id,
      // position) — that would turn two concurrent drags into a 409 for no
      // benefit — so ties are possible. Break them deterministically or
      // the board renders in a different order on every refetch.
      .order('created_at', { referencedTable: 'lists.cards', ascending: true })
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not load board');
    if (!data) throw new HttpError(404, 'Board not found');

    const { lists, ...board } = data;
    res.json({ board, lists: lists ?? [] });
  })
);

/**
 * POST /api/orgs/:orgId/boards/:boardId/lists
 *
 * org_id and board_id come from the authorised route params, never the
 * body. A new list is appended; the client only picks positions when it
 * drags something.
 */
listsRouter.post(
  '/lists',
  staff,
  asyncRoute(async (req, res) => {
    const boardId = await requireBoard(req);
    const title = readTitle(req, 'List');

    const { data: tail, error: tailError } = await req.supabase
      .from('lists')
      .select('position')
      .eq('board_id', boardId)
      .eq('org_id', req.orgId)
      .order('position', { ascending: false })
      .limit(1);

    if (tailError) throw fromPostgrestError(tailError, 'Could not create list');

    const { data, error } = await req.supabase
      .from('lists')
      .insert({
        org_id: req.orgId,
        board_id: boardId,
        title,
        position: appendPosition(tail),
      })
      .select(LIST_COLUMNS)
      .single();

    if (error) throw fromPostgrestError(error, 'Could not create list');

    emitToOrg(req.orgId, 'list:created', { boardId, list: data }, originSocketId(req));
    res.status(201).json({ list: data });
  })
);

/** PATCH /api/orgs/:orgId/boards/:boardId/lists/:listId */
listsRouter.patch(
  '/lists/:listId',
  staff,
  asyncRoute(async (req, res) => {
    const boardId = readUuidParam(req.params.boardId, 'Board');
    const listId = readUuidParam(req.params.listId, 'List');
    const title = readTitle(req, 'List');

    const { data, error } = await req.supabase
      .from('lists')
      .update({ title })
      .eq('id', listId)
      .eq('board_id', boardId)
      .eq('org_id', req.orgId)
      .select(LIST_COLUMNS)
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not update list');
    if (!data) throw new HttpError(404, 'List not found');

    emitToOrg(req.orgId, 'list:updated', { boardId, list: data }, originSocketId(req));
    res.json({ list: data });
  })
);

/**
 * DELETE /api/orgs/:orgId/boards/:boardId/lists/:listId
 *
 * The list's cards go with it, by ON DELETE CASCADE on the composite FK.
 * No `card:deleted` fan-out for each one: the client drops the column and
 * everything in it on `list:deleted`, and emitting n+1 events for one
 * action is how a drag-heavy board floods its own socket.
 */
listsRouter.delete(
  '/lists/:listId',
  admins,
  asyncRoute(async (req, res) => {
    const boardId = readUuidParam(req.params.boardId, 'Board');
    const listId = readUuidParam(req.params.listId, 'List');

    const { data, error } = await req.supabase
      .from('lists')
      .delete()
      .eq('id', listId)
      .eq('board_id', boardId)
      .eq('org_id', req.orgId)
      .select('id')
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not delete list');
    if (!data) throw new HttpError(404, 'List not found');

    emitToOrg(
      req.orgId,
      'list:deleted',
      { boardId, listId: data.id },
      originSocketId(req)
    );
    res.status(204).end();
  })
);

/**
 * POST /api/orgs/:orgId/boards/:boardId/lists/:listId/move
 *
 * A collision on (board_id, position) surfaces as 409 rather than being
 * quietly nudged aside. Two clients that computed the same midpoint have
 * genuinely disagreed about the order, and the loser needs to refetch —
 * silently rewriting one of them produces a board that looks different in
 * two browsers with no error anywhere.
 */
listsRouter.post(
  '/lists/:listId/move',
  staff,
  asyncRoute(async (req, res) => {
    const boardId = readUuidParam(req.params.boardId, 'Board');
    const listId = readUuidParam(req.params.listId, 'List');
    const position = readPosition(req);

    const { data, error } = await req.supabase
      .from('lists')
      .update({ position })
      .eq('id', listId)
      .eq('board_id', boardId)
      .eq('org_id', req.orgId)
      .select(LIST_COLUMNS)
      .maybeSingle();

    if (error) throw fromPostgrestError(error, 'Could not move list');
    if (!data) throw new HttpError(404, 'List not found');

    emitToOrg(req.orgId, 'list:moved', { boardId, list: data }, originSocketId(req));
    res.json({ list: data });
  })
);
