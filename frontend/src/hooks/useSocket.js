import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(
  /\/+$/,
  ''
);

/**
 * One socket per signed-in session.
 *
 * Two things this deliberately gets right:
 *
 * 1. `auth` is a callback, not an object. Socket.io re-invokes it on every
 *    reconnect attempt, so a reconnection after the access token rotated
 *    handshakes with the current token instead of the one captured when
 *    the socket was first created.
 *
 * 2. The socket is keyed on *whether* there is a token, not on the token
 *    itself. Supabase silently rotates the access token about hourly; if
 *    the effect depended on the token value, every rotation would tear
 *    down the connection and drop the user out of their board's room.
 *    Instead the new token is pushed over the existing connection via
 *    session:refresh.
 */
export function useSocket(accessToken) {
  const [socket, setSocket] = useState(null);
  const [status, setStatus] = useState('disconnected');

  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;

  const hasToken = Boolean(accessToken);

  useEffect(() => {
    if (!hasToken) {
      setSocket(null);
      setStatus('disconnected');
      return undefined;
    }

    const instance = io(API_URL, {
      auth: (cb) => cb({ access_token: tokenRef.current }),
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    });

    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');
    const onConnectError = () => setStatus('error');

    instance.on('connect', onConnect);
    instance.on('disconnect', onDisconnect);
    instance.on('connect_error', onConnectError);

    setSocket(instance);
    setStatus('connecting');

    return () => {
      instance.off('connect', onConnect);
      instance.off('disconnect', onDisconnect);
      instance.off('connect_error', onConnectError);
      instance.disconnect();
      setSocket(null);
      setStatus('disconnected');
    };
  }, [hasToken]);

  useEffect(() => {
    if (!socket || !accessToken || !socket.connected) return;
    socket.emit('session:refresh', { accessToken });
  }, [socket, accessToken]);

  return { socket, status };
}
