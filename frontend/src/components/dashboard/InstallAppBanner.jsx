import React from 'react';
import { Smartphone, Share, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import useInstallPrompt from '../../hooks/useInstallPrompt';

/**
 * "Install AfriPay" banner (FE-213). Shown on Dashboard when the browser
 * offered `beforeinstallprompt` and the user has visited twice or completed
 * a send. Hidden in standalone mode and for 30 days after dismissal. On iOS
 * Safari (no event) a one-time sheet explains Share → Add to Home Screen.
 */
export default function InstallAppBanner({ user, onAnalytics }) {
  const { t } = useTranslation();
  const { showBanner, showIosSheet, install, dismiss, dismissIosSheet } = useInstallPrompt(user?.id, { onAnalytics });

  if (showBanner) {
    return (
      <div
        className="flex items-center justify-between gap-3 bg-primary-500/10 border border-primary-500/30 rounded-xl px-4 py-3"
        data-testid="install-app-banner"
      >
        <div className="flex items-center gap-2 text-primary-400 text-sm">
          <Smartphone size={15} aria-hidden="true" />
          <span>{t('install.banner')}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={install}
            className="text-xs bg-primary-500 hover:bg-primary-600 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
          >
            {t('install.button')}
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t('install.dismiss')}
            className="p-1.5 text-gray-400 hover:text-gray-200 rounded-lg"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  if (showIosSheet) {
    return (
      <div
        role="dialog"
        aria-labelledby="ios-install-title"
        className="bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 space-y-2"
        data-testid="install-ios-sheet"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 id="ios-install-title" className="text-sm font-semibold text-white">{t('install.ios_title')}</h3>
          <button
            type="button"
            onClick={dismissIosSheet}
            aria-label={t('install.dismiss')}
            className="p-1 text-gray-400 hover:text-gray-200"
          >
            <X size={14} />
          </button>
        </div>
        <p className="text-xs text-gray-400 flex items-center gap-1 flex-wrap">
          {t('install.ios_step1')} <Share size={12} aria-hidden="true" /> {t('install.ios_step2')}
        </p>
      </div>
    );
  }

  return null;
}
