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

> **Production has real users.** 3 accounts, all email-confirmed, plus 3
> workspaces and 5 memberships, created by actual people. Boards, lists and
> cards are still 0. Anything in this repo that assumes prod is empty is
> out of date — see [Database](#database).

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
Prod had no users at the time, so nothing broke — on a live system it is
an outage. **That escape hatch is gone:** prod now has real accounts, so
the next time this ordering is wrong, someone notices.

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

Currently deployed: commit `7435614` (deployment `5cae9256`, SUCCESS),
pushed by hand, so production matches `main`. The smoke test passed 13/13
against it.

### To enable auto-deploy — dashboard only

Railway → `flowspace-v2` → `backend` → Settings → Deploys → Auto Deploy.
Then verify with a real push rather than trusting the toggle: change
something under `backend/**`, push, and confirm a new deployment appears.

**Do not try to do this through the Railway connector.** It cannot. The
agent happily performs reads and triggers deploys, but silently refuses
this particular write — no error, no change — confirmed over roughly six
attempts across two sessions. Time spent retrying is time wasted; open the
dashboard.

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
| prod | `ajkzoiqsvcibvcodkuzs` | all migrations, **no seed**, real user data |

**Prod is no longer empty.** It holds 3 real users (all email-confirmed),
3 workspaces and 5 memberships, created by actual people. Boards, lists
and cards are still 0.

Apply migrations to **dev first**, verify, then prod. **Never seed prod.**

This document used to justify both that rule and the read-only smoke test
by saying prod had zero rows and that emptiness was worth keeping. That
justification is obsolete. **The rule is stronger now, not weaker:** what
was "don't spoil a clean row count" is now "don't touch other people's
data." If you find the old wording somewhere and conclude the constraint
has expired, you have it exactly backwards.

The dev seed publishes six accounts sharing the password `password123` in
a public repo. A deployment pointed at dev is a deployment anyone can log
into.

After any DDL, run the Supabase linter (`get_advisors`, security). It is
what caught migration `0008`: `revoke execute … from public` does **not**
remove the direct grant Supabase issues to `anon`.

Two prod settings live only in the dashboard and no automated check
covers them:

- **Site URL** — must be the Netlify origin, and it now **is**, confirmed
  the only way it can be: `mailer_autoconfirm` is false, so sign-up
  requires an email confirmation whose link is built from Site URL, and
  three people completed that confirmation. A wrong value could not have
  produced a confirmed account. Earlier notes list this as unverified;
  they are out of date.
- **Leaked-password protection** — still **disabled** (confirmed by the
  linter). Genuinely outstanding, and it matters more now that there are
  real accounts.

### Production tenant isolation, verified against real accounts

Isolation on prod is no longer inferred from the dev suites. It has been
exercised as the actual production users: **6/6**, with every attempted
write rolled back. Cross-tenant reads, cross-tenant writes, roster access,
profile visibility and anonymous access were all refused. Prod row counts
were unchanged afterwards.

---

## CI

`.github/workflows/ci.yml`. Three jobs:

| Job | Runs on | What it does |
|---|---|---|
| `frontend` | push + PR | The production Vite build compiles |
| `backend` | push + PR | The 64 checks in `backend/tests/*.mjs`, against **dev** |
| `smoke` | **`workflow_dispatch` only** | `scripts/smoke-prod.mjs`, against **live production** |

**It has still never run on GitHub** — it needs repository secrets that
only a human can create. But it is no longer only "validated as parsing":
the `backend` job has been reproduced step by step on a developer machine
and it works. See "Dry run" below for what that did and did not prove.

### Secrets

Settings → Secrets and variables → Actions:

| Secret | Value | Needed by |
|---|---|---|
| `SUPABASE_URL` | `https://hjylkhswlwqiwvztynkw.supabase.co` — the **dev** project | `backend` |
| `SUPABASE_ANON_KEY` | The dev anon key, from Supabase → Project Settings → API | `backend` |
| `SMOKE_SUPABASE_ANON` | The **prod** anon key. Public by design; RLS is the protection | `smoke` |

The first two must point at dev, and the workflow hard-fails if
`SUPABASE_URL` contains the prod ref, because those suites write and
delete rows. The third is the odd one out: it is the **prod** key, and
that is correct — the smoke test checks production, and it only ever
reads.

`SMOKE_SUPABASE_ANON` is optional in the sense that eleven of the thirteen
checks do not need it. It is **not** optional in the sense of "the job
will be green without it": the script treats a missing key as a failure
rather than a skip and exits non-zero, so the `smoke` job goes red until
the secret exists. That is deliberate — a smoke test that quietly shrinks
is worse than one that complains — and the job prints a `::warning::`
naming the missing secret so the red is self-explanatory.

### The smoke job is manual on purpose

`frontend` and `backend` run against dev and are safe to fire on every
commit. `smoke` is the only job here that touches production, and
production now holds real user data. Read-only or not, that is traffic
against a system people are using, so it happens when someone asks for
it: Actions → CI → Run workflow. Run it after a production deploy.

Dispatching the workflow re-runs `frontend` and `backend` too. That is
intended — a manual run means "check everything" — but note that it also
means a manual smoke run writes to **dev**, via the backend suites.

A manual dispatch gets its own `concurrency` group keyed by run id, so a
push cannot cancel a run someone asked for by hand, and vice versa.

### Dry run — what was actually verified locally

The `backend` job was reproduced on a developer machine: each `run:` block
executed verbatim under `bash -e` from `backend/`, with stand-in
`$RUNNER_TEMP` and `$GITHUB_ENV` and `$GITHUB_ENV` sourced between steps,
the way the runner does it.

Confirmed working:

- **`npm ci`** from `backend/package-lock.json` — 107 packages, 0
  vulnerabilities, `socket.io-client` present. It is a devDependency and
  three of the four suites import it, so a `--omit=dev` install would fail
  the job.
- **The scratch `backend/.env`** — six keys, and the suites do need the
  file rather than just the environment, because every script in
  `backend/package.json` is `node --env-file=.env …`.
- **`SERVER_PID` crossing the step boundary** via `$GITHUB_ENV`. This was
  the main unknown, since `$GITHUB_ENV` does not exist outside Actions. It
  carries.
- **The health-poll loop, both branches.** Healthy: `curl` succeeds and
  the step exits 0 with the API still running in the background — it
  survives the step because both its streams are redirected to a file.
  Unhealthy: with `SUPABASE_URL` blanked so `config/env.js` throws at boot,
  the `kill -0` guard failed the step in **2 seconds** with the stack trace
  in the log, instead of burning the full 30-second poll.
- **The secret guard, every branch.** Both secrets empty (which is exactly
  what CI sees today, since GitHub injects an absent secret as an empty
  string), one empty, prod ref, dev ref — correct exit code and message in
  all four.
- **`npm test` — 64/64 passed** against dev: 9 realtime, 12 invitations,
  18 kanban, 25 hardening.

One thing was **broken and has been fixed**: `Stop the API` ran
`kill "$SERVER_PID"`, but `$SERVER_PID` is the pid of the `npm` wrapper
and the API is npm's child. SIGTERM to npm left the node process alive and
still holding `:4000`. The step now kills children first
(`pkill -P`) and then the wrapper. On a hosted runner this is cosmetic —
the VM is destroyed regardless — but it is the step anyone reproducing the
job locally depends on, and it silently did nothing.

What the dry run does **not** prove: `actions/checkout`, `setup-node` and
its npm cache, the fork-PR `if:` guard, and the concurrency groups. Those
are runner features with no local equivalent. The first GitHub run is
still the first GitHub run.

### The frontend job's zero-`VITE_` claim holds

The job supplies no `VITE_*` variables and asserts the build succeeds
anyway. That was re-checked, because if it were false the job would fail
the moment CI first ran: `frontend/.env` **and** `frontend/.env.production`
moved aside — both are gitignored, so their absence is the true shape of a
fresh CI checkout — and no `VITE_*` in the shell.

`npm run build` **exits 0**, 122 modules transformed. The claim is true.
Nothing dereferences the missing values at build time;
`frontend/src/lib/supabase.js` only throws when the module is imported in
a browser.

The same run also proves the second half of that comment — the CI bundle
is not deployable. Built with no env, it falls back to `localhost:4000`
and contains no Supabase URL at all, and its content hash differs from the
real production bundle. It is a compile check and is deliberately not
uploaded as an artifact.

### Reproducing the backend job yourself

Worth knowing, because one of these will waste your afternoon otherwise:

- **Free `:4000` first.** The poll only asks whether *something* answers
  `/health` there. A dev server left running satisfies it instantly and
  the job appears to pass while testing the wrong process. CI gets a fresh
  VM; you do not.
- **Back up `backend/.env`.** The job overwrites it with `NODE_ENV=test`
  and no `SUPABASE_SERVICE_ROLE_KEY` line. It is gitignored, so git will
  not warn you and will not restore it.
- **`npm ci` deletes `node_modules`,** which fails on Windows while a
  server is running out of it. Another reason to stop the dev server
  first.

### Not covered by CI

`supabase/tests/rls.test.sql` — psql-driven, no npm script, stays manual.

---

## Verifying a release

```bash
node scripts/smoke-prod.mjs
```

Or, without a checkout: Actions → CI → Run workflow.

13 read-only checks: health, unauthenticated refusal, forged-token
refusal, CORS allow and deny, SPA deep links, real assets not rewritten,
no localhost or dev-project reference in the live bundle, security
headers, and the prod auth error path. Exits non-zero on failure.

Set `SMOKE_SUPABASE_ANON` to the prod anon key to include the auth checks;
without it P12/P13 fail rather than skip, so the run goes red instead of
passing quietly with fewer checks.

### It is read-only — audited, not assumed

Prod holds real user data now, so this claim was checked rather than
trusted, and the reasoning is recorded here so nobody has to redo it:

- **One network primitive.** Every request in the file goes through
  `probe()`, and `probe()` is the only place `fetch` appears.
- **Thirteen call sites, one non-idempotent verb.** Eleven GET, two
  `OPTIONS` CORS preflights — which cannot mutate by definition, and which
  the `cors()` middleware short-circuits before any route — and exactly
  one POST.
- **That POST is a sign-IN, not a sign-up.** It hits GoTrue's
  `/auth/v1/token?grant_type=password`. Account creation is `/signup`,
  which the file never calls, so it cannot create or modify a user. The
  address is `smoke-probe-nonexistent@example.invalid`; `.invalid` is
  reserved by RFC 2606 and can never be registered, so it cannot collide
  with a real account either. A 400 is the pass condition — the check is
  that the auth chain is wired, not that anyone logged in.
- **`redirect: 'manual'`** on every request. The script cannot be bounced
  onto an endpoint it did not choose.
- **No credentials that could write.** It reads four env vars, all
  `SMOKE_*`. There is no service-role key anywhere in the file; the anon
  key it does take is bounded by RLS, so its worst case is a public read.
- **No imports, no filesystem, no subprocesses.** Zero dependencies —
  global `fetch` only — and no `fs`, `child_process`, `eval` or `Function`.
- **The one deep link that looks dangerous is not.**
  `/accept-invite?token=smoke-probe` is a GET to the **Netlify static
  host**, which returns `index.html`. Redemption is a client-side POST to
  the API, and `fetch` executes no JavaScript. The token is also
  nonsense and could never hash-match a real invitation.

**Verdict: provably read-only against application data.** Being precise
about the one piece of residue rather than overclaiming: a failed sign-in
does leave an entry in Supabase's own auth audit log and counts against
the auth rate limit (one attempt per run, well inside the default). No
application table is touched and no user-visible state changes.

To keep the verdict true, three properties have to hold, and all three are
cheap to check in review: `probe()` stays the only caller of `fetch`, no
new verb other than GET/OPTIONS is introduced, and the file keeps zero
imports.

## Rollback

- **Backend:** Railway keeps previous deployments — redeploy the last
  good one from the dashboard. If the bad release depended on a
  migration, rolling the code back does **not** roll the schema back.
- **Frontend:** Netlify → Deploys → publish a previous deploy. Instant,
  since it is static output.
- **Database:** there is no automatic rollback. Write a forward migration
  that reverses the change. This is the main reason to prefer
  expand/contract: each step is small enough to reverse on its own.
