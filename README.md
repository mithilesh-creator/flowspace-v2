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

**Not done yet** — the last remaining item in Phase 1. Config is in place
([`backend/railway.json`](./backend/railway.json),
[`frontend/vercel.json`](./frontend/vercel.json)); what is missing is
accounts and credentials.

There is a deliberate ordering problem here: the backend needs the
frontend's URL for CORS, and the frontend needs the backend's URL. Deploy
the backend first with a placeholder, then come back and fix it.

### 1. Production Supabase project

A **new** project, not `flowspace-v2-dev`. Apply
`supabase/migrations/0001`–`0008` in order. Do **not** run `seed.sql` —
those are six accounts sharing a published password.

In Auth settings: set **Site URL** to the deployed frontend origin (email
confirmation links use it), and turn on **leaked-password protection**,
which is off by default and flagged by the linter.

### 2. Backend → Railway

Root directory `backend/`. `railway.json` supplies the start command and
`/health` check.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | production project URL |
| `SUPABASE_ANON_KEY` | production anon key |
| `CORS_ORIGINS` | deployed frontend origin — **the server refuses to boot on `*`** |
| `APP_URL` | deployed frontend origin |

`APP_URL` is the one that is easy to miss. Invitation links are built
from it and then **emailed to a human**, so if it is left unset it falls
back to the first CORS origin — and every invitation you send points
somewhere wrong. There is no way to fix a link already sent; the
invitation has to be revoked and reissued.

Leave `SUPABASE_SERVICE_ROLE_KEY` unset. Nothing in Phase 1 uses it, and
an unset key cannot be misused.

### 3. Frontend → Vercel

Root directory `frontend/`. `vercel.json` handles the build and the SPA
rewrite — that rewrite is required, not cosmetic: without it
`/accept-invite?token=…` is a 404 on a cold load, which breaks every
invitation link.

Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`
(the Railway URL).

### 4. Close the loop

Set the backend's `CORS_ORIGINS` and `APP_URL` to the real Vercel origin
and redeploy.

### 5. Verify before calling Phase 1 done

```bash
cd backend && PORT=443 npm test
```

Point the suites at the deployed URLs, then repeat by hand: sign up, two
tenants, an invitation redeemed by a signed-out invitee, and a live board
update between two clients.
