import React, { createContext, useContext, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { defaultCurrency } from '../utils/currency';
import { useAuth } from './AuthContext';

const STORAGE_KEY = 'afripay_display_currency';
const isCode = (v) => /^[A-Z0-9]{3,12}$/.test(v || '');

/**
 * Reads the persisted display-currency preference.
 *
 * The stored value is a plain currency code (never JSON), so there is no
 * "corrupted JSON" failure mode — the only realistic failures are storage being
 * unavailable (private mode, disabled cookies, quota exceeded). Returns
 * { value, error } so the provider can surface a fallback UX (issue #997)
 * instead of silently dropping the user's preference.
 */
function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return { value: isCode(v) ? v : null, error: false };
  } catch {
    return { value: null, error: true };
  }
}

const CurrencyContext = createContext(null);

export function CurrencyProvider({ children }) {
  const [stored] = useState(readStored);
  const user = useAuth()?.user;
  const [chosen, setDisplayCurrency] = useState(stored.value);
  const fallback = defaultCurrency(user?.kyc_country || user?.country_code);
  const displayCurrency = chosen || fallback;

  // Fallback UX: the initial state already reads the persisted value on first
  // render (so there is no flash of the default currency), but if storage
  // couldn't be read we surface a warning instead of failing silently.
  useEffect(() => {
    if (stored.error) {
      toast.error("Couldn't load your saved display currency. Using the default.");
    }
  }, [stored.error]);

  const setAndPersist = (code) => {
    const safe = isCode(code) ? code : fallback;
    try {
      localStorage.setItem(STORAGE_KEY, safe);
    } catch {
      // Keep the session value even when persistence fails, but warn the user —
      // otherwise their choice is silently lost on the next reload.
      toast.error("Couldn't save your display currency preference. It will reset on reload.");
    }
    setDisplayCurrency(safe);
  };

  return (
    <CurrencyContext.Provider value={{ displayCurrency, setDisplayCurrency: setAndPersist }}>
      {children}
    </CurrencyContext.Provider>
  );
}

export const useCurrency = () => useContext(CurrencyContext);
