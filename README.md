# Flowspace v2

Multi-tenant SaaS project management with real-time Kanban.
Project guide and conventions: [CLAUDE.md](./CLAUDE.md).

**Phase 1 status: feature-complete, verified locally, not yet deployed.**

38 automated checks pass against a live hosted Supabase project (17
database isolation, 12 invitation flow, 9 realtime isolation), and the
production frontend build succeeds. Confirmed in the browser: sign-up,
sign-in, workspace switching, live board updates across separate clients,
read-only `client` access, and the full invitation path — a signed-out
invitee clicking a link, signing in, and landing in the workspace with
the role they were given.

Deployment to Railway/Vercel is the one thing left.

```
frontend/   React + Vite
backend/    Express + Socket.io
supabase/   migrations, RLS policies, seed, isolation tests
docs/       architecture, socket contract, case studies
```

---

## Environment

The dev database is a hosted Supabase project, `flowspace-v2-dev`
(ref `hjylkhswlwqiwvztynkw`, ap-south-1, free tier).

> **Dev only.** The seed creates six fake accounts with a shared, known
> password. This project must never be promoted to production — cut a
> fresh one and apply migrations without the seed.

`backend/.env` and `frontend/.env` are already populated and are
gitignored. To recreate them, copy the `.env.example` next to each and
fill in the project URL and anon key.

## Running it

```bash
cd backend && npm install && npm run dev
```

```bash
cd frontend && npm install && npm run dev
```

Backend on `:4000` (`curl http://localhost:4000/health`), frontend on
`:5173`.

If `node` is not on PATH after a fresh install, open a new terminal —
Windows does not refresh PATH in already-running shells.

## Test accounts

Password for all: `password123`

| Email | Workspace | Role |
|---|---|---|
| `owner@northwind.test` | Northwind Studio | owner |
| `admin@northwind.test` | Northwind Studio | admin |
| `member@northwind.test` | Northwind Studio | member |
| `client@northwind.test` | Northwind Studio | client |
| `owner@acme.test` | Acme Logistics | owner |
| `dual@contractor.test` | **both** | member |

---

## The isolation suites

Per CLAUDE.md, nothing ships without passing both. They cover the two
places the tenant boundary actually lives, and they are independent —
the database one cannot see realtime, and vice versa.

### Database — 17 assertions across T01–T16

Cross-tenant reads and writes in both directions, board reassignment
across tenants, admin privilege escalation, last-owner protection,
profile visibility, orphan-org prevention, invitation email binding, and
anon lockout.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.test.sql
```

Silence plus a final `NOTICE` means all passed. Any `FAIL [Tnn]` is a
leak — fix before writing another line of feature code.

Without `psql` installed, the same assertions can be run through the
Supabase SQL editor or MCP connector by wrapping them in a harness
function; see the file header.

### Invitations — 12 checks

The API layer in front of `accept_invitation()`: who may issue a token,
who may redeem it, single use, revocation, and that listing invitations
never returns `token_hash`.

```bash
cd backend && npm run test:invitations
```

### Realtime — 9 checks

Three concurrent authenticated socket clients across two tenants.
Requires the backend running.

```bash
cd backend && npm run test:realtime
```

Asserts: unauthenticated sockets are refused; members join their own
room; **tenant B is refused entry to tenant A's room when it asks by
uuid**; a teammate receives the broadcast while the other tenant stays
silent through the write; the author does not get its own echo;
cross-tenant REST reads 404; deletes broadcast.

Both backend suites at once:

```bash
cd backend && npm test
```

### After any DDL change

Run the Supabase database linter. Migration 0008 exists because
`revoke execute … from public` does not revoke the direct grant Supabase
issues to `anon`, which left eight SECURITY DEFINER functions reachable
without a session. Nothing leaked — they all guard on `auth.uid()` — but
the linter is what caught it, and it will catch the next one.

---

## Deployment

Not yet done. Per CLAUDE.md a phase is not complete until it has been
verified in a real deployed environment.

- **Supabase** — create a *separate* production project. Apply
  `supabase/migrations/` in order. Do **not** run `seed.sql` against it.
  Enable leaked-password protection in Auth settings (flagged by the
  linter, off by default).
- **Backend → Railway** — root `backend/`, start `npm start`, healthcheck
  `/health`. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `CORS_ORIGINS` (the
  deployed frontend origin; the server refuses to boot on `*` in
  production), `NODE_ENV=production`.
- **Frontend → Vercel/Netlify** — root `frontend/`, build `npm run build`,
  output `dist`. Set the three `VITE_` variables. Then add that origin to
  the backend's `CORS_ORIGINS` and redeploy the backend.

Re-run both isolation suites against the deployed URLs before calling
Phase 1 done.
