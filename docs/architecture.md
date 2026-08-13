# Architecture — Phase 1

## The one idea

**RLS is the only authorisation layer.** Everything else is ergonomics.

The Express API does not re-implement "can this user see this row". It
forwards the caller's Supabase access token to Postgres and lets the
policies in `supabase/migrations/0005_rls_policies.sql` decide. Where the
API does check a role — `requireOrgRole()` — that is to return a clean 403
early, not to enforce anything. Delete that middleware and the database
still refuses the write; the user just gets an uglier error.

This matters because the usual multi-tenant failure is two copies of the
rule that drift: a policy says one thing, a hand-written `WHERE org_id =`
in a service layer says another, and the gap between them is the leak.
There is one copy here.

## Request path

```
Browser
  │  supabase-js signs in → access token (JWT) in localStorage
  │
  ├─ REST ─────────────────────────────────────────────────────┐
  │  Authorization: Bearer <token>                             │
  │  X-Org-Id / :orgId, X-Socket-Id                            │
  │                                                            ▼
  │                                            Express (backend/src)
  │                                              requireAuth
  │                                                → verifyAccessToken (cached)
  │                                                → req.supabase = userClient(token)
  │                                              requireOrgMember
  │                                                → rpc current_org_role()
  │                                              route handler
  │                                                → PostgREST as the user
  │                                                → RLS applies ◄── the boundary
  │                                              emitToOrg(...)
  │                                                            │
  └─ WebSocket ────────────────────────────────────────────────┤
     auth: { access_token }                                    │
       → io.use() verifies, refuses unauthenticated sockets    │
       → org:join re-checks membership, then socket.join()     │
       ◄──────────── broadcast to room org:<uuid> ◄────────────┘
```

## Trust boundaries

| Input | Trusted? | Why |
|---|---|---|
| Access token in `Authorization` | After verification | Checked against Supabase Auth, result cached until just before expiry. |
| `:orgId` in the URL | No | Every request re-resolves membership via `current_org_role()`. |
| `orgId` in a socket payload | No | Re-checked before `socket.join()`. Trusting it would let any authenticated user subscribe to any tenant by guessing a uuid. |
| `org_id` in a request body | Never read | Boards take `org_id` from the authorised route param only. |
| `activeOrgId` in localStorage | No | A hint. Reconciled against the org list the server returned. |
| `X-Socket-Id` | Harmless if forged | Only decides whether the sender gets its own echo. Worst case: a client suppresses an event for itself. |

## Key choices, and what they cost

**SECURITY DEFINER helpers.** A policy on `memberships` that queries
`memberships` recurses. The helpers run as the function owner, which holds
BYPASSRLS, so the lookup inside is not re-filtered. Cost: these four
functions are genuinely privileged code and need reviewing as such.

**Org creation via RPC, not INSERT.** Creating a tenant writes two rows —
the org and the creator's owner membership — and the membership policy
requires you to already be an owner. `create_organization()` does both in
one transaction. There is no INSERT policy on `organizations` at all, so
an org can never exist with nobody able to see it.

**Token verification is cached.** Verifying against Supabase Auth is a
network round trip; doing it per request would make auth the slowest part
of every call. Cost: a token stays valid in the cache until shortly before
its own expiry, so sign-out is not instantly enforced server-side. Same
behaviour PostgREST has with the same JWT. If instant revocation is needed
later, the fix is a revocation list, not a shorter cache.

**Service role is quarantined.** `adminClient()` throws if the key is
absent and is used nowhere in Phase 1. It exists for Stripe webhooks and
scheduled jobs — work with no user session behind it. Using it to serve a
user request silently removes tenant isolation from that path.

## Where the tenant boundary actually lives

Three places, and they must agree:

1. `supabase/migrations/0005_rls_policies.sql`, `0007_boards.sql` and
   `0009_lists_and_cards.sql` — the real one.
2. `backend/src/realtime/rooms.js` + `emitter.js` — realtime, which the
   database cannot police.
3. `backend/src/middleware/tenant.js` — early rejection only.

There is now a fourth mechanism that is stronger than any of them:
**composite foreign keys**. `lists(board_id, org_id) → boards(id, org_id)`
and `cards(list_id, board_id, org_id) → lists(...)` mean a cross-tenant
list or card is not forbidden, it is *unrepresentable*. Since 0011,
`cards(org_id, assignee_id) → memberships(org_id, user_id)` does the same
for assignment. Prefer this shape over a policy whenever the invariant can
be expressed as a key — a policy can be forgotten on a new table, a
foreign key cannot.

All of it has automated coverage against two live tenants:

- `supabase/tests/rls.test.sql` — database level, T01 onward.
- `backend/tests/realtime-isolation.test.mjs` — 9 assertions, three
  concurrent socket clients.
- `backend/tests/kanban-isolation.test.mjs` — 18 assertions across lists
  and cards.
- `backend/tests/hardening.test.mjs` — 20 assertions covering assignment,
  cross-board moves, rebalancing and socket eviction.

`cd backend && npm test` runs all four (59 checks). Run them, plus the SQL
suite, before merging anything that touches policies, rooms, or the
emitter.

## Known gaps

**Function grants are easy to get wrong.** Migration 0008 exists because
`revoke execute … from public` does not revoke the direct grant Supabase
issues to `anon`. Any new SECURITY DEFINER function needs an explicit
`revoke … from anon`, and the Supabase database linter (`get_advisors`,
lints 0028/0029) is what catches it. Check it after every DDL change.

**Token revocation is not immediate.** See the token cache note above.

**Realtime has no reconnect-storm handling.** Each `org:join` costs one
membership round trip, and the client now also refetches the board list
on `org:joined`. Fine at Phase 1 scale; revisit if a mass reconnect ever
becomes a thundering herd.

**~~A removed member keeps their socket in the room.~~ CLOSED (H4).**
Every socket now joins a `user:<uuid>` index room at connection time —
an index, never a broadcast target — so `evictUserFromOrg()` can find a
specific person's sockets and force them out of `org:<uuid>` the moment
their membership is deleted. Verified by `hardening.test.mjs` H4.1–H4.7:
the removed socket goes silent across four subsequent writes while a
control socket receives all of them, REST returns 404, and the evicted
socket cannot re-join.

One residue worth naming, because "H4 shipped" will otherwise read as
"revocation is instant": the removed member still holds a valid access
token for up to an hour (see the token cache above). RLS refuses them
everything, since the membership row is gone — what remains is token
*validity*, not authority.

`fetchSockets()` over the user room is deliberately the cheap
implementation. It assumes one Node process, which is the deployed shape
today, and it is the single call that must change if that stops being
true.

**Broadcasts are at-most-once.** Socket.io does not replay missed
events, and there are two windows where one is silently lost: the
polling→WebSocket upgrade just after connecting, and any brief
disconnect. The client compensates by refetching on `org:joined` rather
than trusting the stream to be complete — worth remembering in Phase 2,
where card moves will be far more frequent than board creates. Anything
that must not be missed needs a sequence number or a periodic resync,
not a bigger buffer.
