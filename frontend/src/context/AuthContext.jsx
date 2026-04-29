import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import * as Sentry from '@sentry/react';
import api from '../utils/api';

function maskWalletAddress(address) {
  if (!address || address.length < 8) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export const AuthContext = createContext(null);

// In-memory token store — never touches localStorage, safe from XSS.
// Exported so api.js can read the current token without a circular import.
export const tokenStore = {
  token: null,
  get() { return this.token; },
  set(t) { this.token = t; },
  clear() { this.token = null; },
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // On mount: attempt a silent refresh using the httpOnly cookie.
  // If the cookie is valid the backend returns a new access token.
  useEffect(() => {
    api.post('/auth/refresh', {})
      .then((res) => {
        tokenStore.set(res.data.token);
        return api.get('/auth/me');
      })
      .then((res) => setUser(res.data))
      .catch(() => { /* no valid session — stay logged out */ })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
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
    localStorage.removeItem('afripay_slippage');
    setUser(null);
    Sentry.setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
