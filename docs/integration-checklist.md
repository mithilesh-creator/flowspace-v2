# Phase 2 integration checklist

The acceptance gate for "Phase 2 is done" (§1–§7), extended with the
acceptance gate for the Phase 2 **hardening pass** H1–H10 (§8). Derived
from the Definition of done in `docs/phase-2-contract.md` and
`docs/phase-2-hardening-contract.md`, plus the specific scenarios, commands
and manual checks those definitions imply but do not spell out.

**How to use this:** every box is either checked with evidence or it is not
checked. "Should be fine" is not evidence. Where a check has an expected
HTTP status, the status is part of the check — a 500 where a 403 was
expected is a failure even if nothing leaked.

**State as of 13 August 2026.** Phase 2 shipped: §1–§6 were worked through
against `flowspace-v2-dev` and the suites are green there, which is why the
boxes below are left as a re-runnable gate rather than a to-do list. Run
them again after any change to policies, routes, rooms or the emitter.
**In §8, H1–H6 are met and checked with evidence; H7, H8 and H10 are not**
— see §8.11.

**Everything here runs against dev.** Prod has zero rows and no seed, so
none of it can run there. There are no production checks in this document
that have actually run: §8.10's script does not exist yet. Do not read a
green run of this document as a statement about production.

**A green build is not evidence a page renders.** During H6, `CardEditor`
called an undefined `memberOptionLabel`. `npm run build` passed — a
`ReferenceError` is a runtime fault, not a compile error — and opening any
card blanked the entire application. Nothing in this document below the
manual sections would have caught it. Where a box says *in a browser*, that
is why.

---

## 0. Prerequisites

- [ ] `flowspace-v2-dev` has every migration in `supabase/migrations/`
      applied — `0001`–`0010` for §1–§7, `0011`+ for §8 — and
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
- [ ] `rebalance_list_positions(p_board uuid)` exists. **Decided and
      recorded: SECURITY INVOKER**, the default — it has no policy-recursion
      problem, so it runs as the caller and the `lists` UPDATE policy
      decides what it may touch. A DEFINER version would reorder any
      tenant's board for anyone who can guess a uuid. The explicit
      `revoke execute … from anon` is present anyway, because revoking from
      `public` does not remove Supabase's direct grant to `anon`. See
      migration `0008`; asserted by `T23`/`T24`.
- [ ] Supabase database linter run after the DDL, lints **0028/0029**
      clean. This is the check that caught the 0008 problem; it is not
      optional after a migration that adds functions.

```powershell
# Fresh-apply check, if the Supabase CLI is available
supabase db reset
```

---

## 2. Database isolation suite

`supabase/tests/rls.test.sql` now runs `T01`–`T24`: `T01`–`T16` Phase 1,
`T17`–`T24` lists and cards. This suite is the only place RLS is tested
directly — the REST layer masks policy failures behind a 404 (see §3), so
REST tests alone do **not** prove RLS. The list below is the Phase 2
requirement it was written against; keep it as the re-run gate.

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

- [ ] `member@northwind.test` can create, rename and move lists, and can
      create, rename, move and delete cards.
- [ ] `member@northwind.test` **cannot delete a list** → **403**.
      **Resolved, and this is a deliberate deviation from the Phase 2
      contract's blanket "writes are `owner|admin|member`".** Migration
      `0010` narrows list deletion to `owner|admin`, because deleting a list
      cascades every card in it while deleting the board that contains it
      already needs an admin. Cards stay `owner|admin|member`. Asserted by
      `T22`. Recorded in `docs/product-roadmap.md`; do not "fix" it back.

### 3e. Input trust

- [ ] `org_id` in a request body is ignored. `POST …/lists` with
      `{"title":"x","org_id":"{ORG_B}"}` while authorised for A creates the
      list in **A**, or fails — it must never create it in B.
- [ ] `board_id` in a request body is ignored; it comes from the route.
- [ ] Empty / whitespace-only `title` → **400**, on both create and rename,
      for both lists and cards. (The DB check constraint is the backstop;
      the route should not be relying on it for a clean message.)
- [ ] A card `move` to a list in a **different board of the same tenant** →
      **404** `"List not found on this board"`, not 400. The route decides
      this one; `0009`'s composite FK is blind to it (same `org_id`, so the
      constraint is satisfied). Asserted by `K8`. **Note the two refusals
      are different on purpose and both are correct: 404 = same tenant,
      wrong board (route); 400 = wrong tenant (`23503`, composite FK).**
      **H2 (`0012`) has since added the database backstop** — the widened
      key `(list_id, board_id, org_id)` refuses this move at the database
      too, and `H2.2` proves it. The route check stays, so the observed
      status is still 404. If it ever becomes 400, that is a regression in
      the error surface even though nothing leaked.

### 3f. Ordering and concurrency

- [ ] Fractional insert works: place a card between two neighbours and
      confirm the resulting order, then repeat 10 times in the same gap.
- [ ] Two clients computing the same **list** position simultaneously →
      **409** (`23505` via `fromPostgrestError`), not 500, and the losing
      client recovers rather than leaving a ghost list on screen. *Client
      behaviour on a 409 is still unspecified; decide it and write it down.*
- [ ] **Cards behave differently and this is not a bug to patch here.**
      `lists` has `unique (board_id, position)`; `cards` has **no** unique
      constraint on `(list_id, position)`. Two clients dropping cards into
      the same gap both succeed, and the resulting order is an arbitrary
      tie-break — there is no 409 because there is no collision. Confirm
      that is what actually happens, then confirm the UI does not present a
      stable order it cannot deliver. Recorded as gap 9 in
      `docs/product-roadmap.md`; it needs a decision, not a hotfix.
- [ ] `rebalance_list_positions(BOARD_A1)` rewrites positions to `1..n`,
      preserves the visible order, and does not trip the deferrable unique
      constraint mid-update.
- [ ] Callable by a member of that board's org; **not** callable by a
      member of another org; not callable by `anon`. (`T23`, `T24`.)

---

## 4. Realtime isolation suite

Four Node suites, 59 checks total: `realtime-isolation.test.mjs` (9,
`R1`–`R9`, board-level), `invitations.test.mjs` (12, `I1`–`I12`),
`kanban-isolation.test.mjs` (18, `K1`–`K16` plus sub-checks) for lists and
cards, and `hardening.test.mjs` (20, `H1.x`–`H4.x`) for the hardening pass.

```powershell
cd backend; npm run test:realtime      # requires the backend running
cd backend; npm run test:invitations
cd backend; npm run test:kanban
cd backend; npm run test:hardening
cd backend; npm test                   # all four
```

Note: `npm test` runs the four Node suites only — **it does not run the
SQL isolation suite**, which is `psql`-driven (§2). "npm test green" is not
the same as "the isolation suites pass". Both are required. H7 would put
the Node suites in CI; the SQL suite stays manual.

Checks the Kanban suite must keep covering:

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
- [x] `docs/architecture.md` updated with the Phase 2 tables in "Where the
      tenant boundary actually lives", and with the new assertion counts.
      **Done after the hardening pass:** it now names `0009`'s and `0011`'s
      composite keys as the strongest boundary, cites 59 backend checks
      across four suites, and marks gap 1 (H4) CLOSED with the token
      residual spelled out. Its heading still says "Phase 1".
- [ ] Frontend production build green: `cd frontend; npm run build`.
- [ ] **And the built app opened in a browser**, with a card editor
      actually opened. The build is a compile check; it cannot see a
      `ReferenceError`. This box exists because a green build shipped a
      blank app once — see the note at the top of this file.
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
- [ ] **Removed-member window (gap 1 — CLOSED by H4).** With a member's
      board open, remove them from the org in another window. Their REST
      calls must fail immediately **and their open socket must receive
      nothing** — before H4 it kept receiving `card:*` events until the tab
      closed. Automated version: §8.4, `H4.5`. Keep this as a re-runnable
      manual gate. Note what it does *not* prove: their access token stays
      valid for up to an hour, so signing them out is not what happened —
      RLS refusing them is.
- [ ] **Deep link / refresh.** Hard-refresh directly on a board URL. It
      loads (SPA redirect is in `netlify.toml`; locally Vite handles it).
      A board id from another tenant in the URL shows a clean not-found,
      not a crash and not another tenant's board.
- [ ] **Empty states.** A board with no lists; a list with no cards.
- [ ] **Long content.** A very long card title and a long description do
      not break the column layout.

---

## 7. Phase 2 sign-off — done

Recorded as met on 13 August 2026:

- [x] §1–§6 worked through against `flowspace-v2-dev`.
- [x] Both isolation suites pass on dev — the SQL one (`T01`–`T24`) **and**
      the Node ones (39 checks: 9 realtime, 12 invitation, 18 Kanban —
      the count at Phase 2 sign-off; the hardening pass has since taken it
      to 59, see §4).
- [x] `docs/socket-events.md` carries all eight Phase 2 events.
- [x] `docs/case-studies/phase-2-kanban.md` DRAFT banner removed.
- [x] `docs/product-roadmap.md` Phase 2 row updated.
- [x] Deployed: Netlify + Railway + `flowspace-v2-prod`.

**The caveat that survives sign-off.** `CLAUDE.md` requires end-to-end
verification in a real deployed environment. The stack *is* deployed and
the auth path is verified there, but the suites above ran against **dev**,
because they need the two-tenant seed and prod has none. So Phase 2 is
signed off on: green suites on dev, plus a verified deployment, plus the
prod auth path. It is **not** signed off on tenant isolation observed in
production, and that cannot happen until real rows exist. Gap 6 in
`docs/product-roadmap.md` carries it forward. Do not let a later reader
collapse "deployed" into "verified in production".

---

## 8. Phase 2 hardening pass — H1–H10

The acceptance gate for `docs/phase-2-hardening-contract.md`. All of it
runs against `flowspace-v2-dev` except §8.10.

**Where this stands.** H1–H6 are complete, tested and deployed; their boxes
are checked below with the evidence that checked them. H7 is written but
has never run, H8 is being written, H10 is not written. Migrations
`0011`–`0013` are applied to dev **and** prod, both at `0013`.

**The caveat that applies to every checked box in this section:** the
evidence is a green run against `flowspace-v2-dev`. Prod has zero rows and
cannot run any of it. Nothing here is a statement about production.

The contract's own rule for H9 governs this whole section: each fix needs a
test that **fails before it and passes after**. A test written after the
fix, which passes first time, has proved that the code does what it does —
not that it does what was missing. Where a box says *record both runs*, a
single green run is not evidence.

### 8.1 H1 — assignee must be a member of the card's org — **met**

Migration `0011`. Evidence: `hardening.test.mjs` `H1.1`–`H1.5`, green on
dev.

- [x] `memberships` has a referenceable `unique (org_id, user_id)` (it
      already did, from `0003`), and `cards` has a composite FK
      `(org_id, assignee_id)` → that key.
- [x] Assigning a card to a profile **in another tenant** → **400**
      (`23503`). `H1.2`, using `owner@acme.test` — a real profile in
      another tenant, not a fabricated uuid.
- [x] Assigning to a member of the same org → **200**. `H1.1`. Without
      this one, "assignment is refused" could just mean assignment is
      broken.
- [x] `assigneeId: null` still clears the assignee → **200**. `H1.5`.
- [x] The refused write left nothing half-applied. `H1.4`.
- [x] The database refuses the same write with Express out of the path.
      `H1.3` goes straight at PostgREST — this is what proves the
      constraint is structural rather than a route check.
- [x] Removing a member **unassigns** their cards rather than failing. The
      key is declared `on delete set null (assignee_id)` with the column
      list, so `org_id` is not nulled. *Verified by reading `0011`, not by
      a test — the runtime path (delete a membership that has cards
      assigned, confirm the delete succeeds and the cards survive) has no
      automated coverage. Worth adding.*
- [ ] The dual-org contractor can be assigned a card in **both** tenants.
      **Not covered.** No assertion exercises this, and it is the account
      most likely to expose a wrong constraint.
- [ ] SQL suite extended with the cross-tenant assignee case. **Not done** —
      the suite is still `T01`–`T24`. `H1.3` covers the same ground through
      PostgREST rather than `psql`, which is close but is not the SQL
      suite.
- [ ] Supabase linter clean after the DDL. **Not recorded.** Run it and
      write down the result.

### 8.2 H2 — cards carry `board_id` — **met**

Migration `0012`. Evidence: `hardening.test.mjs` `H2.1`–`H2.4`, green on
dev, and `0012` applied over dev's seeded rows before prod.

- [x] Migration is ordered add-nullable → backfill → NOT NULL → key, and
      applied over **existing rows** on dev, which has cards in it. Prod
      had zero rows, so prod's apply proves nothing about the backfill;
      dev's does.
- [x] `lists` has the unique constraint the widened key targets
      (`lists_id_board_id_org_id_key`), and `cards` references
      `(list_id, board_id, org_id)`.
- [x] Same-tenant cross-board move still returns **404** from the route.
      `H2.1`. The new key is the backstop, not the message — the error
      surface did not change.
- [x] The same move straight at PostgREST, with Express out of the path, is
      refused by the **database** → `23503`. `H2.2`. This is the assertion
      that proves H2 did anything; without it the test only re-proves `K8`.
- [x] The card really is where it started after the refusal. `H2.3`.
- [x] Cross-tenant move still **400**. `H2.4`, and `K7`/`T20` unchanged.
- [ ] `board_id` in a request body is still ignored — the column is
      denormalised, not client-supplied. **Not covered by an assertion.**
      §3e's equivalent for `org_id` is; this one is not.
- [ ] Card PATCH/DELETE/move no longer read `lists` to resolve the board.
      **Not confirmed.** The extra read was the stated motivation for H2;
      nothing here checks it is actually gone.
- [ ] SQL suite extended for the same-tenant wrong-board move. **Not done** —
      still `T01`–`T24`. `H2.2` covers it through PostgREST.

### 8.3 H3 — `rebalance_card_positions(p_list uuid)` — **met**

Migration `0013`. Evidence: `hardening.test.mjs` `H3.1`–`H3.4`, green on
dev.

- [x] Exists, **SECURITY INVOKER**, with an explicit
      `revoke execute … from anon`. `H3.4` asserts `anon` cannot execute
      it — the migration `0008` rule, tested rather than assumed.
- [x] Rewrites positions and leaves whole numbers behind. `H3.1`, `H3.2`.
- [x] Pointed at another tenant's list it does nothing. `H3.3` — that is
      what SECURITY INVOKER buys, and it is the assertion that would fail
      if someone "fixed" it to DEFINER.
- [ ] The `created_at` tie-break for cards that share a position — the
      state gap 9 says cards can actually reach — is **not** separately
      asserted.
- [ ] SQL suite extended, mirroring `T23`/`T24`. **Not done.**
- [ ] Supabase linter clean. **Not recorded.**

### 8.4 H4 — a removed member's socket is evicted — **met** *(the one that mattered)*

The highest-value check in this document. Gap 1 was open since Phase 1 and
was the blocker on the client portal. **It is closed.** Every socket joins
a `user:<uuid>` index room at connection time — an index, never a broadcast
target — and `evictUserFromOrg()` forces matching sockets out of
`org:<uuid>` when the membership is deleted.

Evidence: `hardening.test.mjs` `H4.1`–`H4.7`, green on dev.

- [x] **The proof, automated.** `H4.5`: after the removal, the removed
      member's socket receives nothing across four subsequent writes,
      asserted as silence over a quiet window rather than on a single tick.
- [x] **The baseline that makes it mean something.** `H4.2` shows the same
      socket receiving the tenant's broadcasts *before* the removal, and
      `H4.4` shows a control socket in the same room receiving all four
      writes *after* it. A silent socket in a dead room would otherwise
      pass `H4.5` for the wrong reason.
- [x] `H4.1` both sockets admitted; `H4.3` the removal itself succeeds;
      `H4.6` REST is closed to the removed member at the same instant —
      included so a failure of `H4.5` cannot be read as "the removal never
      happened".
- [x] The evicted user cannot simply re-`org:join`. `H4.7` — confirmed, not
      assumed.
- [x] No Redis. `fetchSockets()` over the user room, per the contract.
- [x] `docs/architecture.md` updated: gap 1 marked CLOSED, with the
      one-process assumption behind `fetchSockets()` named as the single
      call that must change if the deployment stops being one Node process.
      `docs/socket-events.md` is Backend's file.
- [ ] The socket is out of `org:<uuid>` specifically and **not**
      disconnected outright. Implied by the multi-org design but not
      separately asserted.
- [ ] **Multi-org case:** a user in A and B, one socket joined to both,
      removed from A only — must stop receiving A's traffic and keep
      receiving B's. **Not covered.** This is the case a naive
      `disconnect()` gets wrong, and it is the one worth adding next.
- [ ] **Multi-socket case:** the same user with two open tabs; both sockets
      leave the room. **Not covered.** An index keyed by user id must fan
      out, not return the first match.
- [ ] `member:removed` still reaches the remaining members with
      `{orgId, membershipId, userId}`. **Not separately asserted.**
- [ ] A realtime failure during eviction does not roll back or 500 the
      removal itself. **Not covered.**
- [ ] A member who **leaves** voluntarily is evicted by the same path.
      **Not covered.**
- [x] **Gap 3 re-read, and it stands.** The evicted user still holds a
      valid access token for up to an hour. RLS refuses them everything
      because the membership row is gone, so what remains is token
      *validity*, not authority. H4 closed the room, not the session.

### 8.5 H5 — keyboard-accessible reordering — **met, manually**

No automated coverage exists or is planned. This is a manual gate, so it
can regress silently — re-run it by hand after any change to the board UI.
Shipped shape: **Space grabs, arrows move, Space or Enter drops, Escape
cancels**, with `aria-live` announcements.

- [x] A card can be grabbed, moved and dropped using only the keyboard, and
      the move **persists server-side**. Verified in a browser with real key
      events, not simulated ones.
- [x] Cancel (Escape) restores the original position **without
      committing** — verified in the same session.
- [x] An `aria-live` region announces the operation. *Whether every
      announcement names the target list and position was not separately
      recorded; confirm on the next pass.*
- [ ] Lists as well as cards. Only the card path was recorded.
- [ ] Focus lands somewhere sensible after a drop and after a cancel, and is
      never lost to `<body>`. **Not recorded.**
- [ ] Pointer drag-and-drop still works, and the two paths share one
      optimistic-update path rather than two. **Not recorded.**
- [ ] A keyboard move that the server rejects rolls back visibly and
      announces the failure. **Not recorded.**
- [ ] `client@northwind.test` gets no keyboard grab affordance either.
      **Not recorded, and this one matters:** disabling the pointer path
      alone would leave a read-only user able to attempt a write with a key
      press.

### 8.6 H6 — assignee picker offers only org members — **met**

- [x] The picker is populated from `GET /api/orgs/:orgId/members`, not from
      a profile search. With H1 enforcing membership in the database, this
      stops the UI from offering a choice the database will reject.
- [x] A card assigned to someone since removed renders without crashing and
      shows a **"former member" label** rather than a blank — the departed
      assignee is kept and labelled, not silently dropped. That is a
      deliberate product decision: a card losing its assignee invisibly is
      worse than a card showing that its assignee has gone.
- [ ] It offers every role including `client`, or deliberately does not —
      **decision not recorded.** A read-only client is a legal assignee
      under H1's constraint, which may or may not be intended.
- [ ] After an org switch the picker shows the new org's members and none of
      the previous org's. **Not recorded.**
- [ ] A failure to load members degrades to a disabled picker, not a broken
      board. **Not recorded.**

> **What this section cost, and why the browser box in §5 exists.**
> `CardEditor` shipped a call to an undefined `memberOptionLabel`.
> `npm run build` passed, because a `ReferenceError` is a runtime fault and
> the bundler has no reason to object. Opening any card blanked the whole
> application. A green production build is not evidence that a page
> renders; only opening it is.

### 8.7 H7 — CI — **written, never run**

`.github/workflows/ci.yml` exists. **It cannot run**: it needs repository
secrets, and setting those requires a human with repo settings access.
Until a real push produces a real result, none of these boxes can be
checked, and a workflow that has never run proves nothing.

- [ ] Runs on PR and on push to `main`. *(Declared in the file; never
      observed.)*
- [ ] Frontend production build.
- [ ] Backend suites against **dev**, with credentials from repository
      secrets. No secret appears in the workflow file, in logs, or in a
      failure message.
- [ ] **A deliberately failing test fails the workflow.** Push one, watch it
      go red, remove it. A workflow that has only ever been green has not
      been tested — and this one has not even been green.
- [ ] The SQL suite's absence from CI is recorded in the workflow, since it
      is `psql`-driven and has no npm script. "CI green" must not be read as
      "both isolation suites pass".
- [ ] CI never points at prod. There is nothing there to test and a write
      would break the zero-rows invariant.

### 8.8 H8 — deploy pipeline documented — **in progress**

Owned by DevOps in `docs/deployment.md`, which is being written now. Two
facts it has to carry, recorded here only so they are not lost: **Railway
auto-deploy is disabled**, so every backend release needs a manual trigger,
and **Netlify is a manual upload**, not repo-connected. Product's only
checks:

- [ ] Once `docs/deployment.md` exists, `README.md`'s deployment section
      links to it rather than restating it, and any statement the two share
      is removed from one of them.
- [x] Netlify is **not** connected to the repo as part of this pass — still
      true, and deliberately so.

### 8.9 H9 — coverage for H1–H4 — **met at the API level**

- [x] Each of H1–H4 has at least one test: `hardening.test.mjs`, 20 checks,
      `H1.1`–`H1.5`, `H2.1`–`H2.4`, `H3.1`–`H3.4`, `H4.1`–`H4.7`. Each pair
      of fix-and-proof includes a negative control (`H1.1`, `H4.2`, `H4.4`)
      so a passing assertion cannot be passing for the wrong reason.
- [x] The existing backend checks and `T01`–`T24` still pass unchanged. The
      Node total is now **59**: 9 realtime, 12 invitation, 18 Kanban, 20
      hardening.
- [x] New counts written into `README.md`, `docs/product-roadmap.md` and
      `docs/architecture.md`.
- [ ] Each test **observed failing** against the pre-fix code, with *how* it
      failed recorded, not just that it did. **Not recorded here.** The
      contract requires it; if those before-runs happened, they were not
      written down, and an unrecorded before-run is not evidence.
- [ ] The SQL isolation suite extended for H1, H2 and H3, as §8.1–§8.3 each
      require. **Not done** — it is still `T01`–`T24`. The equivalent
      coverage exists through PostgREST in `hardening.test.mjs`, which is
      close but is not the same layer.

### 8.10 H10 — production smoke test — **not written**

`scripts/smoke-prod.mjs` does not exist in the repo. Every box below is
outstanding, and the read-only prod facts recorded elsewhere in these docs
were established by hand rather than by this script. What it must be when
it is written: read-only, against the live URLs.

- [ ] `/health` ok.
- [ ] `/api/orgs` without a token → **401**.
- [ ] CORS: the Netlify origin is echoed; any other origin is not.
- [ ] SPA deep links resolve — `/login`, `/signup`, `/boards`,
      `/boards/:id`, `/accept-invite?token=…` — and `/assets/*` is still
      served as a real file.
- [ ] The prod auth error path returns a clean `400 invalid_credentials`.
- [ ] **It creates nothing.** No sign-up, no org, no row, not even a failed
      one. Re-read the script for this specifically; the auth check is the
      one that could drift into creating an account.
- [ ] Prod row count is still zero after a run. Verify, do not infer.
- [ ] The script's output distinguishes "prod is reachable and correctly
      wired" from "prod works", because it only ever proves the first.

### 8.11 Hardening sign-off — partial

**Signed off: H1–H6, on dev.** Not signed off: H7, H8, H10.

- [x] Migrations `0011`–`0013` apply cleanly to dev **and** prod. Both
      projects are at `0013`. *Advisor cleanliness after the DDL is not
      recorded — see §8.1 and §8.3.*
- [x] Every existing check still passes, plus the new ones: **59** Node
      checks green on dev via `cd backend && npm test`, plus the SQL suite
      (`T01`–`T24`, unextended).
- [x] Frontend production build green; keyboard reordering confirmed by
      hand in a browser. Backend live at commit `3731804`; frontend
      redeployed with H5 and H6; both verified serving.
- [x] **Prod still has zero rows.**
- [x] `docs/architecture.md` "Known gaps" updated: gap 1 marked CLOSED with
      the token residual named, the gaps that did not close left standing.
- [ ] CI green on a real push, and observed red on a real failure. **H7
      cannot run** — repository secrets need a human.
- [ ] `docs/deployment.md` landed and `README.md` pointing at it rather
      than restating it. **In progress, DevOps.**
- [ ] `scripts/smoke-prod.mjs` written. **Not started.**
- [ ] Two prod dashboard settings, neither of which any automated check in
      this document can reach:
      - [ ] **Site URL** set to `https://flowspace-v2.netlify.app`.
            Unconfirmed. If it is wrong, every email confirmation link
            points at the wrong host and no new user can finish signing up
            — which makes it the highest-risk unverified setting in the
            system, because the first real sign-up is the outstanding test.
      - [ ] **Leaked-password protection** enabled. **Confirmed DISABLED**
            by the Supabase linter on the prod project. This is a
            known-bad state, not an unknown one, and it is a dashboard
            toggle.
