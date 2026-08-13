/**
 * Ordering and shape helpers for the Kanban board.
 *
 * Positions are fractional (`numeric` in Postgres, see the Phase 2
 * contract). The client computes the new position and the server stores it
 * verbatim — the server validates the target list, it does not reorder.
 * That means the arithmetic here is the ordering rule, so it lives in one
 * place rather than being inlined at each drop site.
 */

// PostgREST serialises `numeric` as a JSON number, but a numeric wide
// enough to lose precision comes back as a string. Coerce rather than
// assume: `(prev + next) / 2` on two strings concatenates them.
function toNumber(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The position for an item dropped between `prev` and `next`, either of
 * which may be absent at the ends of the list.
 *
 * Contract: midpoint between neighbours, `first - 1` before the first,
 * `last + 1` after the last.
 */
export function positionBetween(prev, next) {
  const p = toNumber(prev);
  const n = toNumber(next);

  if (p === null && n === null) return 1; // first item in an empty list
  if (p === null) return n - 1;
  if (n === null) return p + 1;
  return (p + n) / 2;
}

/**
 * Ascending by `position`, ties broken by `created_at` then `id`.
 *
 * `lists` has `unique (board_id, position)` so its ties only exist
 * mid-transaction, but **cards have no such constraint** — two clients can
 * legitimately land two cards on the same position. Without a deterministic
 * tiebreak those two cards would swap places on every re-render.
 */
export function sortByPosition(items) {
  return [...items].sort((a, b) => {
    const byPosition = (toNumber(a.position) ?? 0) - (toNumber(b.position) ?? 0);
    if (byPosition !== 0) return byPosition;

    const byCreated = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
    if (byCreated !== 0) return byCreated;

    return String(a.id).localeCompare(String(b.id));
  });
}

// Rows come back in the database's snake_case; socket payload envelopes
// use camelCase. Read foreign keys through these so a move never silently
// lands the card in the wrong column.
//
// The card row shape is not frozen — `board_id` is being denormalised onto
// it — so every consumer reads fields through these accessors rather than
// destructuring a shape it assumes. Reading is tolerant; *writing* is not:
// `board_id` is never sent in a request body, the server takes it from the
// authorised route param.
export const cardListId = (card) => card?.list_id ?? card?.listId ?? null;
export const cardBoardId = (card) => card?.board_id ?? card?.boardId ?? null;
export const cardAssigneeId = (card) => card?.assignee_id ?? card?.assigneeId ?? null;
export const cardDueDate = (card) => card?.due_date ?? card?.dueDate ?? null;
export const listBoardId = (list) => list?.board_id ?? list?.boardId ?? null;

/**
 * Normalise `GET /api/orgs/:orgId/boards/:boardId` into
 * `{ board, lists }`, where every list carries a sorted `cards` array.
 *
 * The contract specifies "board + lists + cards, nested, ordered" without
 * pinning the envelope, so this accepts the nesting either on the board or
 * beside it, and regroups a flat `cards` array if that is what arrives.
 */
export function normalizeBoard(payload) {
  const board = payload?.board ?? payload ?? null;
  const rawLists = payload?.lists ?? board?.lists ?? [];
  const flatCards = payload?.cards ?? board?.cards ?? null;

  const lists = sortByPosition(rawLists).map((list) => {
    const cards = Array.isArray(flatCards)
      ? flatCards.filter((c) => cardListId(c) === list.id)
      : (list.cards ?? []);
    return { ...list, cards: sortByPosition(cards) };
  });

  return { board, lists };
}

/**
 * Work out where a dragged card lands.
 *
 * `displayIndex` is an index into the *rendered* target column, which
 * still contains the dragged card when the drag started in that column.
 * Returns null for a no-op so callers can skip the request entirely
 * instead of writing a position identical to the current one.
 */
export function planCardMove(lists, { cardId, fromListId, toListId, displayIndex }) {
  const source = lists.find((l) => l.id === fromListId);
  const target = lists.find((l) => l.id === toListId);
  if (!source || !target) return null;

  const card = source.cards.find((c) => c.id === cardId);
  if (!card) return null;

  const remaining = target.cards.filter((c) => c.id !== cardId);

  let index = displayIndex;
  if (fromListId === toListId) {
    const sourceIndex = target.cards.findIndex((c) => c.id === cardId);
    // Dropping below yourself shifts every index above you down by one
    // once you are lifted out of the array.
    if (displayIndex > sourceIndex) index -= 1;
    if (index === sourceIndex) return null;
  }
  index = Math.max(0, Math.min(index, remaining.length));

  const position = positionBetween(
    remaining[index - 1]?.position,
    remaining[index]?.position
  );

  const moved = { ...card, list_id: toListId, position };
  const nextCards = [...remaining.slice(0, index), moved, ...remaining.slice(index)];

  const nextLists = lists.map((list) => {
    if (list.id === toListId) return { ...list, cards: nextCards };
    if (list.id === fromListId) {
      return { ...list, cards: list.cards.filter((c) => c.id !== cardId) };
    }
    return list;
  });

  return { position, toListId, fromListId, card: moved, lists: nextLists };
}

/** The column equivalent of `planCardMove`. */
export function planListMove(lists, { listId, displayIndex }) {
  const sourceIndex = lists.findIndex((l) => l.id === listId);
  if (sourceIndex === -1) return null;

  const remaining = lists.filter((l) => l.id !== listId);

  let index = displayIndex;
  if (displayIndex > sourceIndex) index -= 1;
  if (index === sourceIndex) return null;
  index = Math.max(0, Math.min(index, remaining.length));

  const position = positionBetween(
    remaining[index - 1]?.position,
    remaining[index]?.position
  );

  const moved = { ...lists[sourceIndex], position };
  const nextLists = [...remaining.slice(0, index), moved, ...remaining.slice(index)];

  return { position, list: moved, lists: nextLists };
}

// ---------------------------------------------------------------------
// Slot arithmetic — the keyboard path.
//
// Pointer drag thinks in *display* indices: the index under the cursor in
// the column as rendered, which still contains the dragged item when it
// has not left its own column. Keyboard reordering thinks in *slots*: the
// index the item would occupy once it has been lifted out. Slots are the
// only sane model for "press ArrowDown once, move down one place".
//
// The two differ by exactly one below the item's own origin, so the
// keyboard entry points convert and then delegate. The position maths
// itself — midpoint between neighbours, first-1 / last+1 at the ends —
// stays in `positionBetween` with a single caller chain, which is the
// point: there is one ordering rule in this app, not one per input device.
// ---------------------------------------------------------------------

const clamp = (n, min, max) => Math.max(min, Math.min(n, max));

/** How many cards a column holds once the grabbed card is lifted out. */
export function slotCount(lists, { cardId, fromListId, listId }) {
  const list = lists.find((l) => l.id === listId);
  if (!list) return 0;
  const holdsIt = listId === fromListId && list.cards.some((c) => c.id === cardId);
  return list.cards.length - (holdsIt ? 1 : 0);
}

/** `planCardMove`, addressed by slot instead of display index. */
export function planCardMoveToSlot(lists, { cardId, fromListId, toListId, slot }) {
  const source = lists.find((l) => l.id === fromListId);
  if (!source) return null;

  let displayIndex = slot;
  if (fromListId === toListId) {
    const sourceIndex = source.cards.findIndex((c) => c.id === cardId);
    if (slot > sourceIndex) displayIndex = slot + 1;
  }
  return planCardMove(lists, { cardId, fromListId, toListId, displayIndex });
}

/** `planListMove`, addressed by slot instead of display index. */
export function planListMoveToSlot(lists, { listId, slot }) {
  const sourceIndex = lists.findIndex((l) => l.id === listId);
  if (sourceIndex === -1) return null;
  return planListMove(lists, {
    listId,
    displayIndex: slot > sourceIndex ? slot + 1 : slot,
  });
}

/**
 * The board as it would look with the grabbed card sitting in `slot`.
 *
 * Deliberately does **not** assign a position: this is what the user sees
 * mid-grab, and nothing is committed until they drop. Computing a position
 * here would mean recomputing it on every arrow key and then throwing all
 * but the last one away.
 */
export function previewCardSlot(lists, { cardId, fromListId, toListId, slot }) {
  const source = lists.find((l) => l.id === fromListId);
  const card = source?.cards.find((c) => c.id === cardId);
  if (!card) return lists;

  const targetRemaining = (lists.find((l) => l.id === toListId)?.cards ?? []).filter(
    (c) => c.id !== cardId
  );
  const index = clamp(slot, 0, targetRemaining.length);

  return lists.map((list) => {
    if (list.id === toListId) {
      return {
        ...list,
        cards: [
          ...targetRemaining.slice(0, index),
          card,
          ...targetRemaining.slice(index),
        ],
      };
    }
    if (list.id === fromListId) {
      return { ...list, cards: list.cards.filter((c) => c.id !== cardId) };
    }
    return list;
  });
}

/** The column equivalent of `previewCardSlot`. */
export function previewListSlot(lists, { listId, slot }) {
  const sourceIndex = lists.findIndex((l) => l.id === listId);
  if (sourceIndex === -1) return lists;

  const remaining = lists.filter((l) => l.id !== listId);
  const index = clamp(slot, 0, remaining.length);
  return [...remaining.slice(0, index), lists[sourceIndex], ...remaining.slice(index)];
}

/**
 * Apply an authoritative list row — from our own response or from a
 * `list:*` broadcast — over whatever we currently hold.
 */
export function upsertList(lists, row) {
  const existing = lists.find((l) => l.id === row.id);
  const merged = { ...row, cards: existing?.cards ?? row.cards ?? [] };
  const next = existing
    ? lists.map((l) => (l.id === row.id ? merged : l))
    : [...lists, merged];
  return sortByPosition(next);
}

/**
 * Apply an authoritative card row. The row's own `list_id` decides which
 * column it belongs to, so this removes it from wherever it currently sits
 * first — that is what makes it correct for a cross-column move as well as
 * an in-place edit.
 */
export function upsertCard(lists, row) {
  const targetId = cardListId(row);

  return lists.map((list) => {
    const without = list.cards.filter((c) => c.id !== row.id);
    if (list.id !== targetId) {
      return without.length === list.cards.length ? list : { ...list, cards: without };
    }
    return { ...list, cards: sortByPosition([...without, row]) };
  });
}

export function removeCard(lists, cardId) {
  return lists.map((list) => {
    const without = list.cards.filter((c) => c.id !== cardId);
    return without.length === list.cards.length ? list : { ...list, cards: without };
  });
}
