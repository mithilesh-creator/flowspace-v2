-- 0007 — boards (Phase 1 scope only)
--
-- Deliberately minimal: just enough tenant-scoped, mutating data to prove
-- the auth + Socket.io path end to end. Lists, cards, ordering and the
-- rest of the Kanban model land in Phase 2.

create table public.boards (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  title       text not null check (btrim(title) <> ''),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index boards_org_id_idx on public.boards (org_id, created_at desc);

create trigger boards_set_updated_at
  before update on public.boards
  for each row execute function public.set_updated_at();

alter table public.boards enable row level security;
alter table public.boards force row level security;

-- Everyone in the org reads, including `client` — that is the whole point
-- of the portal role.
create policy boards_select_members
  on public.boards for select to authenticated
  using (public.is_org_member(org_id));

-- Writes exclude `client`, so the portal is read-only by construction
-- rather than by the frontend remembering to hide a button.
create policy boards_insert_staff
  on public.boards for insert to authenticated
  with check (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  );

create policy boards_update_staff
  on public.boards for update to authenticated
  using (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  )
  -- Repeated in WITH CHECK so a board cannot be moved into another org:
  -- USING vets the row you started from, WITH CHECK vets the row you end
  -- up with.
  with check (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  );

create policy boards_delete_admins
  on public.boards for delete to authenticated
  using (public.has_org_role(org_id, 'owner'::public.org_role, 'admin'::public.org_role));

revoke all on public.boards from anon;
grant select, insert, update, delete on public.boards to authenticated;
