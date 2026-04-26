import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { AuthContext } from '../context/AuthContext';
import Dashboard from './Dashboard';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock('react-hot-toast', () => ({ error: jest.fn() }));

import api from '../utils/api';
import { convertFromXLM } from '../utils/currency';

const mockUser = { full_name: 'Ada Obi' };

const walletResponse = {
  data: {
    public_key: 'GABC1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
    balances: [{ asset: 'XLM', balance: '100.0000000' }],
  },
};

const historyResponse = (txs = []) => ({ data: { transactions: txs } });

const sampleTxs = [
  {
    id: '1',
    direction: 'sent',
    recipient_wallet: 'GDEST1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345678',
    sender_wallet: null,
    amount: '10.00',
    asset: 'XLM',
    created_at: '2024-01-15T10:00:00Z',
  },
  {
    id: '2',
    direction: 'received',
    recipient_wallet: null,
    sender_wallet: 'GSEND1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345678',
    amount: '25.00',
    asset: 'XLM',
    created_at: '2024-01-14T09:00:00Z',
  },
];

function renderDashboard() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <AuthContext.Provider value={{ user: mockUser }}>
          <Dashboard />
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nextProvider>
  );
}

const COINGECKO_FIXTURE = {
  stellar: { usd: 0.11, ngn: 170, ghs: 1.35, kes: 14.5 },
};

describe('Dashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(COINGECKO_FIXTURE),
      })
    );
  });

  test('shows loading spinner while fetching', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    renderDashboard();
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  test('displays XLM balance after loading', async () => {
    api.get
      .mockResolvedValueOnce(walletResponse)
      .mockResolvedValueOnce(historyResponse());

    renderDashboard();

    await waitFor(() =>
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
    );

    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('XLM')).toBeInTheDocument();
  });

  test('shows "No transactions yet" when history is empty', async () => {
    api.get
      .mockResolvedValueOnce(walletResponse)
      .mockResolvedValueOnce(historyResponse());

    renderDashboard();

    await waitFor(() =>
      expect(
        screen.getByText('No transactions yet. Send your first payment!')
      ).toBeInTheDocument()
    );
  });

  test('renders recent transactions list', async () => {
    api.get
      .mockResolvedValueOnce(walletResponse)
      .mockResolvedValueOnce(historyResponse(sampleTxs));

    renderDashboard();

    await waitFor(() =>
      expect(screen.getByText('-10.00 XLM')).toBeInTheDocument()
    );

    expect(screen.getByText('+25.00 XLM')).toBeInTheDocument();
  });

  test.each(['NGN', 'USD', 'GHS', 'KES'])(
    'currency toggle converts XLM to %s',
    async (currencyCode) => {
      api.get
        .mockResolvedValueOnce(walletResponse)
        .mockResolvedValueOnce(historyResponse());

      renderDashboard();

      // Wait for the dashboard to finish loading (spinner gone)
      await waitFor(() =>
        expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
      );

      await userEvent.click(
        screen.getByRole('button', { name: new RegExp(currencyCode) })
      );

      const expected = parseFloat(
        convertFromXLM('100.0000000', currencyCode)
      ).toLocaleString();

      await waitFor(() =>
        expect(screen.getByText(expected)).toBeInTheDocument()
      );

      // The selected currency label should now appear in the balance display
      const balanceLabel = screen.getByText(currencyCode, {
        selector: 'span.text-primary-200',
      });
      expect(balanceLabel).toBeInTheDocument();
    }
  );
});
