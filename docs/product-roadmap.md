# Product roadmap — status

Phase order is from `CLAUDE.md`. Status here is what is actually true as
of **13 August 2026**, not what is planned. Where something is unverified,
it says so.

**Read the qualifier on every "verified" below.** Phases 1 and 2 are built,
tested and deployed, but the automated suites run against the **dev**
database. Production has zero rows by design, so the isolation properties
those suites prove are proven on dev and unexercised on prod. That
distinction is the single most important thing on this page.

---

## Status at a glance

| # | Phase | Status |
|---|---|---|
| 1 | Multi-tenant workspaces + Supabase Auth/RLS | **Shipped** — built, suites green on dev, deployed |
| 2 | Real-time Kanban (lists, cards, Socket.io sync) | **Shipped** — built, suites green on dev, deployed. Hardening pass H1–H10 **in progress** |
| 3 | AI task automation | Not started. Spec drafted: `docs/phase-3-spec.md` |
| 4 | Client-facing portal mode | Not started |
| 5 | Billing (Stripe) + onboarding + tenant admin panel | Not started |

Live surfaces:

| | |
|---|---|
| Frontend | `flowspace-v2.netlify.app` |
| Backend | `backend-production-8d147.up.railway.app` |
| Database | Supabase `flowspace-v2-prod` (`ajkzoiqsvcibvcodkuzs`) |

---

## Phase 1 — Multi-tenant foundation

**Shipped.**

**Built:** organizations, memberships, four roles (`owner`/`admin`/`member`/
`client`), Supabase Auth, RLS on all tenant-scoped tables (ENABLE + FORCE),
invitations with hashed single-use tokens, boards, authenticated Socket.io
with per-org rooms, React frontend covering sign-up, sign-in, org switching,
boards, members panel and invitation acceptance.

**Verified on dev:** the SQL isolation suite (`supabase/tests/rls.test.sql`)
and the two Node suites (`backend/tests/invitations.test.mjs`,
`backend/tests/realtime-isolation.test.mjs`) pass against
`flowspace-v2-dev`. Manual browser confirmation covered sign-up, sign-in,
org switching, live board updates across two clients, read-only `client`
access, and the signed-out-invitee invitation path.

**Verified on prod:** deployment and the auth error path only — see
"What production has and has not proven" below.

**Resolved:** the "Phase 1 is not deployed" flag that this document carried
until 12 August is closed. Both phases are deployed. What replaces it is a
narrower and still-open question, recorded as gap 6.

---

## Phase 2 — Real-time Kanban

**Shipped, with a hardening pass in flight.**

**Built:** migrations `0009` (lists, cards, composite foreign keys, RLS,
`rebalance_list_positions`) and `0010` (list deletion narrowed to
`owner|admin`). Nine REST endpoints under
`/api/orgs/:orgId/boards/:boardId`. Eight socket events (`list:*`,
`card:*`), documented in `docs/socket-events.md`. Board-detail UI with
drag-and-drop and optimistic updates, resyncing the whole board on
`org:joined` and on reconnect.

**Verified on dev:** 39 backend checks — 9 realtime
(`realtime-isolation.test.mjs`), 12 invitation
(`invitations.test.mjs`), 18 Kanban (`kanban-isolation.test.mjs`) — plus
the SQL isolation suite, now `T01`–`T24`. All green against
`flowspace-v2-dev`. The two assertions worth naming:

- `K7` / `T20` — a card cannot be dragged into another tenant's list.
  Refused by the composite foreign key (`23503` → 400), not by a policy.
- `K8` — a card cannot be dragged onto another board of the **same**
  tenant. At the time that test was written the route's own check was the
  only thing enforcing it; migration `0012` (H2) makes it structural.

**Not verified on prod:** none of the above. See below.

### One deliberate scope change, already made

Migration `0010` narrows list deletion to `owner|admin`, against the Phase 2
contract's blanket "writes are `owner|admin|member`". The reasoning is in
the migration header: deleting a list cascades every card in it, while
deleting the board that contains it already needs an admin. Cards stay
`owner|admin|member`. `T22` asserts the new shape. **This is a recorded
contract deviation, not a drift** — noted here so it is not rediscovered as
a bug.

### Phase 2 hardening pass (H1–H10) — in progress

Scope is frozen in `docs/phase-2-hardening-contract.md`. Five agents are
working against it in parallel as this is written. **None of it is done.**
Status below is what was on disk when this page was last edited and will be
stale quickly — the contract, not this table, is authoritative.

| | Item | Owner | Closes |
|---|---|---|---|
| H1 | `assignee_id` accepts users outside the org | Backend | gap 7 |
| H2 | Cards carry no `board_id`; cross-board move has no DB backstop | Backend | gap 8 |
| H3 | No `rebalance_card_positions` | Backend | gap 9 |
| H4 | A removed member's socket stays in the org room | Backend | **gap 1** |
| H5 | Drag-and-drop is mouse-only | Frontend | gap 10 |
| H6 | Assignee picker must offer only org members | Frontend | pairs with H1 |
| H7 | No CI | DevOps | gap 11 |
| H8 | Deploy pipeline documented honestly; Netlify not git-connected | DevOps | gap 12 |
| H9 | Tests for H1–H4, each failing before and passing after | QA | — |
| H10 | Read-only production smoke test, `scripts/smoke-prod.mjs` | QA | partially gap 6 |

Acceptance criteria for the pass: `docs/integration-checklist.md` §8.

---

## What production has and has not proven

**Proven on `flowspace-v2-prod`:**

- The stack is reachable and wired to itself: `/health` ok, `/api/orgs`
  without a token 401, CORS echoes only the Netlify origin, every SPA deep
  link resolves, security headers applied, and the live bundle carries the
  prod Supabase ref and the Railway API URL with no dev reference.
- The auth path end to end. A non-existent account returns a clean
  `400 invalid_credentials` and the deployed UI renders that message —
  which exercises Netlify bundle → prod Supabase → rendered error.
- `disable_signup: false`, `mailer_autoconfirm: false`: sign-up is open and
  email confirmation is required.

**Not proven on `flowspace-v2-prod`, and why:**

The 39 backend checks and the SQL suite are built on `supabase/seed.sql` —
two fixed tenants, fixed uuids, six accounts including the dual-org
contractor. Prod deliberately has no seed and must keep zero rows. The
suites therefore **cannot** run there; pointing them at prod would mean
seeding it, which the hardening contract forbids. Consequently, on prod:

- Sign-up has never completed. No account exists.
- Tenant isolation has never been exercised — there is only one possible
  number of tenants in an empty database, and it is zero.
- No invitation has been issued or redeemed.
- No socket has joined an org room, because no org exists.
- Email confirmation delivery is untested, which makes **Site URL** the
  highest-risk unverified setting in the system: if it does not point at
  the Netlify origin, every confirmation link goes to the wrong host and
  no new user can finish signing up.

**The first real sign-up is the outstanding test.** H10 adds a read-only
smoke test that raises the floor but cannot close this: by design it
creates nothing.

### Environment

| Project | Ref | Contents |
|---|---|---|
| `flowspace-v2-dev` | `hjylkhswlwqiwvztynkw` | all migrations + seed |
| `flowspace-v2-prod` | `ajkzoiqsvcibvcodkuzs` | all migrations, **no seed, zero rows** |

Never point a deployment at dev: its seed publishes six accounts sharing
`password123`. Two prod dashboard settings are still manual — **Site URL**
set to the Netlify origin, and **leaked-password protection** enabled.
Confirm both; neither has an automated check.

---

## Phase 3 — AI task automation

Not started. Auto-subtasks, priority suggestions, standup summaries, via
the Claude API. Spec to think against: `docs/phase-3-spec.md`.

Hard dependency on Phase 2, now satisfied: cards exist. The new surfaces
Phase 3 introduces, none of which exist in the repo today, are an outbound
paid API call, a secret (`ANTHROPIC_API_KEY`) that must never reach the
browser, per-tenant cost exposure, and a class of latency the current UI
has no pattern for.

---

## Phase 4 — Client-facing portal mode

Not started. A limited external view built on the existing read-only
`client` role.

The role and its policies exist and are asserted at both levels — `T08` for
boards, `T21` for lists and cards. What Phase 4 adds is the external-facing
surface, per-board scoping (which boards a client sees, not just which
org), and revocation that actually works. Gaps 1 and 3 both land here; H4
is closing the first of them early.

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

Gaps 1–5 are from `docs/architecture.md`. Gaps 6–12 are the ones the
deployment and the hardening pass surfaced. Deadlines marked *(recommended)*
are a proposal, not something an existing doc already commits to.

### 1. A removed member keeps their socket in the org room

**What:** removing a member deletes the membership, so RLS blocks them over
REST immediately — but their open socket stays joined to `org:<uuid>` and
keeps receiving that tenant's broadcasts until it disconnects or switches
org. Fixing it needs a user-id → socket-id index so the server can evict
the socket.

**Deadline was Phase 4** — `docs/architecture.md`: *"Fix this before the
client portal ships, where revoking an external party's access is the
entire point."* **Now being closed early, in this hardening pass, as H4.**
The deadline does not move; the expected close date does. Until H9's
eviction test passes, treat this gap as open — the fix landing is not the
same as the fix being proven.

**Phase 2 made the window more expensive, not longer.** The leak now
carries every card move, title and description on every board in the
tenant, not just board creates. Same duration, much more data.

### 2. Broadcasts are at-most-once

**What:** Socket.io does not replay missed events. Two windows drop them
silently — the polling→WebSocket upgrade just after connecting, and any
brief disconnect. A dropped event is invisible: the UI just goes quietly
stale.

**Mitigated in Phase 2, as the contract required.** The client resyncs the
whole board on `org:joined` and on reconnect rather than trusting the
stream.

**A real delivery guarantee: Phase 4 (recommended).** Resync-on-join is
adequate while every participant is an employee on a stable connection.
External portal users reconnect more, and each reconnect costs a full board
refetch — which is also gap 5. The fix then is a sequence number or a
periodic resync, per `docs/architecture.md`: *"not a bigger buffer."*
Nothing in H1–H10 touches this.

### 3. Token revocation is not immediate

**What:** token verification is cached until shortly before the token's own
expiry (default 1 hour), so sign-out is not enforced server-side straight
away. Same behaviour PostgREST has with the same JWT. The fix is a
revocation list, not a shorter cache.

**Phase 4 (recommended), hard requirement by Phase 5.** Unchanged by the
hardening pass, and worth restating precisely because H4 closes the socket
half of the same story: after H4, a removed member is evicted from the room
but still holds a token that PostgREST will accept for up to an hour. RLS
stops them reading anything, because the membership row is gone — so the
residual exposure is the token's validity, not its authority. Do not let
"H4 shipped" be read as "revocation is instant".

### 4. New SECURITY DEFINER functions are easy to leave open to `anon`

**What:** `revoke execute … from public` does not remove the direct grant
Supabase issues to `anon`. Migration `0008` exists because eight functions
were left reachable without a session.

**Not a phase deadline; a standing process rule.** Every migration adding a
function needs an explicit `revoke execute … from anon`, and the Supabase
linter (lints 0028/0029) must be run after every DDL change.

**Question closed:** this page previously asked whether
`rebalance_list_positions()` was SECURITY DEFINER. It is **SECURITY
INVOKER** (`0009`), deliberately, with the anon revoke present, and `T23`
and `T24` assert both. H3's `rebalance_card_positions` must match — the
hardening contract says so explicitly.

### 5. Realtime has no reconnect-storm handling

**What:** each `org:join` costs a membership round trip, and the client also
refetches on `org:joined`. *"Fine at Phase 1 scale; revisit if a mass
reconnect ever becomes a thundering herd."*

**No phase deadline — trigger is scale, not feature.** Phase 2 raised the
cost of each reconnect from "the board list" to "a whole board's lists and
cards". H2 makes each card write cheaper but does nothing for the refetch.

### 6. Production is deployed but unexercised

**What:** zero rows, no seed, no account. Every isolation property is proven
on dev only. Sign-up, invitations, email confirmation and realtime have
never run against prod.

**Closes with the first real sign-up, which must be treated as a test, not
as an event.** Someone should perform it deliberately: sign up, confirm the
email actually arrives and its link resolves to the Netlify origin, create
a workspace, invite a second address, redeem it, open a board in two
browsers, and record the result. H10's smoke test covers the read-only half
and must not be mistaken for this.

### 7. `assignee_id` accepted users outside the org

**What:** `cards.assignee_id` referenced `profiles(id)` — any profile,
including another tenant's. Not a leak (the assignee still cannot read the
card) but an invariant the schema did not hold.

**Closing now as H1**, structurally, via a composite FK to `memberships`.
H6 makes the UI offer only members. Until H9 covers it, open.

### 8. A card could be moved to another board of the same tenant

**What:** `0009`'s composite key was blind to this — same `org_id`, so
`(list_id, org_id)` resolved — leaving the route's own 404 check as the only
enforcement. `K8` documents exactly that.

**Closing now as H2**, by widening the key to
`(list_id, board_id, org_id)`. Note for QA: the route check stays, so the
observable status for a same-tenant cross-board move remains **404**, while
a cross-tenant move remains **400**. Two different refusals, both correct.

### 9. Cards have no position rebalance, and no position uniqueness

**What:** `rebalance_list_positions` exists; cards have no equivalent, and
cards are where fractional drift actually accumulates. H3 adds it.

**Second, separate issue, not covered by H3 and not in the contract:**
`lists` has `unique (board_id, position)` (deferrable); `cards` has **no**
unique constraint on `(list_id, position)`. Two clients dropping cards into
the same gap simultaneously therefore do not collide — both writes succeed
and the resulting order is decided by an arbitrary tie-break. There is no
409 to recover from because there is no conflict to detect. This may be the
right trade for a hot path, but it is currently undocumented and it means
the concurrency expectation in the integration checklist applies to lists
only. **Needs a decision, not a patch.** Recommended: decide by Phase 3,
since AI-generated subtasks will insert cards in bulk.

### 10. Drag-and-drop was mouse-only

**What:** no keyboard path to reorder — an accessibility failure and a
credibility problem for a sellable product.

**Closing now as H5.** Open until keyboard grab/move/drop/cancel, focus
management and the `aria-live` announcement are confirmed by hand; there is
no automated coverage for this and none planned in H9.

### 11. No CI

**What:** nothing runs the suites automatically. Every green result in this
document was produced by a human running a command.

**Closing now as H7.** Note the standing limitation: CI will run the suites
against **dev**, because that is the only database with fixtures. CI green
will never mean "prod is correct".

### 12. The frontend is deployed by hand

**What:** Netlify is not connected to the repo. Builds are uploaded
pre-built from `frontend/`, so Netlify's own build-time environment
variables are never consulted, and the deployed bundle is whatever was on
one machine at one moment.

**H8 documents this honestly and deliberately does not fix it** —
connecting the repo needs account access. Until then, "what is live" is not
derivable from git, which is a release-management gap rather than a
security one. Recommended: close before Phase 5, where a billing change
shipping from an unknown working tree stops being tolerable.
