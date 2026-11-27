import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';

/**
 * FE-204: "Data saver" mode for users on prepaid data / 2G-3G connections.
 *
 * When on, background traffic is cut: no Horizon payment stream, no
 * notification polling (socket only), exchange rates every 10 minutes and
 * manual-refresh-only swap quotes.
 *
 * The preference is stored per user (a user-scoped localStorage key, so it is
 * cleared with the rest of the user's storage on logout — see userStorage.js).
 * With no stored preference the default follows the Network Information API.
 */
export const DATA_SAVER_RATES_INTERVAL_MS = 10 * 60 * 1000;

const keyFor = (userId) => `afripay_data_saver_${userId ?? 'anon'}`;

export function detectDataSaverDefault() {
  if (typeof navigator === 'undefined') return false;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return false;
  return Boolean(conn.saveData) || ['2g', 'slow-2g'].includes(conn.effectiveType);
}

export function readDataSaverPreference(userId) {
  try {
    const v = localStorage.getItem(keyFor(userId));
    if (v === 'on') return true;
    if (v === 'off') return false;
  } catch { /* storage unavailable */ }
  return detectDataSaverDefault();
}

const DataSaverContext = createContext({ dataSaver: false, setDataSaver: () => {} });

export function DataSaverProvider({ children }) {
  const { user } = useAuth() || {};
  const userId = user?.id ?? null;
  const [dataSaver, setState] = useState(() => readDataSaverPreference(userId));

  useEffect(() => {
    setState(readDataSaverPreference(userId));
  }, [userId]);

  const setDataSaver = useCallback((on) => {
    setState(Boolean(on));
    try {
      localStorage.setItem(keyFor(userId), on ? 'on' : 'off');
    } catch { /* keep the session value */ }
  }, [userId]);

  return (
    <DataSaverContext.Provider value={{ dataSaver, setDataSaver }}>
      {children}
    </DataSaverContext.Provider>
  );
}

export const useDataSaver = () => useContext(DataSaverContext);
