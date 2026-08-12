-- 0005 — Row-Level Security
--
-- Conventions used throughout:
--
--   * ENABLE + FORCE. FORCE means even the table owner is filtered, so a
--     stray query from a privileged connection cannot quietly cross the
--     tenant line. (Roles with BYPASSRLS still bypass — that is how the
--     SECURITY DEFINER helpers in 0004 avoid recursion.)
--   * One policy per command, never FOR ALL. USING controls which rows
--     you can see/target; WITH CHECK controls what you can leave behind.
--     FOR ALL collapses the two and makes write rules easy to get wrong.
--   * Policies are scoped TO authenticated. anon gets no policies at all,
--     which combined with the revokes in 0002/0003 means anon sees
--     nothing.

alter table public.profiles       enable row level security;
alter table public.organizations  enable row level security;
alter table public.memberships    enable row level security;

alter table public.profiles       force row level security;
alter table public.organizations  force row level security;
alter table public.memberships    force row level security;

-- ---------------------------------------------------------------------
-- profiles
--
-- You can see yourself and your teammates. No INSERT policy (the
-- auth.users trigger owns creation) and no DELETE policy (profiles die
-- with their auth user, by cascade).
-- ---------------------------------------------------------------------

create policy profiles_select_self_or_teammate
  on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or public.shares_org_with(id)
  );

create policy profiles_update_self
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- organizations
--
-- No INSERT policy on purpose — see create_organization() in 0004.
-- ---------------------------------------------------------------------

create policy organizations_select_members
  on public.organizations for select to authenticated
  using (public.is_org_member(id));

create policy organizations_update_admins
  on public.organizations for update to authenticated
  using (public.has_org_role(id, 'owner'::public.org_role, 'admin'::public.org_role))
  with check (public.has_org_role(id, 'owner'::public.org_role, 'admin'::public.org_role));

create policy organizations_delete_owners
  on public.organizations for delete to authenticated
  using (public.has_org_role(id, 'owner'::public.org_role));

-- ---------------------------------------------------------------------
-- memberships
--
-- The privilege-escalation guard: admins may manage members, but only an
-- owner may mint another owner. Without the second conjunct an admin
-- could promote themselves and then delete the real owner.
-- ---------------------------------------------------------------------

create policy memberships_select_members
  on public.memberships for select to authenticated
  using (public.is_org_member(org_id));

create policy memberships_insert_admins
  on public.memberships for insert to authenticated
  with check (
    public.has_org_role(org_id, 'owner'::public.org_role, 'admin'::public.org_role)
    and (
      role <> 'owner'::public.org_role
      or public.has_org_role(org_id, 'owner'::public.org_role)
    )
  );

create policy memberships_update_admins
  on public.memberships for update to authenticated
  using (public.has_org_role(org_id, 'owner'::public.org_role, 'admin'::public.org_role))
  with check (
    public.has_org_role(org_id, 'owner'::public.org_role, 'admin'::public.org_role)
    and (
      role <> 'owner'::public.org_role
      or public.has_org_role(org_id, 'owner'::public.org_role)
    )
  );

-- Admins can remove people; anybody can remove themselves (leave the
-- org). The last-owner trigger from 0003 still applies on top of this.
create policy memberships_delete_admins_or_self
  on public.memberships for delete to authenticated
  using (
    public.has_org_role(org_id, 'owner'::public.org_role, 'admin'::public.org_role)
    or user_id = (select auth.uid())
  );
