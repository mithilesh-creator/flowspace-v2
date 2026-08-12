import { useCallback, useEffect, useState } from 'react';

import { CreateOrg } from '../components/CreateOrg.jsx';
import { MembersPanel } from '../components/MembersPanel.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useOrg } from '../context/OrgContext.jsx';
import { useSocket } from '../hooks/useSocket.js';
import { api } from '../lib/api.js';

const WRITE_ROLES = ['owner', 'admin', 'member'];
const DELETE_ROLES = ['owner', 'admin'];

export function Boards() {
  const { accessToken, user, signOut } = useAuth();
  const {
    organizations,
    activeOrg,
    activeOrgId,
    role,
    loading: orgsLoading,
    selectOrg,
  } = useOrg();

  const { socket, status } = useSocket(accessToken);

  const [boards, setBoards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);

  const canWrite = WRITE_ROLES.includes(role);
  const canDelete = DELETE_ROLES.includes(role);

  // ------------------------------------------------------------------
  // Initial load. Re-runs on org switch, which is also what clears the
  // previous tenant's boards out of state — leaving them on screen while
  // the next fetch lands would show one tenant's data under another
  // tenant's heading.
  // ------------------------------------------------------------------
  const loadBoards = useCallback(async () => {
    if (!accessToken || !activeOrgId) return;

    try {
      const { boards: list } = await api.listBoards(accessToken, activeOrgId);
      setBoards(list);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, [accessToken, activeOrgId]);

  useEffect(() => {
    if (!accessToken || !activeOrgId) {
      setBoards([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setBoards([]);
    setError(null);
    loadBoards().finally(() => setLoading(false));
  }, [accessToken, activeOrgId, loadBoards]);

  // ------------------------------------------------------------------
  // Realtime. Joining is a request the server validates against
  // membership — see realtime/index.js. Every handler re-checks orgId
  // anyway, because during an org switch an in-flight event from the
  // previous room can still arrive.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!socket || !activeOrgId) return undefined;

    const join = () => socket.emit('org:join', { orgId: activeOrgId });

    const forThisOrg = (handler) => (payload) => {
      if (payload?.orgId !== activeOrgId) return;
      handler(payload);
    };

    const onCreated = forThisOrg(({ board }) => {
      setBoards((prev) =>
        prev.some((b) => b.id === board.id) ? prev : [board, ...prev]
      );
      setLastEvent(`board:created — ${board.title}`);
    });

    const onUpdated = forThisOrg(({ board }) => {
      setBoards((prev) => prev.map((b) => (b.id === board.id ? board : b)));
      setLastEvent(`board:updated — ${board.title}`);
    });

    const onDeleted = forThisOrg(({ boardId }) => {
      setBoards((prev) => prev.filter((b) => b.id !== boardId));
      setLastEvent('board:deleted');
    });

    const onUnauthorized = ({ message }) => setError(message);

    // Resync once we are actually in the room.
    //
    // Broadcasts are fire-and-forget, and there are two windows where one
    // can be missed entirely: the Socket.io polling→WebSocket upgrade
    // right after connecting, and any brief disconnect. A dropped event
    // is invisible — the list just quietly goes stale until the user
    // reloads. Refetching on join makes the board list self-heal instead.
    const onJoined = forThisOrg(() => loadBoards());

    join();
    // Rejoin after a dropped connection: rooms do not survive a
    // reconnect, and without this the board silently stops updating.
    socket.on('connect', join);
    socket.on('org:joined', onJoined);
    socket.on('board:created', onCreated);
    socket.on('board:updated', onUpdated);
    socket.on('board:deleted', onDeleted);
    socket.on('error:unauthorized', onUnauthorized);

    return () => {
      socket.emit('org:leave', { orgId: activeOrgId });
      socket.off('connect', join);
      socket.off('org:joined', onJoined);
      socket.off('board:created', onCreated);
      socket.off('board:updated', onUpdated);
      socket.off('board:deleted', onDeleted);
      socket.off('error:unauthorized', onUnauthorized);
    };
  }, [socket, activeOrgId, loadBoards]);

  const handleCreate = useCallback(
    async (event) => {
      event.preventDefault();
      const trimmed = title.trim();
      if (!trimmed) return;

      setBusy(true);
      setError(null);
      try {
        const { board } = await api.createBoard(accessToken, activeOrgId, {
          title: trimmed,
          socketId: socket?.id,
        });
        // The originating client is excluded from the broadcast, so it
        // applies its own result here.
        setBoards((prev) =>
          prev.some((b) => b.id === board.id) ? prev : [board, ...prev]
        );
        setTitle('');
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [accessToken, activeOrgId, socket, title]
  );

  const handleRename = useCallback(
    async (board) => {
      const next = window.prompt('Rename board', board.title);
      if (next === null) return;
      if (!next.trim() || next.trim() === board.title) return;

      try {
        const { board: updated } = await api.renameBoard(
          accessToken,
          activeOrgId,
          board.id,
          { title: next.trim(), socketId: socket?.id }
        );
        setBoards((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      } catch (err) {
        setError(err.message);
      }
    },
    [accessToken, activeOrgId, socket]
  );

  const handleDelete = useCallback(
    async (board) => {
      if (!window.confirm(`Delete “${board.title}”?`)) return;

      try {
        await api.deleteBoard(accessToken, activeOrgId, board.id, {
          socketId: socket?.id,
        });
        setBoards((prev) => prev.filter((b) => b.id !== board.id));
      } catch (err) {
        setError(err.message);
      }
    },
    [accessToken, activeOrgId, socket]
  );

  if (orgsLoading) {
    return <div className="screen-centered muted">Loading workspace…</div>;
  }

  if (organizations.length === 0) {
    return <CreateOrg onSignOut={signOut} email={user?.email} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">Flowspace</div>

        <label className="org-picker">
          <span className="visually-hidden">Workspace</span>
          <select
            value={activeOrgId ?? ''}
            onChange={(e) => selectOrg(e.target.value)}
          >
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>

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

      <main className="app-main">
        <div className="section-heading">
          <h1>{activeOrg?.name}</h1>
          <p className="muted small">
            Open this page in a second window signed in as another member of
            this workspace — changes appear in both without a refresh.
          </p>
        </div>

        {canWrite && (
          <form className="new-board" onSubmit={handleCreate}>
            <input
              type="text"
              value={title}
              placeholder="New board title"
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button type="submit" disabled={busy || !title.trim()}>
              {busy ? 'Adding…' : 'Add board'}
            </button>
          </form>
        )}

        {!canWrite && (
          <p className="notice">
            You have <strong>{role}</strong> access to this workspace, which is
            read-only.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        {loading ? (
          <p className="muted">Loading boards…</p>
        ) : boards.length === 0 ? (
          <p className="muted">No boards yet.</p>
        ) : (
          <ul className="board-list">
            {boards.map((board) => (
              <li key={board.id} className="card board">
                <div>
                  <h2>{board.title}</h2>
                  <p className="muted small">
                    Updated {new Date(board.updated_at).toLocaleString()}
                  </p>
                </div>
                <div className="board-actions">
                  {canWrite && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => handleRename(board)}
                    >
                      Rename
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      className="ghost danger"
                      onClick={() => handleDelete(board)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <MembersPanel orgId={activeOrgId} role={role} socket={socket} />

        {lastEvent && (
          <p className="muted small event-log">last realtime event: {lastEvent}</p>
        )}
      </main>
    </div>
  );
}
