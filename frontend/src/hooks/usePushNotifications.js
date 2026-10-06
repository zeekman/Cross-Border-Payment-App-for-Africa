import { useState, useEffect, useCallback } from 'react';
import api from '../utils/api';

const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISSED_KEY = 'notifications_dismissed';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function usePushNotifications() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  // True when the backend has deactivated our subscription after repeated
  // delivery failures (BE-022) — the browser still thinks it's subscribed,
  // but the server will no longer send to it until we re-subscribe.
  const [needsResubscribe, setNeedsResubscribe] = useState(false);

  useEffect(() => {
    setSupported('serviceWorker' in navigator && 'PushManager' in window);
  }, []);

  // Register SW and check existing subscription on mount (no auto-subscribe)
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(!!sub))
      .catch(() => {});
  }, [supported]);

  useEffect(() => {
    api
      .get('/notifications/subscription-health')
      .then(({ data }) => setNeedsResubscribe(!!data?.needsResubscribe))
      .catch(() => {});
  }, []);

  const shouldShowPrompt = useCallback(() => {
    if (permissionStatus !== 'default') return false;
    // Durable opt-out: once the user says "don't ask again", never re-prompt.
    if (localStorage.getItem(DISMISSED_KEY) === 'true') return false;
    // Otherwise, only re-prompt once the 7-day deferral has fully elapsed.
    if (permissionStatus === 'denied') return false;
    if (permissionStatus === 'granted') return needsResubscribe;
    const deferred = localStorage.getItem('notifications_deferred');
    if (!deferred) return true;
    return Date.now() - parseInt(deferred, 10) > SEVEN_DAYS_MS;
  }, [permissionStatus, needsResubscribe]);

  const subscribe = useCallback(async () => {
    if (!supported || !VAPID_PUBLIC_KEY) return;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await api.post('/notifications/subscribe', { subscription: sub.toJSON() });
      setSubscribed(true);
      setPermissionStatus(Notification.permission);
      setNeedsResubscribe(false);
    } catch (err) {
      console.error('Push subscribe failed', err);
    } finally {
      setLoading(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      await api.delete('/notifications/subscribe');
      setSubscribed(false);
    } catch (err) {
      console.error('Push unsubscribe failed', err);
    } finally {
      setLoading(false);
    }
  }, [supported]);

  return { supported, subscribed, loading, subscribe, unsubscribe, permissionStatus, shouldShowPrompt, needsResubscribe };
}
