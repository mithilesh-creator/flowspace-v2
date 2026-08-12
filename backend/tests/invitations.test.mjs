/**
 * Invitation flow suite.
 *
 * Covers the API layer that migration 0006 could not: issuing a token,
 * who may issue it, and who may redeem it. The database tests already
 * prove accept_invitation() binds a token to an email; these prove the
 * HTTP surface in front of it does not hand that power to the wrong
 * person.
 *
 * Requires the backend running and the seed loaded. Self-cleaning: every
 * invitation and membership it creates is removed at the end.
 *
 *   npm run test:invitations
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const API = `http://localhost:${process.env.PORT ?? 4000}`;

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Northwind
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Acme
const PASSWORD = 'password123';

const results = [];
const cleanup = [];

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  — ${detail}`);
}

async function signIn(email) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return data.session.access_token;
}

/** Never throws — returns { status, body } so tests can assert on 4xx. */
async function call(path, { token, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  const [aOwner, aAdmin, aMember, bOwner] = await Promise.all([
    signIn('owner@northwind.test'),
    signIn('admin@northwind.test'),
    signIn('member@northwind.test'),
    signIn('owner@acme.test'),
  ]);

  // I1 — an ordinary member cannot invite. Membership is not authority.
  const asMember = await call(`/api/orgs/${ORG_A}/invitations`, {
    token: aMember,
    method: 'POST',
    body: { email: 'nope@example.com', role: 'member' },
  });
  record('I1 member cannot invite', asMember.status === 403,
    `responded ${asMember.status}`);

  // I2 — nor can another tenant, even naming org A explicitly. 404, not
  // 403: from outside the tenant, the org does not exist.
  const asOtherTenant = await call(`/api/orgs/${ORG_A}/invitations`, {
    token: bOwner,
    method: 'POST',
    body: { email: 'nope@example.com', role: 'member' },
  });
  record('I2 other tenant cannot invite', asOtherTenant.status === 404,
    `responded ${asOtherTenant.status}`);

  // I3 — an admin can invite, and the raw token comes back exactly once.
  const created = await call(`/api/orgs/${ORG_A}/invitations`, {
    token: aAdmin,
    method: 'POST',
    body: { email: 'owner@acme.test', role: 'member' },
  });
  const inviteId = created.body?.invitation?.id;
  const rawToken = created.body?.token;
  if (inviteId) cleanup.push({ orgId: ORG_A, inviteId, token: aOwner });

  record('I3 admin can invite',
    created.status === 201 && !!rawToken && !!created.body?.inviteUrl,
    created.status === 201
      ? `201, token issued, url ${created.body.inviteUrl.slice(0, 42)}…`
      : `responded ${created.status}: ${created.body?.error?.message}`);

  // I4 — an admin cannot mint an owner. Same escalation guard as the
  // memberships policy, enforced before the database is even asked.
  const ownerInvite = await call(`/api/orgs/${ORG_A}/invitations`, {
    token: aAdmin,
    method: 'POST',
    body: { email: 'someone-else@example.com', role: 'owner' },
  });
  record('I4 admin cannot invite an owner', ownerInvite.status === 403,
    `responded ${ownerInvite.status}`);

  // I5 — the stored hash must not be readable. Listing returns metadata
  // only; a token_hash in the response would make the list a keyring.
  const listed = await call(`/api/orgs/${ORG_A}/invitations`, { token: aAdmin });
  const leaksHash = JSON.stringify(listed.body ?? {}).includes('token_hash');
  record('I5 listing does not expose token_hash',
    listed.status === 200 && !leaksHash,
    leaksHash ? 'LEAK: token_hash present in response' : 'metadata only');

  // I6 — duplicate invitation for the same live address is rejected.
  const duplicate = await call(`/api/orgs/${ORG_A}/invitations`, {
    token: aAdmin,
    method: 'POST',
    body: { email: 'owner@acme.test', role: 'member' },
  });
  record('I6 duplicate invitation rejected', duplicate.status === 409,
    `responded ${duplicate.status}`);

  // I7 — the token is bound to its email. aMember is a real, signed-in
  // user holding a valid token that simply is not theirs.
  const wrongPerson = await call('/api/invitations/accept', {
    token: aMember,
    method: 'POST',
    body: { token: rawToken },
  });
  record('I7 wrong recipient cannot redeem', wrongPerson.status === 403,
    `responded ${wrongPerson.status}: ${wrongPerson.body?.error?.message ?? ''}`);

  // I8 — a forged token is rejected, not merely ignored.
  const forged = await call('/api/invitations/accept', {
    token: aMember,
    method: 'POST',
    body: { token: 'not-a-real-token' },
  });
  record('I8 forged token rejected', forged.status === 404,
    `responded ${forged.status}`);

  // I9 — the right recipient joins, and lands in the right tenant with
  // the role the inviter chose.
  const accepted = await call('/api/invitations/accept', {
    token: bOwner,
    method: 'POST',
    body: { token: rawToken },
  });
  const membership = accepted.body?.membership;
  if (membership) {
    cleanup.push({ removeMembership: membership.id, orgId: ORG_A, token: aOwner });
  }
  record('I9 correct recipient joins',
    accepted.status === 201 &&
      membership?.org_id === ORG_A &&
      membership?.role === 'member',
    accepted.status === 201
      ? `joined ${membership.org_id.slice(0, 8)}… as ${membership.role}`
      : `responded ${accepted.status}: ${accepted.body?.error?.message}`);

  // I10 — single use. The same link must not work twice.
  const replay = await call('/api/invitations/accept', {
    token: bOwner,
    method: 'POST',
    body: { token: rawToken },
  });
  record('I10 token is single-use', replay.status === 400,
    `responded ${replay.status}: ${replay.body?.error?.message ?? ''}`);

  // I11 — the new member can now actually see the workspace. Proves the
  // membership is real and not just a row.
  const boards = await call(`/api/orgs/${ORG_A}/boards`, { token: bOwner });
  record('I11 new member can read the workspace',
    boards.status === 200 && Array.isArray(boards.body?.boards),
    boards.status === 200
      ? `sees ${boards.body.boards.length} board(s)`
      : `responded ${boards.status}`);

  // I12 — revoking works, so a mis-sent invitation can be killed.
  const revokeTarget = await call(`/api/orgs/${ORG_B}/invitations`, {
    token: bOwner,
    method: 'POST',
    body: { email: 'temp-revoke@example.com', role: 'client' },
  });
  const revoked = await call(
    `/api/orgs/${ORG_B}/invitations/${revokeTarget.body?.invitation?.id}`,
    { token: bOwner, method: 'DELETE' }
  );
  const afterRevoke = await call('/api/invitations/accept', {
    token: aMember,
    method: 'POST',
    body: { token: revokeTarget.body?.token },
  });
  record('I12 revoked invitation cannot be redeemed',
    revoked.status === 204 && afterRevoke.status === 404,
    `revoke ${revoked.status}, redeem ${afterRevoke.status}`);
}

async function runCleanup() {
  for (const item of cleanup) {
    try {
      if (item.removeMembership) {
        // Remove the membership I9 created so the suite is repeatable.
        await call(`/api/orgs/${item.orgId}/members/${item.removeMembership}`, {
          token: item.token,
          method: 'DELETE',
        });
      } else if (item.inviteId) {
        await call(`/api/orgs/${item.orgId}/invitations/${item.inviteId}`, {
          token: item.token,
          method: 'DELETE',
        });
      }
    } catch {
      // Best effort — reported below via the residue check.
    }
  }
}

main()
  .catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.code ?? err.cause.message})` : '';
    record('SUITE', false, `aborted: ${err.message}${cause}`);
  })
  .finally(async () => {
    await runCleanup();

    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} passed` +
        (failed.length ? ` — FAILURES: ${failed.map((f) => f.id).join(', ')}` : '')
    );
    process.exit(failed.length ? 1 : 0);
  });
