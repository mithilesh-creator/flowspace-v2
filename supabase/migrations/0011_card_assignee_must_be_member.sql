-- 0011 — a card can only be assigned to a member of its own organization
--
-- H1. Before this, `assignee_id` referenced profiles(id): any profile in
-- the system, including one belonging to another tenant. Not a data leak —
-- the assignee still cannot read the card, RLS sees to that — but an
-- invariant the schema did not hold. "Assigned to someone who cannot see
-- it" is a state the product has no meaning for.
--
-- Fixed the same way lists and cards already are: a composite foreign key
-- that carries the tenant, so the bad row is unrepresentable rather than
-- merely rejected. (org_id, assignee_id) must resolve to a real membership
-- of the same org.
--
-- memberships already declares `unique (org_id, user_id)` (0003), so the
-- referenceable key the contract asks for exists — nothing to add.
--
-- Two details that are load-bearing:
--
--   * NOT null-forced. assignee_id stays nullable and an unassigned card
--     is still valid; a composite FK with a NULL member is not checked at
--     all (MATCH SIMPLE, the default), which is exactly what we want.
--
--   * `on delete set null (assignee_id)` — the column list matters. A bare
--     ON DELETE SET NULL on a composite key nulls *every* referencing
--     column, org_id included, and org_id is NOT NULL: removing a member
--     would fail with a not-null violation instead of unassigning their
--     cards. The column list (Postgres 15+) narrows it to the one column
--     that may become null.
--
-- The existing cards_assignee_id_fkey → profiles is left in place. It is
-- implied by this one (a membership implies a profile) but it costs
-- nothing to keep and this migration is not the place to widen its blast
-- radius.

alter table public.cards
  add constraint cards_assignee_membership_fkey
  foreign key (org_id, assignee_id)
  references public.memberships (org_id, user_id)
  on delete set null (assignee_id);

-- The referencing side of a foreign key needs its own index or every
-- membership delete degrades into a sequential scan of cards. The existing
-- cards_assignee_id_idx leads with assignee_id, which is selective enough
-- on its own, so there is nothing to add here — noted so the next person
-- does not add a redundant one.
