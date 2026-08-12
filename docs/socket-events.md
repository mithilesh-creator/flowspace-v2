# Socket.io event contract

Per CLAUDE.md, this file is the contract — not the code. Add the event
here in the same change that adds it to `backend/src/realtime/`.

Implementation: [`backend/src/realtime/index.js`](../backend/src/realtime/index.js).

---

## Connection

The handshake is authenticated. A socket that cannot present a valid
Supabase access token is **refused**, not connected-with-limits.

```js
io(API_URL, {
  // A callback, not an object: Socket.io re-invokes it on every
  // reconnect, so a reconnection after a token rotation handshakes with
  // the current token.
  auth: (cb) => cb({ access_token: session.access_token }),
});
```

On failure the client receives `connect_error` with message
`unauthorized`.

### Rooms are the tenant boundary

A socket receives tenant traffic only for org rooms it has been admitted
to via `org:join`, and admission is decided by a database membership
check — never by the client's claim. Room name is always `org:<uuid>`,
derived server-side from the id the server itself authorised.

This is the realtime equivalent of an RLS policy. A broadcast reaching a
room the user was never admitted to is a cross-tenant leak even though
the database was never queried incorrectly.

---

## Client → server

| Event | Payload | Ack | Notes |
|---|---|---|---|
| `org:join` | `{ orgId: uuid }` | `{ ok, orgId, role }` / `{ ok: false, error }` | Membership re-checked against `current_org_role()`. On refusal also emits `error:unauthorized`. |
| `org:leave` | `{ orgId: uuid }` | `{ ok: true }` | No membership check needed — leaving is always allowed. |
| `session:refresh` | `{ accessToken: string }` | `{ ok }` / `{ ok: false, error }` | Replaces the socket's token in place. Must be the **same user**; a mismatch disconnects the socket. |
| `board:ping` | `{ orgId: uuid }` | — | Smoke test. Silently ignored unless the socket has actually joined that room. |

### Why `session:refresh` exists

Supabase access tokens expire (default: 1 hour). A socket can stay open
much longer. Without this, the connection keeps working off a token that
is no longer valid and the next membership re-check fails for no visible
reason. The client pushes the rotated token over the existing connection
rather than reconnecting, so the user does not drop out of their room.

---

## Server → client

| Event | Payload | Sent to |
|---|---|---|
| `connection:ready` | `{ userId }` | The connecting socket, immediately after a successful handshake. |
| `org:joined` | `{ orgId, role }` | The joining socket. |
| `board:created` | `{ orgId, board }` | Everyone in `org:<orgId>`. |
| `board:updated` | `{ orgId, board }` | Everyone in `org:<orgId>`. |
| `board:deleted` | `{ orgId, boardId }` | Everyone in `org:<orgId>`. |
| `board:pong` | `{ orgId, userId, at }` | Everyone in `org:<orgId>`. |
| `error:unauthorized` | `{ event, orgId, message }` | The offending socket. |

Every tenant-scoped payload carries `orgId`. Clients should still check it
before applying the event: during an org switch, an in-flight event from
the previous room can arrive after the UI has moved on.

### Echo suppression

`board:*` events originate from REST handlers, not from socket messages.
The writing client sends its socket id as the `X-Socket-Id` header and the
server excludes that socket from the broadcast, so a client never receives
the echo of a change it already applied locally.

---

## Not yet implemented

Reserved names, so Phase 2 does not collide with anything above:
`list:created` · `list:updated` · `list:deleted` · `card:created` ·
`card:updated` · `card:moved` · `card:deleted` · `presence:sync`
