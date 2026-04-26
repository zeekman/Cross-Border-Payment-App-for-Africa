/**
 * useOnlineStatus
 *
 * Returns { isOnline, wasOffline } where:
 *  - isOnline   : current navigator.onLine value, updated on network events
 *  - wasOffline : true if the user went offline at least once this session
 *                 (useful for showing a "back online" toast)
 *
 * Also listens for the PAYMENT_SYNCED message posted by the service worker
 * after it successfully replays a queued payment, and calls the optional
 * onPaymentSynced callback so the UI can refresh data.
 */

import { useState, useEffect, useCallback } from 'react';

/**
 * @param {{ onPaymentSynced?: () => void }} [options]
 */
export function useOnlineStatus({ onPaymentSynced } = {}) {
  const [isOnline, setIsOnline]     = useState(() => navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);

  const handleOnline = useCallback(() => {
    setIsOnline(true);
  }, []);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
    setWasOffline(true);
  }, []);

  // Listen for the SW → client message when a queued payment is replayed
  const handleMessage = useCallback(
    (event) => {
      if (event.data?.type === 'PAYMENT_SYNCED' && onPaymentSynced) {
        onPaymentSynced();
      }
    },
    [onPaymentSynced]
  );

  useEffect(() => {
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);
    navigator.serviceWorker?.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
      navigator.serviceWorker?.removeEventListener('message', handleMessage);
    };
  }, [handleOnline, handleOffline, handleMessage]);

  return { isOnline, wasOffline };
}
