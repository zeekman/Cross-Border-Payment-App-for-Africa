import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import api from '../utils/api';
import { tokenStore, useAuth } from '../context/AuthContext';

const POLL_INTERVAL_MS = 60000;
const socketURL = (process.env.REACT_APP_API_URL || 'http://localhost:5000/api').replace(/\/api\/?$/, '');

/**
 * In-app notification inbox (FE-128). Loads notifications from the REST API,
 * receives `notification:new` over Socket.IO (reconnecting whenever the
 * in-memory access token changes) and falls back to polling the unread count.
 */
export function useNotifications() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

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
      setItems((prev) => (cursor ? [...prev, ...data.data] : data.data));
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

  // Polling fallback — also covers the gap while the socket is disconnected.
  useEffect(() => {
    if (!user) return undefined;
    refreshUnread();
    const timer = setInterval(refreshUnread, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [user, refreshUnread]);

  // Real-time updates; reconnect with a fresh token, disconnect on logout.
  useEffect(() => {
    if (!user) return undefined;
    let socket = null;
    const connect = (token) => {
      if (socket) socket.disconnect();
      socket = null;
      if (!token) return;
      socket = io(socketURL, { auth: { token }, withCredentials: true });
      socket.on('notification:new', (notification) => {
        setItems((prev) => [notification, ...prev]);
        setUnreadCount((c) => c + 1);
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
