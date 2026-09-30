import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import * as Sentry from '@sentry/react';
import api, { refreshSession } from '../utils/api';
import { clearUserStorage } from '../utils/userStorage';
import {
  setQueueOwner,
  purgeStaleQueuedPayments,
  clearPaymentQueue,
} from '../utils/offlineDB';

function maskWalletAddress(address) {
  if (!address || address.length < 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export const AuthContext = createContext(null);

// In-memory token store — never touches localStorage, safe from XSS.
// Exported so api.js can read the current token without a circular import.
export const tokenStore = {
  token: null,
  listeners: new Set(),
  get() { return this.token; },
  set(t) { this.token = t; this.listeners.forEach((fn) => fn(t)); },
  clear() { this.token = null; this.listeners.forEach((fn) => fn(null)); },
  /** Subscribe to token changes (e.g. to reconnect sockets); returns unsubscribe. */
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Bind the offline payment queue to whoever is logged in (FE-137): new
  // queued payments are stamped with this id, and any entries left behind by
  // another user (or expired ones) are dropped as soon as a session starts.
  useEffect(() => {
    const userId = user?.id ?? null;
    setQueueOwner(userId);
    if (userId != null) {
      purgeStaleQueuedPayments(userId).catch(() => {});
    }
  }, [user?.id]);

  // On mount: attempt a silent refresh using the httpOnly cookie.
  // If the cookie is valid the backend returns a new access token.
  useEffect(() => {
    refreshSession()
      .then((token) => {
        tokenStore.set(token);
        return api.get('/auth/me');
      })
      .then((res) => setUser(res.data))
      .catch(() => { /* no valid session — stay logged out */ })
      .finally(() => setLoading(false));
  }, []);

  // api.js signals an expired session; clearing the user lets PrivateRoute
  // redirect protected pages while public pages stay put.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('afripay:session-expired', onExpired);
    return () => window.removeEventListener('afripay:session-expired', onExpired);
  }, []);

  // Device-trust is carried by an httpOnly cookie the backend sets on login
  // (issue #995) — the browser attaches it automatically via withCredentials,
  // so no token is read from or written to localStorage here.
  const login = async (email, password, options = {}) => {
    const res = await api.post('/auth/login', { email, password, ...options });
    tokenStore.set(res.data.token);
    setUser(res.data.user);
    Sentry.setUser({
      id: res.data.user.id,
      wallet: maskWalletAddress(res.data.user.walletAddress),
    });
    return res.data;
  };

  const register = async (data) => {
    const res = await api.post('/auth/register', data);
    return res.data;
  };

  const logout = async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* still clear local session */
    }
    tokenStore.clear();
    clearUserStorage();
    setQueueOwner(null);
    // Pending offline payments belong to this user — never leave them for the
    // next person who logs in on this device.
    await clearPaymentQueue().catch(() => {});
    setUser(null);
    Sentry.setUser(null);
  };

  const updateUser = (fields) => setUser((prev) => (prev ? { ...prev, ...fields } : fields));

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
