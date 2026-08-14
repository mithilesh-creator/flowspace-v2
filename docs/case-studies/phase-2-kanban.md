# Phase 2 — Real-time Kanban

*Case-study summary for the product catalogue. Non-technical, outcome-first.*

## What it does

Phase 1 gave each company a private workspace and boards inside it. Phase 2
makes those boards the place the work actually lives: columns you name
yourself, cards you write work on, and dragging a card from one column to
the next.

A card carries a title, a description, who it is assigned to, and when it is
due. Columns can be renamed, reordered and deleted. Cards move within a
column or across to another one — with a mouse, or entirely from the
keyboard for anyone who does not use one.

Work can only be assigned to someone who is actually in the workspace. The
list of people you can pick from is the list of people who are there, and
if someone leaves, the cards they were working on keep their name with a
"former member" label rather than quietly going blank — so nobody loses
track of who had the job.

The point of the phase is that all of it is live. When a colleague moves a
card, it moves on your screen too — within the same second, without a
refresh, without a "someone else changed this, reload?" banner. Two people
can work the same board at the same time and see one shared picture of it.

Read-only clients see the board exactly as the team does, and cannot change
anything on it. That is enforced the way it was in Phase 1 — by the database
refusing the write, not by hiding a button.

When someone is removed from a workspace, their live view of it stops
immediately. Not when they close the tab, not at some point later — the
moment the removal is made.

## Why it matters

A Kanban board is a shared model of what a team is doing. Its value comes
entirely from everyone believing it is current. The moment two people are
looking at two different versions, the board stops being the source of truth
and the team goes back to asking each other in chat.

Most tools solve this by making you refresh, or by resolving conflicts after
the fact with a warning dialogue. Flowspace pushes each change to everyone
entitled to see it as it happens, and each screen re-reads the whole board
whenever it reconnects — so an update lost to a flaky connection heals
itself instead of leaving one person quietly out of date.

The second thing that matters here is boring and invisible: the columns and
cards inherited Phase 1's security model rather than getting their own. The
database physically cannot record a card from one company inside another
company's column — not because a developer remembered to check, but because
the shape of the data makes that row impossible to write. Cross-company
leakage is the failure that ends a product like this, and the way to survive
it is to make each new feature protected by default.

**Two things worth knowing if you are evaluating this for a team.**

*Work can only be assigned to someone who is actually in the workspace.* It
sounds obvious, and in most tools it is enforced by the dropdown you are
offered. Here it is enforced by the database: even a request that bypasses
the interface entirely cannot attach a card to somebody outside the company
that owns it. That means an assignee is always a real, current colleague —
not a name left over from an old export or a mistyped identifier — so "who
is this with?" always has an answer you can act on.

*Removing someone cuts off their live view immediately.* When a person is
taken out of a workspace, the open board on their screen stops updating
that instant. Previously they could no longer load anything new, but a tab
already open kept receiving the stream of changes until it was closed —
which could be all afternoon. That gap is closed. It matters most for
people who are not permanent staff: a contractor whose engagement ends, or
an outside party who was given a look at a board. It is also the piece that
had to exist before we could offer a client-facing portal at all, because
withdrawing an outsider's access is the whole of that feature.

## How it was proven

The same two-company setup used for Phase 1 — two separate businesses with
one contractor deliberately placed inside both, plus a read-only client
account — was extended to cover the new columns and cards.

Fifty-nine automated checks now run at the interface level, and a separate
suite of twenty-four runs directly against the database, where the rules
actually live. Together they confirm:

- One company can neither read nor change the other's columns or cards.
- A card cannot be dragged into another company's column, even by the one
  person who legitimately belongs to both companies. The attempt is refused
  by the structure of the data, not by a permission check that someone had
  to remember to write.
- A card cannot be dragged onto a board it does not belong to, even inside
  the same company.
- While one company is actively moving cards around, the other company's
  live connection stays completely silent for the entire sequence — not
  "receives events it then ignores", but receives nothing.
- A read-only client can open a board, see everything on it, and change
  nothing.
- Deleting a column — which takes every card in it — is restricted to
  owners and admins, while deleting a single card is ordinary work anyone on
  the team can do.
- A card cannot be assigned to anyone outside the company that owns it,
  including by a request that goes around the interface entirely. The same
  attempt made directly against the database is refused there too.
- A person removed from a workspace stops receiving its live updates
  immediately: across four subsequent changes their connection hears
  nothing, while a colleague's connection in the same workspace hears all
  four — so the silence is the removal working, not the board being quiet.
  They also cannot ask to be let back in.

Alongside that, people worked the same board in two browsers by hand:
dragging between columns, reordering within one, killing the connection
mid-session and confirming the board healed itself on reconnect. The
keyboard path was walked the same way — grabbing a card, moving it with the
arrow keys, dropping it and confirming the change was really saved, then
grabbing another and cancelling to confirm nothing was.

**Where this was proven.** All of the above ran against the development
database, which is the only environment that contains the two rehearsal
companies these checks need. The production system deliberately starts
completely empty, so those same checks cannot be run there without putting
fake companies into a live product — which we are not willing to do. What
production has confirmed so far is that the deployed pieces are correctly
wired to each other and that the sign-in path behaves properly. Everything
above is proven; it is proven in the environment built for proving it.

## Status

**Built, hardened, tested and deployed.** The application is live: the
interface on Netlify, the service on Railway, and a separate, empty
production database.

A hardening pass followed the build. It was never a bug list — the features
worked — it was the set of edges worth closing before the product carries
anyone's real work, and **every one a customer would feel is now closed**:
dragging works from the keyboard, a card can only be assigned to someone
genuinely in the workspace, a removed person's live view stops at once, and
the ordering of cards has a repair path for boards that have been in use a
long time.

What is left of that pass is internal plumbing. The checks described above
are run by a person on demand rather than automatically on every change;
the automation is written but not yet switched on, which needs an
administrator rather than more work.

The first real customer sign-up is the last outstanding test, and it is
deliberately outstanding: an empty production database is the safest state
to be in until someone real is ready to use it.

Next after this: AI task automation (Phase 3), the first feature that reads
the card data this phase creates.
