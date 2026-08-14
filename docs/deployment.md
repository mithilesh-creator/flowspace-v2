# Deployment

What the pipeline actually is today, not what it should be. Where this
file disagrees with the runbook at the bottom of `README.md`, this file
wins.

## Topology

| Tier | Where | How it ships |
|---|---|---|
| Frontend | Netlify site `flowspace-v2`, team `novaxis` | **Manual.** Built locally, uploaded pre-built |
| Backend | Railway project `flowspace-v2`, service `backend`, root `/backend` | **Manual.** Auto-deploy is off |
| Database | Supabase `flowspace-v2-prod` (`ajkzoiqsvcibvcodkuzs`) | Migrations applied through the Supabase connector |

Live: <https://flowspace-v2.netlify.app> ·
<https://backend-production-8d147.up.railway.app>

---

## The two things most likely to bite you

### 1. Nothing deploys on `git push`

Railway's service-level auto-deploy is **disabled**, and Netlify is not
connected to the repo at all. Pushing to `main` ships nothing, anywhere.

This has been verified twice, not assumed. Commit `3731804` sat unbuilt
until triggered by hand; after auto-deploy was reportedly enabled, commit
`ec5042e` also failed to trigger a build — the running deployment stayed
at `3731804` with an uptime of over 23 hours. The GitHub webhook itself
works: Railway can see the repo and manual deploys succeed.

If you expect a push to deploy, **check that it did.**

### 2. Migrate and deploy are separate steps, so ordering matters

Because the code deploy does not follow the push automatically, a
migration and the code that depends on it land at different times, and
whichever goes first defines what breaks in between.

This already happened. Migration `0012` added `cards.board_id` as
`NOT NULL`. Applying it before the deploy left production running code
that did not populate that column, so a card insert would have failed.
Prod had zero rows, so nothing broke — on a live system it is an outage.

**Use expand/contract for any migration that could reject existing
code's writes:**

1. **Expand** — add the column nullable, with no constraint.
2. **Deploy** the code that writes it.
3. **Backfill** any rows the old code left behind.
4. **Contract** — apply `NOT NULL` / the foreign key.

Only step 4 can reject a write, and by then nothing is writing the old
shape. A migration that only adds an index, a policy, or a nullable
column is safe in one step.

Enabling auto-deploy does not remove this hazard. It makes it *more*
likely, because the deploy lands the instant you push rather than when
you choose.

---

## Deploying the backend

Manual until auto-deploy is enabled:

- **Dashboard:** Railway → `flowspace-v2` → `backend` → Deploy.
- **Connector:** the Railway MCP agent, which is what has been used so
  far. Note it has intermittently returned empty responses and executed
  no tool calls — if that happens, use the dashboard.

Config lives in `backend/railway.json`: `npm start`, healthcheck
`/health`, `ON_FAILURE` restart with 3 retries. Watch patterns are
`backend/**`, so once auto-deploy is on, a docs-only or frontend-only
commit will correctly not rebuild the API.

### To enable auto-deploy

Railway → `flowspace-v2` → `backend` → Settings → Deploys → Auto Deploy.
Then verify with a real push rather than trusting the toggle: change
something under `backend/**`, push, and confirm a new deployment appears.

### Environment variables

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | |
| `SUPABASE_URL` | prod project URL | Must be **prod**, never `hjylkhswlwqiwvztynkw` |
| `SUPABASE_ANON_KEY` | prod anon key | Public by design; RLS is the protection |
| `CORS_ORIGINS` | `https://flowspace-v2.netlify.app` | The server **refuses to boot** on `*` when `NODE_ENV=production` |
| `APP_URL` | `https://flowspace-v2.netlify.app` | See below |
| `SUPABASE_SERVICE_ROLE_KEY` | *unset* | Bypasses RLS. Nothing uses it. Leave it unset |

`APP_URL` is the dangerous one. Invitation links are built from it and
then **emailed to a person**. It defaults to the first `CORS_ORIGINS`
entry, so a missing value fails silently rather than loudly. A wrong
value cannot be corrected after sending — the invitation has to be
revoked and reissued.

---

## Deploying the frontend

Netlify is **not** connected to the repo. Builds happen locally and the
output is uploaded. Consequence worth internalising: **Netlify's own
environment variables are never consulted.** Setting them there changes
nothing.

```bash
cd frontend && npm run build
```

Vite loads `frontend/.env.production` (gitignored) during `build`, which
is where the prod values live. Verify before shipping — a bundle built
with dev values looks identical:

```bash
node -e "const fs=require('fs'),f=fs.readdirSync('dist/assets').find(n=>n.endsWith('.js')),s=fs.readFileSync('dist/assets/'+f,'utf8');console.log('railway',s.includes('backend-production-8d147.up.railway.app'),'| localhost',s.includes('localhost:4000'),'| devproj',s.includes('hjylkhswlwqiwvztynkw'))"
```

Then deploy via the Netlify MCP `deploy-site` operation, which returns a
one-shot `npx @netlify/mcp …` command carrying a signed token. Run it
from `frontend/`. It uploads the directory and builds on Netlify's side.

The connector's **write** path is unreliable — creating the site took
four attempts and setting a single environment variable failed three
times. Reads are fine. Retry; it does eventually succeed.

`frontend/netlify.toml` carries the build config, the SPA redirect and
security headers. The redirect is load-bearing: without it
`/accept-invite?token=…` 404s on a cold load and every invitation breaks.

### Connecting Netlify to the repo

Not done, and it is a real change rather than a convenience:

- Netlify would build from source, so its environment variables would
  start mattering and must be correct **first**.
- `frontend/.env.production` would stop being the source of truth.
- Base directory must be `frontend`.

---

## Database

| | ref | contents |
|---|---|---|
| dev | `hjylkhswlwqiwvztynkw` | all migrations **+ seed** |
| prod | `ajkzoiqsvcibvcodkuzs` | all migrations, **no seed, zero rows** |

Apply migrations to **dev first**, verify, then prod. **Never seed prod.**
Zero rows there is a deliberate invariant — it is what makes "has anyone
used this yet?" answerable, and it is why `scripts/smoke-prod.mjs` is
read-only.

The dev seed publishes six accounts sharing the password `password123` in
a public repo. A deployment pointed at dev is a deployment anyone can log
into.

After any DDL, run the Supabase linter (`get_advisors`, security). It is
what caught migration `0008`: `revoke execute … from public` does **not**
remove the direct grant Supabase issues to `anon`.

Two prod settings live only in the dashboard and no automated check
covers them:

- **Site URL** must be the Netlify origin. `mailer_autoconfirm` is false,
  so sign-up requires an email confirmation whose link is built from it.
- **Leaked-password protection** — currently **disabled** (confirmed by
  the linter).

---

## CI

`.github/workflows/ci.yml`. Two jobs: the frontend production build, and
the 64 backend checks against **dev**. Validated as parsing; **it has
never run**, because it needs repository secrets that only a human can
create.

Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | `https://hjylkhswlwqiwvztynkw.supabase.co` — the **dev** project |
| `SUPABASE_ANON_KEY` | The dev anon key, from Supabase → Project Settings → API |

Only two, and both must point at dev. The workflow hard-fails if
`SUPABASE_URL` contains the prod ref, because these suites write rows.

Not covered by CI: `supabase/tests/rls.test.sql` (psql-driven, manual) and
`scripts/smoke-prod.mjs` (points at live URLs — run it after a deploy,
not on every commit).

---

## Verifying a release

```bash
node scripts/smoke-prod.mjs
```

13 read-only checks: health, unauthenticated refusal, forged-token
refusal, CORS allow and deny, SPA deep links, real assets not rewritten,
no localhost or dev-project reference in the live bundle, security
headers, and the prod auth error path. Exits non-zero on failure. It
never writes, and it must stay that way.

Set `SMOKE_SUPABASE_ANON` to include the auth checks; without it P12/P13
skip and the run fails loudly rather than passing quietly.

## Rollback

- **Backend:** Railway keeps previous deployments — redeploy the last
  good one from the dashboard. If the bad release depended on a
  migration, rolling the code back does **not** roll the schema back.
- **Frontend:** Netlify → Deploys → publish a previous deploy. Instant,
  since it is static output.
- **Database:** there is no automatic rollback. Write a forward migration
  that reverses the change. This is the main reason to prefer
  expand/contract: each step is small enough to reverse on its own.
