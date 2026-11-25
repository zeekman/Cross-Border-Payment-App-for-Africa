/**
 * Integration tests verifying Hausa (ha) locale coverage.
 *
 * Audit result: all 151 EN keys are present in the HA locale (0 missing).
 * These tests verify that switching to `ha` renders correct Hausa strings
 * for key UI labels — no English fallbacks, no raw translation keys.
 *
 * Issue #643 — i18n: Complete Hausa (ha) Translation Coverage
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import api from '../utils/api';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
jest.mock('../context/AuthContext', () => ({
  ...jest.requireActual('../context/AuthContext'),
  useAuth: () => ({
    user: { full_name: 'Musa', email: 'musa@test.com', wallet_address: 'GC...123' },
    logout: jest.fn(),
  }),
}));
jest.mock('react-hot-toast', () => ({ error: jest.fn(), success: jest.fn() }));

const Profile = require('./Profile').default;

function mockMountCalls() {
  api.get
    .mockResolvedValueOnce({ data: { trustlines: [] } })
    .mockResolvedValueOnce({ data: { contacts: [] } })
    .mockResolvedValueOnce({ data: { activity: [] } });
}

async function renderInHausa() {
  await act(async () => {
    await i18n.changeLanguage('ha');
  });
  await act(async () => {
    render(
      <BrowserRouter>
        <I18nextProvider i18n={i18n}>
          <Profile />
        </I18nextProvider>
      </BrowserRouter>
    );
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});
afterEach(() => i18n.changeLanguage('en'));

jest.setTimeout(15000);

describe('Hausa (ha) locale integration', () => {
  test('profile.title renders "Bayanan Kai" in Hausa', async () => {
    mockMountCalls();
    await renderInHausa();
    await waitFor(() =>
      expect(screen.getByText('Bayanan Kai')).toBeInTheDocument()
    );
  });

  test('profile.member renders "Memba na AfriPay" in Hausa', async () => {
    mockMountCalls();
    await renderInHausa();
    await waitFor(() =>
      expect(screen.getByText('Memba na AfriPay')).toBeInTheDocument()
    );
  });

  test('profile.language renders "Harshe" in Hausa', async () => {
    mockMountCalls();
    await renderInHausa();
    await waitFor(() =>
      expect(screen.getByText('Harshe')).toBeInTheDocument()
    );
  });

  test('profile.no_contacts renders "Babu tuntuɓi tukuna" in Hausa', async () => {
    mockMountCalls();
    await renderInHausa();
    await waitFor(() =>
      expect(screen.getByText('Babu tuntuɓi tukuna')).toBeInTheDocument()
    );
  });

  test('profile.frequent_contacts renders correct Hausa string', async () => {
    mockMountCalls();
    await renderInHausa();
    await waitFor(() =>
      expect(
        screen.getByText('Tuntuɓin Da Ake Amfani Da Su')
      ).toBeInTheDocument()
    );
  });

  test('common.sign_out renders "Fita" in Hausa', async () => {
    mockMountCalls();
    await renderInHausa();
    await waitFor(() =>
      expect(screen.getByText('Fita')).toBeInTheDocument()
    );
  });

  test('no raw translation keys rendered when locale is ha', async () => {
    mockMountCalls();
    await renderInHausa();
    // Keys should never appear as text
    const keyPatterns = [
      'profile.title', 'profile.member', 'profile.language',
      'common.sign_out', 'profile.no_contacts',
    ];
    for (const key of keyPatterns) {
      expect(screen.queryByText(key)).not.toBeInTheDocument();
    }
  });

  test('no English fallback for profile.title when locale is ha', async () => {
    mockMountCalls();
    await renderInHausa();
    await waitFor(() =>
      expect(screen.queryByText('Profile')).not.toBeInTheDocument()
    );
  });

  test('switching from en to ha updates profile title without reload', async () => {
    mockMountCalls();
    await act(async () => { await i18n.changeLanguage('en'); });
    await act(async () => {
      render(
        <BrowserRouter>
          <I18nextProvider i18n={i18n}>
            <Profile />
          </I18nextProvider>
        </BrowserRouter>
      );
    });
    await waitFor(() => expect(screen.getByText('Profile')).toBeInTheDocument());

    await act(async () => { await i18n.changeLanguage('ha'); });
    await waitFor(() =>
      expect(screen.getByText('Bayanan Kai')).toBeInTheDocument()
    );
  });

  test('Hausa locale code is "ha" after switching', async () => {
    mockMountCalls();
    await renderInHausa();
    expect(i18n.language).toBe('ha');
  });

  test('i18n.t returns Hausa strings for 10 key labels', async () => {
    await act(async () => { await i18n.changeLanguage('ha'); });
    const checks = [
      ['common.back', 'Koma'],
      ['common.loading', 'Ana lodawa...'],
      ['common.cancel', 'Soke'],
      ['common.sign_out', 'Fita'],
      ['dashboard.greeting', 'Barka,'],
      ['dashboard.send', 'Aika'],
      ['dashboard.receive', 'Karɓa'],
      ['send.title', 'Aika Kuɗi'],
      ['receive.title', 'Karɓi Kuɗi'],
      ['profile.title', 'Bayanan Kai'],
    ];
    for (const [key, expected] of checks) {
      expect(i18n.t(key)).toBe(expected);
    }
  });
});
