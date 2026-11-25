import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';

const STORAGE_KEY = 'afripay_active_wallet';

const WalletContext = createContext({ activeWalletId: null, setActiveWalletId: () => {} });

function readStored(userId) {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return stored && stored.userId === userId ? stored.walletId : null;
  } catch {
    return null;
  }
}

// Active wallet shared by Dashboard, Send, Receive and History (FE-174).
// Persisted per user; logout wipes it via clearUserStorage and the effect below.
export function WalletProvider({ children }) {
  const { user } = useAuth() || {};
  const userId = user?.id ?? null;
  const [activeWalletId, setActiveWalletId] = useState(() => readStored(userId));

  useEffect(() => {
    setActiveWalletId(readStored(userId));
  }, [userId]);

  useEffect(() => {
    try {
      if (userId != null && activeWalletId) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, walletId: activeWalletId }));
      } else if (userId == null) {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* storage unavailable */
    }
  }, [userId, activeWalletId]);

  return (
    <WalletContext.Provider value={{ activeWalletId, setActiveWalletId }}>
      {children}
    </WalletContext.Provider>
  );
}

export const useWallet = () => useContext(WalletContext);
