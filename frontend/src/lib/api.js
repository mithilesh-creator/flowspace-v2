const BASE_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(
  /\/+$/,
  ''
);

export class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Thin fetch wrapper.
 *
 * `socketId` is passed along so the backend can skip echoing a change
 * back to the client that made it — that client already applied it
 * optimistically, and re-applying the echo makes inputs flicker.
 */
export async function apiFetch(path, { token, socketId, ...init } = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('Accept', 'application/json');

  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (socketId) headers.set('X-Socket-Id', socketId);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, 'Cannot reach the API. Is the backend running?');
  }

  if (response.status === 204) return null;

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.message ?? `Request failed (${response.status})`,
      payload?.error?.code ?? null
    );
  }

  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  listOrgs: (token) => apiFetch('/api/orgs', { token }),

  createOrg: (token, { name, slug }) =>
    apiFetch('/api/orgs', {
      token,
      method: 'POST',
      body: JSON.stringify({ name, slug }),
    }),

  listBoards: (token, orgId) => apiFetch(`/api/orgs/${orgId}/boards`, { token }),

  createBoard: (token, orgId, { title, socketId }) =>
    apiFetch(`/api/orgs/${orgId}/boards`, {
      token,
      socketId,
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  renameBoard: (token, orgId, boardId, { title, socketId }) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}`, {
      token,
      socketId,
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  deleteBoard: (token, orgId, boardId, { socketId } = {}) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}`, {
      token,
      socketId,
      method: 'DELETE',
    }),

  // ------------------------------------------------------------------
  // Lists & cards. Everything hangs off the board, and both `orgId` and
  // `boardId` travel in the path — the server takes them from the
  // authorised route params and never from a body, so sending them twice
  // would just create a second, untrusted copy.
  // ------------------------------------------------------------------

  /** Board with its lists and cards nested and ordered by position. */
  getBoard: (token, orgId, boardId) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}`, { token }),

  createList: (token, orgId, boardId, { title, socketId }) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}/lists`, {
      token,
      socketId,
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  renameList: (token, orgId, boardId, listId, { title, socketId }) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}/lists/${listId}`, {
      token,
      socketId,
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  deleteList: (token, orgId, boardId, listId, { socketId } = {}) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}/lists/${listId}`, {
      token,
      socketId,
      method: 'DELETE',
    }),

  // `position` is computed client-side (see lib/board.js). The server
  // stores it as given rather than recomputing the ordering.
  moveList: (token, orgId, boardId, listId, { position, socketId }) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}/lists/${listId}/move`, {
      token,
      socketId,
      method: 'POST',
      body: JSON.stringify({ position }),
    }),

  createCard: (token, orgId, boardId, { listId, title, description, socketId }) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}/cards`, {
      token,
      socketId,
      method: 'POST',
      body: JSON.stringify({ listId, title, description }),
    }),

  updateCard: (token, orgId, boardId, cardId, { socketId, ...fields }) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}/cards/${cardId}`, {
      token,
      socketId,
      method: 'PATCH',
      body: JSON.stringify(fields),
    }),

  deleteCard: (token, orgId, boardId, cardId, { socketId } = {}) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}/cards/${cardId}`, {
      token,
      socketId,
      method: 'DELETE',
    }),

  moveCard: (token, orgId, boardId, cardId, { listId, position, socketId }) =>
    apiFetch(`/api/orgs/${orgId}/boards/${boardId}/cards/${cardId}/move`, {
      token,
      socketId,
      method: 'POST',
      body: JSON.stringify({ listId, position }),
    }),

  listMembers: (token, orgId) => apiFetch(`/api/orgs/${orgId}/members`, { token }),

  listInvitations: (token, orgId) =>
    apiFetch(`/api/orgs/${orgId}/invitations`, { token }),

  createInvitation: (token, orgId, { email, role }) =>
    apiFetch(`/api/orgs/${orgId}/invitations`, {
      token,
      method: 'POST',
      body: JSON.stringify({ email, role }),
    }),

  revokeInvitation: (token, orgId, invitationId) =>
    apiFetch(`/api/orgs/${orgId}/invitations/${invitationId}`, {
      token,
      method: 'DELETE',
    }),

  acceptInvitation: (token, inviteToken) =>
    apiFetch('/api/invitations/accept', {
      token,
      method: 'POST',
      body: JSON.stringify({ token: inviteToken }),
    }),
};
