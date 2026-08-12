-- 0003 — organizations (the tenant) and memberships (the tenant boundary)
--
-- `memberships` is the single source of truth for "who can see what".
-- Every policy in 0005 resolves back to a row in this table.

create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (btrim(name) <> ''),
  slug        text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index organizations_slug_key on public.organizations (slug);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  role        public.org_role not null default 'member',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create index memberships_user_id_idx on public.memberships (user_id);
create index memberships_org_id_role_idx on public.memberships (org_id, role);

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- An organization must always have at least one owner, otherwise it
-- becomes unadministrable. RLS cannot express this (it sees one row at a
-- time), so it is a trigger.
-- ---------------------------------------------------------------------

create or replace function public.prevent_last_owner_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_count integer;
begin
  -- Only owner rows can strand an organization.
  if old.role <> 'owner' then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- Still an owner after the update: nothing to check.
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;

  -- Cascade from `delete from organizations`: the parent row is already
  -- gone by the time the FK trigger fires, so there is no org left to
  -- protect. Same for a cascade from profiles/auth.users.
  if not exists (select 1 from public.organizations o where o.id = old.org_id) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  select count(*) into v_owner_count
  from public.memberships m
  where m.org_id = old.org_id
    and m.role = 'owner';

  if v_owner_count <= 1 then
    raise exception 'organization % must retain at least one owner', old.org_id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create trigger memberships_prevent_last_owner_removal
  before update or delete on public.memberships
  for each row execute function public.prevent_last_owner_removal();

-- ---------------------------------------------------------------------
-- Grants.
--
-- No INSERT on organizations for anyone: creating a tenant is a two-row
-- operation (org + owner membership) and must go through
-- public.create_organization() in 0004 so it cannot half-succeed and
-- strand an org with no members.
-- ---------------------------------------------------------------------

revoke all on public.organizations from anon;
revoke all on public.memberships from anon;

grant select, update, delete on public.organizations to authenticated;
grant select, insert, update, delete on public.memberships to authenticated;
