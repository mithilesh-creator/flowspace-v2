# Product roadmap — status

Phase order is from `CLAUDE.md`. Status here is what is actually true as
of **13 August 2026**, not what is planned. Where something is unverified,
it says so.

**Read the qualifier on every "verified" below.** Phases 1 and 2 are built,
tested and deployed, and the Phase 2 hardening pass has closed H1–H6 — but
the automated suites run against the **dev** database. Production has zero
rows by design, so the isolation properties those suites prove are proven
on dev and unexercised on prod. That distinction is the single most
important thing on this page, and closing H1–H6 does not change it.

**The Phase 4 blocker is closed.** Gap 1 — a removed member's socket
staying in the org room — was the item that had to be fixed before the
client portal. H4 closed it. The residual is narrower and still real: that
member's access token stays valid for up to an hour, though RLS refuses
them everything. What remains is token *validity*, not authority. That is
gap 3, and it is still open.

---

## Status at a glance

| # | Phase | Status |
|---|---|---|
| 1 | Multi-tenant workspaces + Supabase Auth/RLS | **Shipped** — built, suites green on dev, deployed |
| 2 | Real-time Kanban (lists, cards, Socket.io sync) | **Shipped and hardened** — H1–H6 complete, tested and deployed. H7 (CI) written but never run; H8 (deploy docs) being written; H10 (prod smoke test) not written |
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

**Shipped and hardened.**

**Built:** migrations `0009` (lists, cards, composite foreign keys, RLS,
`rebalance_list_positions`) and `0010` (list deletion narrowed to
`owner|admin`), then `0011`–`0013` for the hardening pass. Nine REST
endpoints under `/api/orgs/:orgId/boards/:boardId`. Eight socket events
(`list:*`, `card:*`), documented in `docs/socket-events.md`. Board-detail
UI with pointer **and keyboard** drag-and-drop, optimistic updates,
resyncing the whole board on `org:joined` and on reconnect.

**Verified on dev:** 59 backend checks — 9 realtime
(`realtime-isolation.test.mjs`), 12 invitation
(`invitations.test.mjs`), 18 Kanban (`kanban-isolation.test.mjs`), 20
hardening (`hardening.test.mjs`, `H1.x`–`H4.x`) — plus the SQL isolation
suite, `T01`–`T24`. All green against `flowspace-v2-dev`, run by
`cd backend && npm test` (the four Node suites; the SQL suite is separate
and `psql`-driven). The assertions worth naming:

- `K7` / `T20` — a card cannot be dragged into another tenant's list.
  Refused by the composite foreign key (`23503` → 400), not by a policy.
- `K8` — a card cannot be dragged onto another board of the **same**
  tenant. When that test was written the route's own check was the only
  thing enforcing it; migration `0012` (H2) makes it structural, and the
  route check stays, so the observable status is still 404.
- `H4.1`–`H4.7` — a removed member's socket goes silent across four
  subsequent writes while a control socket receives all of them, REST
  returns 404, and the evicted socket cannot re-join.

**Not verified on prod:** none of the above. See below.

**Note on the SQL suite.** It is still `T01`–`T24`; it was **not**
extended for H1–H3, though the hardening contract's §8.1/8.2/8.3 asked for
that. Those three are covered at the API level by `hardening.test.mjs`
instead. Recorded here rather than quietly dropped — see
`docs/integration-checklist.md` §8.

### One deliberate scope change, already made

Migration `0010` narrows list deletion to `owner|admin`, against the Phase 2
contract's blanket "writes are `owner|admin|member`". The reasoning is in
the migration header: deleting a list cascades every card in it, while
deleting the board that contains it already needs an admin. Cards stay
`owner|admin|member`. `T22` asserts the new shape. **This is a recorded
contract deviation, not a drift** — noted here so it is not rediscovered as
a bug.

### Phase 2 hardening pass (H1–H10) — H1–H6 done

Scope is frozen in `docs/phase-2-hardening-contract.md`. **H1–H6 are
complete, tested and deployed.** What remains is H7, H8 and H10, and none
of the three is blocked on code we control.

| | Item | Owner | State | Closes |
|---|---|---|---|---|
| H1 | Assignee must be a member of the card's org | Backend | **Done** — `0011`, composite FK `cards(org_id, assignee_id) → memberships(org_id, user_id)` | gap 7 |
| H2 | Cards carry `board_id`; FK widened to `(list_id, board_id, org_id)` | Backend | **Done** — `0012` | gap 8 |
| H3 | `rebalance_card_positions`, SECURITY INVOKER, anon revoked | Backend | **Done** — `0013` | gap 9 (half) |
| H4 | A removed member's socket is evicted from the org room | Backend | **Done** — `user:<uuid>` index room, `evictUserFromOrg()` | **gap 1** |
| H5 | Keyboard-accessible reordering | Frontend | **Done** — Space grabs, arrows move, Space/Enter drops, Escape cancels, `aria-live` announcements | gap 10 |
| H6 | Assignee picker offers only org members | Frontend | **Done** — a departed assignee is kept and labelled, not dropped | pairs with H1 |
| H7 | CI | DevOps | **Written, never run** — `.github/workflows/ci.yml` exists; repository secrets need a human | gap 11, still open |
| H8 | Deploy pipeline documented honestly | DevOps | **In progress** — `docs/deployment.md` being written now | gap 12, still open |
| H9 | Tests for H1–H4, failing before and passing after | QA | **Done at the API level** — `hardening.test.mjs`, 20 checks. The SQL suite was **not** extended | — |
| H10 | Read-only production smoke test | QA | **Not written** — `scripts/smoke-prod.mjs` is not in the repo | partially gap 6 |

Deployed state: migrations `0011`–`0013` applied to **both** dev and prod,
both at `0013`; backend live at commit `3731804`; frontend redeployed with
H5 and H6. Both surfaces verified serving.

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

The 64 backend checks and the SQL suite are built on `supabase/seed.sql` —
two fixed tenants, fixed uuids, six accounts including the dual-org
contractor. Prod has no seed and must never get one, so the suites
**cannot** run there.

That gap has since been closed a different way: **real users signed up.**
Prod now holds 3 confirmed accounts, 3 workspaces and 5 memberships, which
made a direct check possible. Verified on prod, as those actual accounts,
every block rolled back — **6/6**:

- Sign-up and email confirmation complete. That also settles **Site URL**,
  previously the highest-risk unverified setting: confirmation links could
  not resolve if it were wrong.
- Invitations are issued and redeemed — one workspace has an owner plus a
  `client`.
- Tenant isolation holds: cross-tenant reads, writes, roster access and
  profile visibility all refused; `anon` reads nothing.

**Still not proven on prod:** boards, lists, cards and realtime. Prod has
0 boards, so no socket has yet joined an org room with real data behind
it. Those rest on the dev suites alone.

### Environment

| Project | Ref | Contents |
|---|---|---|
| `flowspace-v2-dev` | `hjylkhswlwqiwvztynkw` | all migrations (`0001`–`0013`) + seed |
| `flowspace-v2-prod` | `ajkzoiqsvcibvcodkuzs` | all migrations (`0001`–`0013`), **no seed**, **3 real users / 3 workspaces / 0 boards** |

Never point a deployment at dev: its seed publishes six accounts sharing
`password123`. Two prod dashboard settings are still manual and neither has
an automated check — **Site URL** set to the Netlify origin (unconfirmed),
and **leaked-password protection**, which the Supabase linter confirms is
currently **DISABLED** on prod. The second is a known-bad state, not an
unknown one; it is a dashboard toggle and needs a human.

---

## Phase 3 — AI task automation

Not started. Auto-subtasks, priority suggestions, standup summaries, via
the Claude API. Spec to think against: `docs/phase-3-spec.md`.

Hard dependency on Phase 2, now satisfied: cards exist, and H1–H6 are
closed — the spec's precondition. Note for whoever starts it: H2 changed
the card shape. Cards carry a NOT NULL `board_id`, so bulk inserts of
AI-generated subtasks must supply it.

The new surfaces
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
org), and revocation that actually works.

**The blocker on this phase is closed.** Gap 1 — a removed member's socket
staying in the org room — was the item `docs/architecture.md` said had to
be fixed before the client portal, because revoking an outsider's access is
the entire feature. H4 closed it, and `H4.1`–`H4.7` prove it on dev. Gap 3
still lands here: a removed member's access token stays *valid* for up to
an hour, though RLS refuses them everything. That is the residual, and it
is narrower than the thing that blocked the phase.

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

**Closed by the hardening pass: 1, 7, 8, 10, and half of 9.** Closed items
are struck through and kept rather than deleted, so a later reader can see
what the shape of the system used to be. **Still open: 2, 3, 4, 5, 6, 11,
12, and the uniqueness half of 9.**

### 1. ~~A removed member keeps their socket in the org room~~ — CLOSED (H4)

**What it was:** removing a member deleted the membership, so RLS blocked
them over REST immediately, but their open socket stayed joined to
`org:<uuid>` and kept receiving that tenant's broadcasts until it
disconnected or switched org. Open since Phase 1; the deadline was Phase 4,
because revoking an external party's access is the entire point of the
client portal.

**Closed in the hardening pass as H4.** Every socket joins a `user:<uuid>`
index room at connection time — an index, never a broadcast target — so
`evictUserFromOrg()` can find one person's sockets and force them out of
`org:<uuid>` the moment their membership is deleted. Proven by
`hardening.test.mjs` `H4.1`–`H4.7` on dev: the removed socket is silent
across four subsequent writes while a control socket receives all of them,
REST returns 404, and the evicted socket cannot re-join. Recorded as CLOSED
in `docs/architecture.md`.

**The residual, stated plainly so "H4 shipped" is not misread as "removal
is instant everywhere":** the removed member still holds a **valid access
token for up to an hour** (gap 3). RLS refuses them everything, because the
membership row is gone. What remains is token *validity*, not authority.

**Caveat that applies to everything on this page:** proven on dev. Prod has
no members to remove.

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

**Phase 4 (recommended), hard requirement by Phase 5. Still open.**
Unchanged by the hardening pass, and now the whole of what is left of gap
1's story: H4 has shipped, so a removed member **is** evicted from the room,
but they still hold a token that PostgREST will accept for up to an hour.
RLS stops them reading anything, because the membership row is gone — the
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
and `T24` assert both. H3's `rebalance_card_positions` (`0013`) matches:
SECURITY INVOKER with the anon revoke, covered by `H3.1`–`H3.4`.

### 5. Realtime has no reconnect-storm handling

**What:** each `org:join` costs a membership round trip, and the client also
refetches on `org:joined`. *"Fine at Phase 1 scale; revisit if a mass
reconnect ever becomes a thundering herd."*

**No phase deadline — trigger is scale, not feature.** Phase 2 raised the
cost of each reconnect from "the board list" to "a whole board's lists and
cards". H2 makes each card write cheaper but does nothing for the refetch.

### 6. Production is deployed and partly exercised — **mostly closed**

**Closed by real usage.** Three people signed up, confirmed by email, and
created workspaces; invitations were issued and redeemed, including one
with the `client` role. Tenant isolation was then checked directly against
those accounts: **6/6**, every block rolled back, row counts unchanged.
`scripts/smoke-prod.mjs` now exists and passes 13/13 read-only checks.

**Site URL is settled** — confirmation links could not have resolved
otherwise. It was the highest-risk unverified setting; it is verified by
use rather than by inspection.

**What remains open:** prod has **0 boards**. Boards, lists, cards and
realtime have never run against production data, and rest on the dev
suites alone. Closing it needs someone to create a board, add a list and a
card, and open it in two browsers — a smaller ask than the original
first-sign-up test, and no longer blocking.

**Still no automated reach:** **leaked-password protection**, confirmed
**off** by the linter. A dashboard toggle.

### 7. ~~`assignee_id` accepted users outside the org~~ — CLOSED (H1, H6)

**What it was:** `cards.assignee_id` referenced `profiles(id)` — any
profile, including another tenant's. Not a leak (the assignee still could
not read the card) but an invariant the schema did not hold.

**Closed as H1**, structurally: `memberships` gained `unique (org_id,
user_id)` and `cards` a composite FK `(org_id, assignee_id)` → that key,
nullable and `ON DELETE SET NULL`, so removing a member unassigns rather
than blocks. H6 makes the UI offer only org members and keeps a departed
assignee visible with a label rather than silently blanking the card.
Covered by `H1.1`–`H1.5` on dev. The SQL suite was not extended for this.

### 8. ~~A card could be moved to another board of the same tenant~~ — CLOSED (H2)

**What it was:** `0009`'s composite key was blind to this — same `org_id`,
so `(list_id, org_id)` resolved — leaving the route's own 404 check as the
only enforcement. `K8` documents exactly that.

**Closed as H2** (`0012`): cards carry `board_id` and the key is widened to
`(list_id, board_id, org_id)`. A same-tenant wrong-board move is now
refused by the database, not just by the route. The route check stays, so
the observable status for a same-tenant cross-board move is still **404**
and a cross-tenant move is still **400** — two different refusals, both
correct, and the status surface did not change. Covered by `H2.1`–`H2.4`.

**Side effect worth knowing about downstream:** `cards` has a new NOT NULL
column. Anything that inserts cards in bulk — Phase 3's AI subtasks, in
particular — must supply `board_id`. See `docs/phase-3-spec.md`.

### 9. Cards have no position rebalance, and no position uniqueness

**Half closed.** `rebalance_card_positions(p_list uuid)` now exists
(`0013`), SECURITY INVOKER with the anon revoke, asserted by `H3.1`–`H3.4`.
That was H3 and it is done.

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

### 10. ~~Drag-and-drop was mouse-only~~ — CLOSED (H5)

**What it was:** no keyboard path to reorder — an accessibility failure and
a credibility problem for a sellable product.

**Closed as H5.** Space grabs, arrows move, Space or Enter drops, Escape
cancels, with `aria-live` announcements. Verified in a browser with real
key events, including that a move persists server-side and that Escape
restores the original position without committing. There is still no
automated coverage for this path — it is a manual gate
(`docs/integration-checklist.md` §8.5), so it can regress silently.

### 11. No CI — still open

**What:** nothing runs the suites automatically. Every green result in this
document was produced by a human running a command.

**H7 is written but has never run.** `.github/workflows/ci.yml` exists;
what it needs is repository secrets, which require a human with repo
settings access. Until a real push goes green — and, per §8.7, a real
failure goes red — this gap is open, and a workflow that has only ever been
unrun proves nothing. Standing limitation once it does run: CI runs the
suites against **dev**, the only database with fixtures, so CI green will
never mean "prod is correct".

### 12. Releases are manual — still open

**What:** two halves.

- **Netlify is not connected to the repo.** Builds are uploaded pre-built
  from `frontend/`, so Netlify's own build-time environment variables are
  never consulted, and the deployed bundle is whatever was on one machine
  at one moment.
- **Railway auto-deploy is DISABLED on the backend service.** A push to
  `main` builds nothing; every backend release needs a manual trigger. The
  GitHub webhook works — the service-level toggle is off.

**H8 documents the pipeline honestly and deliberately does not fix either
half** — connecting Netlify needs account access. `docs/deployment.md`
(DevOps) is the authority on the mechanics; this page only records that the
gap is open. Until it closes, "what is live" is not derivable from git.
That is a release-management gap rather than a security one, with one sharp
edge: **a migration cannot rely on a push shipping the matching code.**
Adding a NOT NULL column (`0012`) ahead of a deploy would have broken
inserts from the old code the moment it landed; prod had zero rows so
nothing broke. Expand/contract — add nullable, deploy code that writes it,
then enforce NOT NULL — is the rule, not a preference.

Recommended: close before Phase 5, where a billing change shipping from an
unknown working tree stops being tolerable.
