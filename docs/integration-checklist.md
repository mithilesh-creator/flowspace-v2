# Phase 2 integration checklist

The acceptance gate for "Phase 2 is done". Derived from the Definition of
done in `docs/phase-2-contract.md` and extended with the specific
scenarios, commands and manual checks that definition implies but does not
spell out.

**How to use this:** every box is either checked with evidence or it is not
checked. "Should be fine" is not evidence. Where a check has an expected
HTTP status, the status is part of the check — a 500 where a 403 was
expected is a failure even if nothing leaked.

Nothing here has been run. Every box below is unchecked as of 12 August
2026.

---

## 0. Prerequisites

- [ ] `flowspace-v2-dev` has migrations `0001`–`0010` applied and
      `supabase/seed.sql` loaded.
- [ ] Backend running locally on `:4000` (`curl http://localhost:4000/health`).
- [ ] Seed accounts usable. Password for all: `password123`.

| Email | Workspace(s) | Role |
|---|---|---|
| `owner@northwind.test` | Northwind (A) | owner |
| `admin@northwind.test` | Northwind (A) | admin |
| `member@northwind.test` | Northwind (A) | member |
| `client@northwind.test` | Northwind (A) | client |
| `owner@acme.test` | Acme (B) | owner |
| `dual@contractor.test` | **Northwind (A) and Acme (B)** | member in both |

Fixed ids used throughout:

```
ORG_A    aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa   Northwind
ORG_B    bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb   Acme
BOARD_A1 aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa   Northwind / Q3 Delivery
BOARD_A2 aaaa0002-aaaa-4aaa-8aaa-aaaaaaaaaaaa   Northwind / Website Rebuild
BOARD_B1 bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb   Acme / Fleet Rollout
```

`dual@contractor.test` is the important account. Everyone else can be
refused at the middleware before RLS is ever consulted; the contractor is
a legitimate member of both tenants, so their requests reach the database
and actually exercise the policies and the composite foreign keys.

---

## 1. Migrations

- [ ] `0009`/`0010` apply cleanly to a **fresh** database, in order, with
      no manual steps. Verify on a throwaway Supabase branch or a local
      `supabase db reset`, not on dev-with-history.
- [ ] `boards` has `unique (id, org_id)` — required before `lists` can
      reference `(board_id, org_id)`.
- [ ] `lists` has `unique (id, org_id)` — required before `cards` can
      reference `(list_id, org_id)`. *The contract's data-model table does
      not list this constraint; without it the `cards` composite FK cannot
      be created at all.*
- [ ] `lists` and `cards` both have `enable row level security` **and**
      `force row level security`.
- [ ] One policy per command (`select` / `insert` / `update` / `delete`),
      each scoped `to authenticated`. `anon` has no policies.
- [ ] `revoke all on public.lists from anon;` and the same for
      `public.cards`. `grant select, insert, update, delete … to authenticated`.
- [ ] `update` policies repeat the role check in **both** `using` and
      `with check`, so a row cannot be moved into another org — the same
      pattern as `boards_update_staff` in `0007_boards.sql`.
- [ ] `position` is `numeric`, not `float`.
- [ ] `unique (board_id, position)` on `lists` is **deferrable initially
      deferred**.
- [ ] Indexes present: `(board_id, position)` on `lists`,
      `(list_id, position)` on `cards`, `org_id` on both.
- [ ] `set_updated_at` trigger on both tables.
- [ ] `rebalance_list_positions(p_board uuid)` exists. **Decide and record
      whether it is SECURITY DEFINER.** If it is, it must carry an explicit
      `revoke execute on function … from anon;` — revoking from `public`
      does not remove Supabase's direct grant to `anon`. See migration
      `0008`.
- [ ] Supabase database linter run after the DDL, lints **0028/0029**
      clean. This is the check that caught the 0008 problem; it is not
      optional after a migration that adds functions.

```powershell
# Fresh-apply check, if the Supabase CLI is available
supabase db reset
```

---

## 2. Database isolation suite

`supabase/tests/rls.test.sql` currently holds 17 assertions across
T01–T16, all Phase 1. Phase 2 must add assertions for lists and cards.
This suite is the only place RLS is tested directly — the REST layer masks
policy failures behind a 404 (see §3), so REST tests alone do **not** prove
RLS.

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.test.sql
```

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.test.sql
```

Silence plus the final `NOTICE` means everything passed. Any `FAIL [Tnn]`
is a leak.

Without `psql`, run through the Supabase SQL editor or MCP connector using
the plpgsql-savepoint harness described in the file header.

New assertions required — each must exist and pass:

- [ ] Tenant A's owner sees zero of tenant B's `lists`.
- [ ] Tenant A's owner sees zero of tenant B's `cards`.
- [ ] Tenant A cannot `insert` a list with `org_id = ORG_B`.
- [ ] Tenant A cannot `insert` a card with `org_id = ORG_B`.
- [ ] Tenant A cannot `update` tenant B's list or card (zero rows affected,
      not an error — a silent no-op is the correct RLS outcome for `update`
      filtered by `using`).
- [ ] Tenant A cannot `delete` tenant B's list or card.
- [ ] **A list cannot be created pointing at a board in another tenant.**
      Insert `lists (org_id = ORG_A, board_id = BOARD_B1)` → foreign-key
      violation. This is the composite-FK test; it must fail at the
      constraint, not at a trigger or an application check.
- [ ] **A card cannot be moved into another tenant's list.** Update a
      tenant A card's `list_id` to a tenant B list → foreign-key violation.
      This one is explicitly named in the contract's Definition of done.
- [ ] A card cannot be created with `org_id` of one tenant and `list_id`
      belonging to another.
- [ ] `client@northwind.test` **can** select tenant A's lists and cards.
      (Read-only means read, not blind — the portal depends on it.)
- [ ] `client@northwind.test` **cannot** insert, update or delete a list
      or a card in their own org. Expect `42501`.
- [ ] `anon` can do nothing on either table — no select, no insert.
- [ ] The dual-org contractor sees tenant A's lists and cards when acting
      as A, tenant B's when acting as B, and never both in one result set.

---

## 3. REST API — cross-tenant scenarios

Run against a locally running backend. Every response below has a specific
expected status; record the actual one.

Two things to understand before reading the expectations:

- **Non-members get 404, not 403.** `requireOrgMember` returns
  "Organization not found" on purpose — telling an outsider the org exists
  is itself a small leak. So a tenant B user hitting a tenant A route is
  rejected at the middleware and never reaches RLS.
- **A cross-tenant parent is a foreign-key violation, which
  `fromPostgrestError` maps to 400**, not 403. 403 is what RLS refusal
  looks like (`42501`); 400 is what the composite FK looks like (`23503`).
  Both are correct. **500 is never correct.**

### 3a. Outsider — `owner@acme.test` against tenant A

- [ ] `GET /api/orgs/{ORG_A}/boards/{BOARD_A1}` → **404**
- [ ] `POST /api/orgs/{ORG_A}/boards/{BOARD_A1}/lists` → **404**
- [ ] `POST /api/orgs/{ORG_A}/boards/{BOARD_A1}/cards` → **404**
- [ ] `PATCH` and `DELETE` on any tenant A list or card id → **404**
- [ ] No response body anywhere in the above leaks a tenant A title,
      list id, card id, or table/constraint name.

### 3b. Dual-org contractor — `dual@contractor.test`

The account that actually reaches the database. This is the highest-value
block in this document.

- [ ] `GET /api/orgs/{ORG_A}/boards/{BOARD_A1}` → **200**, tenant A's data.
- [ ] `GET /api/orgs/{ORG_B}/boards/{BOARD_B1}` → **200**, tenant B's data.
- [ ] `GET /api/orgs/{ORG_B}/boards/{BOARD_A1}` → **404**. Authorised for
      org B, asking for a board in org A. Must not return board A.
- [ ] `POST /api/orgs/{ORG_B}/boards/{BOARD_A1}/lists` with a valid title →
      **400 or 404**, never 201. If it returns 201, a list has just been
      created in the wrong tenant — stop and treat as a leak.
- [ ] Create a list in A and a list in B. Then, as the contractor,
      `POST /api/orgs/{ORG_A}/boards/{BOARD_A1}/cards/{cardId}/move` with
      `listId` = **the tenant B list** → **400** (`23503`). Not 201, not
      500. *This is the single most important request in this checklist.*
- [ ] Same move, in the other direction (B card into an A list) → **400**.
- [ ] `PATCH` a tenant A card while authorised against `{ORG_B}` → **404**.
- [ ] After every one of the above, re-`GET` both boards and confirm no row
      moved, no row was created, and no row disappeared.

### 3c. Read-only client — `client@northwind.test`

- [ ] `GET /api/orgs/{ORG_A}/boards/{BOARD_A1}` → **200**, full nested
      board with lists and cards.
- [ ] `POST …/lists` → **403**
- [ ] `PATCH …/lists/{listId}` → **403**
- [ ] `DELETE …/lists/{listId}` → **403**
- [ ] `POST …/lists/{listId}/move` → **403**
- [ ] `POST …/cards` → **403**
- [ ] `PATCH …/cards/{cardId}` → **403**
- [ ] `DELETE …/cards/{cardId}` → **403**
- [ ] `POST …/cards/{cardId}/move` → **403**
- [ ] Repeat at least two of the above with `requireOrgRole` mentally
      removed — i.e. confirm the corresponding RLS assertions in §2 exist.
      The middleware is an early 403, not the boundary; if only the
      middleware refuses the client, the boundary is missing.

### 3d. Role boundaries within one tenant

- [ ] `member@northwind.test` can create, rename, move and delete lists and
      cards. (Per the contract, writes are `owner|admin|member` for **all**
      Phase 2 endpoints, including deletes.)
- [ ] **Confirm this is intended:** board deletion is `owner|admin` only
      (`boards_delete_admins`), but list deletion under this contract is
      open to `member` — and deleting a list cascades every card in it. If
      that asymmetry is deliberate, record the decision; if not, it is a
      contract change and must be raised, not patched in code.

### 3e. Input trust

- [ ] `org_id` in a request body is ignored. `POST …/lists` with
      `{"title":"x","org_id":"{ORG_B}"}` while authorised for A creates the
      list in **A**, or fails — it must never create it in B.
- [ ] `board_id` in a request body is ignored; it comes from the route.
- [ ] Empty / whitespace-only `title` → **400**, on both create and rename,
      for both lists and cards. (The DB check constraint is the backstop;
      the route should not be relying on it for a clean message.)
- [ ] A card `move` to a list in a **different board of the same tenant** is
      either rejected or handled deliberately. The contract says the server
      "validates the target list belongs to the same board" — confirm that
      validation exists and returns 400, because the composite FK will
      **not** catch it (same `org_id`, so the constraint is satisfied).

### 3f. Ordering and concurrency

- [ ] Fractional insert works: place a card between two neighbours and
      confirm the resulting order, then repeat 10 times in the same gap.
- [ ] Two clients computing the same list position simultaneously →
      **409** (`23505` via `fromPostgrestError`), not 500, and the losing
      client recovers rather than leaving a ghost card on screen. *The
      contract does not specify client behaviour on a 409; decide it and
      write it down.*
- [ ] `rebalance_list_positions(BOARD_A1)` rewrites positions to `1..n`,
      preserves the visible order, and does not trip the deferrable unique
      constraint mid-update.
- [ ] Callable by a member of that board's org; **not** callable by a
      member of another org; not callable by `anon`.

---

## 4. Realtime isolation suite

`backend/tests/realtime-isolation.test.mjs` currently holds 9 checks
(R1–R9), all board-level.

```powershell
cd backend; npm run test:realtime      # requires the backend running
cd backend; npm run test:invitations
cd backend; npm test                   # both backend suites
```

Note: `npm test` runs the realtime and invitation suites only — **it does
not run the SQL isolation suite**, which is `psql`-driven (§2). "npm test
green" is not the same as "the isolation suites pass". Both are required.

New checks required:

- [ ] Tenant A member creates a list → their teammate in room `org:A`
      receives `list:created` with `{orgId, boardId, list}`.
- [ ] Tenant B's socket receives **nothing** during the whole tenant A
      list/card sequence. Assert on silence over a quiet window, the way
      R6 does.
- [ ] `card:created`, `card:updated`, `card:deleted`, `card:moved`
      each broadcast to room `org:A` only. `card:moved` carries
      `fromListId`.
- [ ] `list:updated`, `list:deleted`, `list:moved` likewise.
- [ ] Echo suppression: the writing client passes `X-Socket-Id` and does
      **not** receive its own `card:*` or `list:*` event.
- [ ] Every payload carries both `orgId` and `boardId`. A client viewing
      board A2 receives an event for board A1 (same org, correct — rooms
      are per-org, not per-board) and ignores it on `boardId`.
- [ ] The suite writes immediately after connecting, so pin
      `transports: ['websocket']` as the existing suite does — otherwise
      the polling→WebSocket upgrade window makes these flake for reasons
      unrelated to isolation.

---

## 5. Documentation and build

- [ ] `docs/socket-events.md` updated **in the same change as the code**,
      per CLAUDE.md. All eight Phase 2 events moved out of "Not yet
      implemented" into the server→client table with payloads.
- [ ] `list:moved` added to `docs/socket-events.md`. It is in the contract
      but is **missing from the reserved-names list** in that file today.
- [ ] `presence:sync` stays reserved and unimplemented — it is in
      `socket-events.md` but not in the Phase 2 contract, so it is out of
      scope.
- [ ] `docs/architecture.md` updated with the Phase 2 tables in "Where the
      tenant boundary actually lives", and with the new assertion counts.
- [ ] Frontend production build green: `cd frontend; npm run build`.
- [ ] No new secrets in the repo; `.env.example` still accurate.

---

## 6. Manual browser checks

Nothing here can be automated today. Two browsers (or one plus a private
window) signed in as different users, both on the same board.

- [ ] **Two-user live sync.** `owner@northwind.test` and
      `member@northwind.test` on board A1. Create a list in one window; it
      appears in the other without a refresh. Same for renaming a list,
      creating a card, editing a card, deleting a card.
- [ ] **Drag across columns.** Drag a card between lists in window 1; the
      card moves in window 2, into the correct list, at the correct
      position — not appended to the end.
- [ ] **Drag within a column.** Reorder cards in one list; the order
      matches in both windows.
- [ ] **No self-echo flicker.** The dragging user's card does not jump,
      duplicate, or snap back and re-settle when the server response and
      their own optimistic update reconcile.
- [ ] **Reconnect self-heals.** With window 2 open, kill the backend, make
      three changes in window 1 (which will fail), restart the backend, and
      confirm window 2 resyncs the whole board on reconnect rather than
      staying stale. Then: with the backend up, disconnect window 2's
      network for ~10s while window 1 moves cards; on reconnect window 2
      must show the correct final state. *This is the mitigation for
      at-most-once broadcasts and it is the only defence there is.*
- [ ] **Org switch.** As `dual@contractor.test`, open board A1, switch to
      Acme in the dropdown. Tenant A's lists and cards must be gone from
      the screen immediately — not still visible under Acme's heading while
      the next fetch lands. Then switch back and confirm the board reloads.
- [ ] **In-flight event after a switch.** Have a tenant A user move a card
      at the moment the contractor switches to Acme. Nothing from tenant A
      may render. (Handlers must check `orgId` **and** `boardId`.)
- [ ] **Client portal view.** `client@northwind.test` opens board A1: sees
      all lists and cards, and has no add/edit/delete/drag affordance
      anywhere. Confirm drag is actually disabled, not merely unstyled —
      attempt a drag and confirm nothing moves and no request is sent.
- [ ] **Removed-member window (known gap, verify the blast radius).** With
      a member's board open, remove them from the org in another window.
      Confirm: their REST calls fail immediately, and note whether their
      open socket keeps receiving `card:*` events. It will — that is
      documented gap 1 in `docs/product-roadmap.md`. Record what is
      actually visible to them during the window, so the risk is measured
      rather than assumed.
- [ ] **Deep link / refresh.** Hard-refresh directly on a board URL. It
      loads (SPA redirect is in `netlify.toml`; locally Vite handles it).
      A board id from another tenant in the URL shows a clean not-found,
      not a crash and not another tenant's board.
- [ ] **Empty states.** A board with no lists; a list with no cards.
- [ ] **Long content.** A very long card title and a long description do
      not break the column layout.

---

## 7. Sign-off

Phase 2 is done when:

- [ ] Every box above is checked, with the actual result recorded where a
      status code was expected.
- [ ] Both isolation suites pass — the SQL one **and** the realtime one —
      with their new assertion counts written into `README.md`.
- [ ] `docs/case-studies/phase-2-kanban.md` has its DRAFT banner removed
      and its "How it will be proven" section rewritten to past tense with
      real numbers.
- [ ] `docs/product-roadmap.md` Phase 2 row updated.

**One caveat on the whole gate.** `CLAUDE.md` requires end-to-end
verification in a real deployed environment before any phase is marked
complete. Nothing is deployed yet, including Phase 1. Everything above can
pass locally and Phase 2 still will not satisfy that rule. Either deploy
first, or record an explicit decision to sign off Phase 2 locally and carry
the deployment gate forward — but do not let it pass silently.
