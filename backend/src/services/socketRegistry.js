/**
 * Holds the Socket.IO server so controllers can force-disconnect live sockets
 * when a session is revoked, a user logs out, resets their password or is
 * suspended (#1302).
 */
let io = null;

function setSocketIO(instance) {
  io = instance;
}

function userRoom(userId) {
  return `user:${userId}`;
}

/** Disconnect every socket opened with the given access-token JTI. */
function disconnectJti(jti) {
  if (!io || !jti) return;
  io.sockets.sockets.forEach((socket) => {
    if (socket.data?.jti === jti) socket.disconnect(true);
  });
}

/** Disconnect every socket belonging to the given user(s). */
function disconnectUser(userIds) {
  if (!io) return;
  [].concat(userIds || []).forEach((id) => io.in(userRoom(id)).disconnectSockets(true));
}

module.exports = { setSocketIO, userRoom, disconnectJti, disconnectUser };
