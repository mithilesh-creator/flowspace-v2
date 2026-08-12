# Flowspace v2

[![Netlify Status](https://api.netlify.com/api/v1/badges/f84dac52-1e23-4dd1-ab5c-5b7a5747688b/deploy-status)](https://app.netlify.com/projects/flowspace-v2/deploys)

Multi-tenant SaaS project management with real-time Kanban.
Project guide and conventions: [CLAUDE.md](./CLAUDE.md).

| | |
|---|---|
| Frontend | [flowspace-v2.netlify.app](https://flowspace-v2.netlify.app) — **live** |
| Backend | [backend-production-8d147.up.railway.app](https://backend-production-8d147.up.railway.app) — **live**, healthcheck passing |
| Database | Supabase `flowspace-v2-prod` — all 10 migrations applied |
| Repo | `mithilesh-creator/flowspace-v2` (private) |

Verified against the deployed stack:

- `/health` returns ok; `/api/orgs` without a token returns 401.
- CORS echoes `https://flowspace-v2.netlify.app` and returns an empty
  allow-origin for any other origin.
- Every SPA deep link resolves — `/login`, `/signup`, `/boards`,
  `/boards/:id`, and `/accept-invite?token=…` — while `/assets/*` is
  still served as a real file rather than rewritten to `index.html`.
- `X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy` are
  applied from `netlify.toml`.
- The live bundle carries the prod Supabase ref and the Railway API URL,
  with no localhost and no dev-project reference.

Production auth path, verified against `flowspace-v2-prod`:

- GoTrue reachable; a non-existent account returns a clean
  `400 invalid_credentials` rather than a 500 or a CORS failure.
- The deployed UI surfaces that error correctly, proving the whole chain:
  Netlify bundle → prod Supabase → rendered message.
- `disable_signup: false`, `mailer_autoconfirm: false` — sign-up is open
  and email confirmation is required, which is why **Site URL** must
  point at the Netlify origin. A wrong value there sends every
  confirmation link to the wrong host and no new user can finish.

**What deployment does NOT prove.** The 39 automated checks cannot run
against prod, because prod deliberately has no seed — and the suites are
built on seeded fixtures across two tenants. They pass against
`flowspace-v2-dev`. Prod has **zero rows in every table**, so sign-up,
tenant isolation, invitations and realtime are unexercised there until a
real account exists. The first real sign-up is the remaining test.

Frontend builds are uploaded pre-built from `frontend/`, using
`frontend/.env.production` (gitignored). The site is not connected to the
repo, so Netlify's own build-time variables are not consulted — worth
knowing before wiring up git-push deploys.

**Phase 1 status: feature-complete, verified locally, not yet deployed.**

38 automated checks pass against a live hosted Supabase project (17
database isolation, 12 invitation flow, 9 realtime isolation), and the
production frontend build succeeds. Confirmed in the browser: sign-up,
sign-in, workspace switching, live board updates across separate clients,
read-only `client` access, and the full invitation path — a signed-out
invitee clicking a link, signing in, and landing in the workspace with
the role they were given.

Deployment to Railway/Netlify is the one thing left.

**Phase 2 status: in progress.** Kanban lists and cards, built in parallel
by two engineers against the frozen spec in
[`docs/phase-2-contract.md`](./docs/phase-2-contract.md). Not started on
disk at the time of writing — no `0009`/`0010` migrations, no
`backend/src/routes/lists.js` or `cards.js`, no board-detail route. No
Phase 2 test coverage exists yet, so the 38 checks above cover Phase 1
only. Acceptance criteria:
[`docs/integration-checklist.md`](./docs/integration-checklist.md).

Full phase-by-phase status:
[`docs/product-roadmap.md`](./docs/product-roadmap.md).

```
frontend/   React + Vite
backend/    Express + Socket.io
supabase/   migrations, RLS policies, seed, isolation tests
docs/       architecture, socket contract, roadmap, checklist, case studies
```

### Docs

| File | What it is |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | How the tenant boundary works, and the known gaps |
| [`docs/socket-events.md`](./docs/socket-events.md) | The Socket.io event contract |
| [`docs/phase-2-contract.md`](./docs/phase-2-contract.md) | Phase 2 spec — frozen while it is being built |
| [`docs/product-roadmap.md`](./docs/product-roadmap.md) | Five phases, honest status, gap deadlines |
| [`docs/integration-checklist.md`](./docs/integration-checklist.md) | The acceptance gate for Phase 2 |
| [`docs/case-studies/`](./docs/case-studies/) | Catalogue-ready summaries (Phase 2 is a DRAFT) |

---

## Environment

Two hosted Supabase projects, both ap-south-1, both free tier:

| | ref | contents |
|---|---|---|
| `flowspace-v2-dev` | `hjylkhswlwqiwvztynkw` | migrations 0001–0008 **+ seed** |
| `flowspace-v2-prod` | `ajkzoiqsvcibvcodkuzs` | migrations 0001–0008, **no seed**, zero rows |

Phase 2 adds migrations `0009`/`0010` (lists, cards). Apply them to dev
first; prod gets them as part of the deployment step below.

> **Never point a deployment at the dev project.** Its seed creates six
> accounts sharing the password `password123`, published in this repo.

Prod was verified empty and locked down on creation: 5 tables with RLS
enabled *and* forced, 17 policies, and `anon` execute revoked on all
helpers. Still to do there by hand, in the Supabase dashboard: set
**Site URL** to the Netlify origin and enable **leaked-password
protection**.

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

Note `npm test` runs the realtime and invitation suites only — the
database isolation suite is `psql`-driven and has no npm script. "npm test
green" is not "the isolation suites pass"; run both.

### Phase 2 extends both suites

Lists and cards need their own assertions in `supabase/tests/rls.test.sql`
and `backend/tests/realtime-isolation.test.mjs` — including that a card
cannot be moved into another tenant's list, and that tenant B hears
nothing while tenant A drags. The counts above will change when they land;
update them here at the same time. See
[`docs/integration-checklist.md`](./docs/integration-checklist.md).

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
[`frontend/netlify.toml`](./frontend/netlify.toml)); what is missing is
accounts and credentials.

Target: **backend → Railway, frontend → Netlify.** Nothing in the app
favours Netlify over Vercel — it is a static Vite SPA calling an external
API, with no SSR or edge functions — so this is an account-preference
choice, not a technical one. Swapping to Vercel later means replacing
`netlify.toml` with equivalent rewrite rules and nothing else.

There is a deliberate ordering problem here: the backend needs the
frontend's URL for CORS, and the frontend needs the backend's URL. Deploy
the backend first with a placeholder, then come back and fix it.

### 1. Production Supabase project

A **new** project, not `flowspace-v2-dev`. Apply every migration in
`supabase/migrations/` in order — `0001`–`0008` today, plus `0009`/`0010`
once Phase 2 lands. Do **not** run `seed.sql` —
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

### 3. Frontend → Netlify

Base directory `frontend/`. `netlify.toml` supplies the build, the
publish directory, and the SPA redirect.

That redirect is required, not boilerplate: `/accept-invite?token=…` is a
client-side route with no file behind it, so without it a cold load of an
invitation link 404s and every invite is broken. Netlify checks the
filesystem before applying redirects, so it does not shadow `/assets/*`.

Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_API_URL`
(the Railway URL). Note these are baked in **at build time** — changing
one requires a redeploy, not just a restart.

### 4. Close the loop

Set the backend's `CORS_ORIGINS` and `APP_URL` to the real Netlify origin
and redeploy the backend.

### 5. Verify before calling Phase 1 done

```bash
cd backend && PORT=443 npm test
```

> Unverified: both suites build their base URL as
> `http://localhost:${PORT}`, so `PORT` alone will not point them at a
> deployed host. Pointing them at Railway needs an env override the
> suites do not currently read. Check this before relying on the command
> above.

Point the suites at the deployed URLs, then repeat by hand: sign up, two
tenants, an invitation redeemed by a signed-out invitee, and a live board
update between two clients.
