import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import { getUserPref, setUserPref } from '../utils/userPrefs';
import { getErrorKey } from '../utils/apiError';

/**
 * Idle auto-lock (FE-214).
 *
 * - Activity = pointer, keyboard, touch, scroll and wheel events. Background
 *   polling and network traffic never count, because they aren't user input.
 * - After the user's timeout (1, 5, 15 minutes or never; default 5) a
 *   full-screen overlay covers the app. The content behind it is blurred,
 *   made inert, and hidden from assistive tech, so it can't be read or
 *   interacted with.
 * - Returning from the background after more than the timeout locks immediately.
 * - The PIN (verified by `/auth/verify-pin`) unlocks. After 3 wrong PINs the
 *   user is fully logged out.
 */

export const LOCK_OPTIONS_MINUTES = [1, 5, 15, 0]; // 0 = never
export const DEFAULT_LOCK_MINUTES = 5;
export const MAX_UNLOCK_ATTEMPTS = 3;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'scroll'];

export function getLockMinutes(userId) {
  const value = getUserPref(userId, 'lock_after_minutes', DEFAULT_LOCK_MINUTES);
  return LOCK_OPTIONS_MINUTES.includes(value) ? value : DEFAULT_LOCK_MINUTES;
}

export function setLockMinutes(userId, minutes) {
  if (LOCK_OPTIONS_MINUTES.includes(minutes)) setUserPref(userId, 'lock_after_minutes', minutes);
}

/** Tracks inactivity and reports when the app should lock. */
export function useIdleLock(timeoutMs) {
  const [locked, setLocked] = useState(false);
  const lastActivity = useRef(Date.now());
  const hiddenAt = useRef(null);

  useEffect(() => {
    if (!timeoutMs) return undefined;
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setLocked(true), timeoutMs);
    };
    const onActivity = () => {
      if (locked) return;
      lastActivity.current = Date.now();
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      const awayFor = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      if (awayFor >= timeoutMs || Date.now() - lastActivity.current >= timeoutMs) setLocked(true);
      else schedule();
    };

    schedule();
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [timeoutMs, locked]);

  const unlock = useCallback(() => {
    lastActivity.current = Date.now();
    setLocked(false);
  }, []);

  return { locked, unlock };
}

function LockOverlay({ onUnlock, onLogout }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!pin || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/verify-pin', { pin });
      onUnlock();
    } catch (err) {
      const next = attempts + 1;
      setAttempts(next);
      setPin('');
      const key = getErrorKey(err);
      const isWrongPin = key === 'errors.INVALID_PIN' || err?.response?.status === 401 || err?.response?.status === 400;
      if (!isWrongPin) {
        setError(t(key, { defaultValue: t('errors.generic') }));
      } else if (next >= MAX_UNLOCK_ATTEMPTS) {
        onLogout();
        return;
      } else {
        setError(t('app_lock.wrong_pin', { count: MAX_UNLOCK_ATTEMPTS - next }));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-lock-title"
      data-testid="app-lock-overlay"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-gray-950/90 backdrop-blur-xl p-4"
    >
      <form onSubmit={submit} className="w-full max-w-xs space-y-4 text-center">
        <Lock className="mx-auto text-primary-500" size={32} aria-hidden="true" />
        <h2 id="app-lock-title" className="text-lg font-semibold text-white">{t('app_lock.title')}</h2>
        <p className="text-sm text-gray-400">{t('app_lock.description')}</p>
        <label htmlFor="app-lock-pin" className="sr-only">{t('app_lock.pin_label')}</label>
        <input
          id="app-lock-pin"
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          className="w-full rounded-xl bg-gray-900 border border-gray-700 px-4 py-3 text-center text-xl tracking-widest text-white"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'app-lock-error' : undefined}
        />
        {error && <p id="app-lock-error" role="alert" className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={!pin || busy}
          className="w-full rounded-xl bg-primary-500 py-3 font-semibold text-white disabled:opacity-50"
        >
          {busy ? t('common.loading') : t('app_lock.unlock')}
        </button>
        <button type="button" onClick={onLogout} className="text-xs text-gray-400 underline">
          {t('common.sign_out')}
        </button>
      </form>
    </div>
  );
}

/** Wraps the authenticated app. Renders children normally until the idle lock engages. */
export default function AppLock({ children }) {
  const { user, logout } = useAuth();
  const minutes = user ? getLockMinutes(user.id) : 0;
  const { locked, unlock } = useIdleLock(user && minutes > 0 ? minutes * 60_000 : 0);

  const handleLogout = useCallback(async () => {
    await logout();
    window.location.assign('/login');
  }, [logout]);

  return (
    <>
      <div
        aria-hidden={locked ? true : undefined}
        inert={locked ? '' : undefined}
        className={locked ? 'pointer-events-none select-none blur-xl' : undefined}
        data-testid="app-lock-content"
      >
        {children}
      </div>
      {locked && <LockOverlay onUnlock={unlock} onLogout={handleLogout} />}
    </>
  );
}

/** Profile setting: lock after 1 / 5 / 15 minutes or never. Persisted per user. */
export function AutoLockSetting() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [minutes, setMinutes] = useState(() => getLockMinutes(user?.id));

  const onChange = (e) => {
    const value = Number(e.target.value);
    setMinutes(value);
    setLockMinutes(user?.id, value);
  };

  return (
    <div className="card">
      <label htmlFor="auto-lock-select" className="block font-semibold text-white mb-1">
        {t('app_lock.setting_label')}
      </label>
      <p className="text-xs text-gray-400 mb-2">{t('app_lock.setting_description')}</p>
      <select
        id="auto-lock-select"
        value={minutes}
        onChange={onChange}
        className="w-full rounded-xl bg-gray-900 border border-gray-700 px-3 py-2 text-sm text-white"
      >
        {LOCK_OPTIONS_MINUTES.map((m) => (
          <option key={m} value={m}>
            {m === 0 ? t('app_lock.never') : t('app_lock.minutes', { count: m })}
          </option>
        ))}
      </select>
      <p className="text-xs text-gray-500 mt-2">{t('app_lock.setting_note')}</p>
    </div>
  );
}
