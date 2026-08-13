# Phase 2 — Real-time Kanban

*Case-study summary for the product catalogue. Non-technical, outcome-first.*

## What it does

Phase 1 gave each company a private workspace and boards inside it. Phase 2
makes those boards the place the work actually lives: columns you name
yourself, cards you write work on, and dragging a card from one column to
the next.

A card carries a title, a description, who it is assigned to, and when it is
due. Columns can be renamed, reordered and deleted. Cards move within a
column or across to another one.

The point of the phase is that all of it is live. When a colleague moves a
card, it moves on your screen too — within the same second, without a
refresh, without a "someone else changed this, reload?" banner. Two people
can work the same board at the same time and see one shared picture of it.

Read-only clients see the board exactly as the team does, and cannot change
anything on it. That is enforced the way it was in Phase 1 — by the database
refusing the write, not by hiding a button.

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

## How it was proven

The same two-company setup used for Phase 1 — two separate businesses with
one contractor deliberately placed inside both, plus a read-only client
account — was extended to cover the new columns and cards.

Thirty-nine automated checks now run at the interface level, and a separate
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

Alongside that, two people worked the same board in two browsers by hand:
dragging between columns, reordering within one, killing the connection
mid-session and confirming the board healed itself on reconnect.

**Where this was proven.** All of the above ran against the development
database, which is the only environment that contains the two rehearsal
companies these checks need. The production system deliberately starts
completely empty, so those same checks cannot be run there without putting
fake companies into a live product — which we are not willing to do. What
production has confirmed so far is that the deployed pieces are correctly
wired to each other and that the sign-in path behaves properly. Everything
above is proven; it is proven in the environment built for proving it.

## Status

**Built, tested and deployed.** The application is live: the interface on
Netlify, the service on Railway, and a separate, empty production database.

A hardening pass is underway now. It is not a bug list — the features work —
it is the set of edges worth closing before the product carries anyone's
real work: keyboard-accessible dragging so the board is usable without a
mouse, tighter rules about who a card can be assigned to, automated checks
running on every change, and closing a known gap where someone removed from
a workspace could keep receiving its live updates until they closed their
browser tab. That last one is the one that has to be finished before the
client portal, where withdrawing an outsider's access is the whole feature.

The first real customer sign-up is the last outstanding test, and it is
deliberately outstanding: an empty production database is the safest state
to be in until someone real is ready to use it.

Next after this: AI task automation (Phase 3), the first feature that reads
the card data this phase creates.
