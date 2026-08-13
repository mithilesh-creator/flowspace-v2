# Phase 3 spec — AI task automation

**Status: draft. Nothing here is built, and nothing here is decided.**

This is a document to think against before Phase 3 starts, not an
implementation plan. Where it states a fact about the existing system, that
fact is checkable in the repo today. Where it proposes a design, it says
"proposed". Where it does not know, it asks a question and leaves it open.

Scope is the three features `CLAUDE.md` names, in that order:
auto-subtasks, priority suggestions, standup summaries. Nothing else.

**Precondition:** Phase 2 is shipped and the hardening pass H1–H10 is in
flight. Phase 3 should not start until H1–H4 are closed and their tests
pass — H1 in particular, because AI-generated cards will want assignees and
the membership constraint is what makes an assignee meaningful.

---

## 1. What each feature does, in product terms

### 1.1 Auto-subtasks

**The user's experience.** A member opens a card with a title like "Migrate
billing to Stripe" and a paragraph of description. They press a button. A
few seconds later the card offers a proposed checklist — six or eight
smaller pieces of work, in a sensible order — and the member accepts the
list, edits it, or discards it.

**The value.** The hard part of a Kanban board is not moving cards, it is
writing them. A card that says "migrate billing" is not workable; the same
card broken into eight steps is. The feature converts intent into
something a team can actually pick up.

**Decisions this raises, all open:**

- Do subtasks become **real cards** in the same list, or a new lightweight
  `subtasks` table hanging off a card? Cards mean they inherit RLS,
  realtime and drag-and-drop for free, at the cost of flooding a board with
  eight new cards from one click. A new table means new policies, new
  events, new UI. **This is the biggest structural decision in the phase
  and it should be made before anything else.**
- Are they applied automatically or proposed and accepted? Proposed, per
  §4.4. Automatic writes make an AI failure indistinguishable from a user's
  own edit.
- Does the request see the whole board, the list, or only the card? The
  more context, the better the suggestion and the higher the token bill.

### 1.2 Priority suggestions

**The user's experience.** A member looks at a list of thirty cards and
asks which to do next. The system proposes an ordering, or tags a handful
as high/medium/low, with one sentence of reasoning per card.

**The value.** Ordering a backlog is the work people avoid. A defensible
starting order that a human then corrects is worth more than a blank
opinion.

**Decisions this raises, all open:**

- **Cards have no priority field today.** `cards` carries `title`,
  `description`, `position`, `assignee_id`, `due_date`. Adding a priority
  is a migration and a schema decision, and it is a product decision first:
  is priority an enum, a score, or just the existing `position`?
- If the suggestion reorders cards, it collides directly with `position`,
  and with gap 9 in `docs/product-roadmap.md` — cards have no unique
  constraint on `(list_id, position)`, so a bulk reordering has no
  collision detection. Resolve gap 9 before building this.
- What signal does the model actually have? Titles, descriptions, due
  dates, assignees, list names. It does not know the business. A suggestion
  presented as authoritative will be wrong in ways the team can see, which
  is worse than no suggestion. The framing must be "a starting point".

### 1.3 Standup summaries

**The user's experience.** A daily or on-demand summary of what moved on a
board: what was finished, what started, what has not moved, what is
overdue. Delivered in the app; possibly by email later, which is a
different feature with its own consent problem.

**The value.** The board already holds the answer to "what happened
yesterday" and nobody reads it. This is the one of the three that is
mostly mechanical — most of the summary is a database query, and the model
only writes the prose.

**Decisions this raises, all open:**

- **The data to summarise does not exist.** There is no activity log. Cards
  carry `created_at` and `updated_at` but nothing records that a card moved
  from "In Progress" to "Done", who moved it, or when. A summary built only
  on `updated_at` can say "this card changed" and nothing more. Either
  Phase 3 adds an append-only `card_events` table, or standup summaries are
  much weaker than the name suggests. **Decide this first; it is a bigger
  piece of work than the AI call.**
- On-demand or scheduled? Scheduled means a job with no user session, which
  is the first legitimate use of `SUPABASE_SERVICE_ROLE_KEY` — and per
  `docs/architecture.md` that is the one path where a mistake removes
  tenant isolation entirely. On-demand, running as the requesting user
  through RLS, is far safer and should be the v1.
- Per board, or per org? Per board is simpler and matches how the
  realtime payloads are already shaped.

---

## 2. Where this sits in the existing architecture

The load-bearing constraint from `docs/architecture.md` is unchanged and
non-negotiable:

> **RLS is the only authorisation layer.**

AI features must not become a second copy of the tenant rule. Concretely:

**The Claude API call happens in the Express backend, in a new
`backend/src/ai/` module, behind new routes.** Never in the browser. See
§3.1 — this is a security requirement, not a preference.

**The read side goes through `req.supabase`, exactly like every other
route.** The AI code should not have a privileged path to card data. If the
requesting user cannot read a card through RLS, the model must not see it
either. This is what makes "the AI leaked another tenant's data" a
structurally impossible sentence rather than a bug class. `adminClient()`
stays quarantined.

**The write side goes through the same routes that already exist.**
Accepting a set of generated subtasks should call the same insert path as
creating a card by hand — same policies, same validation, same
`card:created` broadcasts, same echo suppression. A separate write path is
a second copy of the rules.

Proposed shape, in the style of the existing routes:

```
POST /api/orgs/:orgId/boards/:boardId/cards/:cardId/suggest-subtasks
POST /api/orgs/:orgId/boards/:boardId/suggest-priorities
POST /api/orgs/:orgId/boards/:boardId/standup
```

All three sit under the existing `requireAuth` → `requireOrgMember` chain,
with `requireOrgRole('owner','admin','member')` for anything that can
result in a write. Nesting under `/boards/:boardId` matches Phase 2 and
means the board is already authorised by the time the handler runs.

**Realtime.** Suggestions are per-user and must **not** broadcast — a
proposal is not shared state until someone accepts it. Only the accept
step, which goes through the normal card routes, emits `card:*`. If a
suggestion ever does need to be shared, it is a new event in
`docs/socket-events.md` and Backend owns that file.

**The `client` role.** Read-only means read-only. A client must not be able
to invoke any of these — even the read-only-looking standup summary,
because it spends the tenant's money. Writes are already
`owner|admin|member`; the standup route needs the same restriction
deliberately, not by accident.

**New surfaces Phase 3 introduces that do not exist in the repo today:**
an outbound paid API call, a secret (`ANTHROPIC_API_KEY`), per-tenant cost
exposure, a dependency whose latency the current UI has no pattern for,
and — probably — the activity log.

---

## 3. Questions that need answering before building

### 3.1 Where the API key lives, and why it must never reach the browser

**The rule: `ANTHROPIC_API_KEY` is a backend-only environment variable on
Railway, in the same slot as any other server secret, and it never appears
in `frontend/.env*`, in the Vite bundle, or in any response body.**

**Why this is not negotiable.** The frontend is a static Vite SPA. Every
`VITE_`-prefixed variable is **baked into the JavaScript at build time** and
served to anyone who loads the page — that is already documented in
`README.md` for the Supabase URL and anon key, which are public by design.
An Anthropic key is not. A key in the bundle is a key published on the
internet: anyone can read it out of the served JS and spend against the
account until it is revoked, and there is no way to un-publish a build that
has already been downloaded. The only remedy is rotation, after the fact.

This is different from the Supabase anon key, and the difference is worth
stating because the two look similar in a `.env` file. The anon key is
safe to publish because **RLS constrains what it can do** — it is an
identity, not an authorisation. The Anthropic key has no equivalent
backstop: possession is authorisation, and the blast radius is a billing
account rather than a row.

Practical consequences:

- `backend/.env.example` gains `ANTHROPIC_API_KEY=`; `frontend/.env.example`
  does not, and no `VITE_ANTHROPIC_*` variable may ever exist.
- The key is set in Railway's variables, alongside `SUPABASE_ANON_KEY` and
  `CORS_ORIGINS`. It is never committed. Per `CLAUDE.md`: no hardcoded
  secrets, `.env.example` kept up to date.
- The backend must never echo the key, or any part of an upstream error
  that might contain it, into a response body or a client-visible log.
- **Open question:** should the backend refuse to boot without it once
  Phase 3 ships, the way it already refuses to boot on `CORS_ORIGINS=*`? A
  loud failure at deploy time beats a 500 on the first user request.
- **Open question:** one org-wide key, or a per-tenant bring-your-own-key
  option? BYOK moves the cost to the customer and is a plausible paid
  feature, but it means storing a customer secret in the database, which is
  a materially larger security commitment than anything in the repo today.
  Default answer for v1: **one key, ours.**

### 3.2 Per-tenant cost control and abuse limits

**This is the first feature where a user action costs real money, and the
current system has no concept of that.** There is no billing (Phase 5), no
usage table, no rate limiting anywhere in the backend, and sign-up is open
with only email confirmation. A single authenticated user can currently
call any endpoint as fast as they can issue requests. Applied to a paid
API, that is an uncapped bill.

Questions that need answers before a single call is made:

- **What is the per-tenant cap, and what happens at the cap?** A hard stop
  with a clear message is honest. Silent degradation is not. A cap needs a
  counter, which means a usage table, which is a migration.
- **What is the unit — requests, or tokens?** Requests are simple and
  wrong: one standup over a 300-card board costs vastly more than one over
  an empty one. Tokens are the real unit. The Claude API returns exact
  usage on every response (`usage.input_tokens`, `usage.output_tokens`,
  plus cache fields), and `client.messages.count_tokens()` can price a
  request *before* sending it — which is how a pre-flight cap can refuse
  rather than overspend.
- **Where does the counter live?** A tenant-scoped table with RLS, like
  everything else. It is written by the backend on behalf of the user, so
  the usual "who may write this" question applies and the answer must not
  be `adminClient()`.
- **Per-user limits as well as per-tenant?** One member should not be able
  to exhaust their whole org's allowance. Both, probably.
- **Which model, and is that a per-feature choice?** The three features are
  not equally hard. Standup summaries are largely formatting; auto-subtasks
  benefit from stronger reasoning. `claude-opus-5` is $5/$25 per million
  input/output tokens; `claude-sonnet-5` is $3/$15; `claude-haiku-4-5` is
  $1/$5. Pick per feature after measuring, not up front.
- **Prompt caching, and does it actually apply here?** Caching pays off
  when a large prefix is stable across requests. A board's card list is not
  stable — it changes constantly — so the reusable prefix here is the
  system prompt and instructions, and it must be **at the front, before any
  board data**. Caching is a prefix match: one card title interpolated
  early invalidates everything after it. Worth designing for, not worth
  assuming.
- **Batching for scheduled work.** If standup summaries ever become
  scheduled and org-wide, the Batches API runs asynchronous requests at
  50% of standard price. Irrelevant for on-demand v1; relevant the moment a
  cron job exists.
- **Abuse, specifically.** The realistic attack is not clever: sign up, get
  confirmed, create an org, hold down a button. Prod is open for sign-up.
  Rate limiting on the AI routes is therefore a launch requirement, not a
  hardening item, and it should be per-user and per-org, enforced before
  the upstream call is made.

### 3.3 What happens when the model is slow or unavailable

The current UI has no pattern for this. Every existing request is a
database round trip that either succeeds in milliseconds or fails. An AI
call can take many seconds, can be rate-limited, can be overloaded, and can
decline.

Cases that need a defined behaviour:

- **Slow.** Seconds, not milliseconds — and longer for a large board.
  Needs a visible pending state, and a decision on whether to stream. The
  API supports streaming; streaming is the difference between "the app
  froze" and "it is working". **Open question:** is a streamed suggestion
  worth the frontend complexity in v1, or is a spinner with a cancel button
  enough?
- **Rate-limited (429).** The upstream returns `retry-after`; the SDK
  retries automatically with backoff by default. The question is what the
  *user* sees: a queue, a "try again shortly", or a hard failure.
- **Overloaded (529) and 5xx.** Retryable. Same question.
- **Timeout.** The backend needs its own ceiling, well under any proxy or
  browser timeout, so a hung upstream cannot pin an Express worker
  indefinitely. What is the number? Unanswered.
- **Refusal.** A response can come back with `stop_reason: "refusal"` and
  an empty or partial body. Code that reads the first content block
  unconditionally breaks on this. Check `stop_reason` first, and treat it
  as a clean product-level "could not generate a suggestion", not a 500.
- **Malformed output.** The model can return something that does not match
  the shape the UI expects. Structured outputs (`output_config.format` with
  a JSON schema) constrain the response and are the right tool here — but
  a refusal or a `max_tokens` truncation can still produce output that does
  not validate, so the parse must be defensive regardless.
- **Down entirely.** Every AI feature must be **strictly additive**. If the
  Anthropic API is unreachable, the board must work exactly as it does
  today: create cards, drag them, invite people. The failure must be
  contained to the AI panel. A card that cannot be created because a
  suggestion service is down is an unacceptable coupling, and it is easy to
  build by accident if the AI call ends up inside an existing route rather
  than beside it.
- **Partial application.** If eight subtasks are accepted and card five
  fails to insert, what is the state? Either all-or-nothing in one
  transaction, or a clearly reported partial result. Silently creating four
  is the worst option. Unanswered.

An explicit non-goal for v1: no background job queue. On-demand,
request-scoped calls only. A queue is the right answer eventually and the
wrong thing to build first.

### 3.4 How AI-generated content is marked as such

**The principle: a user must always be able to tell what a machine wrote,
and the record must survive the suggestion being accepted.**

Two distinct requirements, easy to conflate:

1. **At suggestion time.** The proposal is visibly a proposal — clearly
   labelled, requiring an explicit accept, and editable before accepting.
   Nothing is written to the database until a human acts.
2. **After acceptance.** The card carries a durable marker that it
   originated as a suggestion. This is the harder one and it needs a schema
   decision.

Questions:

- **Is provenance a column on `cards`, or a separate table?** A nullable
  `source` (`'human' | 'ai_suggested'`) is the cheap version. A separate
  table can record which model, which prompt version, when, and at whose
  request — which matters if a suggestion is ever wrong in a way somebody
  needs to trace. **Unanswered.**
- **Does provenance survive editing?** If a member accepts a generated
  subtask and then rewrites the title entirely, is it still AI-generated?
  Arguable both ways. Pick one and write it down.
- **Does the marker appear in the API and in socket payloads?** If it is a
  column on `cards`, it appears in `CARD_COLUMNS` and therefore in every
  `card:*` event automatically. That is probably right, and it is a
  contract change to `docs/socket-events.md` (Backend owns that file).
- **What does the client portal see?** Phase 4 shows boards to external
  parties. "This was drafted by AI" is exactly the kind of thing an outside
  client should be able to see, and exactly the kind of thing that is
  embarrassing to add retroactively. Design the marker now with the portal
  in mind.
- **Standup summaries are ephemeral text, not rows** — so they need
  labelling in the UI, but no schema. Unless they get stored, in which case
  they do. Another reason to decide the storage question early.

**A standing rule regardless of how the questions above resolve:** the
product must never present machine-generated text as a human's writing, and
must never attribute a generated card to a person as its author. The
requesting user is who *asked*; the model is who *wrote*.

---

## 4. Non-goals for Phase 3

Stated so they do not creep in:

- No chat interface, no general-purpose assistant.
- No background job queue and no scheduled runs. On-demand only.
- No fine-tuning, no embeddings, no vector search, no RAG over board
  history.
- No AI writes without explicit human acceptance.
- No use of `adminClient()` / `SUPABASE_SERVICE_ROLE_KEY`. If a feature
  seems to need it, that is a signal the design is wrong for this phase.
- No customer-supplied API keys.
- No email delivery of standup summaries.

---

## 5. Open questions, collected

The ones that block a start, in rough dependency order:

1. Are subtasks cards, or a new table? (§1.1)
2. Does Phase 3 include an activity log, and is that a prerequisite for
   standup summaries or a fast-follow? (§1.3)
3. Does `cards` gain a priority field, and what shape? (§1.2)
4. Is gap 9 — cards have no `(list_id, position)` uniqueness — resolved
   before bulk reordering is built? (§1.2)
5. What is the per-tenant cost cap, in what unit, stored where? (§3.2)
6. What are the rate limits, per-user and per-org, and are they in place
   before the first call ships? (§3.2)
7. Backend request timeout for an upstream call — what number? (§3.3)
8. Streaming or spinner for v1? (§3.3)
9. Provenance: column or table, and does it survive editing? (§3.4)
10. Does the backend refuse to boot without `ANTHROPIC_API_KEY`? (§3.1)

None of these are technical unknowns. They are product decisions that will
be made badly under time pressure if they are not made now.
