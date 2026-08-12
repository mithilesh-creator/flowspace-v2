-- seed.sql — two tenants with deliberately overlapping and non-overlapping
-- membership, so cross-tenant isolation can actually be tested.
--
-- Fixed UUIDs: supabase/tests/rls.test.sql references these directly.
--
--   Northwind Studio (org A)        Acme Logistics (org B)
--   ------------------------        ----------------------
--   owner@northwind.test   owner    owner@acme.test    owner
--   admin@northwind.test   admin    dual@contractor.test  member
--   member@northwind.test  member
--   client@northwind.test  client
--   dual@contractor.test   member   <- belongs to BOTH orgs
--
-- Password for every seeded account: password123
--
-- Run as the postgres role (which holds BYPASSRLS), so these inserts are
-- not filtered by the policies in 0005.

set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- Auth users. The on_auth_user_created trigger from 0002 creates the
-- matching public.profiles rows.
--
-- confirmation_token / recovery_token / email_change_token_new /
-- email_change are set to '' explicitly and NOT left to default.
--
-- Those four columns are nullable with no default, but GoTrue scans them
-- into non-nullable Go strings. Leave them NULL and every sign-in fails
-- with the famously unhelpful "Database error querying schema" — which
-- looks like a broken schema or a bad password, and is neither.
-- ---------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
values
  ('00000000-0000-0000-0000-000000000000', '11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'owner@northwind.test',    crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Ada Okonkwo"}',      now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '66666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated', 'admin@northwind.test',    crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Bo Lindqvist"}',     now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'member@northwind.test',   crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Cyd Ramaswamy"}',    now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '55555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated', 'client@northwind.test',   crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Dara Whitfield"}',   now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-4333-8333-333333333333', 'authenticated', 'authenticated', 'owner@acme.test',         crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Emeka Novak"}',      now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated', 'dual@contractor.test',    crypt('password123', gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Fen Alvarez"}',      now(), now(), '', '', '', '')
on conflict (id) do nothing;

-- GoTrue needs a matching identity row or password login fails.
insert into auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id,
  u.id::text,
  json_build_object('sub', u.id::text, 'email', u.email)::jsonb,
  'email',
  now(), now(), now()
from auth.users u
where u.email like '%@northwind.test'
   or u.email like '%@acme.test'
   or u.email like '%@contractor.test'
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug, created_by)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Northwind Studio', 'northwind', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Acme Logistics',   'acme',      '33333333-3333-4333-8333-333333333333')
on conflict (id) do nothing;

insert into public.memberships (org_id, user_id, role)
values
  -- Northwind
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '66666666-6666-4666-8666-666666666666', 'admin'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'member'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '55555555-5555-4555-8555-555555555555', 'client'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '44444444-4444-4444-8444-444444444444', 'member'),
  -- Acme
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'owner'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '44444444-4444-4444-8444-444444444444', 'member')
on conflict (org_id, user_id) do nothing;

-- ---------------------------------------------------------------------
-- Boards: 2 in Northwind, 1 in Acme.
-- ---------------------------------------------------------------------

insert into public.boards (id, org_id, title, created_by)
values
  ('aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Q3 Delivery',    '11111111-1111-4111-8111-111111111111'),
  ('aaaa0002-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Website Rebuild','66666666-6666-4666-8666-666666666666'),
  ('bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Fleet Rollout',  '33333333-3333-4333-8333-333333333333')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Lists and cards (Phase 2).
--
-- Both tenants get a populated board so the isolation suite has something
-- on each side of the line to try to reach across it. "Website Rebuild"
-- is deliberately left with no lists at all — an empty board is the state
-- every board starts in and the one most likely to be handled by a `.map`
-- on undefined.
--
-- org_id is written explicitly on every row and must agree with the
-- parent's. It is not belt-and-braces: the composite foreign keys
-- (board_id, org_id) and (list_id, org_id) mean a mismatch here is
-- rejected outright, so getting these wrong fails the seed loudly rather
-- than quietly planting a cross-tenant row.
-- ---------------------------------------------------------------------

insert into public.lists (id, org_id, board_id, title, position)
values
  -- Northwind / Q3 Delivery
  ('aaaa1001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Backlog',     1),
  ('aaaa1002-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'In Progress', 2),
  ('aaaa1003-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaa0001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Done',        3),
  -- Acme / Fleet Rollout
  ('bbbb1001-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Backlog',     1),
  ('bbbb1002-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Rolling out', 2)
on conflict (id) do nothing;

insert into public.cards (id, org_id, list_id, title, description, position, assignee_id, due_date)
values
  ('aaaa2001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaa1001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Draft the Q3 brief',       'Scope, budget, and the two dates that actually matter.', 1, '11111111-1111-4111-8111-111111111111', now() + interval '5 days'),
  ('aaaa2002-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaa1001-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Chase supplier quotes',    null,                                                     2, null,                                   null),
  ('aaaa2003-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaa1002-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Rebuild onboarding flow',  'Blocked on the copy review.',                            1, '22222222-2222-4222-8222-222222222222', null),
  ('bbbb2001-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbb1001-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Audit depot inventory',    null,                                                     1, '33333333-3333-4333-8333-333333333333', null)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- One live invitation, so accept_invitation() has something to redeem.
-- Raw token: flowspace-test-invite-token
-- ---------------------------------------------------------------------

insert into public.invitations (org_id, email, role, token_hash, invited_by, expires_at)
values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'member@northwind.test',
  'member',
  encode(sha256(convert_to('flowspace-test-invite-token', 'utf8')), 'hex'),
  '33333333-3333-4333-8333-333333333333',
  now() + interval '7 days'
)
on conflict (token_hash) do nothing;

reset search_path;
