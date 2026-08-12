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
| `list:created` | `{ orgId, boardId, list }` | Everyone in `org:<orgId>`. |
| `list:updated` | `{ orgId, boardId, list }` | Everyone in `org:<orgId>`. |
| `list:moved` | `{ orgId, boardId, list }` | Everyone in `org:<orgId>`. |
| `list:deleted` | `{ orgId, boardId, listId }` | Everyone in `org:<orgId>`. |
| `card:created` | `{ orgId, boardId, card }` | Everyone in `org:<orgId>`. |
| `card:updated` | `{ orgId, boardId, card }` | Everyone in `org:<orgId>`. |
| `card:moved` | `{ orgId, boardId, card, fromListId }` | Everyone in `org:<orgId>`. |
| `card:deleted` | `{ orgId, boardId, cardId }` | Everyone in `org:<orgId>`. |
| `member:joined` | `{ orgId, membership, profile }` | Everyone in `org:<orgId>`, when an invitation is redeemed. |
| `member:removed` | `{ orgId, membershipId, userId }` | Everyone in `org:<orgId>`, when a member is removed or leaves. |
| `error:unauthorized` | `{ event, orgId, message }` | The offending socket. |

`member:joined` is emitted from `POST /api/invitations/accept` *after* the
membership is committed, and inside a try/catch: a realtime failure must
never roll back a join that already succeeded. The new member is not yet
in the room when it fires — it exists to update the people list for those
already there.

`member:removed` has a known limitation: the removed user's own socket is
still in the org room and will keep receiving that tenant's broadcasts
until they disconnect or switch orgs. RLS already stops them reading
anything over REST, so this leaks only events emitted in the window
between removal and disconnect — but it is a real gap. The fix is for
the server to force that socket out of the room on removal, which needs
a socket-id-by-user index. Deliberately deferred; see
docs/architecture.md.

Every tenant-scoped payload carries `orgId`. Clients should still check it
before applying the event: during an org switch, an in-flight event from
the previous room can arrive after the UI has moved on.

### Why `list:*` and `card:*` also carry `boardId`

The room is the tenant, not the board. Everyone in `org:<uuid>` receives
every card move in the tenant, including moves on boards they are not
looking at. `boardId` is what lets a client drop those in one comparison
instead of searching its state for a list id it has never seen.

Widening the room to `org:<uuid>:board:<uuid>` would be the other answer,
and it is the wrong one for now: a socket would have to re-join on every
board switch, and the membership re-check that guards `org:join` would
have to be repeated per board. The filter is cheap; the extra boundary is
not.

### `card:moved` carries `fromListId`

The card in the payload already says where it landed. `fromListId` says
where it left, because a client holding the board as lists-of-cards has to
remove it from the old column and cannot know which one that was without
scanning every list. It is the previous value, read before the update.

### Deleting a list does not emit `card:deleted` per card

`list:deleted` means "this column and everything in it is gone" — the
cards go with it in the database, by `ON DELETE CASCADE`. Emitting n+1
events for one click is how a busy board floods its own socket.

### Echo suppression

`board:*`, `list:*` and `card:*` events all originate from REST handlers,
not from socket messages. The writing client sends its socket id as the
`X-Socket-Id` header and the server excludes that socket from the
broadcast, so a client never receives the echo of a change it already
applied locally.

This matters more in Phase 2 than it did in Phase 1. A drag produces an
optimistic local move followed by a server round trip; without
suppression, the authoritative row arrives back as an event and the card
visibly re-seats itself mid-animation.

### Resync, not replay

Broadcasts are at-most-once — Socket.io does not replay what was missed
during the polling→WebSocket upgrade or a brief disconnect. Card moves are
far more frequent than board creates, so a client that treats this stream
as complete will drift. Refetch `GET /api/orgs/:orgId/boards/:boardId` on
`org:joined` and on reconnect; the endpoint returns the whole board
nested and ordered for exactly this reason. See docs/architecture.md.

---

## Not yet implemented

Reserved name, so a later phase does not collide with anything above:
`presence:sync`
