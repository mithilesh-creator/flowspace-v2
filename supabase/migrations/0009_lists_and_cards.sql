-- 0009 — lists and cards (Phase 2 Kanban model)
--
-- Two tenant-scoped tables, both carrying org_id denormalised so the
-- policies filter without a join — the same shape as boards in 0007.
--
-- The interesting part is not the columns, it is the composite foreign
-- keys. `lists` references (board_id, org_id) -> boards(id, org_id), and
-- `cards` references (list_id, org_id) -> lists(id, org_id). A row whose
-- org_id says tenant A but whose parent lives in tenant B does not fail a
-- policy — it fails to exist. There is no trigger to forget to install and
-- no application check to route around: the reference itself carries the
-- tenant, so a cross-tenant list or card is unrepresentable.
--
-- That needs a unique (id, org_id) on each parent, which is redundant with
-- the primary key on paper (id is already unique, so id+org_id trivially
-- is) and entirely load-bearing in practice: Postgres will only accept a
-- foreign key that targets a declared unique constraint.

-- ---------------------------------------------------------------------
-- Referenceable (id, org_id) on the parent.
-- ---------------------------------------------------------------------

alter table public.boards
  add constraint boards_id_org_id_key unique (id, org_id);

-- ---------------------------------------------------------------------
-- lists
-- ---------------------------------------------------------------------

create table public.lists (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations (id) on delete cascade,
  board_id    uuid not null,
  title       text not null check (btrim(title) <> ''),
  position    numeric not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint lists_board_fkey
    foreign key (board_id, org_id)
    references public.boards (id, org_id)
    on delete cascade,

  -- Deferrable so a multi-row reorder inside one transaction is judged on
  -- its end state. Checked per row immediately, swapping two positions
  -- trips on the intermediate collision even though the transaction was
  -- always going to land somewhere valid.
  constraint lists_board_id_position_key
    unique (board_id, position) deferrable initially deferred,

  -- Same trick as boards above, so cards can reference (list_id, org_id).
  constraint lists_id_org_id_key unique (id, org_id)
);

-- No separate (board_id, position) index: lists_board_id_position_key
-- already builds exactly that index, and a duplicate would cost writes for
-- nothing.
create index lists_org_id_idx on public.lists (org_id);

create trigger lists_set_updated_at
  before update on public.lists
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- cards
-- ---------------------------------------------------------------------

create table public.cards (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations (id) on delete cascade,
  list_id      uuid not null,
  title        text not null check (btrim(title) <> ''),
  description  text,
  position     numeric not null,
  assignee_id  uuid references public.profiles (id) on delete set null,
  due_date     timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint cards_list_fkey
    foreign key (list_id, org_id)
    references public.lists (id, org_id)
    on delete cascade
);

create index cards_list_id_position_idx on public.cards (list_id, position);
create index cards_org_id_idx on public.cards (org_id);
create index cards_assignee_id_idx on public.cards (assignee_id);

create trigger cards_set_updated_at
  before update on public.cards
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- RLS. Same shape as boards: everyone in the org reads (including the
-- read-only `client` portal role), staff write.
-- ---------------------------------------------------------------------

alter table public.lists enable row level security;
alter table public.lists force row level security;
alter table public.cards enable row level security;
alter table public.cards force row level security;

create policy lists_select_members
  on public.lists for select to authenticated
  using (public.is_org_member(org_id));

create policy lists_insert_staff
  on public.lists for insert to authenticated
  with check (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  );

-- USING vets the row you started from, WITH CHECK the row you end up with.
-- Both are needed: without WITH CHECK a member could rewrite org_id and
-- push a list into a tenant they do not belong to. (The composite FK would
-- also refuse it, but a policy that only half-checks is the kind of thing
-- that stops being backed up the day the schema changes.)
create policy lists_update_staff
  on public.lists for update to authenticated
  using (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  )
  with check (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  );

-- Deleting a list takes its cards with it, so this is a bigger action than
-- deleting a board's title — but the contract puts every list/card write in
-- the same owner|admin|member bucket, and a member who can empty a list one
-- card at a time gains nothing from being blocked here.
create policy lists_delete_staff
  on public.lists for delete to authenticated
  using (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  );

create policy cards_select_members
  on public.cards for select to authenticated
  using (public.is_org_member(org_id));

create policy cards_insert_staff
  on public.cards for insert to authenticated
  with check (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  );

create policy cards_update_staff
  on public.cards for update to authenticated
  using (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  )
  with check (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  );

create policy cards_delete_staff
  on public.cards for delete to authenticated
  using (
    public.has_org_role(
      org_id,
      'owner'::public.org_role,
      'admin'::public.org_role,
      'member'::public.org_role
    )
  );

revoke all on public.lists from anon;
revoke all on public.cards from anon;
grant select, insert, update, delete on public.lists to authenticated;
grant select, insert, update, delete on public.cards to authenticated;

-- ---------------------------------------------------------------------
-- rebalance_list_positions(board) — the escape hatch for precision drift.
--
-- Fractional positions ((prev + next) / 2) are numeric, not float, so they
-- do not silently stop ordering after ~50 halvings of one gap. They do
-- still grow: numeric is arbitrary precision, and a pathological drag
-- sequence eventually stores positions hundreds of digits long. This
-- rewrites them to 1..n so the fix is one call.
--
-- Not called automatically in Phase 2. Nothing in the API depends on it.
--
-- Deliberately SECURITY INVOKER (the default), unlike the 0004 helpers.
-- Those had to bypass RLS to avoid policy recursion; this one has no such
-- problem, so it runs as the caller and the lists UPDATE policy decides
-- what it may touch. A SECURITY DEFINER version would be a function that
-- silently reorders any tenant's board for anyone who can guess a uuid.
-- Execute is still revoked from anon explicitly: revoking from the
-- `public` pseudo-role does not remove Supabase's direct grant to anon.
-- See 0008.
-- ---------------------------------------------------------------------

create or replace function public.rebalance_list_positions(p_board uuid)
returns setof public.lists
language sql
volatile
set search_path = ''
as $$
  update public.lists as l
     set "position" = ranked.rn
    from (
      select id,
             row_number() over (order by "position" asc, created_at asc) as rn
        from public.lists
       where board_id = p_board
    ) as ranked
   where l.id = ranked.id
  returning l.*;
$$;

revoke execute on function public.rebalance_list_positions(uuid) from public;
revoke execute on function public.rebalance_list_positions(uuid) from anon;
grant execute on function public.rebalance_list_positions(uuid) to authenticated, service_role;
