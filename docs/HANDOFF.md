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
| 1 — Multi-tenant workspaces, Auth, RLS | **Shipped and deployed** |
| 2 — Real-time Kanban | **Shipped, deployed, hardened** (H1–H6, H9, H10) |
| 3 — AI task automation | **Not started.** Spec: `docs/phase-3-spec.md` |
| 4 — Client portal | Not started. **Its blocker is now cleared** (H4) |
| 5 — Billing, onboarding, admin | Not started |

**64 automated checks pass** (`cd backend && npm test`): 9 realtime, 12
invitation, 18 kanban, 25 hardening. Plus `supabase/tests/rls.test.sql`
(psql, manual) and `scripts/smoke-prod.mjs` (13 read-only prod checks).

Live: <https://flowspace-v2.netlify.app> ·
<https://backend-production-8d147.up.railway.app> ·
repo `mithilesh-creator/flowspace-v2` (public).

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

**5. Prod has zero rows, deliberately.** The suites cannot run there —
they need seeded two-tenant fixtures. Never seed prod. The smoke test is
read-only for this reason.

## Outstanding, in priority order

| # | Item | Who can do it |
|---|---|---|
| 1 | **First real sign-up on prod** — the last unverified thing in Phase 1/2 | Human. Requires creating an account |
| 2 | **Enable Railway auto-deploy**, then verify with a real push | Human, dashboard |
| 3 | **Create CI secrets** — `SUPABASE_URL`, `SUPABASE_ANON_KEY` (dev values) | Human. CI has never run |
| 4 | **Prod Site URL** → the Netlify origin. Sign-up needs email confirmation, and the link is built from it | Human, Supabase dashboard |
| 5 | **Leaked-password protection** on prod — confirmed disabled | Human, Supabase dashboard |
| 6 | Extend `supabase/tests/rls.test.sql` for H1–H3 | Next session |
| 7 | Cards have no `unique (list_id, position)`; lists do. Undecided, and it matters for bulk AI inserts | Next session |
| 8 | `docs/architecture.md` is still titled "Phase 1" | Trivial |

Items 1–5 are all human-only. Nothing in Phase 3 is blocked by them.

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
