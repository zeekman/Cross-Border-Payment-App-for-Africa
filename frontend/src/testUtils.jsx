import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import './i18n';
import { AuthContext } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { CurrencyProvider } from './context/CurrencyContext';

export const defaultAuth = {
  user: { id: 'user-1', email: 'test@example.com', full_name: 'Test User', walletAddress: 'GTESTWALLET' },
  loading: false,
  login: jest.fn(),
  register: jest.fn(),
  logout: jest.fn(),
  updateUser: jest.fn(),
};

/**
 * Render a component wrapped in every provider the app needs (FE-127):
 * Router, Auth (mocked value, no network), Theme, Currency and i18n.
 */
export function renderWithProviders(ui, { route = '/', auth = {}, ...options } = {}) {
  const authValue = { ...defaultAuth, ...auth };
  function Wrapper({ children }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <AuthContext.Provider value={authValue}>
          <ThemeProvider>
            <CurrencyProvider>{children}</CurrencyProvider>
          </ThemeProvider>
        </AuthContext.Provider>
      </MemoryRouter>
    );
  }
  return { authValue, ...render(ui, { wrapper: Wrapper, ...options }) };
}
