/**
 * Realtime tenant-isolation suite.
 *
 * supabase/tests/rls.test.sql proves the database will not serve one
 * tenant another tenant's rows. It says nothing about Socket.io, because
 * broadcasts never touch a policy — a board created in tenant A reaches
 * whoever is in the room, and the room is chosen by application code.
 *
 * That was the one gap called out in docs/architecture.md. This closes
 * it: real clients, real tokens, real rooms, asserting that a tenant B
 * socket is both refused entry to tenant A's room and silent when tenant
 * A writes.
 *
 * Requires the backend running on VITE_API_URL/PORT and the seed loaded.
 *
 *   node --env-file=.env tests/realtime-isolation.test.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { io } from 'socket.io-client';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const API = `http://localhost:${process.env.PORT ?? 4000}`;

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Northwind
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Acme
const PASSWORD = 'password123';
const QUIET_MS = 1500;

const results = [];
const sockets = [];
let createdBoardId = null;

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

function connect(accessToken) {
  // websocket-only, deliberately.
  //
  // By default Socket.io connects on HTTP long-polling and upgrades to
  // WebSocket a moment later. A broadcast landing inside that upgrade
  // window can be dropped, and this suite writes immediately after
  // connecting — so with the default transports R5 fails maybe one run
  // in three, for a reason that has nothing to do with tenant isolation.
  // Pinning the transport removes the race so a failure here means what
  // it says. The app keeps the polling fallback (proxies that block
  // WebSocket are real) and instead resyncs on org:joined.
  const socket = io(API, {
    auth: { access_token: accessToken },
    transports: ['websocket'],
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timed out')), 8000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function join(socket, orgId) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit('org:join', { orgId }, (timeoutErr, ack) => {
      resolve(timeoutErr ? { ok: false, error: 'timeout' } : ack);
    });
  });
}

/** Resolves with the event payload, or null if nothing arrives in `ms`. */
function nextEvent(socket, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function apiFetch(path, { token, socketId, ...init } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (socketId) headers['X-Socket-Id'] = socketId;
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${res.status} ${body?.error?.message ?? 'request failed'}`);
  }
  return body;
}

async function main() {
  const [aOwnerToken, aMemberToken, bOwnerToken] = await Promise.all([
    signIn('owner@northwind.test'),
    signIn('member@northwind.test'),
    signIn('owner@acme.test'),
  ]);

  // R1 — a socket with no credentials must be refused outright.
  await new Promise((resolve) => {
    const rogue = io(API, { auth: {}, reconnection: false });
    sockets.push(rogue);
    const timer = setTimeout(() => {
      record('R1 unauthenticated socket refused', false, 'connection was not rejected');
      resolve();
    }, 5000);
    rogue.once('connect', () => {
      clearTimeout(timer);
      record('R1 unauthenticated socket refused', false, 'LEAK: rogue socket connected');
      resolve();
    });
    rogue.once('connect_error', (err) => {
      clearTimeout(timer);
      record('R1 unauthenticated socket refused', err.message === 'unauthorized',
        `rejected with "${err.message}"`);
      resolve();
    });
  });

  const aOwner = await connect(aOwnerToken);
  const aMember = await connect(aMemberToken);
  const bOwner = await connect(bOwnerToken);
  record('R2 authenticated sockets connect', true, 'three sessions established');

  // R3 — members are admitted to their own tenant's room.
  const joinA = await join(aOwner, ORG_A);
  const joinAMember = await join(aMember, ORG_A);
  const joinB = await join(bOwner, ORG_B);
  record('R3 members join their own room',
    joinA?.ok === true && joinA.role === 'owner' && joinAMember?.ok === true && joinB?.ok === true,
    `A owner=${joinA?.role}, A member=${joinAMember?.role}, B owner=${joinB?.role}`);

  // R4 — the important one. Tenant B asks to join tenant A's room by
  // naming its uuid. The server must refuse on a fresh membership check
  // rather than trusting the payload.
  const unauthorized = nextEvent(bOwner, 'error:unauthorized', 3000);
  const crossJoin = await join(bOwner, ORG_A);
  const gotUnauthorized = await unauthorized;
  record('R4 cross-tenant room join refused',
    crossJoin?.ok === false && gotUnauthorized !== null,
    crossJoin?.ok === false
      ? `refused ("${crossJoin.error}") and error:unauthorized emitted`
      : 'LEAK: tenant B was admitted to tenant A room');

  // R5/R6 — write into tenant A and watch all three listeners.
  const aMemberHears = nextEvent(aMember, 'board:created', QUIET_MS + 1500);
  const bOwnerHears = nextEvent(bOwner, 'board:created', QUIET_MS + 1500);
  const aOwnerHears = nextEvent(aOwner, 'board:created', QUIET_MS + 1500);

  const created = await apiFetch(`/api/orgs/${ORG_A}/boards`, {
    token: aOwnerToken,
    socketId: aOwner.id,
    method: 'POST',
    body: JSON.stringify({ title: 'realtime isolation probe' }),
  });
  createdBoardId = created.board.id;

  const [heardByTeammate, heardByOtherTenant, heardByAuthor] = await Promise.all([
    aMemberHears,
    bOwnerHears,
    aOwnerHears,
  ]);

  record('R5 teammate receives the broadcast',
    heardByTeammate?.board?.id === createdBoardId,
    heardByTeammate ? `board:created for "${heardByTeammate.board.title}"` : 'no event received');

  record('R6 other tenant hears nothing',
    heardByOtherTenant === null,
    heardByOtherTenant === null
      ? `silent for ${QUIET_MS}ms+ while tenant A wrote`
      : `LEAK: tenant B received board ${heardByOtherTenant.board?.id}`);

  record('R7 author does not get its own echo',
    heardByAuthor === null,
    heardByAuthor === null ? 'X-Socket-Id suppressed the echo' : 'author received its own event');

  // R8 — REST is closed too, not just the room.
  let restBlocked = false;
  let restDetail = '';
  try {
    await apiFetch(`/api/orgs/${ORG_A}/boards`, { token: bOwnerToken });
  } catch (err) {
    restBlocked = err.message.startsWith('404');
    restDetail = err.message;
  }
  record('R8 cross-tenant REST read refused', restBlocked,
    restBlocked ? `responded ${restDetail}` : `expected 404, got: ${restDetail || 'success'}`);

  // R9 — deleting emits to the room and cleans up after ourselves.
  const deletion = nextEvent(aMember, 'board:deleted', 4000);
  await apiFetch(`/api/orgs/${ORG_A}/boards/${createdBoardId}`, {
    token: aOwnerToken,
    method: 'DELETE',
  });
  const deleted = await deletion;
  record('R9 delete broadcasts to the room',
    deleted?.boardId === createdBoardId,
    deleted ? 'board:deleted received' : 'no event received');
  createdBoardId = null;
}

main()
  .catch((err) => {
    // Surface err.cause: a bare "fetch failed" from undici hides the
    // actual reason (connection refused, DNS, socket hang up) and sent
    // us looking for a bug in the app when the dev server had simply
    // restarted underneath the run.
    const cause = err.cause ? ` (cause: ${err.cause.code ?? err.cause.message})` : '';
    record('SUITE', false, `aborted: ${err.message}${cause}`);
  })
  .finally(async () => {
    for (const socket of sockets) socket.disconnect();

    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} passed` +
        (failed.length ? ` — FAILURES: ${failed.map((f) => f.id).join(', ')}` : '')
    );
    process.exit(failed.length ? 1 : 0);
  });
