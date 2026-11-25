import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { skipWaiting } from '../serviceWorker';

const SNOOZE_KEY = 'afripay_sw_update_snoozed_until';
const SNOOZE_MS = 30 * 60 * 1000;

export default function UpdateBanner() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handleUpdateAvailable = () => setVisible(true);
    window.addEventListener('swUpdateAvailable', handleUpdateAvailable);
    return () => window.removeEventListener('swUpdateAvailable', handleUpdateAvailable);
  }, []);

  if (!visible) return null;

  const handleUpdate = () => {
    skipWaiting();
  };

  const handleLater = () => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
    setVisible(false);
    setTimeout(() => setVisible(true), SNOOZE_MS);
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed bottom-0 left-0 right-0 z-50 bg-gray-900 border-t border-gray-700 px-4 py-3 flex items-center justify-between gap-3 shadow-lg"
    >
      <p className="text-sm text-white">{t('shared.newVersion', 'A new version of AfriPay is available.')}</p>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleLater}
          className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          {t('shared.later', 'Later')}
        </button>
        <button
          onClick={handleUpdate}
          className="text-sm bg-primary-500 hover:bg-primary-600 text-white font-medium px-3 py-1.5 rounded-lg transition-colors"
        >
          {t('shared.updateNow', 'Update Now')}
        </button>
      </div>
    </div>
  );
}
