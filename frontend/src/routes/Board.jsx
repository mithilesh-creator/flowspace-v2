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
  planListMove,
  removeCard,
  upsertCard,
  upsertList,
} from '../lib/board.js';

const WRITE_ROLES = ['owner', 'admin', 'member'];
// Deleting a list cascades every card in it, so it is held to the same bar
// as deleting a board.
const DELETE_LIST_ROLES = ['owner', 'admin'];

export function Board() {
  const { boardId } = useParams();
  const navigate = useNavigate();
  const { accessToken, user, signOut } = useAuth();
  const { activeOrg, activeOrgId, role, loading: orgsLoading } = useOrg();
  const { socket, status } = useSocket(accessToken);

  const [board, setBoard] = useState(null);
  const [lists, setLists] = useState([]);
  const [members, setMembers] = useState([]);
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

  // Assignee names. A failure here is cosmetic — the board still works,
  // assignees just render as a generic chip — so it does not set `error`.
  useEffect(() => {
    if (!accessToken || !activeOrgId) return;

    let active = true;
    api
      .listMembers(accessToken, activeOrgId)
      .then(({ members: list }) => active && setMembers(list ?? []))
      .catch(() => active && setMembers([]));

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

  async function handleDropCard(toListId) {
    const current = drag;
    const hint = dropHint;
    endDrag();

    if (!canWrite || current?.kind !== 'card') return;

    const displayIndex =
      hint?.kind === 'card' && hint.listId === toListId
        ? hint.index
        : (lists.find((l) => l.id === toListId)?.cards.length ?? 0);

    const plan = planCardMove(lists, {
      cardId: current.cardId,
      fromListId: current.fromListId,
      toListId,
      displayIndex,
    });
    if (!plan) return;

    const snapshot = lists;
    setLists(plan.lists);
    setError(null);
    setNotice(null);

    try {
      const { card } = await api.moveCard(accessToken, activeOrgId, boardId, current.cardId, {
        listId: toListId,
        position: plan.position,
        socketId,
      });
      setLists((prev) => upsertCard(prev, card));
    } catch (err) {
      // Cards have no unique constraint on position, so this is a real
      // failure rather than a collision — show it. Resync anyway: a
      // rejected move often means the board changed underneath us, which
      // makes the snapshot stale too.
      setLists(snapshot);
      setError(err.message);
      loadBoard({ keepMessage: true });
    }
  }

  async function handleDropList() {
    const current = drag;
    const hint = dropHint;
    endDrag();

    if (!canWrite || current?.kind !== 'list') return;
    if (hint?.kind !== 'list') return;

    const plan = planListMove(lists, {
      listId: current.listId,
      displayIndex: hint.index,
    });
    if (!plan) return;

    const snapshot = lists;
    setLists(plan.lists);
    setError(null);
    setNotice(null);

    try {
      const { list } = await api.moveList(accessToken, activeOrgId, boardId, current.listId, {
        position: plan.position,
        socketId,
      });
      setLists((prev) => upsertList(prev, list));
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
    }
  }

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

        {loading ? (
          <p className="muted">Loading board…</p>
        ) : (
          <div className="kanban" onDragEnd={endDrag}>
            {lists.map((list, index) => (
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
                  memberById={memberById}
                  onDragStartCard={(card, fromListId) =>
                    setDrag({ kind: 'card', cardId: card.id, fromListId })
                  }
                  onDragStartList={(l) => setDrag({ kind: 'list', listId: l.id })}
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
