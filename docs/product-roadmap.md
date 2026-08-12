# Product roadmap — status

Phase order is from `CLAUDE.md`. Status here is what is actually true as
of **12 August 2026**, not what is planned. Where something is unverified,
it says so.

---

## Status at a glance

| # | Phase | Status |
|---|---|---|
| 1 | Multi-tenant workspaces + Supabase Auth/RLS | Feature-complete, verified locally, **not deployed** |
| 2 | Real-time Kanban (lists, cards, Socket.io sync) | **In progress** — no code on disk yet |
| 3 | AI task automation | Not started |
| 4 | Client-facing portal mode | Not started |
| 5 | Billing (Stripe) + onboarding + tenant admin panel | Not started |

---

## Phase 1 — Multi-tenant foundation

**Done:** organizations, memberships, four roles (`owner`/`admin`/`member`/
`client`), Supabase Auth, RLS on all five tenant-scoped tables (ENABLE +
FORCE), invitations with hashed single-use tokens, boards, authenticated
Socket.io with per-org rooms, React frontend covering sign-up, sign-in, org
switching, boards, members panel and invitation acceptance.

**Verified:** 38 automated checks pass against a live hosted Supabase
project — 17 database isolation assertions (`supabase/tests/rls.test.sql`,
T01–T16), 12 invitation-flow checks (`backend/tests/invitations.test.mjs`,
I1–I12), 9 realtime isolation checks
(`backend/tests/realtime-isolation.test.mjs`, R1–R9). Frontend production
build succeeds. Manual browser confirmation covered sign-up, sign-in, org
switching, live board updates across two clients, read-only `client`
access, and the signed-out-invitee invitation path.

**Remaining:** deployment. Backend → Railway, frontend → Netlify, plus a
fresh production Supabase project. Config exists (`backend/railway.json`,
`frontend/netlify.toml`); accounts and credentials do not. Runbook is in
`README.md`.

**Open flag:** `CLAUDE.md` says *"Verify end-to-end in a real deployed
environment before marking any phase complete — local-only 'done' doesn't
count."* By that rule Phase 1 is not complete, and Phase 2 is being built
on top of it anyway. This is a deliberate decision or an oversight — it
needs to be one of those explicitly, not left ambiguous.

### Environment

| Project | Ref | Contents |
|---|---|---|
| `flowspace-v2-dev` | `hjylkhswlwqiwvztynkw` | migrations 0001–0008 + seed |
| `flowspace-v2-prod` | `ajkzoiqsvcibvcodkuzs` | migrations 0001–0008, no seed, zero rows |

Prod still needs, by hand in the dashboard: **Site URL** set to the Netlify
origin, and **leaked-password protection** enabled.

---

## Phase 2 — Real-time Kanban (in progress)

Scope is frozen in `docs/phase-2-contract.md`. Two engineers are building
against it in parallel.

**Done:** nothing yet. At the time of writing there is no `0009`/`0010`
migration, no `backend/src/routes/lists.js` or `cards.js`, no board-detail
route in the frontend, and `docs/socket-events.md` still lists the Phase 2
events under "Not yet implemented".

**Remaining:**

- Migrations `0009`/`0010`: `lists` and `cards` tables, composite foreign
  keys enforcing same-tenant parentage, RLS policies, and
  `rebalance_list_positions()`.
- Nine REST endpoints under `/api/orgs/:orgId/boards/:boardId`.
- Eight socket events (`list:*`, `card:*`).
- Board-detail UI with drag-and-drop and optimistic updates.
- Extending `supabase/tests/rls.test.sql` and
  `backend/tests/realtime-isolation.test.mjs` to cover lists and cards.
- `docs/socket-events.md` updated in the same change as the code.

Acceptance criteria: `docs/integration-checklist.md`.

---

## Phase 3 — AI task automation

Not started. Auto-subtasks, priority suggestions, standup summaries, via
the Claude API.

Hard dependency on Phase 2: there is nothing for it to read until cards
exist. Also the first phase where the backend calls an outbound paid API,
which introduces a cost surface and a secret (`ANTHROPIC_API_KEY`) that
does not exist in the repo today.

---

## Phase 4 — Client-facing portal mode

Not started. A limited external view built on the existing read-only
`client` role.

The role and its policies already exist from Phase 1 — `client` can read
boards and cannot write them, enforced in the database. What Phase 4 adds
is the external-facing surface, scoping (which boards a client sees, not
just which org), and revocation that actually works. See the gaps below:
two of the three land here.

---

## Phase 5 — Billing + onboarding + tenant admin panel

Not started. Stripe subscriptions, a self-serve onboarding flow, and a
per-tenant admin panel.

First consumer of `adminClient()` / `SUPABASE_SERVICE_ROLE_KEY`, which is
deliberately unused and unset today. Stripe webhooks arrive with no user
session, so they are the one legitimate reason to bypass RLS — and
therefore the one path where a mistake removes tenant isolation entirely.

---

## Known gaps and the phase they must close by

These are the gaps already documented in `docs/architecture.md`. Nothing
below is speculative; each is quoted from an existing doc or verified in
code. Deadlines marked *(recommended)* are my proposal, not something the
architecture doc already commits to.

### 1. A removed member keeps their socket in the org room

**What:** removing a member deletes the membership, so RLS blocks them over
REST immediately — but their open socket stays joined to `org:<uuid>` and
keeps receiving that tenant's broadcasts until it disconnects or switches
org. Fixing it needs a user-id → socket-id index so the server can evict
the socket.

**Must be fixed by: Phase 4.** `docs/architecture.md` already commits to
this: *"Fix this before the client portal ships, where revoking an external
party's access is the entire point."* Revoking a client's access is the
portal's core promise; a revocation that leaves a live feed open is a
broken promise, not a rough edge.

**Phase 2 makes the window more expensive, not longer.** Today the leak
carries board creates and renames. After Phase 2 it carries every card
move, title and description on every board in the tenant. Same duration,
much more data. That does not move the deadline, but it does mean the gap
should be re-costed at Phase 2 sign-off rather than assumed unchanged.

### 2. Broadcasts are at-most-once

**What:** Socket.io does not replay missed events. Two windows drop them
silently — the polling→WebSocket upgrade just after connecting, and any
brief disconnect. A dropped event is invisible: the UI just goes quietly
stale.

**Mitigation is required in Phase 2, and is already in the contract.** The
client must resync the whole board on `org:joined` and on reconnect rather
than trusting the stream. That is the same self-healing pattern
`frontend/src/routes/Boards.jsx` already uses for the board list.

**A real delivery guarantee: Phase 4 (recommended).** Resync-on-join is
adequate while every participant is an employee on a stable connection.
External client-portal users on worse networks reconnect more, and each
reconnect currently costs a full board refetch — which is also gap 5 below.
At that point the fix is a sequence number or a periodic resync, per
`docs/architecture.md`: *"not a bigger buffer."*

### 3. Token revocation is not immediate

**What:** token verification is cached until shortly before the token's own
expiry (default 1 hour), so sign-out is not enforced server-side straight
away. This is the same behaviour PostgREST has with the same JWT. The fix
is a revocation list, not a shorter cache.

**Must be fixed by: Phase 4 (recommended), hard requirement by Phase 5.**
Phase 4 because "remove this client's access" is the portal's headline
control and it currently means "within the hour"; combined with gap 1, a
removed external party keeps both a valid token and a live socket. Phase 5
because a cancelled or downgraded subscription that keeps working for an
hour is a billing correctness problem, not just a security one.

### 4. New SECURITY DEFINER functions are easy to leave open to `anon`

**What:** `revoke execute … from public` does not remove the direct grant
Supabase issues to `anon`. Migration 0008 exists because eight functions
were left reachable without a session. Nothing leaked — each guards on
`auth.uid()` — but the surface should not have existed.

**Not a phase deadline; a standing process rule.** Every migration that
adds a SECURITY DEFINER function needs an explicit `revoke execute … from
anon`, and the Supabase database linter (lints 0028/0029) must be run after
every DDL change. This applies to Phase 2's
`rebalance_list_positions()` immediately if it is defined SECURITY DEFINER
— the contract does not say which it is, and that needs answering.

### 5. Realtime has no reconnect-storm handling

**What:** each `org:join` costs a membership round trip, and the client
also refetches on `org:joined`. `docs/architecture.md`: *"Fine at Phase 1
scale; revisit if a mass reconnect ever becomes a thundering herd."*

**No phase deadline — trigger is scale, not feature.** Worth restating that
Phase 2 raises the cost of each reconnect: the refetch goes from "the board
list" to "a whole board's lists and cards". Still not urgent at current
scale, but the constant got bigger.
