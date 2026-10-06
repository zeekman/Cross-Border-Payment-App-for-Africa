/**
 * OfflineBanner
 *
 * Displays a persistent banner when the device is offline.
 * Shows queued payment count, a dropdown list of queued transactions,
 * and allows the user to cancel individual queued items.
 *
 * Queued payments are never sent automatically (FE-137). Only payments queued
 * by the logged-in user, and not yet expired, are shown. When connectivity is
 * restored the user must review them and re-confirm with their PIN before
 * they are sent; they can also discard them.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { WifiOff, Wifi, Clock, ChevronDown, X, Send, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../context/AuthContext';
import {
  getQueuedPaymentsForUser,
  removeQueuedPayment,
  updateQueuedPaymentStatus,
} from '../utils/offlineDB';
import api from '../utils/api';
import PINVerificationModal from './PINVerificationModal';

function describeItem(item) {
  return `${item.payload.amount} ${item.payload.asset || 'XLM'}`;
}

function QueueList({ items, onCancel, disabled }) {
  return items.map(item => (
    <div
      key={item.id}
      className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 last:border-0"
    >
      <div className="text-xs text-gray-300">
        <span className="font-semibold text-white">{describeItem(item)}</span>
        {item.payload.recipient_address && (
          <span className="ml-1 text-gray-500 font-mono">
            → {item.payload.recipient_address.slice(0, 8)}…
          </span>
        )}
        <span className="ml-2 text-gray-600">
          {new Date(item.createdAt).toLocaleString()}
        </span>
        {item.status === 'failed' && (
          <span className="ml-2 text-red-400">failed</span>
        )}
      </div>
      <button
        type="button"
        onClick={() => onCancel(item.id)}
        disabled={disabled}
        className="ml-3 text-gray-400 hover:text-red-400 transition-colors shrink-0 disabled:opacity-50"
        aria-label="Cancel this queued payment"
      >
        <X size={14} />
      </button>
    </div>
  ));
}

export default function OfflineBanner({ onPaymentSynced }) {
  const { isOnline, wasOffline } = useOnlineStatus({ onPaymentSynced });
  const { user } = useAuth() || {};
  const userId = user?.id ?? null;
  const [showBackOnline, setShowBackOnline] = useState(false);
  const [queuedItems, setQueuedItems] = useState([]);
  const [showQueue, setShowQueue] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);

  // Latest user id, read after async gaps so a logout / user switch mid-send
  // stops the replay instead of sending with the new user's session.
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const queueCount = queuedItems.length;

  const refreshQueue = useCallback(async () => {
    try {
      setQueuedItems(await getQueuedPaymentsForUser(userId));
    } catch {
      setQueuedItems([]);
    }
  }, [userId]);

  // Refresh the queue whenever online status or the logged-in user changes
  useEffect(() => {
    refreshQueue();
  }, [isOnline, refreshQueue]);

  // Close the confirmation if the user logs out or goes offline again
  useEffect(() => {
    if (!isOnline || userId == null) setPinOpen(false);
  }, [isOnline, userId]);

  // Only called after the user has re-confirmed with their PIN.
  const sendQueued = useCallback(async () => {
    const ownerId = userIdRef.current;
    if (ownerId == null) return;

    // Re-read from storage: never trust the rendered list, which may be stale.
    const items = await getQueuedPaymentsForUser(ownerId);
    if (items.length === 0) {
      refreshQueue();
      return;
    }

    setSyncing(true);
    for (const item of items) {
      if (userIdRef.current !== ownerId || !navigator.onLine) break;
      try {
        // Mark as syncing so a mid-replay connectivity drop doesn't re-generate
        // a new idempotency key — the stored key is reused on the next attempt.
        await updateQueuedPaymentStatus(item.id, 'syncing');
        await api.post('/payments/send', item.payload, {
          // Reuse the key that was stamped at queue time.  This is the
          // critical guarantee: even if connectivity drops mid-replay and
          // the user confirms again later, the backend will see the
          // same Idempotency-Key and return the cached response instead of
          // processing a duplicate payment.
          headers: { 'Idempotency-Key': item.idempotencyKey },
        });
        await removeQueuedPayment(item.id);
        toast.success(`Payment of ${describeItem(item)} sent successfully.`, { duration: 4000 });
        onPaymentSynced?.();
      } catch (err) {
        // Mark as 'failed' so the user can retry it (with the same
        // idempotency key still intact) or discard it.
        await updateQueuedPaymentStatus(item.id, 'failed').catch(() => {});
        toast.error(
          `Failed to send queued payment (${describeItem(item)}): ${
            err.response?.data?.error || err.message || 'Unknown error'
          }`,
          { duration: 8000, id: `queue-fail-${item.id}` }
        );
      }
    }
    setSyncing(false);
    refreshQueue();
  }, [onPaymentSynced, refreshQueue]);

  // Show the "back online" notice for 4 seconds after reconnecting
  useEffect(() => {
    if (isOnline && wasOffline) {
      setShowBackOnline(true);
      const t = setTimeout(() => setShowBackOnline(false), 4000);
      return () => clearTimeout(t);
    }
  }, [isOnline, wasOffline]);

  const handleCancel = async (id) => {
    await removeQueuedPayment(id);
    refreshQueue();
    toast('Queued payment cancelled.', { icon: '🗑️' });
  };

  const handleDiscardAll = async () => {
    await Promise.all(queuedItems.map(item => removeQueuedPayment(item.id)));
    setShowQueue(false);
    refreshQueue();
    toast('Queued payments discarded.', { icon: '🗑️' });
  };

  const totalLabel = queueCount === 1
    ? describeItem(queuedItems[0])
    : `${queueCount} queued payments`;

  if (!isOnline) {
    return (
      <div className="relative">
        <div
          role="status"
          aria-live="assertive"
          className="bg-red-600 text-white text-xs font-semibold py-2 px-4 flex items-center justify-center gap-2"
        >
          <WifiOff size={14} aria-hidden="true" />
          <span>You're offline — showing cached data</span>
          {queueCount > 0 && (
            <button
              type="button"
              onClick={() => setShowQueue(v => !v)}
              className="flex items-center gap-1 ml-2 bg-red-700 hover:bg-red-800 rounded-full px-2 py-0.5 transition-colors"
              aria-expanded={showQueue}
              aria-label={`${queueCount} payment${queueCount !== 1 ? 's' : ''} queued — click to view`}
            >
              <Clock size={11} aria-hidden="true" />
              {queueCount} payment{queueCount !== 1 ? 's' : ''} queued
              <ChevronDown
                size={11}
                className={`transition-transform ${showQueue ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
          )}
        </div>

        {/* Queue dropdown */}
        {showQueue && queuedItems.length > 0 && (
          <div
            role="region"
            aria-label="Pending payment queue"
            className="absolute top-full left-0 right-0 z-50 bg-gray-900 border border-red-600/40 shadow-xl max-h-64 overflow-y-auto"
          >
            <p className="px-4 py-2 text-xs text-gray-400 font-semibold uppercase tracking-wide border-b border-gray-800">
              Pending Queue
            </p>
            <QueueList items={queuedItems} onCancel={handleCancel} />
          </div>
        )}
      </div>
    );
  }

  // Online with pending payments: require explicit review + PIN before sending
  if (userId != null && queueCount > 0) {
    return (
      <div className="relative">
        <div
          role="status"
          aria-live="polite"
          className="bg-amber-600 text-white text-xs font-semibold py-2 px-4 flex flex-wrap items-center justify-center gap-2"
        >
          <Clock size={14} aria-hidden="true" />
          <span>
            {syncing
              ? `Sending ${queueCount} queued payment${queueCount !== 1 ? 's' : ''}…`
              : `${queueCount} payment${queueCount !== 1 ? 's' : ''} queued while offline — confirm to send`}
          </span>
          <button
            type="button"
            onClick={() => setShowQueue(v => !v)}
            className="flex items-center gap-1 bg-amber-700 hover:bg-amber-800 rounded-full px-2 py-0.5 transition-colors"
            aria-expanded={showQueue}
          >
            Review
            <ChevronDown
              size={11}
              className={`transition-transform ${showQueue ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            onClick={() => setPinOpen(true)}
            disabled={syncing}
            className="flex items-center gap-1 bg-white text-amber-700 hover:bg-amber-50 rounded-full px-2 py-0.5 transition-colors disabled:opacity-50"
          >
            <Send size={11} aria-hidden="true" />
            Send queued payments
          </button>
          <button
            type="button"
            onClick={handleDiscardAll}
            disabled={syncing}
            className="flex items-center gap-1 bg-amber-700 hover:bg-amber-800 rounded-full px-2 py-0.5 transition-colors disabled:opacity-50"
          >
            <Trash2 size={11} aria-hidden="true" />
            Discard
          </button>
        </div>

        {showQueue && (
          <div
            role="region"
            aria-label="Pending payment queue"
            className="absolute top-full left-0 right-0 z-50 bg-gray-900 border border-amber-600/40 shadow-xl max-h-64 overflow-y-auto"
          >
            <p className="px-4 py-2 text-xs text-gray-400 font-semibold uppercase tracking-wide border-b border-gray-800">
              Pending Queue — amounts are sent at current rates and balance
            </p>
            <QueueList items={queuedItems} onCancel={handleCancel} disabled={syncing} />
          </div>
        )}

        <PINVerificationModal
          isOpen={pinOpen}
          onClose={() => setPinOpen(false)}
          onSuccess={sendQueued}
          amount={totalLabel}
          recipient={queueCount === 1 ? queuedItems[0].payload.recipient_address : undefined}
        />
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
        <span>Back online — all caught up</span>
      </div>
    );
  }

  return null;
}
