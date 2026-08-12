# Phase 1 — Secure multi-tenant foundation

*Case-study summary for the product catalogue. Non-technical, outcome-first.*

## What it does

Flowspace lets a company create its own private workspace, invite
colleagues into it with different levels of access, and work on shared
boards that update live for everyone at once — no refresh, no "who has the
latest version".

One person can belong to several workspaces at the same time (an agency
contractor working across three clients, for example) and sees each one
completely separately. Switching between them is a dropdown.

Access comes in four levels: owners run the workspace, admins manage
people, members do the work, and clients get a read-only view — the basis
for the client portal.

## Why it matters

Software that holds several companies' data in one system has one failure
that ends the business: one customer seeing another customer's work. It is
not a bug you apologise for.

Most products defend against this in application code — a check written
into each screen and each API call. That works until someone adds a new
screen and forgets one.

Flowspace puts the boundary in the database instead. Every request runs as
the person who made it, and the database itself refuses to return another
company's rows. A new feature is protected by default, because the
protection is not something a developer has to remember to add. Getting it
wrong is a deliberate act rather than an oversight.

The same rule covers the live-updating side, which is where this class of
product usually slips: a workspace's real-time updates are delivered only
to people the server has confirmed are in that workspace, checked fresh
each time rather than trusted from the browser.

## How it was proven

Two separate companies were set up with overlapping staff, including one
person deliberately placed in both. Twenty-five automated checks then
attempted to cross the line in every direction available: reading the
other company's boards, writing into them, moving a board between
companies, promoting yourself to a higher access level, removing the last
owner so a workspace becomes unmanageable, redeeming someone else's
invitation, and reading anything at all while signed out.

Because live updates travel outside the database, they are tested
separately: three real users connect at once, and the suite confirms that
the outside company is refused access to the other's update stream and
receives nothing at all while that company is actively making changes.

All twenty-five pass, and both suites are written to run on every change.

## Status

Verified end to end against a live hosted database on 11 August 2026 —
sign-up, sign-in, workspace switching, live board updates across separate
clients, and read-only client access all confirmed working.

One hardening issue was found and fixed during verification: internal
database functions were reachable by unauthenticated callers. Nothing was
exposed by it — each one already refused to answer without a valid
session — but the surface should not have existed, and it is now closed.

Boards exist as containers; lists, cards and drag-and-drop are Phase 2,
and they inherit this security model rather than needing their own.
