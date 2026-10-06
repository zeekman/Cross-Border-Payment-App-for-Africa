import React, { useEffect, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';
import { useNotifications } from '../hooks/useNotifications';

export default function NotificationBell() {
  const { items, unreadCount, hasMore, loading, load, loadMore, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white transition-colors"
        title="Notifications"
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={open}
      >
        <Inbox size={18} />
        {unreadCount > 0 && (
          <span data-testid="notification-badge" className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-lg z-50">
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-primary-500 hover:underline">Mark all read</button>
            )}
          </div>
          {items.length === 0 && !loading && (
            <p className="px-4 py-6 text-sm text-center text-gray-500">No notifications yet</p>
          )}
          <ul>
            {items.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => !n.read_at && markRead(n.id)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800 ${n.read_at ? 'opacity-60' : ''}`}
                >
                  <p className="text-sm font-medium text-gray-900 dark:text-white">{n.title}</p>
                  {n.body && <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{n.body}</p>}
                  <p className="text-[10px] text-gray-400 mt-1">{new Date(n.created_at).toLocaleString()}</p>
                </button>
              </li>
            ))}
          </ul>
          {hasMore && (
            <button onClick={loadMore} disabled={loading} className="w-full py-2 text-xs text-primary-500 hover:underline disabled:opacity-50">
              {loading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
