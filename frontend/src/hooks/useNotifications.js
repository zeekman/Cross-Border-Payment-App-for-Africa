import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import api from '../utils/api';
import { tokenStore, useAuth } from '../context/AuthContext';
import { useVisibleInterval } from './useVisibleInterval';
import { useDataSaver } from '../context/DataSaverContext';

const POLL_INTERVAL_MS = 60000;
const socketURL = (process.env.REACT_APP_API_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');

/**
 * In-app notification inbox (FE-128). Loads notifications from the REST API,
 * receives `notification:new` over Socket.IO (reconnecting whenever the
 * in-memory access token changes) and falls back to polling the unread count.
 */
export function useNotifications() {
  const { user } = useAuth();
  const { dataSaver } = useDataSaver();
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);

  const refreshUnread = useCallback(async () => {
    try {
      const { data } = await api.get('/notifications/notifications/unread-count');
      setUnreadCount(data.count || 0);
    } catch { /* keep last known count */ }
  }, []);

  const load = useCallback(async (cursor = null) => {
    setLoading(true);
    try {
      const { data } = await api.get('/notifications/notifications', {
        params: { limit: 20, ...(cursor ? { cursor } : {}) },
      });
      setItems((prev) => {
        if (!cursor) return data.data;
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...data.data.filter((n) => !seen.has(n.id))];
      });
      setNextCursor(data.next_cursor);
      setHasMore(data.has_more);
    } catch { /* surfaced as empty list */ } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(() => {
    if (hasMore && nextCursor) load(nextCursor);
  }, [hasMore, nextCursor, load]);

  const markRead = useCallback(async (id) => {
    await api.patch(`/notifications/notifications/${id}/read`);
    setItems((prev) => prev.map((n) => (n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n)));
    refreshUnread();
  }, [refreshUnread]);

  const markAllRead = useCallback(async () => {
    await api.post('/notifications/notifications/read-all');
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: now })));
    setUnreadCount(0);
  }, []);

  // Refresh on mount and whenever the socket connects or drops, so nothing is missed
  // in the gap between the initial fetch and the live connection (or after it falls over).
  useEffect(() => {
    if (!user) return;
    refreshUnread();
  }, [user, socketConnected, refreshUnread]);

  // Polling is only a fallback for when the socket is down: skip it while the socket is
  // connected, and never poll in a hidden tab (returning to the tab refreshes immediately).
  useVisibleInterval(refreshUnread, POLL_INTERVAL_MS, { enabled: Boolean(user) && !socketConnected && !dataSaver });

  // Real-time updates; reconnect with a fresh token, disconnect on logout.
  useEffect(() => {
    if (!user) return undefined;
    let socket = null;
    const connect = (token) => {
      if (socket) socket.disconnect();
      socket = null;
      setSocketConnected(false);
      if (!token) return;
      socket = io(socketURL, { auth: { token }, withCredentials: true });
      socket.on('connect', () => setSocketConnected(true));
      socket.on('disconnect', () => setSocketConnected(false));
      socket.on('connect_error', () => setSocketConnected(false));
      socket.on('notification:new', (notification) => {
        let isNew = false;
        setItems((prev) => {
          if (prev.some((n) => n.id === notification.id)) return prev;
          isNew = true;
          return [notification, ...prev];
        });
        if (isNew) setUnreadCount((c) => c + 1);
      });
    };
    connect(tokenStore.get());
    const unsubscribe = tokenStore.subscribe(connect);
    return () => {
      unsubscribe();
      if (socket) socket.disconnect();
    };
  }, [user]);

  // Reset state when the user logs out.
  useEffect(() => {
    if (!user) {
      setItems([]);
      setUnreadCount(0);
      setNextCursor(null);
      setHasMore(false);
    }
  }, [user]);

  return { items, unreadCount, hasMore, loading, load, loadMore, markRead, markAllRead };
}
