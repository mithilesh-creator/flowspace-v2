/**
 * Phase 2 hardening suite — H1 to H4.
 *
 * The third sibling of realtime-isolation.test.mjs and
 * kanban-isolation.test.mjs. Those two prove the isolation that already
 * works; this one covers the four gaps docs/architecture.md admits to and
 * docs/phase-2-hardening-contract.md schedules for repair. Every check
 * here is written to FAIL against the pre-hardening build and pass after
 * the fix — a green run of this file is the definition of H1–H4 landing.
 *
 *   H1 — a card can be assigned to a profile outside the org. Nobody can
 *        read the card, so it is not a leak; it is an invariant with
 *        nothing holding it up. Closed by a composite FK
 *        (org_id, assignee_id) -> memberships(org_id, user_id).
 *
 *   H2 — a card can be moved onto a *different board of the same tenant*.
 *        routes/cards.js refuses it (K8 in the kanban suite proves that),
 *        but the route is the only thing that does: PostgREST is reachable
 *        from the browser with the same anon key and the same session, so
 *        "the Express route checks it" is not a control. Closed by
 *        denormalising board_id onto cards and extending the FK.
 *
 *   H3 — cards have no position rebalance, which is where fractional drift
 *        actually accumulates. rebalance_card_positions(p_list) must exist,
 *        must be SECURITY INVOKER (so RLS filters it to the caller's own
 *        rows), and must not be callable by anon.
 *
 *   H4 — THE IMPORTANT ONE. Removing a member deletes the membership, so
 *        REST closes immediately; their open socket keeps receiving that
 *        tenant's broadcasts until it happens to disconnect. This has to be
 *        fixed before the client portal, where revoking an outsider's
 *        access *is* the feature.
 *
 * Ordering is load-bearing: H1 needs owner@acme.test to be an outsider to
 * Northwind, and H4 makes them a member of it (temporarily, via a real
 * invitation) in order to remove them again. H1–H3 therefore run first,
 * and the H4 removal doubles as its own cleanup.
 *
 * Requires the backend running on PORT and supabase/seed.sql loaded.
 * Self-cleaning: probe boards are deleted and the temporary membership is
 * removed even when the run aborts.
 *
 *   node --env-file=.env tests/hardening.test.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { io } from 'socket.io-client';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const API = `http://localhost:${process.env.PORT ?? 4000}`;

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // Northwind
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Acme
const LIST_B = 'bbbb1001-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; // Acme / Backlog (seed)

const USER_A_MEMBER = '22222222-2222-4222-8222-222222222222'; // member@northwind
const USER_B_OWNER = '33333333-3333-4333-8333-333333333333'; // owner@acme

const PASSWORD = 'password123';

// How long a removed member's socket has to stay silent. Long enough that
// a slow broadcast is not mistaken for eviction: every write in the H4
// phase is acknowledged by the control socket well inside it.
const SILENCE_MS = 2000;
// Grace given to the eviction itself, between the removal returning 204
// and the writes starting.
const EVICTION_SETTLE_MS = 1000;

// Every event a Phase 2 client subscribes to. A removed member must
// receive none of them; the control member must receive them all.
const TENANT_EVENTS = [
  'board:created',
  'board:updated',
  'board:deleted',
  'list:created',
  'list:updated',
  'list:deleted',
  'list:moved',
  'card:created',
  'card:updated',
  'card:deleted',
  'card:moved',
  'member:removed',
];

const results = [];
const sockets = [];
const boardCleanup = [];
const membershipCleanup = [];

// The one Northwind board every phase writes to, set up in main(). Held
// here so H5 can write to it without main() threading it through a second
// argument list.
const SCRATCH = { board: null, list: null };

function record(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  — ${detail}`);
}

/**
 * Returns the token *and* a supabase-js client bound to it.
 *
 * Several checks below deliberately bypass Express and speak to PostgREST
 * directly. That is not a shortcut: the browser holds the anon key and the
 * user's session, so anything the database itself allows is reachable by
 * any signed-in user with curl. Per CLAUDE.md, RLS and the schema are the
 * authorization layer — a rule only routes/cards.js enforces is not
 * enforced.
 */
async function signIn(email) {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { token: data.session.access_token, userId: data.user.id, supabase };
}

function connect(accessToken) {
  // websocket-only, for the same reason the other two suites pin it: this
  // file writes immediately after connecting, and a broadcast landing
  // inside the polling -> WebSocket upgrade window is dropped. A dropped
  // event would make H4 pass for the wrong reason, which is the single
  // worst outcome available to this file.
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

/**
 * Records every tenant event a socket hears into an array, so silence can
 * be asserted over a window rather than per event. Returns the array plus
 * a reset, because H4 needs "nothing after this point", not "nothing ever".
 */
function transcribe(socket) {
  const heard = [];
  for (const event of TENANT_EVENTS) {
    socket.on(event, (payload) => heard.push({ event, payload }));
  }
  return {
    heard,
    reset() {
      heard.length = 0;
    },
    names() {
      return heard.map((e) => e.event).join(', ') || 'nothing';
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Status + body, never throws — the refusals are the subject matter. */
async function apiTry(path, { token, socketId, ...init } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
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

// =====================================================================
// H1 — assignee_id must reference a member of the same org.
// =====================================================================
async function testH1({ aOwner, board, list }) {
  const { card } = await api(`/api/orgs/${ORG_A}/boards/${board.id}/cards`, {
    token: aOwner.token,
    method: 'POST',
    body: JSON.stringify({ listId: list.id, title: 'H1 assignee probe' }),
  });

  // H1.1 — the legitimate case still works. Without this, "assignment is
  // refused" could be satisfied by refusing every assignment.
  const toTeammate = await apiTry(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}`,
    {
      token: aOwner.token,
      method: 'PATCH',
      body: JSON.stringify({ assigneeId: USER_A_MEMBER }),
    }
  );
  record(
    'H1.1 a card can be assigned to a member of the org',
    toTeammate.status === 200 && toTeammate.body?.card?.assignee_id === USER_A_MEMBER,
    toTeammate.status === 200
      ? `assigned to ${toTeammate.body.card.assignee_id.slice(0, 8)}…`
      : `responded ${toTeammate.status}: ${toTeammate.body?.error?.message}`
  );

  // H1.2 — the fix. owner@acme.test is a real profile in another tenant.
  // The composite FK (org_id, assignee_id) -> memberships has no row to
  // point at, so 23503 -> 400 via fromPostgrestError. Before H1 there is
  // no such FK and this returns 200.
  const toOutsider = await apiTry(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}`,
    {
      token: aOwner.token,
      method: 'PATCH',
      body: JSON.stringify({ assigneeId: USER_B_OWNER }),
    }
  );
  record(
    'H1.2 a card cannot be assigned to a user outside the org',
    toOutsider.status === 400,
    toOutsider.status === 400
      ? `refused 400 "${toOutsider.body?.error?.message}" (composite FK, 23503)`
      : `expected 400, got ${toOutsider.status} — H1 not enforced`
  );

  // H1.3 — and not through PostgREST either. Same write, no Express in the
  // path. If this one passes while H1.2 fails, the check was put in the
  // route instead of the schema.
  const { error: directError } = await aOwner.supabase
    .from('cards')
    .update({ assignee_id: USER_B_OWNER })
    .eq('id', card.id);
  record(
    'H1.3 the database refuses the same write directly',
    directError?.code === '23503',
    directError
      ? `refused ${directError.code} "${directError.message.slice(0, 80)}"`
      : 'LEAK: PostgREST accepted a cross-tenant assignee — the rule is route-only'
  );

  // H1.4 — nothing stuck. A refused write that half-applied would be worse
  // than one that was allowed.
  const after = await api(`/api/orgs/${ORG_A}/boards/${board.id}`, {
    token: aOwner.token,
  });
  const stored = after.lists
    .flatMap((l) => l.cards ?? [])
    .find((c) => c.id === card.id);
  record(
    'H1.4 the refused assignment left the card untouched',
    stored?.assignee_id === USER_A_MEMBER,
    `assignee is ${stored?.assignee_id ? `${stored.assignee_id.slice(0, 8)}…` : 'null'}, expected the teammate`
  );

  // H1.5 — nullable, so an unassigned card stays legal under the new FK.
  const cleared = await apiTry(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}`,
    {
      token: aOwner.token,
      method: 'PATCH',
      body: JSON.stringify({ assigneeId: null }),
    }
  );
  record(
    'H1.5 an unassigned card is still valid',
    cleared.status === 200 && cleared.body?.card?.assignee_id === null,
    cleared.status === 200
      ? 'assignee_id cleared to null'
      : `responded ${cleared.status}: ${cleared.body?.error?.message}`
  );

  return card;
}

// =====================================================================
// H2 — a card cannot sit on a list belonging to another board.
// =====================================================================
async function testH2({ aOwner, board, list, card }) {
  // A second board in the same tenant, with a list of its own. Same
  // org_id throughout, so RLS and the existing (list_id, org_id) key are
  // both perfectly happy with the move that follows.
  const { board: otherBoard } = await api(`/api/orgs/${ORG_A}/boards`, {
    token: aOwner.token,
    method: 'POST',
    body: JSON.stringify({ title: 'hardening probe — second board' }),
  });
  boardCleanup.push(otherBoard.id);

  const { list: otherList } = await api(
    `/api/orgs/${ORG_A}/boards/${otherBoard.id}/lists`,
    {
      token: aOwner.token,
      method: 'POST',
      body: JSON.stringify({ title: 'Elsewhere' }),
    }
  );

  // H2.1 — the route check that exists today must keep working. This is a
  // regression guard, not the H2 assertion: it passes before and after.
  const viaRoute = await apiTry(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}/move`,
    {
      token: aOwner.token,
      method: 'POST',
      body: JSON.stringify({ listId: otherList.id, position: 1 }),
    }
  );
  record(
    'H2.1 the move route still refuses another board of the same tenant',
    viaRoute.status === 404,
    `responded ${viaRoute.status} "${viaRoute.body?.error?.message ?? ''}"`
  );

  // H2.2 — the fix. The same move, straight at PostgREST with the user's
  // own session: exactly what a browser console can do. With board_id
  // denormalised onto cards and the FK extended to
  // (list_id, board_id, org_id) -> lists(id, board_id, org_id), the row
  // (other board's list, this card's board, org A) does not exist and the
  // write dies on 23503. Before H2 nothing objects and the card silently
  // relocates to a board its own board_id knows nothing about.
  const { error: crossBoard } = await aOwner.supabase
    .from('cards')
    .update({ list_id: otherList.id })
    .eq('id', card.id);
  record(
    'H2.2 the database refuses a card moved onto another board',
    crossBoard?.code === '23503',
    crossBoard
      ? `refused ${crossBoard.code} "${crossBoard.message.slice(0, 80)}"`
      : 'LEAK: PostgREST moved the card across boards — no database backstop'
  );

  // H2.3 — and the card really is where it started.
  const { data: reread } = await aOwner.supabase
    .from('cards')
    .select('id, list_id')
    .eq('id', card.id)
    .maybeSingle();
  record(
    'H2.3 the card stayed on its own board',
    reread?.list_id === list.id,
    reread
      ? `list_id=${reread.list_id.slice(0, 8)}… expected ${list.id.slice(0, 8)}…`
      : 'card could not be re-read'
  );

  // H2.4 — the cross-tenant version, which the (list_id, org_id) key
  // already refuses. Extending the FK must not weaken it.
  const { error: crossTenant } = await aOwner.supabase
    .from('cards')
    .update({ list_id: LIST_B })
    .eq('id', card.id);
  record(
    'H2.4 the cross-tenant move is still refused',
    crossTenant?.code === '23503',
    crossTenant
      ? `refused ${crossTenant.code}`
      : "LEAK: a card moved into another tenant's list"
  );
}

// =====================================================================
// H3 — rebalance_card_positions(p_list).
// =====================================================================
async function testH3({ aOwner, board, list }) {
  // Three cards in one list, deliberately given the fractional positions a
  // long drag sequence produces, so a rebalance has something to do.
  const created = [];
  for (const [index, title] of ['H3 alpha', 'H3 beta', 'H3 gamma'].entries()) {
    const { card } = await api(`/api/orgs/${ORG_A}/boards/${board.id}/cards`, {
      token: aOwner.token,
      method: 'POST',
      body: JSON.stringify({ listId: list.id, title }),
    });
    created.push(card);
    await api(`/api/orgs/${ORG_A}/boards/${board.id}/cards/${card.id}/move`, {
      token: aOwner.token,
      method: 'POST',
      body: JSON.stringify({ listId: list.id, position: 10 + index * 0.015625 }),
    });
  }

  // H3.1 — it works on the caller's own list.
  const { data: ownRows, error: ownError } = await aOwner.supabase.rpc(
    'rebalance_card_positions',
    { p_list: list.id }
  );
  record(
    'H3.1 rebalance_card_positions renumbers the caller\'s own list',
    !ownError && Array.isArray(ownRows) && ownRows.length >= created.length,
    ownError
      ? `rpc failed ${ownError.code ?? ''} ${ownError.message}`
      : `rewrote ${ownRows?.length ?? 0} card(s)`
  );

  // H3.2 — and leaves whole numbers behind, which is the entire point.
  const { data: afterRows } = await aOwner.supabase
    .from('cards')
    .select('id, position')
    .eq('list_id', list.id)
    .order('position', { ascending: true });
  const positions = (afterRows ?? []).map((r) => Number(r.position));
  record(
    'H3.2 no fractional positions are left in the list',
    positions.length > 0 && positions.every((p) => Number.isInteger(p)),
    positions.length ? `positions [${positions.join(', ')}]` : 'no cards read back'
  );

  // H3.3 — SECURITY INVOKER, and this is what that buys. Pointed at a
  // tenant B list it must touch nothing: the cards UPDATE policy filters
  // it to rows the caller may already write. A DEFINER version would hand
  // every signed-in user on the platform a write primitive over any list
  // whose uuid they can guess.
  const { data: foreignRows, error: foreignError } = await aOwner.supabase.rpc(
    'rebalance_card_positions',
    { p_list: LIST_B }
  );
  record(
    'H3.3 rebalance does nothing to another tenant\'s list',
    !foreignError && Array.isArray(foreignRows) && foreignRows.length === 0,
    foreignError
      ? `rpc failed ${foreignError.code ?? ''} ${foreignError.message}`
      : `touched ${foreignRows?.length ?? 0} of tenant B's cards`
  );

  // H3.4 — the migration 0008 rule. `revoke execute … from public` does
  // not remove Supabase's direct grant to anon, so a new SECURITY INVOKER
  // function is callable at /rest/v1/rpc/<name> with no session unless
  // someone writes the anon revoke. PGRST202 ("function not found") is NOT
  // a pass: that is the function missing, not the grant being absent.
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: anonError } = await anon.rpc('rebalance_card_positions', {
    p_list: list.id,
  });
  record(
    'H3.4 anon cannot execute rebalance_card_positions',
    anonError?.code === '42501',
    anonError
      ? anonError.code === '42501'
        ? 'refused 42501 (execute revoked from anon — see migration 0008)'
        : `refused ${anonError.code} "${anonError.message}" — expected 42501`
      : 'LEAK: anon executed rebalance_card_positions'
  );
}

// =====================================================================
// H4 — a removed member's socket must stop receiving the tenant's
//      broadcasts. The one that has to be right before the client portal.
// =====================================================================
async function testH4({ aOwner, aAdmin, bOwner, board, list }) {
  // ------------------------------------------------------------------
  // Put owner@acme.test inside Northwind through the real invitation
  // flow, so the membership being removed is a genuine one and the
  // removal is the same code path a real revocation takes.
  // ------------------------------------------------------------------
  let membershipId = await findMembership(aOwner.token, USER_B_OWNER);

  if (!membershipId) {
    let invite = await apiTry(`/api/orgs/${ORG_A}/invitations`, {
      token: aAdmin.token,
      method: 'POST',
      body: JSON.stringify({ email: 'owner@acme.test', role: 'member' }),
    });

    // A live invitation left behind by another suite (or an aborted run of
    // this one) answers 409. Revoke it and reissue rather than failing on
    // someone else's residue.
    if (invite.status === 409) {
      const listed = await api(`/api/orgs/${ORG_A}/invitations`, { token: aAdmin.token });
      const stale = (listed.invitations ?? []).find(
        (row) => row.email === 'owner@acme.test'
      );
      if (stale) {
        await apiTry(`/api/orgs/${ORG_A}/invitations/${stale.id}`, {
          token: aAdmin.token,
          method: 'DELETE',
        });
      }
      invite = await apiTry(`/api/orgs/${ORG_A}/invitations`, {
        token: aAdmin.token,
        method: 'POST',
        body: JSON.stringify({ email: 'owner@acme.test', role: 'member' }),
      });
    }

    if (invite.status !== 201) {
      throw new Error(
        `H4 setup: could not invite owner@acme.test (${invite.status} ${invite.body?.error?.message ?? ''})`
      );
    }

    const accepted = await apiTry('/api/invitations/accept', {
      token: bOwner.token,
      method: 'POST',
      body: JSON.stringify({ token: invite.body.token }),
    });
    if (accepted.status !== 201) {
      throw new Error(
        `H4 setup: invitation not redeemed (${accepted.status} ${accepted.body?.error?.message ?? ''})`
      );
    }
    membershipId = accepted.body.membership.id;
  }
  membershipCleanup.push(membershipId);

  // ------------------------------------------------------------------
  // Two sockets in the same org room: the member about to be removed, and
  // a control who stays. The control is what makes the silence meaningful
  // — without it, "heard nothing" is equally consistent with "nothing was
  // broadcast".
  // ------------------------------------------------------------------
  const removedSocket = await connect(bOwner.token);
  const controlSocket = await connect(aOwner.token);

  const joinedRemoved = await join(removedSocket, ORG_A);
  const joinedControl = await join(controlSocket, ORG_A);
  record(
    'H4.1 both sockets are admitted to the org room',
    joinedRemoved?.ok === true && joinedControl?.ok === true,
    `to-be-removed=${joinedRemoved?.role ?? joinedRemoved?.error}, control=${joinedControl?.role ?? joinedControl?.error}`
  );

  const removedHeard = transcribe(removedSocket);
  const controlHeard = transcribe(controlSocket);

  // H4.2 — the baseline. While still a member, the socket receives the
  // tenant's traffic. If this fails, the silence later proves nothing.
  await api(`/api/orgs/${ORG_A}/boards/${board.id}/cards`, {
    token: aAdmin.token,
    method: 'POST',
    body: JSON.stringify({ listId: list.id, title: 'H4 baseline card' }),
  });
  await sleep(1200);
  record(
    'H4.2 baseline: the member does receive the tenant\'s broadcasts',
    removedHeard.heard.some((e) => e.event === 'card:created'),
    `heard ${removedHeard.names()} while still a member`
  );

  // ------------------------------------------------------------------
  // The removal. Everything after this point is about what the socket
  // must NOT hear.
  // ------------------------------------------------------------------
  const removal = await apiTry(`/api/orgs/${ORG_A}/members/${membershipId}`, {
    token: aOwner.token,
    method: 'DELETE',
  });
  record(
    'H4.3 the member is removed',
    removal.status === 204,
    `DELETE /members responded ${removal.status} ${removal.body?.error?.message ?? ''}`
  );
  if (removal.status === 204) membershipCleanup.pop();

  // Let the eviction happen. member:removed itself may or may not reach
  // the removed socket depending on whether it is evicted before or after
  // that broadcast — both are defensible, so it is reported and not
  // asserted on. The buffers are cleared afterwards so the assertion below
  // is strictly about traffic that happened once the member was gone.
  await sleep(EVICTION_SETTLE_MS);
  const duringRemoval = removedHeard.names();
  removedHeard.reset();
  controlHeard.reset();

  // ------------------------------------------------------------------
  // Four writes over a real window, of the kinds a working board produces
  // every few seconds.
  // ------------------------------------------------------------------
  const { list: afterList } = await api(
    `/api/orgs/${ORG_A}/boards/${board.id}/lists`,
    {
      token: aAdmin.token,
      method: 'POST',
      body: JSON.stringify({ title: 'H4 post-removal list' }),
    }
  );
  const { card: afterCard } = await api(
    `/api/orgs/${ORG_A}/boards/${board.id}/cards`,
    {
      token: aAdmin.token,
      method: 'POST',
      body: JSON.stringify({ listId: afterList.id, title: 'H4 post-removal card' }),
    }
  );
  await api(`/api/orgs/${ORG_A}/boards/${board.id}/cards/${afterCard.id}`, {
    token: aAdmin.token,
    method: 'PATCH',
    body: JSON.stringify({ title: 'H4 post-removal card (edited)' }),
  });
  await api(`/api/orgs/${ORG_A}/boards/${board.id}/cards/${afterCard.id}`, {
    token: aAdmin.token,
    method: 'DELETE',
  });

  await sleep(SILENCE_MS);

  // H4.4 — the control heard the writes, so the room was live throughout.
  record(
    'H4.4 the remaining member still receives everything',
    controlHeard.heard.length >= 4,
    `control heard ${controlHeard.heard.length} event(s): ${controlHeard.names()}`
  );

  // H4.5 — THE ONE. Nothing at all reached the removed member's socket.
  record(
    'H4.5 the removed member\'s socket receives nothing',
    removedHeard.heard.length === 0,
    removedHeard.heard.length === 0
      ? `silent for ${SILENCE_MS}ms across 4 writes (saw "${duringRemoval}" during the removal itself)`
      : `LEAK: still in org:${ORG_A.slice(0, 8)}… — received ${removedHeard.names()}`
  );

  // H4.6 — REST closed at the same instant, which it always did. Included
  // so a failure of H4.5 cannot be read as "the removal did not happen".
  const restAfter = await apiTry(`/api/orgs/${ORG_A}/boards/${board.id}`, {
    token: bOwner.token,
  });
  record(
    'H4.6 REST is closed to the removed member',
    restAfter.status === 404,
    `reading the board responded ${restAfter.status}`
  );

  // H4.7 — and the socket cannot simply ask to be let back in. org:join
  // re-checks membership against the database, so this held before H4 too;
  // it is here because eviction without it would be a revolving door.
  const rejoin = await join(removedSocket, ORG_A);
  record(
    'H4.7 the removed socket cannot rejoin the room',
    rejoin?.ok === false,
    rejoin?.ok === false ? `refused ("${rejoin.error}")` : 'LEAK: readmitted after removal'
  );
}

// =====================================================================
// H5 — the two ways a naive eviction is wrong.
//
// H4 proves a removed member goes silent. It cannot catch either of the
// mistakes an implementation is most likely to make, because both still
// produce silence for the one socket H4 watches:
//
//   * Evicting only the FIRST socket found. Two tabs is the normal case,
//     not an edge case, and the second tab would keep streaming.
//   * Evicting too much — `disconnect()`, or leaving every room the
//     socket is in. A contractor removed from one client's workspace
//     would silently lose the live view of every other client they work
//     for. That is a broken product, and no test that only asserts
//     silence would ever notice.
//
// owner@acme.test is used deliberately: they are natively an owner of
// Acme, so this exercises a genuine two-tenant user without touching the
// seeded Northwind membership of dual@contractor.test, which the SQL
// suite's counts depend on.
// =====================================================================
async function testH5({ aOwner, aAdmin, bOwner }) {
  const membershipId = await inviteBOwnerIntoOrgA({ aOwner, aAdmin, bOwner });
  membershipCleanup.push(membershipId);

  // A scratch board in Acme, owned by bOwner, so there is somewhere to
  // write that has nothing to do with Northwind.
  const { board: boardB } = await api(`/api/orgs/${ORG_B}/boards`, {
    token: bOwner.token,
    method: 'POST',
    body: JSON.stringify({ title: 'hardening probe (acme)' }),
  });
  const { list: listB } = await api(`/api/orgs/${ORG_B}/boards/${boardB.id}/lists`, {
    token: bOwner.token,
    method: 'POST',
    body: JSON.stringify({ title: 'Backlog' }),
  });

  // Two tabs for the same person. Both in Northwind; only the first also
  // watching their own Acme workspace.
  const tab1 = await connect(bOwner.token);
  const tab2 = await connect(bOwner.token);

  const j1a = await join(tab1, ORG_A);
  const j2a = await join(tab2, ORG_A);
  const j1b = await join(tab1, ORG_B);
  record(
    'H5.1 two tabs joined, one also watching the other tenant',
    j1a?.ok === true && j2a?.ok === true && j1b?.ok === true,
    `tab1 A=${j1a?.role}, tab2 A=${j2a?.role}, tab1 B=${j1b?.role}`
  );

  const heard1 = transcribe(tab1);
  const heard2 = transcribe(tab2);

  // Baseline: both tabs are genuinely live on Northwind before removal.
  await api(`/api/orgs/${ORG_A}/boards/${SCRATCH.board.id}/cards`, {
    token: aAdmin.token,
    method: 'POST',
    body: JSON.stringify({ listId: SCRATCH.list.id, title: 'H5 baseline' }),
  });
  await sleep(SILENCE_MS / 2);
  record(
    'H5.2 baseline: both tabs receive the tenant traffic',
    heard1.heard.length > 0 && heard2.heard.length > 0,
    `tab1 heard ${heard1.names()}; tab2 heard ${heard2.names()}`
  );

  // Remove from Northwind only. Acme membership is untouched.
  const removed = await apiTry(`/api/orgs/${ORG_A}/members/${membershipId}`, {
    token: aOwner.token,
    method: 'DELETE',
  });
  await sleep(EVICTION_SETTLE_MS);
  heard1.reset();
  heard2.reset();

  // Write to Northwind — neither tab may hear it.
  await api(`/api/orgs/${ORG_A}/boards/${SCRATCH.board.id}/cards`, {
    token: aAdmin.token,
    method: 'POST',
    body: JSON.stringify({ listId: SCRATCH.list.id, title: 'H5 after removal' }),
  });
  await sleep(SILENCE_MS);

  record(
    'H5.3 EVERY tab is evicted, not just the first',
    removed.status === 204 && heard1.heard.length === 0 && heard2.heard.length === 0,
    heard1.heard.length === 0 && heard2.heard.length === 0
      ? `both tabs silent for ${SILENCE_MS}ms after removal`
      : `LEAK: tab1 heard ${heard1.names()}; tab2 heard ${heard2.names()}`
  );

  // Write to Acme — tab1 must STILL hear it. This is the over-eviction
  // check, and it is the one that fails if eviction disconnects the
  // socket or clears all of its rooms.
  heard1.reset();
  await api(`/api/orgs/${ORG_B}/boards/${boardB.id}/cards`, {
    token: bOwner.token,
    method: 'POST',
    body: JSON.stringify({ listId: listB.id, title: 'H5 other tenant still live' }),
  });
  await sleep(SILENCE_MS / 2);

  record(
    'H5.4 their OTHER tenant is untouched',
    heard1.heard.length > 0,
    heard1.heard.length > 0
      ? `tab1 still receives Acme traffic (${heard1.names()})`
      : 'OVER-EVICTION: removal from one tenant killed their other workspace'
  );

  // And the socket is still connected at all — a disconnect would also
  // have produced H5.3's silence, for entirely the wrong reason.
  record(
    'H5.5 the socket was evicted, not disconnected',
    tab1.connected && tab2.connected,
    `tab1 connected=${tab1.connected}, tab2 connected=${tab2.connected}`
  );

  await apiTry(`/api/orgs/${ORG_B}/boards/${boardB.id}`, {
    token: bOwner.token,
    method: 'DELETE',
  });
}

/**
 * Put owner@acme.test into Northwind through the real invitation flow,
 * tolerating residue from an aborted run. Shared by H4 and H5 so the
 * membership under test is always a genuine one.
 */
async function inviteBOwnerIntoOrgA({ aOwner, aAdmin, bOwner }) {
  const existing = await findMembership(aOwner.token, USER_B_OWNER);
  if (existing) return existing;

  let invite = await apiTry(`/api/orgs/${ORG_A}/invitations`, {
    token: aAdmin.token,
    method: 'POST',
    body: JSON.stringify({ email: 'owner@acme.test', role: 'member' }),
  });

  if (invite.status === 409) {
    const listed = await api(`/api/orgs/${ORG_A}/invitations`, { token: aAdmin.token });
    const stale = (listed.invitations ?? []).find((row) => row.email === 'owner@acme.test');
    if (stale) {
      await apiTry(`/api/orgs/${ORG_A}/invitations/${stale.id}`, {
        token: aAdmin.token,
        method: 'DELETE',
      });
    }
    invite = await apiTry(`/api/orgs/${ORG_A}/invitations`, {
      token: aAdmin.token,
      method: 'POST',
      body: JSON.stringify({ email: 'owner@acme.test', role: 'member' }),
    });
  }

  if (invite.status !== 201) {
    throw new Error(
      `setup: could not invite owner@acme.test (${invite.status} ${invite.body?.error?.message ?? ''})`
    );
  }

  const accepted = await apiTry('/api/invitations/accept', {
    token: bOwner.token,
    method: 'POST',
    body: JSON.stringify({ token: invite.body.token }),
  });
  if (accepted.status !== 201) {
    throw new Error(
      `setup: invitation not redeemed (${accepted.status} ${accepted.body?.error?.message ?? ''})`
    );
  }
  return accepted.body.membership.id;
}

/** The membership row for a user in org A, or null. */
async function findMembership(token, userId) {
  const { status, body } = await apiTry(`/api/orgs/${ORG_A}/members`, { token });
  if (status !== 200) return null;
  return body.members?.find((m) => m.profile?.id === userId)?.id ?? null;
}

async function main() {
  const [aOwner, aAdmin, bOwner] = await Promise.all([
    signIn('owner@northwind.test'),
    signIn('admin@northwind.test'),
    signIn('owner@acme.test'),
  ]);

  // One scratch board for the whole run, so nothing here can corrupt
  // seeded rows and a rerun does not inherit the last run's state.
  const { board } = await api(`/api/orgs/${ORG_A}/boards`, {
    token: aOwner.token,
    method: 'POST',
    body: JSON.stringify({ title: 'hardening probe' }),
  });
  boardCleanup.push(board.id);

  const { list } = await api(`/api/orgs/${ORG_A}/boards/${board.id}/lists`, {
    token: aOwner.token,
    method: 'POST',
    body: JSON.stringify({ title: 'Backlog' }),
  });

  SCRATCH.board = board;
  SCRATCH.list = list;

  const card = await testH1({ aOwner, board, list });
  await testH2({ aOwner, board, list, card });
  await testH3({ aOwner, board, list });
  await testH4({ aOwner, aAdmin, bOwner, board, list });

  // H5 re-invites owner@acme.test, because H4 has just removed them.
  await testH5({ aOwner, aAdmin, bOwner });
}

main()
  .catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.code ?? err.cause.message})` : '';
    record('SUITE', false, `aborted: ${err.message}${cause}`);
  })
  .finally(async () => {
    try {
      const { token } = await signIn('owner@northwind.test');

      // Any membership H4 created and did not manage to remove. Leaving
      // owner@acme.test inside Northwind would break the SQL suite's
      // tenant counts for everyone else on this shared database.
      for (const membershipId of membershipCleanup) {
        await apiTry(`/api/orgs/${ORG_A}/members/${membershipId}`, {
          token,
          method: 'DELETE',
        });
      }
      // Deleting the probe boards cascades their lists and cards.
      for (const boardId of boardCleanup) {
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
