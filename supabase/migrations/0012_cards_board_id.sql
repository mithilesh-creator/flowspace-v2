-- 0012 — cards carry their board, and the foreign key carries it too
--
-- H2. A card's board was only reachable through its list, so every card
-- PATCH, DELETE and move paid a read — with an embedded join to lists —
-- purely to prove the card sat on the board named in the URL. Move is the
-- hottest path in the app and it was doing that on every drop.
--
-- Denormalising board_id onto cards is not just a cache. Widening the
-- foreign key to (list_id, board_id, org_id) -> lists(id, board_id, org_id)
-- closes the last Phase 2 rule with no database backstop: a card moved
-- into a list on a *different board of the same tenant*. The composite key
-- from 0009 was blind to that — same org, so (list_id, org_id) resolved
-- fine — and the route's own check was the only thing enforcing it. Now
-- the reference itself refuses it.
--
-- The route keeps its check, because the shapes of the two refusals differ
-- and the friendlier one is worth keeping: the route answers 404 "List not
-- found on this board", the key answers 23503 -> 400. Belt and braces, but
-- this time the braces are structural and the belt is only cosmetic.
--
-- ---------------------------------------------------------------------
-- This is a data migration on a live table. Order is not negotiable:
-- add nullable, backfill from the parent list, then NOT NULL, then the
-- key. Adding the column NOT NULL up front, or the key before the
-- backfill, fails on the first existing card.
-- ---------------------------------------------------------------------

alter table public.cards
  add column board_id uuid;

update public.cards as c
   set board_id = l.board_id
  from public.lists as l
 where l.id = c.list_id;

alter table public.cards
  alter column board_id set not null;

-- The three-column key needs a matching unique constraint to target, the
-- same trick 0009 used for (id, org_id): redundant on paper because id is
-- already the primary key, and the only reason Postgres will accept the
-- reference at all.
alter table public.lists
  add constraint lists_id_board_id_org_id_key unique (id, board_id, org_id);

-- Swap the key. Deliberately no ON UPDATE CASCADE: nothing in the API
-- moves a list between boards or between tenants, and the default NO
-- ACTION means an attempt to do either is *refused* rather than quietly
-- dragging every card in the list across with it. If list-moves-between-
-- boards ever becomes a feature, that is the moment to revisit this — not
-- before.
alter table public.cards
  drop constraint cards_list_fkey;

alter table public.cards
  add constraint cards_list_fkey
  foreign key (list_id, board_id, org_id)
  references public.lists (id, board_id, org_id)
  on delete cascade;

-- No index on cards(board_id). Every route that filters by it also filters
-- by the primary key, and the cascade from lists is driven by list_id,
-- which cards_list_id_position_idx already leads with. An index here would
-- be paid for on every write and read by nothing.
--
-- lists_id_org_id_key (0009) is left in place. Nothing references it any
-- more now that cards point at the three-column key, but dropping a unique
-- constraint other work may be asserting on is not this migration's job.
