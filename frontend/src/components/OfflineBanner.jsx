/**
 * OfflineBanner
 *
 * Displays a persistent banner when the device is offline.
 * Also shows a transient "Back online — syncing payments…" notice
 * when connectivity is restored after an offline period.
 *
 * Rendered inside Layout so it appears on every authenticated page.
 */

import React, { useEffect, useState } from 'react';
import { WifiOff, Wifi, Clock } from 'lucide-react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { getQueueCount } from '../utils/offlineDB';

export default function OfflineBanner({ onPaymentSynced }) {
  const { isOnline, wasOffline } = useOnlineStatus({ onPaymentSynced });
  const [showBackOnline, setShowBackOnline]   = useState(false);
  const [queueCount,     setQueueCount]       = useState(0);

  // Refresh queue count whenever online status changes
  useEffect(() => {
    getQueueCount()
      .then(setQueueCount)
      .catch(() => setQueueCount(0));
  }, [isOnline]);

  // Show the "back online" notice for 4 seconds after reconnecting
  useEffect(() => {
    if (isOnline && wasOffline) {
      setShowBackOnline(true);
      const t = setTimeout(() => setShowBackOnline(false), 4000);
      return () => clearTimeout(t);
    }
  }, [isOnline, wasOffline]);

  if (!isOnline) {
    return (
      <div
        role="status"
        aria-live="assertive"
        className="bg-red-600 text-white text-xs font-semibold py-2 px-4 flex items-center justify-center gap-2"
      >
        <WifiOff size={14} aria-hidden="true" />
        <span>You're offline — showing cached data</span>
        {queueCount > 0 && (
          <span className="flex items-center gap-1 ml-2 bg-red-700 rounded-full px-2 py-0.5">
            <Clock size={11} aria-hidden="true" />
            {queueCount} payment{queueCount !== 1 ? 's' : ''} queued
          </span>
        )}
      </div>
    );
  }

  if (showBackOnline) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="bg-primary-500 text-white text-xs font-semibold py-2 px-4 flex items-center justify-center gap-2"
      >
        <Wifi size={14} aria-hidden="true" />
        <span>
          Back online
          {queueCount > 0
            ? ` — syncing ${queueCount} queued payment${queueCount !== 1 ? 's' : ''}…`
            : ' — all caught up'}
        </span>
      </div>
    );
  }

  return null;
}
