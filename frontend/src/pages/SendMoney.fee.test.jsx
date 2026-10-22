import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { AuthContext } from '../context/AuthContext';
import SendMoney from './SendMoney';

vi.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: vi.fn(), post: vi.fn() },
}));
vi.mock('react-hot-toast', () => {
  const toast = { error: vi.fn(), success: vi.fn() };
  return { default: toast, ...toast };
});
vi.mock('../components/QRScanner', () => ({ default: () => null }));
vi.mock('../components/PINVerificationModal', () => ({ default: () => null }));
vi.mock('../components/XDRInspectorModal', () => ({ default: () => null }));
vi.mock('../components/LedgerSignModal', () => ({ default: () => null }));

import api from '../utils/api';

const mockUser = { full_name: 'Ada', pin_setup_completed: true };
const feeStatsResponse = { data: { fee_bps: 50, fee_xlm: 0.00001 } };

function renderSendMoney() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthContext.Provider value={{ user: mockUser, updateUser: vi.fn() }}>
          <SendMoney />
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nextProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  api.get.mockResolvedValue(feeStatsResponse);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('fee panel hidden when amount is empty', async () => {
  renderSendMoney();
  await act(async () => vi.runAllTimers());
  expect(screen.queryByText(/Recipient receives/i)).not.toBeInTheDocument();
});

test('fee panel shows loading skeleton while debouncing', async () => {
  renderSendMoney();
  const amountInput = screen.getByPlaceholderText('0.00');
  await userEvent.type(amountInput, '100');
  // skeleton present before debounce fires
  const skeletons = document.querySelectorAll('.skeleton');
  expect(skeletons.length).toBeGreaterThan(0);
});

test('fee panel displays breakdown after debounce resolves', async () => {
  renderSendMoney();
  const amountInput = screen.getByPlaceholderText('0.00');
  await userEvent.type(amountInput, '100');
  await act(async () => vi.advanceTimersByTime(300));
  await waitFor(() =>
    expect(screen.getByText(/Recipient receives/i)).toBeInTheDocument()
  );
  expect(screen.getByText(/Platform fee/i)).toBeInTheDocument();
  expect(screen.getByText(/Network fee/i)).toBeInTheDocument();
});

test('fee panel shows error fallback when API fails', async () => {
  api.get.mockRejectedValue(new Error('network'));
  renderSendMoney();
  const amountInput = screen.getByPlaceholderText('0.00');
  await userEvent.type(amountInput, '50');
  await act(async () => vi.advanceTimersByTime(300));
  await waitFor(() =>
    expect(
      screen.getByText(/Fee estimate unavailable/i)
    ).toBeInTheDocument()
  );
});
