import { orgRoom, userRoom } from './rooms.js';

let io = null;

export function setIo(instance) {
  io = instance;
}

/**
 * Broadcast a tenant-scoped event.
 *
 * The single choke point for outbound realtime. Routes call this instead
 * of touching `io` directly, so there is exactly one place in the
 * codebase where a room name is chosen — and it is always derived from
 * the org id the route already authorised.
 *
 * `exceptSocketId` lets the originating client skip the echo of its own
 * change, which it has already applied optimistically.
 */
export function emitToOrg(orgId, event, payload, exceptSocketId = null) {
  if (!io) {
    throw new Error('Realtime emitter used before setIo()');
  }
  if (!orgId) {
    throw new Error('emitToOrg() requires an orgId');
  }

  const target = exceptSocketId
    ? io.to(orgRoom(orgId)).except(exceptSocketId)
    : io.to(orgRoom(orgId));

  target.emit(event, { orgId, ...payload });
}

/**
 * Force every socket belonging to `userId` out of `org:<orgId>`.
 *
 * Deleting a membership stops that user reading anything over REST the
 * instant it commits — RLS does not consult a cache. Their *socket* was a
 * different story: it had already been admitted to the org room, and
 * nothing re-checked it, so it kept receiving that tenant's broadcasts
 * until the tab was closed. Short window, rare event, and completely
 * unacceptable for the client portal, where revoking an outsider's access
 * is the entire feature.
 *
 * `fetchSockets()` over the user index room, rather than a Redis adapter:
 * a single Node process is the deployed shape today, and this is the one
 * call that would have to change if that stops being true. Left as the
 * cheap version deliberately — see docs/socket-events.md.
 *
 * Never throws. It runs after the membership DELETE has committed, and a
 * realtime failure must not turn a successful removal into a 500. Returns
 * the number of sockets evicted so a caller (or a test) can tell the
 * difference between "nobody was connected" and "we did nothing".
 */
export async function evictUserFromOrg(orgId, userId) {
  if (!io || !orgId || !userId) return 0;

  const room = orgRoom(orgId);
  let evicted = 0;

  try {
    // Scoped to the user's own index room, so this walks that user's
    // sockets — typically one or two tabs — and not every socket connected
    // to the process.
    const sockets = await io.in(userRoom(userId)).fetchSockets();

    for (const socket of sockets) {
      if (!socket.rooms.has(room)) continue;
      socket.leave(room);
      evicted += 1;
    }
  } catch {
    return evicted;
  }

  return evicted;
}
