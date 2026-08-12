# Phase 2 — Real-time Kanban (DRAFT, in progress)

> **DRAFT — NOT YET BUILT, NOT YET VERIFIED.**
> Phase 2 is under construction as this is written. Everything below
> describes what the feature is *intended* to do, per
> `docs/phase-2-contract.md`. Nothing here has been tested and nothing
> here should be shown to a customer or used in a catalogue listing until
> `docs/integration-checklist.md` is signed off. The "How it will be
> proven" section describes tests that do not exist yet.

*Case-study summary for the product catalogue. Non-technical, outcome-first.*

## What it does

Phase 1 gave each company a private workspace and boards inside it. Phase 2
makes those boards actually usable: columns you name yourself, cards you
write work on, and dragging a card from one column to the next.

A card carries a title, a description, who it is assigned to, and when it
is due. Columns can be renamed, reordered, and deleted. Cards can be moved
within a column or across to another one.

The point of the phase is that all of it is live. When a colleague moves a
card, it moves on your screen too — within the same second, without a
refresh, without a "someone else changed this, reload?" banner. Two people
can work the same board at the same time and see one shared picture of it.

Read-only clients see the board exactly as the team does, and cannot change
anything on it. That is enforced the same way it was in Phase 1 — by the
database refusing the write, not by hiding a button.

## Why it matters

A Kanban board is a shared model of what a team is doing. Its value comes
entirely from everyone believing it is current. The moment two people are
looking at two different versions, the board stops being the source of
truth and the team goes back to asking each other in chat.

Most tools solve this by making you refresh, or by resolving conflicts
after the fact with a warning dialogue. Flowspace pushes each change to
everyone who is entitled to see it, as it happens, and each client
re-reads the board when it reconnects — so a dropped update heals itself
rather than leaving one person quietly out of date.

The second thing that matters here is boring and invisible: the columns and
cards inherit Phase 1's security model rather than getting their own. The
database physically cannot let a card from one company end up in another
company's column — not because a developer remembered to check, but
because the shape of the data makes it impossible to record. Cross-company
leakage is the failure that ends a product like this, and the way to
survive it is to make each new feature protected by default.

## How it will be proven

*(Planned. None of this has been run yet.)*

The same two-company setup used for Phase 1 — two separate businesses with
one contractor deliberately placed inside both, plus a read-only client
account — is extended to cover the new columns and cards. The checks that
matter:

- One company cannot read or change the other's columns or cards.
- A card cannot be dragged into another company's column, even by the one
  person who legitimately belongs to both companies.
- While one company is actively moving cards around, the other company's
  live connection stays completely silent.
- A read-only client can open the board and can change nothing on it.

The full acceptance list, including the parts a person still has to check
by hand in a browser, is `docs/integration-checklist.md`.

## Status

**In progress.** Not finished, not verified, not deployed.

Phase 1 itself is feature-complete and passing its 38 automated checks
against a live hosted database, but has not yet been deployed to a real
environment — so this phase is currently being built on a foundation that
is proven locally and not in production.

Next after this: AI task automation (Phase 3), which is the first feature
that reads the card data this phase creates.
