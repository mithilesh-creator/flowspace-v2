-- 0010 — deleting a list is an admin action
--
-- 0009 put every list and card write in the same owner|admin|member
-- bucket, which is what the Phase 2 contract's "writes are
-- owner|admin|member" rule says on its face. It reads wrong next to
-- boards_delete_admins: deleting a list cascades every card in it, so one
-- click by a member can destroy a column of work, while deleting the board
-- that contains it needs an admin.
--
-- Cards stay owner|admin|member. Deleting a card is routine; deleting a
-- list is not.
--
-- Nothing else about 0009 changes. This is a policy swap, not a schema
-- change, so it is safe to apply over live data.

drop policy lists_delete_staff on public.lists;

create policy lists_delete_admins
  on public.lists for delete to authenticated
  using (
    public.has_org_role(org_id, 'owner'::public.org_role, 'admin'::public.org_role)
  );
