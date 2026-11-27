import { useCallback, useEffect, useState } from 'react';
import { getUserPref, setUserPref } from '../utils/userPrefs';

/**
 * PWA install prompt (FE-213).
 *
 * `beforeinstallprompt` can fire before React mounts, so the event is
 * captured at module load (imported from index.js) and replayed to the hook.
 */
let deferredPrompt = null;
const listeners = new Set();

export function captureInstallPrompt() {
  if (typeof window === 'undefined' || captureInstallPrompt.installed) return;
  captureInstallPrompt.installed = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault(); // suppress the browser mini-infobar; we show our own banner
    deferredPrompt = event;
    listeners.forEach((fn) => fn(event));
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    listeners.forEach((fn) => fn(null));
  });
}

/** Test-only reset. */
export function __resetInstallPromptForTests() {
  deferredPrompt = null;
  listeners.clear();
  captureInstallPrompt.installed = false;
}

export const DISMISS_FOR_MS = 30 * 24 * 60 * 60 * 1000;
const VISIT_COUNT_KEY = 'install_visit_count';
const DISMISSED_AT_KEY = 'install_dismissed_at';
const SENT_KEY = 'install_first_send_done';
const IOS_SHEET_SEEN_KEY = 'install_ios_sheet_seen';

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.navigator.standalone === true
  );
}

export function isIosSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return iOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

/** Call after the user's first successful send so the banner can appear on Dashboard. */
export function markFirstSendForInstall(userId) {
  setUserPref(userId, SENT_KEY, true);
}

/**
 * @param {string|number} userId
 * @param {{ onAnalytics?: (event: string) => void }} [options]
 *   `onAnalytics` is called only by callers that hold analytics consent.
 */
export default function useInstallPrompt(userId, { onAnalytics } = {}) {
  const [promptEvent, setPromptEvent] = useState(deferredPrompt);
  const [dismissedAt, setDismissedAt] = useState(() => getUserPref(userId, DISMISSED_AT_KEY, null));
  const [visits] = useState(() => {
    const next = Number(getUserPref(userId, VISIT_COUNT_KEY, 0)) + 1;
    setUserPref(userId, VISIT_COUNT_KEY, next);
    return next;
  });
  const [iosSheetSeen, setIosSheetSeen] = useState(() => getUserPref(userId, IOS_SHEET_SEEN_KEY, false));

  useEffect(() => {
    captureInstallPrompt();
    const onPrompt = (event) => setPromptEvent(event);
    listeners.add(onPrompt);
    if (deferredPrompt) setPromptEvent(deferredPrompt);
    return () => listeners.delete(onPrompt);
  }, []);

  const standalone = isStandalone();
  const recentlyDismissed = typeof dismissedAt === 'number' && Date.now() - dismissedAt < DISMISS_FOR_MS;
  const engaged = visits >= 2 || getUserPref(userId, SENT_KEY, false) === true;
  const eligible = !standalone && !recentlyDismissed && engaged;

  const showBanner = eligible && !!promptEvent;
  const showIosSheet = eligible && !promptEvent && !iosSheetSeen && isIosSafari();

  const install = useCallback(async () => {
    if (!promptEvent) return 'unavailable';
    promptEvent.prompt();
    const choice = await promptEvent.userChoice.catch(() => ({ outcome: 'dismissed' }));
    onAnalytics?.(choice.outcome === 'accepted' ? 'pwa_install_accepted' : 'pwa_install_dismissed');
    deferredPrompt = null;
    setPromptEvent(null);
    if (choice.outcome !== 'accepted') {
      const now = Date.now();
      setUserPref(userId, DISMISSED_AT_KEY, now);
      setDismissedAt(now);
    }
    return choice.outcome;
  }, [promptEvent, onAnalytics, userId]);

  const dismiss = useCallback(() => {
    const now = Date.now();
    setUserPref(userId, DISMISSED_AT_KEY, now);
    setDismissedAt(now);
  }, [userId]);

  const dismissIosSheet = useCallback(() => {
    setUserPref(userId, IOS_SHEET_SEEN_KEY, true);
    setIosSheetSeen(true);
  }, [userId]);

  return { showBanner, showIosSheet, install, dismiss, dismissIosSheet };
}
