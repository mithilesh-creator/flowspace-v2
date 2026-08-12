/**
 * Room naming. Every tenant-scoped broadcast goes to exactly one room,
 * and that room is derived from the org id — never from anything the
 * client sent in the event payload.
 *
 * Socket.io rooms are the tenant boundary for realtime, so this is the
 * realtime equivalent of an RLS policy: if a broadcast can reach a room
 * the user was not admitted to, that is a cross-tenant leak even though
 * the database was never wrong.
 */
export function orgRoom(orgId) {
  return `org:${orgId}`;
}

/** The set of org rooms a socket has been admitted to. */
export function joinedOrgIds(socket) {
  const ids = [];
  for (const room of socket.rooms) {
    if (room.startsWith('org:')) ids.push(room.slice(4));
  }
  return ids;
}
