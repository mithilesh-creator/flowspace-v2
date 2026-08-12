-- 0002 — profiles
--
-- Mirror of auth.users so application tables can join user data without
-- reaching into the auth schema (which we do not own and cannot put
-- policies on). Rows are created by trigger, never by the client.

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Case-insensitive uniqueness without depending on citext living in the
-- extensions schema. email is nullable because phone/OAuth signups can
-- arrive without one — a null must never block account creation.
create unique index profiles_email_lower_key
  on public.profiles (lower(email))
  where email is not null;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Provision a profile whenever Supabase Auth creates a user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    lower(nullif(new.email, '')),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Grants. Supabase grants ALL on public tables to anon/authenticated by
-- default, so anything we do not want reachable must be revoked here.
-- ---------------------------------------------------------------------

revoke all on public.profiles from anon;
grant select, update on public.profiles to authenticated;
