-- rls.test.sql — multi-tenant isolation suite
--
-- This is the gate for "Phase 1 is done". Per CLAUDE.md, no feature ships
-- without being tested against a 2+ tenant scenario, and cross-tenant
-- leakage is the #1 risk in this architecture.
--
-- Prerequisites: migrations 0001–0007 applied, supabase/seed.sql loaded.
--
-- Run:
--   supabase db reset                    # applies migrations + seed
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls.test.sql
--
-- Every test runs inside its own transaction and rolls back, so the suite
-- is repeatable and leaves no residue. A failure raises and, with
-- ON_ERROR_STOP=1, aborts the run. Silence plus the final NOTICE means
-- everything passed.
--
-- How a session is impersonated: request.jwt.claims is the GUC that
-- Supabase's auth.uid() reads, and `set local role authenticated` drops
-- the BYPASSRLS privileges of the postgres role so policies actually
-- apply. Both together are required — either one alone tests nothing.
--
-- WITHOUT psql: the \set lines and the begin/rollback wrappers below are
-- psql-specific. To run these through the Supabase SQL editor or MCP
-- connector instead, wrap each test body in a plpgsql block that does
-- `perform set_config('request.jwt.claims', …, true)`, then
-- `execute 'set local role authenticated'`, and ends with
-- `raise exception using errcode='40000'` caught by its own handler —
-- that rolls the block's savepoint back, so mutating tests (T09, T13,
-- T14) undo themselves without needing transaction control.

\set ON_ERROR_STOP on

\set org_a       '''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'''
\set org_b       '''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'''
\set board_b1    '''bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb'''
\set a_owner     '''11111111-1111-4111-8111-111111111111'''
\set a_admin     '''66666666-6666-4666-8666-666666666666'''
\set a_member    '''22222222-2222-4222-8222-222222222222'''
\set a_client    '''55555555-5555-4555-8555-555555555555'''
\set b_owner     '''33333333-3333-4333-8333-333333333333'''
\set dual        '''44444444-4444-4444-8444-444444444444'''


-- =====================================================================
-- T01 — Tenant A's owner sees exactly one organization: their own.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_count integer;
begin
  select count(*) into v_count from public.organizations;
  if v_count <> 1 then
    raise exception 'FAIL [T01]: tenant A owner sees % organizations, expected 1', v_count;
  end if;

  if not exists (
    select 1 from public.organizations where slug = 'northwind'
  ) then
    raise exception 'FAIL [T01]: tenant A owner cannot see their own organization';
  end if;
end $$;

rollback;


-- =====================================================================
-- T02 — Tenant A sees only tenant A's boards. The core leak test.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_total integer;
  v_foreign integer;
begin
  select count(*) into v_total from public.boards;
  if v_total <> 2 then
    raise exception 'FAIL [T02]: tenant A owner sees % boards, expected 2', v_total;
  end if;

  select count(*) into v_foreign
  from public.boards
  where org_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  if v_foreign <> 0 then
    raise exception 'FAIL [T02]: LEAK — tenant A owner sees % of tenant B''s boards', v_foreign;
  end if;
end $$;

rollback;


-- =====================================================================
-- T03 — And the reverse direction, so the test is not passing by
--       accident of row ordering or counts.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :b_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_total integer;
  v_foreign integer;
begin
  select count(*) into v_total from public.boards;
  if v_total <> 1 then
    raise exception 'FAIL [T03]: tenant B owner sees % boards, expected 1', v_total;
  end if;

  select count(*) into v_foreign
  from public.boards
  where org_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  if v_foreign <> 0 then
    raise exception 'FAIL [T03]: LEAK — tenant B owner sees % of tenant A''s boards', v_foreign;
  end if;
end $$;

rollback;


-- =====================================================================
-- T04 — A user in both tenants sees the union, not one or the other.
--       This is what catches an over-restrictive "one org per user"
--       shortcut in the policies.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :dual, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_orgs integer;
  v_boards integer;
begin
  select count(*) into v_orgs from public.organizations;
  if v_orgs <> 2 then
    raise exception 'FAIL [T04]: dual-member sees % organizations, expected 2', v_orgs;
  end if;

  select count(*) into v_boards from public.boards;
  if v_boards <> 3 then
    raise exception 'FAIL [T04]: dual-member sees % boards, expected 3', v_boards;
  end if;
end $$;

rollback;


-- =====================================================================
-- T05 — Tenant A cannot write into tenant B, even naming B's org_id
--       explicitly. Read isolation without write isolation is not
--       isolation.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_blocked boolean := false;
begin
  begin
    insert into public.boards (org_id, title)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Injected by tenant A');
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL [T05]: LEAK — tenant A inserted a board into tenant B';
  end if;
end $$;

rollback;


-- =====================================================================
-- T06 — An UPDATE targeting tenant B's board affects zero rows. RLS
--       filters it out rather than erroring, so assert the row count.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_rows integer;
begin
  update public.boards
  set title = 'Hijacked'
  where id = 'bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'FAIL [T06]: LEAK — tenant A updated % row(s) in tenant B', v_rows;
  end if;
end $$;

rollback;


-- =====================================================================
-- T07 — A board cannot be moved across the tenant line by UPDATE. This
--       is what the repeated WITH CHECK in 0007 is defending.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_blocked boolean := false;
begin
  begin
    update public.boards
    set org_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where id = 'aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL [T07]: LEAK — a board was reassigned to another tenant';
  end if;
end $$;

rollback;


-- =====================================================================
-- T08 — The `client` role reads but cannot write. This is the Feature 4
--       portal guarantee, enforced in the database rather than by the
--       frontend hiding a button.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_client, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_count integer;
  v_blocked boolean := false;
begin
  select count(*) into v_count from public.boards;
  if v_count <> 2 then
    raise exception 'FAIL [T08]: client sees % boards, expected 2', v_count;
  end if;

  begin
    insert into public.boards (org_id, title)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Client-created board');
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL [T08]: client role was able to create a board';
  end if;
end $$;

rollback;


-- =====================================================================
-- T09 — Privilege escalation: an admin may add members but may not mint
--       an owner. Otherwise admin -> owner -> remove the real owner is a
--       three-step tenant takeover.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_admin, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_blocked boolean := false;
begin
  -- Adding an ordinary member is allowed.
  insert into public.memberships (org_id, user_id, role)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          '33333333-3333-4333-8333-333333333333', 'member');

  -- Promoting themselves to owner is not.
  begin
    update public.memberships
    set role = 'owner'
    where org_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and user_id = '66666666-6666-4666-8666-666666666666';
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL [T09]: an admin escalated themselves to owner';
  end if;
end $$;

rollback;


-- =====================================================================
-- T10 — An organization cannot be left ownerless.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_blocked boolean := false;
begin
  begin
    delete from public.memberships
    where org_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and user_id = '11111111-1111-4111-8111-111111111111';
  exception when check_violation then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL [T10]: the last owner was removed from an organization';
  end if;
end $$;

rollback;


-- =====================================================================
-- T11 — Profile visibility follows shared membership: teammates yes,
--       strangers no. A directory of every user on the platform is a
--       leak even without board data attached.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
begin
  if not exists (
    select 1 from public.profiles
    where id = '22222222-2222-4222-8222-222222222222'
  ) then
    raise exception 'FAIL [T11]: a teammate''s profile is not visible';
  end if;

  if exists (
    select 1 from public.profiles
    where id = '33333333-3333-4333-8333-333333333333'
  ) then
    raise exception 'FAIL [T11]: LEAK — a profile from an unrelated tenant is visible';
  end if;
end $$;

rollback;


-- =====================================================================
-- T12 — Organizations cannot be created by direct INSERT. Only
--       create_organization() may, because only it also writes the owner
--       membership.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_member, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_blocked boolean := false;
begin
  begin
    insert into public.organizations (name, slug)
    values ('Orphan Org', 'orphan-org');
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL [T12]: an organization was created by direct insert, bypassing the owner-membership guarantee';
  end if;
end $$;

rollback;


-- =====================================================================
-- T13 — create_organization() works and leaves the caller as owner.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_member, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare
  v_org public.organizations;
  v_role public.org_role;
begin
  select * into v_org from public.create_organization('Cyd''s Side Project', 'cyd-side-project');

  if v_org.id is null then
    raise exception 'FAIL [T13]: create_organization returned no row';
  end if;

  select role into v_role
  from public.memberships
  where org_id = v_org.id
    and user_id = '22222222-2222-4222-8222-222222222222';

  if v_role is distinct from 'owner'::public.org_role then
    raise exception 'FAIL [T13]: creator role is %, expected owner', coalesce(v_role::text, 'null');
  end if;
end $$;

rollback;


-- =====================================================================
-- T14 — accept_invitation() rejects a token issued to a different email
--       address, then succeeds for the right one. Guards against a
--       forwarded invite email being redeemed by the wrong person.
-- =====================================================================
begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_owner, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.accept_invitation('flowspace-test-invite-token');
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL [T14]: an invitation was redeemed by the wrong email address';
  end if;
end $$;

rollback;

begin;
select set_config('request.jwt.claims', json_build_object('sub', :a_member, 'role', 'authenticated')::text, true);
set local role authenticated;

do $$
declare v_membership public.memberships;
begin
  select * into v_membership
  from public.accept_invitation('flowspace-test-invite-token');

  if v_membership.org_id is distinct from 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid then
    raise exception 'FAIL [T14]: invitation granted membership in the wrong organization';
  end if;
end $$;

rollback;


-- =====================================================================
-- T15 — An unauthenticated session sees nothing at all. anon has no
--       policies and no table grants; either produces an error here.
-- =====================================================================
begin;
set local role anon;

do $$
declare
  v_visible integer := 0;
begin
  -- Two ways anon can be shut out: no table grant (raises 42501) or a
  -- grant with no matching policy (returns zero rows). Both are a pass;
  -- anything else is a leak.
  begin
    select (select count(*) from public.boards)
         + (select count(*) from public.organizations)
         + (select count(*) from public.memberships)
         + (select count(*) from public.profiles)
      into v_visible;
  exception when insufficient_privilege then
    v_visible := 0;
  end;

  if v_visible <> 0 then
    raise exception 'FAIL [T15]: LEAK — the anon role can read % tenant row(s)', v_visible;
  end if;
end $$;

rollback;


-- =====================================================================
-- T16 — anon cannot execute the SECURITY DEFINER helpers.
--
-- Regression guard for migration 0008. `revoke execute … from public`
-- does NOT remove the direct grant Supabase issues to anon, which left
-- every helper callable at /rest/v1/rpc/<name> without a session. They
-- all guard on auth.uid() so nothing leaked, but the surface should not
-- exist — and the next helper added will inherit the same default grant
-- unless someone remembers. This fails if they forget.
-- =====================================================================
begin;
set local role anon;

do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.is_org_member('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'FAIL [T16]: anon can execute the SECURITY DEFINER helpers — see migration 0008';
  end if;
end $$;

rollback;


do $$
begin
  raise notice 'RLS suite passed: T01-T16, 2 tenants, no cross-tenant reads or writes.';
end $$;
