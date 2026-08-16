# Handoff — start here

Written at the end of Phase 2 so Phase 3 can begin without archaeology.
Everything below was verified, not assumed. Where something is unproven,
it says so.

## What this is

Flowspace v2 — multi-tenant SaaS Kanban, Division 1 / Project #1. Read
`CLAUDE.md` first; it is the project's constitution and its conventions
are not negotiable.

**The one idea:** RLS is the only authorization layer. The API forwards
the caller's Supabase token to Postgres and lets policies decide. It never
re-implements permission checks. Where an invariant can be expressed as a
key instead of a policy, it is — composite foreign keys make cross-tenant
rows *unrepresentable* rather than merely forbidden. Preserve this. It is
the single most valuable property of the codebase.

## Status

| Phase | State |
|---|---|
| 1 — Multi-tenant workspaces, Auth, RLS | **Shipped, deployed, verified in production** |
| 2 — Real-time Kanban | **Shipped, deployed, hardened** (H1–H10 complete) |
| 3 — AI task automation | **Not started.** Spec: `docs/phase-3-spec.md` |
| 4 — Client portal | Not started. **Its blocker is now cleared** (H4) |
| 5 — Billing, onboarding, admin | Not started |

**Phase 2 is closed.** All ten hardening items are done: H1–H6 shipped and
deployed, H9 covered by 25 assertions, H7 (CI) written and dry-run
locally, H8 (`docs/deployment.md`) written, H10
(`scripts/smoke-prod.mjs`) written and passing.

**64 automated checks pass** (`cd backend && npm test`): 9 realtime, 12
invitation, 18 kanban, 25 hardening. Plus `supabase/tests/rls.test.sql`
(psql, manual) and `scripts/smoke-prod.mjs` — 13 read-only production
checks, 13/13.

Live: <https://flowspace-v2.netlify.app> ·
<https://backend-production-8d147.up.railway.app> ·
repo `mithilesh-creator/flowspace-v2` (public). Backend is running commit
`7435614` (deployment `5cae9256`).

**CI exists but has never run in Actions.** The workflow was dry-run step
by step on a developer machine, which caught a real defect — `SERVER_PID`
is npm's pid, not node's, so the teardown step silently left the API
alive. Everything since is verified locally only: `actions/checkout`, the
npm cache, the fork-PR guard and the concurrency groups have no local
equivalent, and the two repository secrets do not exist yet. Treat the
first real run as a first run.

## Read these before writing code

1. `CLAUDE.md` — conventions.
2. `docs/architecture.md` — the tenant boundary and where it lives.
3. `docs/deployment.md` — how anything actually ships. **Non-obvious.**
4. `docs/socket-events.md` — the realtime contract.
5. `docs/phase-3-spec.md` — what Phase 3 is, and the decisions it needs.

## The five things that will trip you up

**1. Nothing deploys on `git push`.** Railway auto-deploy is off and
Netlify is not repo-connected. Verified twice — commits `3731804` and
`ec5042e` both sat unbuilt. Deploy manually and confirm it happened.

**2. Migrate and deploy are separate, so ordering matters.** Migration
`0012` added a `NOT NULL` column ahead of its code and briefly left prod
unable to insert cards. Use expand/contract. Full explanation in
`docs/deployment.md`.

**3. A green build is not evidence a page renders.** `CardEditor` called
an undefined `memberOptionLabel`; `npm run build` passed because a
`ReferenceError` is a runtime fault. Opening any card blanked the entire
app. **Click the thing in a browser.**

**4. New SECURITY DEFINER functions need an explicit
`revoke execute … from anon`.** Revoking from the `public` pseudo-role
does *not* remove the direct grant Supabase issues to `anon`. This is the
entire reason migration `0008` exists. Run `get_advisors` after any DDL.

**5. Prod holds real user data.** Three accounts, three workspaces, five
memberships, belonging to actual people. The suites still cannot run
there — they need seeded two-tenant fixtures under fixed IDs, and prod has
no seed. Never seed prod, and never write to it from a script. The old
justification ("keep the row count at zero") is obsolete; the rule is
stronger now, not weaker.

## Outstanding, in priority order

| # | Item | Who can do it |
|---|---|---|
| 1 | ~~First real sign-up on prod~~ **DONE** — see below | — |
| 2 | ~~Prod Site URL~~ **DONE** — proven by three confirmed sign-ups | — |
| 3 | **Enable Railway auto-deploy.** Confirmed still disabled. Cannot be done through the Railway MCP agent: it executes reads and deploys but silently refuses the write, across ~6 attempts. Dashboard → backend → Settings → Deploys | Human, dashboard only |
| 4 | **Create CI secrets** — `SUPABASE_URL`, `SUPABASE_ANON_KEY` (dev values) | Human. CI has never run |
| 5 | **Leaked-password protection** on prod — confirmed disabled by the linter | Human, Supabase dashboard |
| 6 | Extend `supabase/tests/rls.test.sql` for H1–H3 | Next session |
| 7 | Cards have no `unique (list_id, position)`; lists do. Undecided, and it matters for bulk AI inserts | Next session |
| 8 | `docs/architecture.md` is still titled "Phase 1" | Trivial |

Items 3–5 are human-only. Nothing in Phase 3 is blocked by them.

## Production is verified, not just deployed

This was Phase 1's outstanding asterisk and it is now closed.

Prod has **3 real users** (all email-confirmed, so Site URL is correct),
**3 workspaces**, **5 memberships** — and the roles prove invitations work
end to end in production: one workspace has an owner plus a member,
another an owner plus a `client`.

That real data made an isolation check possible against production for
the first time. Run as those actual accounts, every block rolled back,
**6/6 passed**:

| | |
|---|---|
| P-T1 | An owner sees only their own workspace, not the other two live ones |
| P-T2 | Cannot read another tenant's member roster |
| P-T3 | Board insert into another live tenant refused (42501) |
| P-T4 | No cross-tenant user directory — sees only their own profile |
| P-T5 | The genuinely dual-workspace user sees exactly their two |
| P-T6 | `anon` reads nothing from production |

Row counts were unchanged afterwards. Note prod has **0 boards**: nobody
has created one yet, so lists, cards and realtime remain unexercised by
real users even though they are covered by the dev suites.

The zero-rows invariant that `scripts/smoke-prod.mjs` was built around no
longer holds — prod has real data now. The smoke test is still read-only
and must stay that way, but for a stronger reason than before: those rows
belong to real people.

## Known residuals

- **Token revocation is not immediate.** A removed member's socket is
  evicted at once and RLS refuses them everything, but their access token
  stays valid for up to an hour. What remains is token *validity*, not
  authority.
- **Broadcasts are at-most-once.** Socket.io does not replay. Clients
  resync on `org:joined` rather than trusting the stream.
- **Eviction assumes one Node process.** `fetchSockets()` over the
  `user:<uuid>` room is the cheap implementation; a second replica breaks
  it. This is the one call to change if the deployment shape does.
- **The SQL suite was never extended for H1–H3.** It is still `T01`–`T24`.
  Equivalent coverage exists through PostgREST in `hardening.test.mjs`, so
  the properties *are* tested — but not at the layer the contract asked
  for. Recorded rather than papered over.
- **Cards have no `unique (list_id, position)`; lists do.** Deliberate for
  drag-and-drop (a unique index turns concurrent drops into 409s), but it
  means ties are possible and ordering falls to `(position, created_at)`.
  Revisit before Phase 3 inserts subtasks in bulk.

## Before starting Phase 3

`docs/phase-3-spec.md` lists blocking decisions. The two that matter most:

- **Where the Anthropic API key lives.** Backend only. It must never
  reach the browser — anything `VITE_`-prefixed is compiled into the
  bundle and served to every visitor.
- **Per-tenant cost control.** An AI feature on a multi-tenant product is
  a shared, metered resource. Decide the limit before building, not after
  the first bill.

Also note H2 changed the card shape: cards carry `board_id`, `NOT NULL`,
inside a three-column foreign key. Bulk-inserting AI-generated subtasks
must populate it.

## First moves in a new session

1. Read `CLAUDE.md`, then this file, then `docs/architecture.md`.
2. `cd backend && npm start` in one shell — most local work needs the API
   on `:4000`, and every test suite fails with `ECONNREFUSED` without it.
   `node` may not be on PATH; it lives at `C:\Program Files\nodejs`.
3. `cd backend && npm test` — expect **64/64**. If it fails, fix that
   before anything else; it is the project's baseline.
4. `node scripts/smoke-prod.mjs` — expect **13/13**. Confirms the live
   deployment still works before you change anything.
5. Only then start Phase 3.

Do not run `supabase db reset` against dev without reason — it is a shared
database and other work depends on its seeded fixtures. Never point
anything at prod.
