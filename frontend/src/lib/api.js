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
