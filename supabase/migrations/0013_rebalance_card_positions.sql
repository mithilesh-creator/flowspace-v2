-- 0013 — rebalance_card_positions(list)
--
-- H3. 0009 shipped rebalance_list_positions but no card equivalent, which
-- is backwards: lists are dragged occasionally, cards are dragged all day.
-- Fractional positions ((prev + next) / 2) on `numeric` never lose
-- ordering the way float would, but they do grow — a long enough sequence
-- of drops into the same gap stores a position hundreds of digits long.
-- This rewrites one list's cards to 1..n.
--
-- Not called automatically, exactly like its sibling. Nothing in the API
-- depends on it; it is the escape hatch, not part of the write path.
--
-- SECURITY INVOKER (the default, stated here because it is a decision and
-- not an oversight). The 0004 helpers are DEFINER because a policy on
-- memberships that queries memberships recurses; this function has no such
-- problem, so it runs as the caller and the cards UPDATE policy decides
-- what it may touch. A DEFINER version would be a function that silently
-- reorders any tenant's list for anyone able to guess a uuid — and the
-- ordering read inside it would bypass RLS too.
--
-- Execute is revoked from anon *explicitly*. Revoking from the `public`
-- pseudo-role does not remove the direct grant Supabase issues to anon;
-- that mistake is the entire reason migration 0008 exists.

create or replace function public.rebalance_card_positions(p_list uuid)
returns setof public.cards
language sql
volatile
set search_path = ''
as $$
  update public.cards as c
     set "position" = ranked.rn
    from (
      select id,
             row_number() over (order by "position" asc, created_at asc) as rn
        from public.cards
       where list_id = p_list
    ) as ranked
   where c.id = ranked.id
  returning c.*;
$$;

-- created_at breaks ties in the window above because cards, unlike lists,
-- deliberately have no unique (list_id, position): two concurrent drags
-- landing on the same midpoint is a race to resolve on the next read, not
-- a 409. Without the tiebreak a rebalance of a tied pair would be
-- non-deterministic.

revoke execute on function public.rebalance_card_positions(uuid) from public;
revoke execute on function public.rebalance_card_positions(uuid) from anon;
grant execute on function public.rebalance_card_positions(uuid) to authenticated, service_role;
