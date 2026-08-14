# Flowspace v2

[![Netlify Status](https://api.netlify.com/api/v1/badges/f84dac52-1e23-4dd1-ab5c-5b7a5747688b/deploy-status)](https://app.netlify.com/projects/flowspace-v2/deploys)

Multi-tenant SaaS project management with real-time Kanban.

**New here, or picking this up in a fresh session? Start with
[`docs/HANDOFF.md`](./docs/HANDOFF.md).** Project guide and conventions:
[CLAUDE.md](./CLAUDE.md).

| | |
|---|---|
| Frontend | [flowspace-v2.netlify.app](https://flowspace-v2.netlify.app) — **live** |
| Backend | [backend-production-8d147.up.railway.app](https://backend-production-8d147.up.railway.app) — **live**, healthcheck passing |
| Database | Supabase `flowspace-v2-prod` — all migrations applied, **3 real users in 3 workspaces** |

**Production is verified, not just deployed.** Three people have signed
up, confirmed by email and created workspaces, and invitations work in
production — one workspace has an owner plus a member, another an owner
plus a `client`. Tenant isolation has been checked against those real
accounts: **6/6**, run as the actual users, every block rolled back, row
counts unchanged. Details in
[`docs/HANDOFF.md`](./docs/HANDOFF.md).

Still unexercised by real users: boards, lists, cards and realtime —
prod has 0 boards. Those are covered by the dev suites only.
| Repo | [`mithilesh-creator/flowspace-v2`](https://github.com/mithilesh-creator/flowspace-v2) (public) |

**Phase 1 and Phase 2 are built, tested and deployed, and the Phase 2
hardening pass is complete on the product side: H1–H6 shipped.** What is
left of the pass is CI (H7, written but never run), the deploy
documentation (H8, in progress) and the prod smoke test (H10, not written).
Full phase-by-phase status:
[`docs/product-roadmap.md`](./docs/product-roadmap.md).

## Status

| Phase | State |
|---|---|
| 1 — Multi-tenant workspaces + Supabase Auth/RLS | Shipped |
| 2 — Real-time Kanban (lists, cards, Socket.io sync) | Shipped and hardened — H1–H6 done; H7/H8/H10 outstanding |
| 3 — AI task automation | Not started — spec drafted, [`docs/phase-3-spec.md`](./docs/phase-3-spec.md) |
| 4 — Client-facing portal mode | Not started |
| 5 — Billing + onboarding + tenant admin | Not started |

### Verified against the deployed stack

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

### What deployment does NOT prove

The 59 backend checks and the SQL isolation suite **cannot run against
prod**, because prod deliberately has no seed and the suites are built on
seeded two-tenant fixtures. They pass against `flowspace-v2-dev`. Prod has
**zero rows in every table**, so sign-up, tenant isolation, invitations and
realtime are unexercised there. **The first real sign-up is the remaining
test** — and it should be performed deliberately, as a test, with the
result recorded. See gap 6 in
[`docs/product-roadmap.md`](./docs/product-roadmap.md).

"Deployed" and "verified in production" are different claims. Only the
first is true today.

## Phase 2 hardening pass (H1–H10)

Scope frozen in
[`docs/phase-2-hardening-contract.md`](./docs/phase-2-hardening-contract.md).
**H1–H6 are complete, tested and deployed.** Migrations `0011`–`0013` are
applied to dev and prod, both at `0013`; the backend is live at commit
`3731804` and the frontend has been redeployed with H5 and H6.

| | Item | Owner | State |
|---|---|---|---|
| H1 | Assignee must be a member of the card's org | Backend | **Done** — `0011`, composite FK to `memberships` |
| H2 | Cards carry `board_id`; FK widened to `(list_id, board_id, org_id)` | Backend | **Done** — `0012` |
| H3 | `rebalance_card_positions`, SECURITY INVOKER, anon revoked | Backend | **Done** — `0013` |
| H4 | **A removed member's socket is evicted from the org room** | Backend | **Done** — `user:<uuid>` index room |
| H5 | Keyboard-accessible reordering | Frontend | **Done** — Space grabs, arrows move, Space/Enter drops, Escape cancels |
| H6 | Assignee picker offers only org members | Frontend | **Done** — a departed assignee is labelled, not dropped |
| H7 | CI | DevOps | **Written, never run** — needs repository secrets, which needs a human |
| H8 | Deploy pipeline documented honestly | DevOps | **In progress** — `docs/deployment.md` |
| H9 | Tests for H1–H4 | QA | **Done at the API level** — `hardening.test.mjs`, 20 checks. The SQL suite was **not** extended |
| H10 | Read-only production smoke test | QA | **Not written** |

H4 was the one that mattered most: an open gap since Phase 1, and the
blocker on the Phase 4 client portal, where revoking an outsider's access
is the entire feature. It is closed — a removed member's socket is forced
out of the org room the moment their membership is deleted, proven by
`H4.1`–`H4.7`. **The residual is narrower and still real:** that person
keeps a valid access token for up to an hour. RLS refuses them everything,
because the membership row is gone, so what remains is token *validity*,
not authority. Recorded as gap 3 in
[`docs/product-roadmap.md`](./docs/product-roadmap.md).

All of the above is green **on dev**. Acceptance criteria and the
box-by-box evidence:
[`docs/integration-checklist.md`](./docs/integration-checklist.md) §8.

```
frontend/   React + Vite
backend/    Express + Socket.io
supabase/   migrations, RLS policies, seed, isolation tests
docs/       architecture, socket contract, roadmap, checklist, case studies
```

### Docs

| File | What it is |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | How the tenant boundary works, and the known gaps. Updated after the hardening pass: composite keys named as the strongest boundary, 59 checks, gap 1 marked CLOSED. Its heading still says "Phase 1" |
| [`docs/socket-events.md`](./docs/socket-events.md) | The Socket.io event contract (Backend owns) |
| [`docs/phase-2-contract.md`](./docs/phase-2-contract.md) | Phase 2 spec — frozen |
| [`docs/phase-2-hardening-contract.md`](./docs/phase-2-hardening-contract.md) | The hardening pass — frozen, authoritative |
| [`docs/product-roadmap.md`](./docs/product-roadmap.md) | Five phases, honest status, gap deadlines |
| [`docs/integration-checklist.md`](./docs/integration-checklist.md) | Acceptance gate for Phase 2 (§1–§7) and the hardening pass (§8) |
| [`docs/phase-3-spec.md`](./docs/phase-3-spec.md) | AI task automation — a draft to think against, nothing decided |
| [`docs/case-studies/`](./docs/case-studies/) | Catalogue-ready summaries |

`docs/deployment.md` is being written by DevOps under H8 and will be the
authority on the deploy pipeline once it lands. Where it disagrees with the
runbook at the bottom of this file, it wins.

---

## Environment

Two hosted Supabase projects, both ap-south-1, both free tier:

| | ref | contents |
|---|---|---|
| `flowspace-v2-dev` | `hjylkhswlwqiwvztynkw` | all migrations **+ seed** |
| `flowspace-v2-prod` | `ajkzoiqsvcibvcodkuzs` | all migrations, **no seed**, zero rows |

> **Never point a deployment at the dev project.** Its seed creates six
> accounts sharing the password `password123`, published in this repo.
>
> **Never seed prod.** Zero rows is a deliberate invariant, and H10's smoke
> test is read-only for that reason.

Prod was verified empty and locked down on creation: RLS enabled *and*
forced on every tenant-scoped table, and `anon` execute revoked on all
helpers. Two things there are still manual, in the Supabase dashboard, and
have **no automated check** — no suite in this repo can reach either:

- **Site URL** must point at the Netlify origin. **Unconfirmed.** If it is
  wrong, every email confirmation link goes to the wrong host and no new
  user can finish signing up — which is the highest-risk unverified setting
  in the system, because the first real sign-up is the outstanding test.
- **Leaked-password protection** must be enabled. **It is currently
  DISABLED**, confirmed by the Supabase linter. A known-bad state, not an
  unknown one, and a single dashboard toggle away from fixed.

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

Dev only. Password for all: `password123`

| Email | Workspace | Role |
|---|---|---|
| `owner@northwind.test` | Northwind Studio | owner |
| `admin@northwind.test` | Northwind Studio | admin |
| `member@northwind.test` | Northwind Studio | member |
| `client@northwind.test` | Northwind Studio | client |
| `owner@acme.test` | Acme Logistics | owner |
| `dual@contractor.test` | **both** | member |

`dual@contractor.test` is the important one: everyone else can be refused
at the middleware before RLS is consulted, but the contractor is a
legitimate member of both tenants, so their requests actually reach the
policies and the composite foreign keys.

---

## The isolation suites

Per CLAUDE.md, nothing ships without passing both kinds. They cover the two
places the tenant boundary actually lives, and they are independent — the
database one cannot see realtime, and vice versa.

**All of them run against `flowspace-v2-dev`.** They need the two-tenant
seed. They cannot run against prod and must not be pointed at it.

### Database — `supabase/tests/rls.test.sql`, T01–T24

`T01`–`T16` cover Phase 1: cross-tenant reads and writes in both
directions, board reassignment across tenants, admin privilege escalation,
last-owner protection, profile visibility, orphan-org prevention,
invitation email binding, and anon lockout.

`T17`–`T24` cover Phase 2 lists and cards, including `T20` — a card cannot
be dragged into another tenant's list — `T22` (deleting a list is an admin
action, deleting a card is not) and `T23`/`T24` (`rebalance_list_positions`
is SECURITY INVOKER and `anon` cannot reach it).

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.test.sql
```

Silence plus a final `NOTICE` means all passed. Any `FAIL [Tnn]` is a leak
— fix before writing another line of feature code.

Without `psql` installed, the same assertions can be run through the
Supabase SQL editor or MCP connector by wrapping them in a harness
function; see the file header.

**Still `T01`–`T24`.** The suite was **not** extended for H1, H2 or H3,
though the hardening contract asked for that. Those three are covered at
the API and PostgREST level by `hardening.test.mjs` instead — close, but
not the same layer. Recorded rather than quietly dropped; see
[`docs/integration-checklist.md`](./docs/integration-checklist.md) §8.9.

### Backend — 59 checks across four Node suites

| Suite | Checks | Covers |
|---|---|---|
| `backend/tests/realtime-isolation.test.mjs` | 9 (`R1`–`R9`) | Three concurrent authenticated sockets across two tenants: unauthenticated sockets refused; members join their own room; **tenant B refused entry to tenant A's room when it asks by uuid**; a teammate receives the broadcast while the other tenant stays silent; no self-echo; cross-tenant REST reads 404; deletes broadcast |
| `backend/tests/invitations.test.mjs` | 12 (`I1`–`I12`) | The API in front of `accept_invitation()`: who may issue a token, who may redeem it, single use, revocation, and that listing invitations never returns `token_hash` |
| `backend/tests/kanban-isolation.test.mjs` | 18 (`K1`–`K16` + sub-checks) | Lists and cards. `K7`: a card cannot be moved into another tenant's list (400, `23503`, composite FK). `K8`: nor onto another board of the same tenant (404, route check) |
| `backend/tests/hardening.test.mjs` | 20 (`H1.x`–`H4.x`) | The hardening pass. `H1.2`/`H1.3`: a card cannot be assigned outside its org, through the API **or** straight at PostgREST. `H2.2`: the same-tenant wrong-board move is refused by the database, not just the route. `H3.3`/`H3.4`: rebalance is SECURITY INVOKER and unreachable by `anon`. `H4.5`: **a removed member's socket receives nothing**, with `H4.2`/`H4.4` as before-and-control so the silence cannot be passing for the wrong reason |

```bash
cd backend && npm run test:realtime      # requires the backend running
cd backend && npm run test:invitations
cd backend && npm run test:kanban
cd backend && npm run test:hardening
cd backend && npm test                   # all four
```

`npm test` runs the four Node suites only — **it does not run the SQL
isolation suite**, which is `psql`-driven and has no npm script. "npm test
green" is not "the isolation suites pass"; run both. H7 would put the Node
suites in CI; the SQL suite stays manual, and CI will run against dev.

### After any DDL change

Run the Supabase database linter. Migration `0008` exists because
`revoke execute … from public` does not revoke the direct grant Supabase
issues to `anon`, which left eight SECURITY DEFINER functions reachable
without a session. Nothing leaked — they all guard on `auth.uid()` — but
the linter is what caught it, and it will catch the next one. Every new
function needs an explicit `revoke execute … from anon`.

## Two lessons worth keeping

Both cost real time during the hardening pass. They are here rather than in
a commit message because the next person will hit them the same way.

**A green production build is not evidence that a page renders.**
`CardEditor` called an undefined `memberOptionLabel`. `npm run build`
passed — a `ReferenceError` is a runtime fault, and a bundler has no reason
to object to a name it cannot resolve at build time. Opening any card
blanked the entire application. Nothing but clicking it in a browser found
it. Treat "the build is green" as "it compiles", never as "it works", and
open the thing you changed.

**Migrating ahead of a deploy is dangerous when the migration adds a
`NOT NULL` column.** `0012` did exactly that. Old code, which does not
populate the column, starts failing inserts the moment the migration lands
— and with auto-deploy disabled, a push does not ship the matching code, so
the window is however long it takes someone to trigger a release by hand.
Prod had zero rows, so nothing broke. The rule is expand/contract: add the
column nullable, deploy the code that writes it, *then* enforce
`NOT NULL`. Never migrate and deploy as one step.

---

## Deployment

**Done.** Backend on Railway, frontend on Netlify, database on Supabase
`flowspace-v2-prod`. The runbook below is what was done and what to repeat;
DevOps owns `docs/deployment.md` under H8 and it supersedes this section
once it exists — read it first, and treat anything here that contradicts it
as stale rather than authoritative.

Config lives in [`backend/railway.json`](./backend/railway.json) and
[`frontend/netlify.toml`](./frontend/netlify.toml).

Nothing in the app favours Netlify over Vercel — it is a static Vite SPA
calling an external API, with no SSR or edge functions — so this was an
account-preference choice, not a technical one. Swapping to Vercel later
means replacing `netlify.toml` with equivalent rewrite rules and nothing
else.

There is a deliberate ordering problem: the backend needs the frontend's
URL for CORS, and the frontend needs the backend's URL. Deploy the backend
first with a placeholder, then come back and fix it (step 4).

### 1. Production Supabase project

A **new** project, not `flowspace-v2-dev`. Apply every migration in
`supabase/migrations/` in order. Do **not** run `seed.sql` — those are six
accounts sharing a published password.

In Auth settings: set **Site URL** to the deployed frontend origin (email
confirmation links use it), and turn on **leaked-password protection**,
which is off by default and flagged by the linter.

### 2. Backend → Railway

Root directory `backend/`. `railway.json` supplies the start command and
`/health` check.

> **Auto-deploy is currently DISABLED on the service.** A push to `main`
> builds nothing — verified: commit `3731804` sat unbuilt until a
> deployment was triggered by hand. The GitHub webhook itself works; the
> service-level toggle is off. Until it is enabled, **every backend
> release needs a manual trigger**, and the frontend needs one always
> (see below).
>
> This is not merely inconvenient. It breaks the assumption behind
> ordering a schema change and a code change: if you migrate first
> expecting the push to ship the matching code, the database moves ahead
> and the running code stays behind.

**Migrations and deploys must be ordered deliberately.** Adding a
`NOT NULL` column (0012) means old code, which does not populate it,
starts failing inserts the moment the migration lands. Prod had zero rows
so nothing broke, but on a live system the safe pattern is
expand/contract: add the column nullable, deploy code that writes it,
*then* enforce `NOT NULL` — never migrate and deploy as one step.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | production project URL |
| `SUPABASE_ANON_KEY` | production anon key |
| `CORS_ORIGINS` | deployed frontend origin — **the server refuses to boot on `*`** |
| `APP_URL` | deployed frontend origin |

`APP_URL` is the one that is easy to miss. Invitation links are built from
it and then **emailed to a human**, so if it is left unset it falls back to
the first CORS origin — and every invitation you send points somewhere
wrong. There is no way to fix a link already sent; the invitation has to be
revoked and reissued.

Leave `SUPABASE_SERVICE_ROLE_KEY` unset. Nothing uses it before Phase 5,
and an unset key cannot be misused.

### 3. Frontend → Netlify

Base directory `frontend/`. `netlify.toml` supplies the build, the publish
directory, the SPA redirect and the security headers.

That redirect is required, not boilerplate: `/accept-invite?token=…` is a
client-side route with no file behind it, so without it a cold load of an
invitation link 404s and every invite is broken. Netlify checks the
filesystem before applying redirects, so it does not shadow `/assets/*`.

`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_API_URL` (the
Railway URL) are baked in **at build time** — changing one requires a
rebuild and redeploy, not a restart.

> **The frontend is currently uploaded pre-built by hand** from
> `frontend/`, using `frontend/.env.production` (gitignored). The site is
> **not connected to the repo**, so Netlify's own build-time environment
> variables are never consulted, and what is live is not derivable from
> git. H8 documents this honestly and deliberately does **not** connect it
> — that needs account access. Recorded as gap 12 in
> [`docs/product-roadmap.md`](./docs/product-roadmap.md).

### 4. Close the loop

Set the backend's `CORS_ORIGINS` and `APP_URL` to the real Netlify origin
and redeploy the backend.

### 5. Verify

```bash
cd backend && PORT=443 npm test
```

> **This does not work.** All three suites build their base URL as
> `http://localhost:${PORT}`, so `PORT` alone will not point them at a
> deployed host, and pointing them at Railway would need an env override
> the suites do not read. It would also require seeding prod, which is
> forbidden. Treat this block as a known dead end, kept here so nobody
> rediscovers it.

What can actually be checked against prod is the read-only set at the top
of this file, which H10 automates as `scripts/smoke-prod.mjs`. Beyond that,
the outstanding verification is the first real sign-up, by hand: sign up,
confirm the email arrives and its link resolves to the Netlify origin,
create a workspace, invite a second address, redeem it, and open a board in
two browsers. Record the result.
