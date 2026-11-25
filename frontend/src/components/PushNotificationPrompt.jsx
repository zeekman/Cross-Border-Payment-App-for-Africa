import React from 'react';
import api from '../utils/api';

const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export default function PushNotificationPrompt({ onDismiss }) {
  const permission = typeof Notification !== 'undefined' ? Notification.permission : 'default';

  const handleNotNow = () => {
    localStorage.setItem('notifications_deferred', Date.now().toString());
    onDismiss();
  };

  const handleDontAskAgain = () => {
    localStorage.setItem('notifications_dismissed', 'true');
    onDismiss();
  };

  const handleEnable = async () => {
    const result = await Notification.requestPermission();
    if (result === 'granted' && 'serviceWorker' in navigator && VAPID_PUBLIC_KEY) {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        await api.post('/notifications/subscribe', { subscription: sub.toJSON() });
      } catch (err) {
        console.error('Push subscribe failed', err);
      }
    }
    onDismiss();
  };

  return (
    <>
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .push-prompt { animation: slideUp 0.3s ease-out; }
      `}</style>
      <div
        className="push-prompt fixed bottom-0 left-0 right-0 z-50 p-4 pb-safe"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-5 max-w-lg mx-auto shadow-2xl">
          {permission === 'denied' ? (
            <p className="text-sm text-gray-300">
              Enable notifications in your browser settings to get payment alerts.
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-200 mb-4">
                Get notified when your payments are confirmed. Enable notifications?
              </p>
              <div className="flex gap-3">
                <button
                  onClick={handleEnable}
                  className="flex-1 bg-primary-600 hover:bg-primary-700 text-white text-sm font-semibold py-2.5 rounded-xl transition-colors"
                >
                  Enable
                </button>
                <button
                  onClick={handleNotNow}
                  className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium py-2.5 rounded-xl transition-colors"
                >
                  Not now
                </button>
              </div>
              <button
                type="button"
                onClick={handleDontAskAgain}
                className="mt-3 w-full text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                Don&apos;t ask again
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
