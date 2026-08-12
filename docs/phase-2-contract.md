# Phase 2 contract — Kanban lists & cards

**This file is the coordination point for three agents working in
parallel. It is authoritative. If your implementation disagrees with it,
the contract wins — do not "improve" it unilaterally, raise it instead.**

Phase 1 is complete and verified: multi-tenant workspaces, Supabase Auth,
RLS as the only authorization layer, boards, invitations, realtime.
Read `docs/architecture.md` before writing anything.

---

## Non-negotiables inherited from Phase 1

1. **RLS is the only authorization layer.** Never re-implement permission
   checks in Express. Queries go through `req.supabase` (the caller's
   token) so policies apply. `requireOrgRole` is for a clean early 403,
   never the boundary.
2. **Every tenant-scoped table gets RLS, ENABLE + FORCE**, one policy per
   command, scoped `TO authenticated`. `anon` gets no policies and no
   grants.
3. **New SECURITY DEFINER functions must `revoke execute … from anon`
   explicitly.** Revoking from the `public` pseudo-role does *not* remove
   Supabase's default grant. See migration 0008.
4. **`client` role is read-only.** Writes are `owner|admin|member`.
5. **Test against 2+ tenants before calling anything done.**

## File ownership — do not edit outside your lane

| Agent | May edit |
|---|---|
| Backend | `supabase/migrations/0009*`, `0010*`, `backend/src/routes/lists.js`, `backend/src/routes/cards.js`, `backend/src/index.js` (mount lines only), `backend/tests/*`, `docs/socket-events.md` |
| Frontend | `frontend/src/**` only |
| Product | `docs/**` except `socket-events.md`, `README.md` |

Nobody edits `CLAUDE.md`, `.env*`, or Phase 1 route files unless the
contract says so.

---

## Data model

Two new tables. Both carry `org_id` **denormalized** so policies filter
without a join — the same shape as `boards`.

Consistency is enforced by the database, not by trust: `boards` gets a
`unique (id, org_id)` and `lists` references `(board_id, org_id)` as a
composite foreign key. A list therefore *cannot* point at a board in
another tenant. Same trick for `cards` → `lists`. Do not replace this
with a trigger or an application check.

### `lists`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `org_id` | uuid NOT NULL | FK → organizations, cascade |
| `board_id` | uuid NOT NULL | composite FK `(board_id, org_id)` → `boards(id, org_id)`, cascade |
| `title` | text NOT NULL | `check (btrim(title) <> '')` |
| `position` | numeric NOT NULL | see ordering below |
| `created_at` / `updated_at` | timestamptz | `set_updated_at` trigger |

`unique (board_id, position)` — **deferrable initially deferred**, so a
multi-row reorder inside one transaction does not trip mid-update.

### `cards`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid NOT NULL | FK → organizations, cascade |
| `list_id` | uuid NOT NULL | composite FK `(list_id, org_id)` → `lists(id, org_id)`, cascade |
| `title` | text NOT NULL | non-empty |
| `description` | text | nullable |
| `position` | numeric NOT NULL | |
| `assignee_id` | uuid | FK → profiles, `on delete set null` |
| `due_date` | timestamptz | nullable |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(board_id, position)` on lists, `(list_id, position)` on cards,
plus `org_id` on both.

### Ordering

**Fractional positions.** To place between neighbours, use
`(prev + next) / 2`; at the ends, `first - 1` / `last + 1`. `numeric` not
`float` — float exhausts precision after ~50 halvings in one gap and then
silently stops ordering correctly.

Add a `rebalance_list_positions(p_board uuid)` helper that rewrites
positions to `1..n`. Not called automatically in Phase 2; it exists so the
fix is one call when someone hits precision drift.

---

## REST API

All under `/api/orgs/:orgId/boards/:boardId`, all requiring
`requireAuth` + `requireOrgMember`. Writes additionally
`requireOrgRole('owner','admin','member')`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/` | — | board + lists + cards, nested, ordered |
| POST | `/lists` | `{title}` | `{list}` |
| PATCH | `/lists/:listId` | `{title?}` | `{list}` |
| DELETE | `/lists/:listId` | — | 204 |
| POST | `/lists/:listId/move` | `{position}` | `{list}` |
| POST | `/cards` | `{listId, title, description?}` | `{card}` |
| PATCH | `/cards/:cardId` | `{title?, description?, assigneeId?, dueDate?}` | `{card}` |
| DELETE | `/cards/:cardId` | — | 204 |
| POST | `/cards/:cardId/move` | `{listId, position}` | `{card}` |

Rules:
- `org_id` is **always** taken from the authorised route param, never the
  body. Same for `board_id`.
- Move endpoints take a computed `position` from the client. The server
  validates the target list belongs to the same board; it does not
  recompute ordering.
- Every mutation echoes the authoritative row back, so the writer can
  reconcile against its optimistic update.
- Errors go through `fromPostgrestError`. 42501 → 403, never 500.

## Socket events

Room stays `org:<uuid>`. Every payload carries `orgId` and `boardId` so
clients can ignore events for a board they are not viewing.

| Event | Payload |
|---|---|
| `list:created` / `list:updated` | `{orgId, boardId, list}` |
| `list:deleted` | `{orgId, boardId, listId}` |
| `list:moved` | `{orgId, boardId, list}` |
| `card:created` / `card:updated` | `{orgId, boardId, card}` |
| `card:deleted` | `{orgId, boardId, cardId}` |
| `card:moved` | `{orgId, boardId, card, fromListId}` |

Echo suppression via the `X-Socket-Id` header, exactly as `boards` does.

**Broadcasts are at-most-once** — see `docs/architecture.md`. Card moves
are far more frequent than board creates, so the client must resync the
whole board on `org:joined` and on reconnect rather than assuming the
stream is complete.

---

## Definition of done

- Migrations apply cleanly to a fresh database.
- RLS suite extended: a tenant cannot read or write another tenant's
  lists/cards, and **cannot move a card into another tenant's list**.
- Realtime suite extended: tenant B receives no `card:*` events while
  tenant A drags.
- `npm test` green, frontend production build green.
- `docs/socket-events.md` updated in the same change as the code.
