-- 0004 — RLS helper functions and the org-creation RPC
--
-- Why these are SECURITY DEFINER:
--
-- A policy on `memberships` that itself queries `memberships` recurses
-- infinitely. SECURITY DEFINER functions run as the function owner
-- (postgres, which holds BYPASSRLS), so the lookup inside the function is
-- not re-filtered and the recursion never starts. This is the documented
-- Supabase pattern for membership-based multi-tenancy.
--
-- Every function is STABLE (so the planner can hoist it out of row loops
-- instead of calling it per row) and pins search_path to '' so a caller
-- cannot shadow `public` with a temp schema and hijack the lookup.
--
-- `(select auth.uid())` rather than a bare `auth.uid()` is deliberate:
-- the subselect form is evaluated once per statement instead of once per
-- row, which is the difference between an index scan and a seq scan on
-- large tables.

-- Is the current user a member of this org, in any role at all?
create or replace function public.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = p_org
      and m.user_id = (select auth.uid())
  );
$$;

-- Does the current user hold one of these roles in this org?
create or replace function public.has_org_role(p_org uuid, variadic p_roles public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = p_org
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

-- The current user's role in this org, or null if not a member.
-- Named current_org_role, NOT org_role: a function sharing a name with a
-- type turns `org_role(x)` into function-style cast syntax and the call
-- becomes ambiguous.
create or replace function public.current_org_role(p_org uuid)
returns public.org_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.memberships m
  where m.org_id = p_org
    and m.user_id = (select auth.uid());
$$;

-- Do the current user and p_user share at least one org? Used by the
-- profiles SELECT policy so teammates are visible to each other and
-- nobody else.
create or replace function public.shares_org_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships me
    join public.memberships them on them.org_id = me.org_id
    where me.user_id = (select auth.uid())
      and them.user_id = p_user
  );
$$;

-- ---------------------------------------------------------------------
-- Tenant creation.
--
-- Inserting an organization and inserting the creator's owner membership
-- have to happen together: the memberships INSERT policy requires you to
-- already be an owner/admin of the org, which you cannot be until this
-- row exists. Doing it in one SECURITY DEFINER call keeps it atomic and
-- avoids a permissive bootstrap policy that a client could abuse to
-- attach itself to somebody else's org.
-- ---------------------------------------------------------------------

create or replace function public.create_organization(p_name text, p_slug text)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_org public.organizations;
begin
  if v_uid is null then
    raise exception 'authentication required'
      using errcode = 'insufficient_privilege';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception 'organization name is required'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.organizations (name, slug, created_by)
  values (btrim(p_name), lower(btrim(p_slug)), v_uid)
  returning * into v_org;

  insert into public.memberships (org_id, user_id, role)
  values (v_org.id, v_uid, 'owner');

  return v_org;
end;
$$;

-- ---------------------------------------------------------------------
-- Execute grants. `public` here is the pseudo-role every role inherits,
-- not the schema.
--
-- NOTE: revoking from `public` is NOT sufficient to close these off to
-- anon. Supabase also issues a direct grant to the anon role via default
-- privileges, and a direct grant survives revoking from the pseudo-role.
-- See 0008_lock_down_function_grants.sql, which fixes it.
-- ---------------------------------------------------------------------

revoke execute on function public.is_org_member(uuid) from public;
revoke execute on function public.has_org_role(uuid, public.org_role[]) from public;
revoke execute on function public.current_org_role(uuid) from public;
revoke execute on function public.shares_org_with(uuid) from public;
revoke execute on function public.create_organization(text, text) from public;

grant execute on function public.is_org_member(uuid) to authenticated, service_role;
grant execute on function public.has_org_role(uuid, public.org_role[]) to authenticated, service_role;
grant execute on function public.current_org_role(uuid) to authenticated, service_role;
grant execute on function public.shares_org_with(uuid) to authenticated, service_role;
grant execute on function public.create_organization(text, text) to authenticated, service_role;
