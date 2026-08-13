# Phase 2 hardening contract

**Authoritative. Five agents work in parallel against this file. If your
implementation disagrees with it, the contract wins — raise it, do not
unilaterally "improve" it.**

Phase 2 features are **already built, green and deployed**: lists, cards,
drag-and-drop, 39 backend checks, live on Netlify + Railway. Nothing here
rebuilds them. This is the hardening pass that makes Phase 2 production
quality.

Read first: `CLAUDE.md`, `docs/architecture.md` (the Known gaps section
is the source of items H1–H4), `docs/phase-2-contract.md`.

## Non-negotiables

1. **RLS is the only authorization layer.** Never re-implement permission
   checks in Express.
2. Every tenant-scoped table: RLS **ENABLE + FORCE**, one policy per
   command, `TO authenticated`.
3. **Every new SECURITY DEFINER function needs an explicit
   `revoke execute … from anon`.** Revoking from the `public`
   pseudo-role does NOT remove Supabase's default grant. This is why
   migration 0008 exists.
4. `client` role is read-only. Writes are `owner|admin|member`.
5. Run `get_advisors` (security) after any DDL and fix what it flags.

## Databases

- dev `hjylkhswlwqiwvztynkw` — seeded, use this for development
- prod `ajkzoiqsvcibvcodkuzs` — **no seed, zero rows, live traffic**

Apply migrations to dev first, verify, then prod. **Never seed prod.**

## File ownership — do not edit outside your lane

| Agent | Owns |
|---|---|
| Backend | `supabase/migrations/0011*`+, `backend/src/**`, `supabase/seed.sql`, `docs/socket-events.md` |
| Frontend | `frontend/src/**` |
| DevOps | `.github/**`, `backend/railway.json`, `frontend/netlify.toml`, `docs/deployment.md` |
| QA | `backend/tests/**`, `supabase/tests/**`, `scripts/**` |
| Product | `docs/**` except `socket-events.md` and `deployment.md`; `README.md` |

Nobody edits `CLAUDE.md`, `.env*`, or this file.

---

## The work

### H1 — `assignee_id` accepts users outside the org (Backend)

A card can be assigned to any profile, including someone in another
tenant. Not a data leak — they still cannot read the card — but an
unenforced invariant.

Fix structurally, the same way lists and cards already are: add
`unique (org_id, user_id)` to `memberships`, then a composite FK
`cards(org_id, assignee_id) → memberships(org_id, user_id)`. Nullable, so
an unassigned card is still valid, and `ON DELETE SET NULL` so removing a
member unassigns rather than blocks.

### H2 — cards carry no `board_id` (Backend)

Every card PATCH/DELETE/move pays an extra read to prove the card is on
the board named in the URL. Move is the hottest path in the app.

Denormalise `board_id` onto `cards` and extend the FK to
`(list_id, board_id, org_id) → lists(id, board_id, org_id)`, which needs
a matching unique constraint on `lists`. That makes the check structural
and free, and closes the one Phase 2 rule that currently has no database
backstop: a card moved into a list on a **different board of the same
tenant**.

### H3 — no rebalance for card positions (Backend)

`rebalance_list_positions` exists; cards have no equivalent, and cards are
where fractional drift actually accumulates. Add
`rebalance_card_positions(p_list uuid)`, SECURITY **INVOKER**, with the
anon revoke.

### H4 — a removed member's socket stays in the org room (Backend)

Removal deletes the membership so RLS blocks REST immediately, but their
open socket keeps receiving that tenant's broadcasts until it
disconnects. **This must be fixed before the client portal**, where
revoking an outsider's access is the entire feature.

Evict on removal: index sockets by user id, and on `member:removed` force
matching sockets out of `org:<uuid>`. Socket.io's `fetchSockets()` is
sufficient — do not add Redis.

### H5 — drag-and-drop is mouse-only (Frontend)

No keyboard path to reorder. That is an accessibility failure and a
credibility problem for a sellable product. Add keyboard-accessible
reordering (grab, move, drop, cancel) with focus management and an
`aria-live` announcement. Keep the existing pointer DnD working.

### H6 — assignee picker (Frontend)

With H1 enforcing membership, the UI must only offer org members. Fetch
from the existing members endpoint.

### H7 — CI (DevOps)

No CI exists. Add GitHub Actions running on PR and push to `main`:
frontend production build, and the backend suites against **dev**.
Secrets via repository secrets, never committed. The workflow must fail
loudly on a failing suite.

### H8 — deploy pipeline (DevOps)

Railway auto-deploys from `main` (watch `backend/**`). Netlify does not —
the frontend is currently uploaded pre-built by hand, so Netlify's own
env vars are never consulted. Document the current pipeline honestly in
`docs/deployment.md` and write down exactly what connecting Netlify to
the repo would require. **Do not connect it** — that needs account
access and the connector's write path is unreliable.

### H9 — test coverage for H1–H4 (QA)

Each fix needs a test that **fails before it and passes after**. The most
important is H4: prove a removed member's socket stops receiving
broadcasts. Also extend the SQL suite for H1 and H2, including the
same-tenant wrong-board move that H2 makes structural.

### H10 — production smoke test (QA)

`scripts/smoke-prod.mjs`: read-only checks against the live URLs —
health, 401 on protected routes, CORS allow/deny, SPA deep links, and the
prod auth error path. **It must not create accounts or write any data.**
Prod has zero rows and must stay that way until a real user signs up.

### H11 — docs (Product)

Update `docs/product-roadmap.md`, `docs/integration-checklist.md` and the
case studies to reflect deployed reality. Draft `docs/phase-3-spec.md`
for AI task automation (Claude API) so Phase 3 can start clean. Be
accurate about what is verified in prod versus dev.

---

## Definition of done

- Migrations apply cleanly to dev **and** prod; advisors clean.
- Every existing check still passes: `cd backend && npm test` (39) plus
  the SQL suite.
- New tests for H1–H4 pass, and demonstrably failed before the fix.
- Frontend production build green; keyboard reordering works.
- CI runs green on a real push.
- Prod still has zero rows.
