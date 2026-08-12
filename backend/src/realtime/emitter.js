import { orgRoom } from './rooms.js';

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
