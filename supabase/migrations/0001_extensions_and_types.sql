-- 0001 — extensions, enum types, shared trigger helpers
--
-- Nothing in this file is tenant-scoped, so nothing here needs RLS.
-- Everything after this file does.

create extension if not exists pgcrypto with schema extensions;

-- The tenant role ladder. `client` exists from day one so that the
-- Feature 4 client portal is a policy change, not a schema migration.
create type public.org_role as enum ('owner', 'admin', 'member', 'client');

-- Generic updated_at maintenance. Attached per-table in later migrations.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with the current transaction time.';
