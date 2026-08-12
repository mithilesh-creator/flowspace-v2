/**
 * Phase 2 tenant-isolation suite — lists and cards.
 *
 * The sibling of realtime-isolation.test.mjs, one level down the tree.
 * That file proved a board created in tenant A does not reach tenant B's
 * socket. This one proves the same for the rows a Kanban board is actually
 * made of, and adds the two failures that only exist once cards can move:
 *
 *   K7 — a card cannot be dragged into another tenant's list. Refused by
 *        the composite foreign key, which means it is refused by the shape
 *        of the schema rather than by a policy someone remembered to
 *        write. It surfaces as 400 (23503), not 403 (42501), and that is
 *        correct: the row the reference points at does not exist, which is
 *        a different statement from "you may not touch it".
 *
 *   K8 — a card cannot be dragged onto another *board of the same tenant*.
 *        The composite key is perfectly happy with that — same org — so
 *        there is no database backstop and the route's own check is the
 *        only thing enforcing it. Precisely the kind of rule that rots
 *        silently, so it gets its own assertion.
 *
 * Requires the backend running on PORT and supabase/seed.sql loaded.
 *
 *   node --env-file=.env tests/kanban-isolation.test.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { io } from 'socket.io-client';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const API = `http://localhost:${process.env.PORT ?? 4000}`;

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Northwind
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Acme
const BOARD_B = 'bbbb0001-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Acme / Fleet Rollout
const LIST_B = 'bbbb1001-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Acme / Backlog (seed)
const PASSWORD = 'password123';
const QUIET_MS = 1200;

const results = [];
const sockets = [];
const cleanup = [];

// Everything tenant B's socket hears on a Phase 2 channel while tenant A
// works. Must still be empty at the end of the run.
const bHeard = [];

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
  // websocket-only for the same reason realtime-isolation.test.mjs pins
  // it: this suite writes immediately after connecting, and a broadcast
  // landing inside the polling→WebSocket upgrade window is dropped.
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

/** Status + body, without throwing — the failure cases are the point. */
async function apiTry(path, { token, socketId, ...init } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (socketId) headers['X-Socket-Id'] = socketId;
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function api(path, options = {}) {
  const { status, body } = await apiTry(path, options);
  if (status >= 400) {
    throw new Error(`${status} ${body?.error?.message ?? 'request failed'} (${path})`);
  }
  return body;
}

async function main() {
  const [aOwnerToken, aMemberToken, bOwnerToken] = await Promise.all([
    signIn('owner@northwind.test'),
    signIn('member@northwind.test'),
    signIn('owner@acme.test'),
  ]);

  const aOwner = await connect(aOwnerToken);
  const aMember = await connect(aMemberToken);
  const bOwner = await connect(bOwnerToken);

  const joinA = await join(aOwner, ORG_A);
  const joinAMember = await join(aMember, ORG_A);
  const joinB = await join(bOwner, ORG_B);
  record(
    'K0 three sessions in two tenants',
    joinA?.ok === true && joinAMember?.ok === true && joinB?.ok === true,
    `A owner=${joinA?.role}, A member=${joinAMember?.role}, B owner=${joinB?.role}`
  );

  for (const event of [
    'list:created',
    'list:updated',
    'list:deleted',
    'list:moved',
    'card:created',
    'card:updated',
    'card:deleted',
    'card:moved',
  ]) {
    bOwner.on(event, (payload) => bHeard.push({ event, payload }));
  }

  // A scratch board of our own, so a failing assertion cannot corrupt
  // seeded data and a rerun does not depend on the last run's leftovers.
  const { board } = await api(`/api/orgs/${ORG_A}/boards`, {
    token: aOwnerToken,
    method: 'POST',
    body: JSON.stringify({ title: 'kanban isolation probe' }),
  });
  cleanup.push(board.id);

  // ------------------------------------------------------------------
  // K1 — a list broadcasts to the tenant, to nobody else, and not back to
  //      its author.
  // ------------------------------------------------------------------
  const teammateList = nextEvent(aMember, 'list:created', QUIET_MS + 1500);
  const authorList = nextEvent(aOwner, 'list:created', QUIET_MS + 1500);

  const { list } = await api(`/api/orgs/${ORG_A}/boards/${board.id}/lists`, {
    token: aOwnerToken,
    socketId: aOwner.id,
    method: 'POST',
    body: JSON.stringify({ title: 'Backlog' }),
  });

  const [heardList, echoedList] = await Promise.all([teammateList, authorList]);
  record(
    'K1 list:created reaches the tenant',
    heardList?.list?.id === list.id &&
      heardList.orgId === ORG_A &&
      heardList.boardId === board.id,
    heardList
      ? `payload carried orgId + boardId + list "${heardList.list.title}"`
      : 'no event received'
  );
  record(
    'K2 author gets no echo of its own list',
    echoedList === null,
    echoedList === null ? 'X-Socket-Id suppressed the echo' : 'author received its own event'
  );

  const second = await api(`/api/orgs/${ORG_A}/boards/${board.id}/lists`, {
    token: aOwnerToken,
    method: 'POST',
    body: JSON.stringify({ title: 'Doing' }),
  });
  record(
    'K3 lists append in order',
    second.list.position > list.position,
    `positions ${list.position} then ${second.list.position}`
  );

  // ------------------------------------------------------------------
  // K4/K5 — cards, and the move payload the client needs.
  // ------------------------------------------------------------------
  const teammateCard = nextEvent(aMember, 'card:created', QUIET_MS + 1500);
  const { card } = await api(`/api/orgs/${ORG_A}/boards/${board.id}/cards`, {
    token: aOwnerToken,
    socketId: aOwner.id,
    method: 'POST',
    body: JSON.stringify({ listId: list.id, title: 'Write the migration' }),
  });
  const heardCard = await teammateCard;
  record(
    'K4 card:created reaches the tenant',
    heardCard?.card?.id === card.id && heardCard.boardId === board.id,
    heardCard ? `card "${heardCard.card.title}" on board ${heardCard.boardId}` : 'no event received'
  );

  const teammateMove = nextEvent(aMember, 'card:moved', QUIET_MS + 1500);
  const moved = await api(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}/move`,
    {
      token: aOwnerToken,
      socketId: aOwner.id,
      method: 'POST',
      body: JSON.stringify({ listId: second.list.id, position: 1 }),
    }
  );
  const heardMove = await teammateMove;
  record(
    'K5 card:moved carries fromListId',
    heardMove?.card?.list_id === second.list.id && heardMove.fromListId === list.id,
    heardMove
      ? `moved ${heardMove.fromListId.slice(0, 8)} → ${heardMove.card.list_id.slice(0, 8)}`
      : 'no event received'
  );
  record(
    'K6 move echoes the authoritative row',
    moved.card.list_id === second.list.id && moved.card.position === 1,
    `server returned list_id=${moved.card.list_id.slice(0, 8)} position=${moved.card.position}`
  );

  // ------------------------------------------------------------------
  // K7 — THE ONE. Tenant A tries to drop its card into tenant B's list.
  //
  //      400, not 403: the card keeps org_id = A, so the UPDATE policy is
  //      satisfied and it is the composite foreign key that refuses —
  //      (B's list, A's org) matches no row in lists. 23503 → 400 through
  //      fromPostgrestError. Structural refusal, not a permission check.
  // ------------------------------------------------------------------
  const crossTenantMove = await apiTry(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}/move`,
    {
      token: aOwnerToken,
      method: 'POST',
      body: JSON.stringify({ listId: LIST_B, position: 1 }),
    }
  );
  record(
    'K7 card cannot be moved into another tenant\'s list',
    crossTenantMove.status === 400,
    crossTenantMove.status === 400
      ? `refused 400 "${crossTenantMove.body?.error?.message}" (composite FK, 23503)`
      : `LEAK: expected 400, got ${crossTenantMove.status}`
  );

  const stillOurs = await api(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}/move`,
    {
      token: aOwnerToken,
      method: 'POST',
      body: JSON.stringify({ listId: second.list.id, position: 2 }),
    }
  );
  record(
    'K7b the refused move changed nothing',
    stillOurs.card.list_id === second.list.id,
    'card is still on its own board and still movable'
  );

  // ------------------------------------------------------------------
  // K8 — same tenant, different board. The FK cannot see anything wrong
  //      with this; only the route can.
  // ------------------------------------------------------------------
  const other = await api(`/api/orgs/${ORG_A}/boards`, {
    token: aOwnerToken,
    method: 'POST',
    body: JSON.stringify({ title: 'kanban isolation probe 2' }),
  });
  cleanup.push(other.board.id);
  const otherList = await api(`/api/orgs/${ORG_A}/boards/${other.board.id}/lists`, {
    token: aOwnerToken,
    method: 'POST',
    body: JSON.stringify({ title: 'Elsewhere' }),
  });

  const crossBoardMove = await apiTry(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}/move`,
    {
      token: aOwnerToken,
      method: 'POST',
      body: JSON.stringify({ listId: otherList.list.id, position: 1 }),
    }
  );
  record(
    'K8 card cannot be moved onto another board of the same tenant',
    crossBoardMove.status === 404,
    crossBoardMove.status === 404
      ? `refused 404 "${crossBoardMove.body?.error?.message}" (route check, no FK backstop)`
      : `expected 404, got ${crossBoardMove.status}`
  );

  // ------------------------------------------------------------------
  // K9/K10 — REST across the tenant line, in both directions.
  // ------------------------------------------------------------------
  const bReadsA = await apiTry(`/api/orgs/${ORG_A}/boards/${board.id}`, {
    token: bOwnerToken,
  });
  record(
    'K9 cross-tenant board read refused',
    bReadsA.status === 404,
    `tenant B got ${bReadsA.status} reading tenant A's board`
  );

  const bWritesA = await apiTry(`/api/orgs/${ORG_A}/boards/${board.id}/lists`, {
    token: bOwnerToken,
    method: 'POST',
    body: JSON.stringify({ title: 'Injected by tenant B' }),
  });
  record(
    'K10 cross-tenant list write refused',
    bWritesA.status === 404,
    `tenant B got ${bWritesA.status} writing into tenant A's board`
  );

  const aWritesB = await apiTry(`/api/orgs/${ORG_B}/boards/${BOARD_B}/cards`, {
    token: aOwnerToken,
    method: 'POST',
    body: JSON.stringify({ listId: LIST_B, title: 'Injected by tenant A' }),
  });
  record(
    'K11 reverse direction refused too',
    aWritesB.status === 404,
    `tenant A got ${aWritesB.status} writing into tenant B's board`
  );

  // ------------------------------------------------------------------
  // K12 — role gates. A member does ordinary card work; deleting a list
  //       cascades its cards and is an admin action (migration 0010).
  // ------------------------------------------------------------------
  const memberCard = await apiTry(`/api/orgs/${ORG_A}/boards/${board.id}/cards`, {
    token: aMemberToken,
    method: 'POST',
    body: JSON.stringify({ listId: list.id, title: 'Member wrote this' }),
  });
  const memberDeletesList = await apiTry(
    `/api/orgs/${ORG_A}/boards/${board.id}/lists/${second.list.id}`,
    { token: aMemberToken, method: 'DELETE' }
  );
  record(
    'K12 member creates cards but cannot delete a list',
    memberCard.status === 201 && memberDeletesList.status === 403,
    `card ${memberCard.status}, list delete ${memberDeletesList.status}`
  );

  // ------------------------------------------------------------------
  // K13 — the nested read the client resyncs from.
  // ------------------------------------------------------------------
  const full = await api(`/api/orgs/${ORG_A}/boards/${board.id}`, { token: aOwnerToken });
  const positions = full.lists.map((l) => l.position);
  const nestedCard = full.lists
    .flatMap((l) => l.cards ?? [])
    .find((c) => c.id === card.id);
  record(
    'K13 GET board returns lists and cards nested and ordered',
    full.board.id === board.id &&
      full.lists.length === 2 &&
      positions.every((p, i) => i === 0 || positions[i - 1] <= p) &&
      nestedCard?.list_id === second.list.id,
    `${full.lists.length} lists, positions [${positions.join(', ')}], card found in its list`
  );

  // ------------------------------------------------------------------
  // K14 — deletes broadcast, and a list takes its cards with it.
  // ------------------------------------------------------------------
  const cardDeleted = nextEvent(aMember, 'card:deleted', 4000);
  await api(`/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}`, {
    token: aOwnerToken,
    method: 'DELETE',
  });
  const heardCardDelete = await cardDeleted;

  const listDeleted = nextEvent(aMember, 'list:deleted', 4000);
  await api(`/api/orgs/${ORG_A}/boards/${board.id}/lists/${list.id}`, {
    token: aOwnerToken,
    method: 'DELETE',
  });
  const heardListDelete = await listDeleted;

  record(
    'K14 deletes broadcast to the room',
    heardCardDelete?.cardId === card.id && heardListDelete?.listId === list.id,
    `card:deleted ${heardCardDelete ? 'received' : 'missing'}, list:deleted ${
      heardListDelete ? 'received' : 'missing'
    }`
  );

  const afterCascade = await api(`/api/orgs/${ORG_A}/boards/${board.id}`, {
    token: aOwnerToken,
  });
  record(
    'K15 deleting a list cascades its cards',
    afterCascade.lists.length === 1 &&
      afterCascade.lists.every((l) => !l.cards.some((c) => c.list_id === list.id)),
    `${afterCascade.lists.length} list(s) left, none of the deleted list's cards remain`
  );

  // ------------------------------------------------------------------
  // K16 — and after all of that, tenant B heard nothing at all.
  // ------------------------------------------------------------------
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  record(
    'K16 tenant B silent throughout',
    bHeard.length === 0,
    bHeard.length === 0
      ? 'no list:* or card:* events crossed the tenant line'
      : `LEAK: tenant B received ${bHeard.map((e) => e.event).join(', ')}`
  );
}

main()
  .catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.code ?? err.cause.message})` : '';
    record('SUITE', false, `aborted: ${err.message}${cause}`);
  })
  .finally(async () => {
    // Deleting the probe boards cascades their lists and cards.
    try {
      const token = await signIn('owner@northwind.test');
      for (const boardId of cleanup) {
        await apiTry(`/api/orgs/${ORG_A}/boards/${boardId}`, { token, method: 'DELETE' });
      }
    } catch {
      console.log('cleanup skipped — probe boards may need removing by hand');
    }

    for (const socket of sockets) socket.disconnect();

    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} passed` +
        (failed.length ? ` — FAILURES: ${failed.map((f) => f.id).join(', ')}` : '')
    );
    process.exit(failed.length ? 1 : 0);
  });
