import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { BoardColumn } from '../components/BoardColumn.jsx';
import { CardEditor, memberUserId } from '../components/CardEditor.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useOrg } from '../context/OrgContext.jsx';
import { useSocket } from '../hooks/useSocket.js';
import { api } from '../lib/api.js';
import {
  normalizeBoard,
  planCardMove,
  planCardMoveToSlot,
  planListMove,
  planListMoveToSlot,
  previewCardSlot,
  previewListSlot,
  removeCard,
  slotCount,
  upsertCard,
  upsertList,
} from '../lib/board.js';

const WRITE_ROLES = ['owner', 'admin', 'member'];
// Deleting a list cascades every card in it, so it is held to the same bar
// as deleting a board.
const DELETE_LIST_ROLES = ['owner', 'admin'];

const KEYBOARD_HINT_ID = 'kb-reorder-hint';
const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
const ZWSP = '​'; // zero-width space

const ARROWS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

// `Spacebar` is IE/old-Edge, `Space` is what a few automation harnesses
// send for `key`. Accept all three rather than lose the primary gesture.
const isSpace = (key) => key === ' ' || key === 'Spacebar' || key === 'Space';

export function Board() {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const { accessToken, user, signOut } = useAuth();
  const { activeOrg, activeOrgId, role, loading: orgsLoading } = useOrg();
  const { socket, status } = useSocket(accessToken);

  const [board, setBoard] = useState(null);
  const [lists, setLists] = useState([]);
  const [members, setMembers] = useState([]);
  const [membersStatus, setMembersStatus] = useState('loading');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newListTitle, setNewListTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);
  const [lastEvent, setLastEvent] = useState(null);

  // Drag state. `drag` is what is in flight, `dropHint` is where it would
  // land if released now — the second exists so the drop indicator can be
  // rendered without touching the real ordering until the drop commits.
  const [drag, setDrag] = useState(null);
  const [dropHint, setDropHint] = useState(null);

  // Keyboard reordering (H5). `grab` is the pointer-free equivalent of
  // `drag` + `dropHint` in one object, because with a keyboard the thing
  // being moved and the place it would land are never independent — every
  // arrow key changes both. Slots, not display indices: see lib/board.js.
  //
  //   { kind: 'card', cardId, fromListId, originSlot, toListId, slot }
  //   { kind: 'list', listId, originSlot, slot }
  const [grab, setGrab] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  // Set on drop/cancel so focus follows the item to wherever it landed,
  // even though crossing columns remounts its DOM node.
  const [pendingFocus, setPendingFocus] = useState(null);

  const canWrite = WRITE_ROLES.includes(role);
  const canDeleteList = DELETE_LIST_ROLES.includes(role);

  const memberById = useMemo(
    () => new Map(members.map((m) => [memberUserId(m), m])),
    [members]
  );

  // ------------------------------------------------------------------
  // Loading. `loadBoard` is the whole-board resync used both for the
  // initial fetch and for self-healing after a missed broadcast.
  // ------------------------------------------------------------------
  //
  // `keepMessage` is for the resync that follows a rejected mutation: the
  // refetch succeeding does not mean the move succeeded, and clearing the
  // message here would wipe the only explanation the user gets for their
  // card springing back.
  const loadBoard = useCallback(
    async ({ keepMessage = false } = {}) => {
      if (!accessToken || !activeOrgId || !boardId) return;

      try {
        const payload = await api.getBoard(accessToken, activeOrgId, boardId);
        const { board: row, lists: nextLists } = normalizeBoard(payload);
        setBoard(row);
        setLists(nextLists);
        if (!keepMessage) setError(null);
      } catch (err) {
        setError(err.message);
      }
    },
    [accessToken, activeOrgId, boardId]
  );

  useEffect(() => {
    if (!accessToken || !activeOrgId || !boardId) return;

    setLoading(true);
    setBoard(null);
    setLists([]);
    setError(null);
    loadBoard().finally(() => setLoading(false));
  }, [accessToken, activeOrgId, boardId, loadBoard]);

  // Org members. These are both the assignee-name lookup for the board and
  // the only legal options in the assignee picker (H6) — `cards` now has a
  // composite FK onto `memberships`, so offering anyone else is offering a
  // save that the database will reject.
  //
  // A failure here is still cosmetic for the board itself — assignees just
  // render as a generic chip — so it does not set `error`. It does set
  // `membersStatus`, because an empty picker and a picker that failed to
  // load are very different things to the person looking at it.
  useEffect(() => {
    if (!accessToken || !activeOrgId) return undefined;

    let active = true;
    setMembersStatus('loading');
    api
      .listMembers(accessToken, activeOrgId)
      .then(({ members: list }) => {
        if (!active) return;
        setMembers(list ?? []);
        setMembersStatus('ready');
      })
      .catch(() => {
        if (!active) return;
        setMembers([]);
        setMembersStatus('error');
      });

    return () => {
      active = false;
    };
  }, [accessToken, activeOrgId]);

  // Switching workspace in the header while a board is open leaves the
  // URL pointing at a board the new tenant cannot see. Go back to the
  // list rather than sit on a 403.
  const openedWithOrg = useRef(activeOrgId);
  useEffect(() => {
    if (!activeOrgId) return;
    if (openedWithOrg.current === null) {
      openedWithOrg.current = activeOrgId;
      return;
    }
    if (openedWithOrg.current !== activeOrgId) navigate('/boards', { replace: true });
  }, [activeOrgId, navigate]);

  // ------------------------------------------------------------------
  // Realtime. Every handler drops events for another tenant *and* for
  // another board — the room is per-org, so a second board in this
  // workspace broadcasts into the same room we are sitting in.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!socket || !activeOrgId || !boardId) return undefined;

    const join = () => socket.emit('org:join', { orgId: activeOrgId });

    const forThisBoard = (handler) => (payload) => {
      if (payload?.orgId !== activeOrgId) return;
      if (payload?.boardId !== boardId) return;
      handler(payload);
    };

    const onListCreated = forThisBoard(({ list }) => {
      setLists((prev) => upsertList(prev, list));
      setLastEvent(`list:created — ${list.title}`);
    });

    const onListUpdated = forThisBoard(({ list }) => {
      setLists((prev) => upsertList(prev, list));
      setLastEvent(`list:updated — ${list.title}`);
    });

    const onListMoved = forThisBoard(({ list }) => {
      setLists((prev) => upsertList(prev, list));
      setLastEvent(`list:moved — ${list.title}`);
    });

    const onListDeleted = forThisBoard(({ listId }) => {
      setLists((prev) => prev.filter((l) => l.id !== listId));
      setLastEvent('list:deleted');
    });

    const onCardCreated = forThisBoard(({ card }) => {
      setLists((prev) => upsertCard(prev, card));
      setLastEvent(`card:created — ${card.title}`);
    });

    const onCardUpdated = forThisBoard(({ card }) => {
      setLists((prev) => upsertCard(prev, card));
      setEditing((current) => (current?.id === card.id ? card : current));
      setLastEvent(`card:updated — ${card.title}`);
    });

    // The row's own list_id is what places it, so `fromListId` is not
    // needed to apply the move — upsertCard lifts the card out of
    // whichever column currently holds it. It is still worth logging.
    const onCardMoved = forThisBoard(({ card, fromListId }) => {
      setLists((prev) => upsertCard(prev, card));
      setLastEvent(`card:moved — ${card.title}${fromListId ? ' (across lists)' : ''}`);
    });

    const onCardDeleted = forThisBoard(({ cardId }) => {
      setLists((prev) => removeCard(prev, cardId));
      setEditing((current) => (current?.id === cardId ? null : current));
      setLastEvent('card:deleted');
    });

    const onBoardUpdated = (payload) => {
      if (payload?.orgId !== activeOrgId || payload?.board?.id !== boardId) return;
      setBoard(payload.board);
    };

    const onBoardDeleted = (payload) => {
      if (payload?.orgId !== activeOrgId || payload?.boardId !== boardId) return;
      navigate('/boards', { replace: true });
    };

    const onUnauthorized = ({ message }) => setError(message);

    // Broadcasts are at-most-once: the polling→WebSocket upgrade and any
    // brief disconnect can each swallow an event, and a dropped card:moved
    // leaves the board silently in the wrong order with nothing on screen
    // to suggest it. Refetching the whole board once we are in the room —
    // on first join and again after every reconnect — makes it self-heal.
    const onJoined = (payload) => {
      if (payload?.orgId !== activeOrgId) return;
      loadBoard();
    };

    join();
    socket.on('connect', join);
    socket.on('org:joined', onJoined);
    socket.on('list:created', onListCreated);
    socket.on('list:updated', onListUpdated);
    socket.on('list:moved', onListMoved);
    socket.on('list:deleted', onListDeleted);
    socket.on('card:created', onCardCreated);
    socket.on('card:updated', onCardUpdated);
    socket.on('card:moved', onCardMoved);
    socket.on('card:deleted', onCardDeleted);
    socket.on('board:updated', onBoardUpdated);
    socket.on('board:deleted', onBoardDeleted);
    socket.on('error:unauthorized', onUnauthorized);

    return () => {
      socket.emit('org:leave', { orgId: activeOrgId });
      socket.off('connect', join);
      socket.off('org:joined', onJoined);
      socket.off('list:created', onListCreated);
      socket.off('list:updated', onListUpdated);
      socket.off('list:moved', onListMoved);
      socket.off('list:deleted', onListDeleted);
      socket.off('card:created', onCardCreated);
      socket.off('card:updated', onCardUpdated);
      socket.off('card:moved', onCardMoved);
      socket.off('card:deleted', onCardDeleted);
      socket.off('board:updated', onBoardUpdated);
      socket.off('board:deleted', onBoardDeleted);
      socket.off('error:unauthorized', onUnauthorized);
    };
  }, [socket, activeOrgId, boardId, loadBoard, navigate]);

  // ------------------------------------------------------------------
  // Mutations. Everything sends X-Socket-Id, so this client is excluded
  // from its own broadcast and applies the echoed row itself.
  // ------------------------------------------------------------------
  const socketId = socket?.id;

  async function handleCreateList(event) {
    event.preventDefault();
    const trimmed = newListTitle.trim();
    if (!trimmed) return;

    setBusy(true);
    setError(null);
    try {
      const { list } = await api.createList(accessToken, activeOrgId, boardId, {
        title: trimmed,
        socketId,
      });
      setLists((prev) => upsertList(prev, { ...list, cards: [] }));
      setNewListTitle('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameList(list) {
    const next = window.prompt('Rename list', list.title);
    if (next === null) return;
    if (!next.trim() || next.trim() === list.title) return;

    try {
      const { list: updated } = await api.renameList(
        accessToken,
        activeOrgId,
        boardId,
        list.id,
        { title: next.trim(), socketId }
      );
      setLists((prev) => upsertList(prev, updated));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDeleteList(list) {
    if (!canDeleteList) return;

    const warning = list.cards.length
      ? `Delete “${list.title}” and its ${list.cards.length} card(s)?`
      : `Delete “${list.title}”?`;
    if (!window.confirm(warning)) return;

    const snapshot = lists;
    setLists((prev) => prev.filter((l) => l.id !== list.id));
    try {
      await api.deleteList(accessToken, activeOrgId, boardId, list.id, { socketId });
    } catch (err) {
      setLists(snapshot);
      setError(err.message);
    }
  }

  async function handleCreateCard(listId, title) {
    setError(null);
    try {
      const { card } = await api.createCard(accessToken, activeOrgId, boardId, {
        listId,
        title,
        socketId,
      });
      setLists((prev) => upsertCard(prev, card));
    } catch (err) {
      setError(err.message);
      // Rethrown so the column keeps what the user typed instead of
      // clearing the input on a card that was never created.
      throw err;
    }
  }

  async function handleSaveCard(patch) {
    const target = editing;
    const snapshot = lists;

    // Optimistic: the editor closes immediately and the card shows the new
    // values, then the echoed row replaces them.
    setLists((prev) => upsertCard(prev, { ...target, ...toRowShape(patch) }));
    setEditing(null);

    try {
      const { card } = await api.updateCard(accessToken, activeOrgId, boardId, target.id, {
        ...patch,
        socketId,
      });
      setLists((prev) => upsertCard(prev, card));
    } catch (err) {
      setLists(snapshot);
      setError(err.message);
      throw err;
    }
  }

  async function handleDeleteCard(card) {
    if (!window.confirm(`Delete “${card.title}”?`)) return;

    const snapshot = lists;
    setLists((prev) => removeCard(prev, card.id));
    setEditing(null);
    try {
      await api.deleteCard(accessToken, activeOrgId, boardId, card.id, { socketId });
    } catch (err) {
      setLists(snapshot);
      setError(err.message);
    }
  }

  // ------------------------------------------------------------------
  // Drag and drop.
  //
  // The optimistic shape is the same for both: compute the destination
  // position client-side, apply it locally, send it, then overwrite the
  // local row with whatever the server echoed back. On failure restore the
  // snapshot and resync — a rejected move usually means someone else
  // changed the board underneath us, so the snapshot alone can be stale.
  // ------------------------------------------------------------------
  function endDrag() {
    setDrag(null);
    setDropHint(null);
  }

  /**
   * Commit a card move. Both input paths land here with a plan already
   * computed by lib/board.js, so pointer and keyboard share one optimistic
   * update, one request, one reconcile and one rollback.
   *
   * Returns whether it stuck, which the keyboard path needs in order to
   * announce the outcome.
   */
  async function commitCardMove(plan) {
    if (!plan) return true; // no-op move; nothing to send, nothing failed

    const snapshot = lists;
    setLists(plan.lists);
    setError(null);
    setNotice(null);

    try {
      const { card } = await api.moveCard(accessToken, activeOrgId, boardId, plan.card.id, {
        listId: plan.toListId,
        position: plan.position,
        socketId,
      });
      setLists((prev) => upsertCard(prev, card));
      return true;
    } catch (err) {
      // Cards have no unique constraint on position, so this is a real
      // failure rather than a collision — show it. Resync anyway: a
      // rejected move often means the board changed underneath us, which
      // makes the snapshot stale too.
      setLists(snapshot);
      setError(err.message);
      loadBoard({ keepMessage: true });
      return false;
    }
  }

  /** The column equivalent of `commitCardMove`. */
  async function commitListMove(plan) {
    if (!plan) return true;

    const snapshot = lists;
    setLists(plan.lists);
    setError(null);
    setNotice(null);

    try {
      const { list } = await api.moveList(accessToken, activeOrgId, boardId, plan.list.id, {
        position: plan.position,
        socketId,
      });
      setLists((prev) => upsertList(prev, list));
      return true;
    } catch (err) {
      setLists(snapshot);

      // `lists` has `unique (board_id, position)`. Two people dropping
      // into the same gap at the same moment both compute the same
      // midpoint and the second one collides. That is ordinary
      // concurrency, not an error the user did anything wrong to cause —
      // resync and say so plainly.
      //
      // Deliberately not retried: the refetch gives us the neighbours'
      // real positions, and recomputing against them is the user's next
      // drag, not an automatic loop that could collide again.
      if (err.status === 409) {
        setNotice('Someone else moved this list — refreshed.');
      } else {
        setError(err.message);
      }
      loadBoard({ keepMessage: true });
      return false;
    }
  }

  async function handleDropCard(toListId) {
    const current = drag;
    const hint = dropHint;
    endDrag();

    if (!canWrite || current?.kind !== 'card') return;

    const displayIndex =
      hint?.kind === 'card' && hint.listId === toListId
        ? hint.index
        : (lists.find((l) => l.id === toListId)?.cards.length ?? 0);

    await commitCardMove(
      planCardMove(lists, {
        cardId: current.cardId,
        fromListId: current.fromListId,
        toListId,
        displayIndex,
      })
    );
  }

  async function handleDropList() {
    const current = drag;
    const hint = dropHint;
    endDrag();

    if (!canWrite || current?.kind !== 'list') return;
    if (hint?.kind !== 'list') return;

    await commitListMove(
      planListMove(lists, { listId: current.listId, displayIndex: hint.index })
    );
  }

  // ------------------------------------------------------------------
  // H5 — keyboard reordering.
  //
  // Space picks a card up, arrows move it (up/down within a column,
  // left/right between columns), space or enter drops it, escape puts it
  // back. Columns get the same treatment from a handle in their header.
  //
  // Nothing is written until the drop: while grabbed, the board renders a
  // preview and `lists` is untouched, so escape is a state reset rather
  // than an undo. The drop then goes through exactly the same commit path
  // as a mouse drop.
  // ------------------------------------------------------------------
  function announce(text) {
    // A screen reader re-reads a live region only when its text changes,
    // and moving an item back and forth produces the same sentence twice.
    // A trailing zero-width space alternates so the repeat still speaks.
    setAnnouncement((prev) =>
      prev.replace(ZWSP, '') === text ? `${text}${ZWSP}` : text
    );
  }

  function cardsIn(listId) {
    return lists.find((l) => l.id === listId)?.cards ?? [];
  }

  function listTitle(listId) {
    return lists.find((l) => l.id === listId)?.title ?? 'list';
  }

  function releaseGrab(focusKey, message) {
    setGrab(null);
    setPendingFocus(focusKey);
    if (message) announce(message);
  }

  function startCardGrab(card, fromListId) {
    if (!canWrite || grab) return;
    const cards = cardsIn(fromListId);
    const slot = cards.findIndex((c) => c.id === card.id);
    if (slot === -1) return;

    setGrab({ kind: 'card', cardId: card.id, fromListId, originSlot: slot, toListId: fromListId, slot });
    announce(`Grabbed ${card.title}, position ${slot + 1} of ${cards.length}`);
  }

  function moveGrabbedCard(direction) {
    if (grab?.kind !== 'card') return;

    const columnIndex = lists.findIndex((l) => l.id === grab.toListId);
    if (columnIndex === -1) return;

    let { toListId, slot } = grab;

    if (direction === 'up' || direction === 'down') {
      const max = slotCount(lists, { ...grab, listId: toListId });
      const next = clamp(slot + (direction === 'up' ? -1 : 1), 0, max);
      if (next === slot) return; // already at the end of the column
      slot = next;
    } else {
      const nextColumn = columnIndex + (direction === 'left' ? -1 : 1);
      if (nextColumn < 0 || nextColumn >= lists.length) return;
      toListId = lists[nextColumn].id;
      slot = clamp(slot, 0, slotCount(lists, { ...grab, listId: toListId }));
    }

    const total = slotCount(lists, { ...grab, listId: toListId }) + 1;
    setGrab({ ...grab, toListId, slot });
    announce(`Moved to ${listTitle(toListId)}, position ${slot + 1} of ${total}`);
  }

  async function dropGrabbedCard() {
    if (grab?.kind !== 'card') return;

    const current = grab;
    releaseGrab(`card:${current.cardId}`);

    const ok = await commitCardMove(
      planCardMoveToSlot(lists, {
        cardId: current.cardId,
        fromListId: current.fromListId,
        toListId: current.toListId,
        slot: current.slot,
      })
    );
    announce(ok ? 'Dropped' : 'Move failed, card put back');
  }

  function startListGrab(list) {
    if (!canWrite || grab) return;
    const slot = lists.findIndex((l) => l.id === list.id);
    if (slot === -1) return;

    setGrab({ kind: 'list', listId: list.id, originSlot: slot, slot });
    announce(`Grabbed list ${list.title}, position ${slot + 1} of ${lists.length}`);
  }

  function moveGrabbedList(direction) {
    if (grab?.kind !== 'list') return;

    const max = lists.length - 1; // the grabbed column is lifted out
    const slot = clamp(grab.slot + (direction === 'left' ? -1 : 1), 0, max);
    if (slot === grab.slot) return;

    setGrab({ ...grab, slot });
    announce(`Moved to position ${slot + 1} of ${lists.length}`);
  }

  async function dropGrabbedList() {
    if (grab?.kind !== 'list') return;

    const current = grab;
    releaseGrab(`list:${current.listId}`);

    const ok = await commitListMove(
      planListMoveToSlot(lists, { listId: current.listId, slot: current.slot })
    );
    announce(ok ? 'Dropped' : 'Move failed, list put back');
  }

  function cancelGrab() {
    if (!grab) return;
    releaseGrab(
      grab.kind === 'card' ? `card:${grab.cardId}` : `list:${grab.listId}`,
      'Cancelled'
    );
  }

  function handleCardKeyDown(event, card, listId) {
    if (!canWrite) return;

    const grabbed = grab?.kind === 'card' && grab.cardId === card.id;
    if (!grabbed) {
      // Space picks up; enter and click still open the editor. Anything
      // grabbed elsewhere owns the keyboard until it is dropped.
      if (grab) return;
      if (isSpace(event.key)) {
        event.preventDefault();
        startCardGrab(card, listId);
      }
      return;
    }

    if (ARROWS[event.key]) {
      event.preventDefault();
      event.stopPropagation();
      moveGrabbedCard(ARROWS[event.key]);
    } else if (isSpace(event.key) || event.key === 'Enter') {
      event.preventDefault();
      dropGrabbedCard();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelGrab();
    } else if (event.key === 'Tab') {
      // Tabbing out mid-grab would strand the card in a preview position
      // that was never committed.
      event.preventDefault();
    }
  }

  function handleListKeyDown(event, list) {
    if (!canWrite) return;

    const grabbed = grab?.kind === 'list' && grab.listId === list.id;
    if (!grabbed) {
      if (grab) return;
      if (isSpace(event.key)) {
        event.preventDefault();
        startListGrab(list);
      }
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      moveGrabbedList(ARROWS[event.key]);
    } else if (isSpace(event.key) || event.key === 'Enter') {
      event.preventDefault();
      dropGrabbedList();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelGrab();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  }

  // What the board renders. Identical to `lists` unless something is
  // grabbed, in which case it is `lists` with the grabbed item shown where
  // it would land — no positions assigned, nothing committed.
  const displayLists = useMemo(() => {
    if (!grab) return lists;
    return grab.kind === 'card'
      ? previewCardSlot(lists, grab)
      : previewListSlot(lists, grab);
  }, [lists, grab]);

  // Focus management. Moving between columns remounts the card's DOM node,
  // and re-rendering the preview can move it within one, so "keep focus on
  // the thing I am moving" has to be reasserted after every render rather
  // than set once. `pendingFocus` covers the render after the drop, when
  // there is no longer a grab to derive the target from.
  const grabFocusKey = grab
    ? grab.kind === 'card'
      ? `card:${grab.cardId}`
      : `list:${grab.listId}`
    : null;

  useEffect(() => {
    const key = grabFocusKey ?? pendingFocus;
    if (!key) return;

    const el = document.querySelector(`[data-kb-focus="${key}"]`);
    if (el && document.activeElement !== el) el.focus();
    if (!grabFocusKey && pendingFocus) setPendingFocus(null);
  });

  // A grabbed item can be deleted or moved by someone else while it is in
  // the air. Drop the grab rather than preview a card that no longer
  // exists.
  useEffect(() => {
    if (!grab) return;
    const stillThere =
      grab.kind === 'card'
        ? lists.some((l) => l.cards.some((c) => c.id === grab.cardId))
        : lists.some((l) => l.id === grab.listId);
    if (!stillThere) setGrab(null);
  }, [lists, grab]);

  const listHint = dropHint?.kind === 'list' ? dropHint.index : null;

  if (orgsLoading) {
    return <div className="screen-centered muted">Loading workspace…</div>;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <Link to="/boards">Flowspace</Link>
        </div>

        <span className="muted">/</span>
        <strong>{board?.title ?? 'Board'}</strong>

        <span className={`badge badge-${status}`}>
          <span className="dot" aria-hidden="true" />
          {status}
        </span>

        <div className="spacer" />

        <span className="muted small">
          {user?.email} · {role}
        </span>
        <button type="button" className="ghost" onClick={signOut}>
          Sign out
        </button>
      </header>

      <main className="app-main board-main">
        <div className="section-heading">
          <p className="muted small">
            <Link to="/boards">← {activeOrg?.name ?? 'Boards'}</Link>
          </p>
        </div>

        {!canWrite && (
          <p className="notice">
            You have <strong>{role}</strong> access to this workspace, which is
            read-only.
          </p>
        )}

        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}

        {/* The keyboard contract, once, referenced by every grabbable
            element via aria-describedby. */}
        <p id={KEYBOARD_HINT_ID} className="visually-hidden">
          Press space to pick up. Use the arrow keys to move it, space or enter
          to drop it, and escape to put it back.
        </p>
        <p
          className="visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="reorder-announcer"
        >
          {announcement}
        </p>

        {loading ? (
          <p className="muted">Loading board…</p>
        ) : (
          <div className="kanban" onDragEnd={endDrag}>
            {displayLists.map((list, index) => (
              <Fragment key={list.id}>
                {listHint === index && (
                  <div className="column-drop-indicator" aria-hidden="true" />
                )}
                <BoardColumn
                  list={list}
                  index={index}
                  canWrite={canWrite}
                  canDeleteList={canDeleteList}
                  drag={drag}
                  dropHint={dropHint}
                  grab={grab}
                  hintId={KEYBOARD_HINT_ID}
                  memberById={memberById}
                  membersStatus={membersStatus}
                  onCardKeyDown={handleCardKeyDown}
                  onListKeyDown={handleListKeyDown}
                  onDragStartCard={(card, fromListId) => {
                    // A mouse taking over mid-grab abandons the keyboard
                    // preview rather than fighting it for the same card.
                    setGrab(null);
                    setDrag({ kind: 'card', cardId: card.id, fromListId });
                  }}
                  onDragStartList={(l) => {
                    setGrab(null);
                    setDrag({ kind: 'list', listId: l.id });
                  }}
                  onDragEnd={endDrag}
                  onHoverCard={(listId, idx) =>
                    setDropHint((prev) =>
                      prev?.kind === 'card' && prev.listId === listId && prev.index === idx
                        ? prev
                        : { kind: 'card', listId, index: idx }
                    )
                  }
                  onHoverList={(idx) =>
                    setDropHint((prev) =>
                      prev?.kind === 'list' && prev.index === idx
                        ? prev
                        : { kind: 'list', index: idx }
                    )
                  }
                  onDropCard={handleDropCard}
                  onDropList={handleDropList}
                  onRenameList={handleRenameList}
                  onDeleteList={handleDeleteList}
                  onCreateCard={handleCreateCard}
                  onOpenCard={setEditing}
                />
              </Fragment>
            ))}

            {listHint === lists.length && (
              <div className="column-drop-indicator" aria-hidden="true" />
            )}

            {canWrite && (
              <form className="column new-list" onSubmit={handleCreateList}>
                <input
                  type="text"
                  value={newListTitle}
                  placeholder="New list title"
                  maxLength={120}
                  aria-label="New list title"
                  onChange={(e) => setNewListTitle(e.target.value)}
                />
                <button type="submit" disabled={busy || !newListTitle.trim()}>
                  {busy ? 'Adding…' : 'Add list'}
                </button>
              </form>
            )}

            {lists.length === 0 && !canWrite && <p className="muted">No lists yet.</p>}
          </div>
        )}

        {editing && (
          <CardEditor
            card={editing}
            members={members}
            membersStatus={membersStatus}
            onSave={handleSaveCard}
            onCancel={() => setEditing(null)}
            onDelete={() => handleDeleteCard(editing)}
          />
        )}

        {lastEvent && (
          <p className="muted small event-log">last realtime event: {lastEvent}</p>
        )}
      </main>
    </div>
  );
}

// The PATCH body is camelCase per the contract; the row it edits is
// snake_case. Translate so the optimistic copy matches what the echo
// will look like.
function toRowShape(patch) {
  const row = {};
  if ('title' in patch) row.title = patch.title;
  if ('description' in patch) row.description = patch.description;
  if ('assigneeId' in patch) row.assignee_id = patch.assigneeId;
  if ('dueDate' in patch) row.due_date = patch.dueDate;
  return row;
}
