import React, { createContext, useContext, useEffect, useState } from 'react';
import toast from 'react-hot-toast';

const STORAGE_KEY = 'afripay_display_currency';
const VALID_CODES = ['XLM', 'USD', 'NGN', 'GHS', 'KES'];
const DEFAULT = 'USD';

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
    return { value: VALID_CODES.includes(v) ? v : DEFAULT, error: false };
  } catch {
    return { value: DEFAULT, error: true };
  }
}

const CurrencyContext = createContext(null);

export function CurrencyProvider({ children }) {
  const [stored] = useState(readStored);
  const [displayCurrency, setDisplayCurrency] = useState(stored.value);

  // Fallback UX: the initial state already reads the persisted value on first
  // render (so there is no flash of the default currency), but if storage
  // couldn't be read we surface a warning instead of failing silently.
  useEffect(() => {
    if (stored.error) {
      toast.error("Couldn't load your saved display currency. Showing USD.");
    }
  }, [stored.error]);

  const setAndPersist = (code) => {
    const safe = VALID_CODES.includes(code) ? code : DEFAULT;
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
