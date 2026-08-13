import { Server } from 'socket.io';

import { env } from '../config/env.js';
import { userClient } from '../lib/supabase.js';
import { verifyAccessToken } from '../lib/verify-token.js';
import { getOrgRole } from '../middleware/tenant.js';
import { setIo } from './emitter.js';
import { orgRoom, userRoom } from './rooms.js';

/**
 * Every event documented in /docs/socket-events.md. Keep the two in sync
 * — per CLAUDE.md the contract does not get to live only in code.
 */
export function attachRealtime(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins,
      credentials: true,
    },
  });

  // ------------------------------------------------------------------
  // Handshake. An unauthenticated socket is refused outright rather than
  // connected-but-limited: a connected socket is a thing that can be
  // subscribed to rooms, and there is no good reason to hold one open
  // for a caller we cannot identify.
  // ------------------------------------------------------------------
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.access_token;
      const user = await verifyAccessToken(token);

      if (!user) {
        next(new Error('unauthorized'));
        return;
      }

      socket.data.user = user;
      socket.data.accessToken = token;
      socket.data.supabase = userClient(token);

      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // The user index. Nothing is ever broadcast to this room — it is how
    // the server finds a specific person's sockets when their membership
    // is revoked and they have to be thrown out of an org room. Joined
    // from the verified handshake identity, never from a client payload,
    // and left automatically on disconnect.
    socket.join(userRoom(socket.data.user.id));

    socket.emit('connection:ready', { userId: socket.data.user.id });

    // ----------------------------------------------------------------
    // org:join — the one place a socket gains access to tenant traffic.
    //
    // Membership is re-checked here against the database. The client
    // saying "I am in org X" is a request, not a fact; if we trusted the
    // payload, any authenticated user of any tenant could subscribe to
    // any other tenant's board stream just by guessing a uuid.
    // ----------------------------------------------------------------
    socket.on('org:join', async ({ orgId } = {}, ack) => {
      try {
        if (!orgId) {
          respond(ack, { ok: false, error: 'orgId is required' });
          return;
        }

        const role = await getOrgRole(socket.data.supabase, orgId);
        if (!role) {
          socket.emit('error:unauthorized', {
            event: 'org:join',
            orgId,
            message: 'Not a member of this organization',
          });
          respond(ack, { ok: false, error: 'not a member' });
          return;
        }

        socket.join(orgRoom(orgId));
        socket.emit('org:joined', { orgId, role });
        respond(ack, { ok: true, orgId, role });
      } catch (error) {
        respond(ack, { ok: false, error: 'join failed' });
        if (!env.isProduction) console.error('[socket] org:join', error);
      }
    });

    socket.on('org:leave', ({ orgId } = {}, ack) => {
      if (orgId) socket.leave(orgRoom(orgId));
      respond(ack, { ok: true });
    });

    // ----------------------------------------------------------------
    // session:refresh — Supabase access tokens expire (default 1h) but a
    // socket can stay open far longer. Without this the connection keeps
    // working off a token that is no longer valid, and the next
    // membership re-check fails for no visible reason. The client sends
    // its refreshed token and we re-verify in place.
    // ----------------------------------------------------------------
    socket.on('session:refresh', async ({ accessToken } = {}, ack) => {
      const user = await verifyAccessToken(accessToken);

      if (!user || user.id !== socket.data.user.id) {
        respond(ack, { ok: false, error: 'invalid token' });
        socket.disconnect(true);
        return;
      }

      socket.data.accessToken = accessToken;
      socket.data.supabase = userClient(accessToken);
      respond(ack, { ok: true });
    });

    // Round-trip check used by the Phase 1 smoke test. Scoped to a room
    // the socket has actually joined, so it doubles as a proof that room
    // isolation works.
    socket.on('board:ping', ({ orgId } = {}) => {
      if (!orgId || !socket.rooms.has(orgRoom(orgId))) return;

      io.to(orgRoom(orgId)).emit('board:pong', {
        orgId,
        userId: socket.data.user.id,
        at: new Date().toISOString(),
      });
    });
  });

  setIo(io);
  return io;
}

function respond(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}
