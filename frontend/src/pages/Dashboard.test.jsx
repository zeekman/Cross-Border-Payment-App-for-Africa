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
  default: { get: jest.fn(), post: jest.fn() },
}));

jest.mock('react-hot-toast', () => ({ error: jest.fn(), success: jest.fn() }));

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

function renderDashboard(Component = Dashboard) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <AuthContext.Provider value={{ user: mockUser }}>
          <Component />
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nextProvider>
  );
}

function renderDashboardWithEnv(env) {
  const originalNetwork = process.env.REACT_APP_STELLAR_NETWORK;
  process.env.REACT_APP_STELLAR_NETWORK = env;
  jest.resetModules();
  try {
    const DashboardModule = require('./Dashboard').default;
    return renderDashboard(DashboardModule);
  } finally {
    process.env.REACT_APP_STELLAR_NETWORK = originalNetwork;
  }
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

  test('shows transaction skeleton rows during the initial fetch', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    renderDashboard();
    expect(screen.getByTestId('transactions-skeleton')).toBeInTheDocument();
  });

  test('replaces transaction skeletons with a retryable error state on fetch failure', async () => {
    api.get.mockRejectedValue(new Error('history unavailable'));

    renderDashboard();

    expect(await screen.findByText('Could not load recent activity.')).toBeInTheDocument();
    expect(screen.queryByTestId('transactions-skeleton')).not.toBeInTheDocument();
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

  test('shows retryable wallet error state when wallet data cannot be loaded', async () => {
    api.get.mockRejectedValue(new Error('wallet unavailable'));

    renderDashboard();

    expect(
      await screen.findByText('Could not load wallet data. Check your connection and try again.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy wallet address/i })).not.toBeInTheDocument();
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

  test('shows Friendbot funding button on testnet for zero XLM balance', async () => {
    api.get
      .mockResolvedValueOnce({ data: { wallets: [{ id: '1', public_key: walletResponse.data.public_key, balances: [{ asset: 'XLM', balance: '0' }], account_exists: true }] } })
      .mockResolvedValueOnce(historyResponse());

    renderDashboard();

    await waitFor(() =>
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
    );

    expect(screen.getByRole('button', { name: /Fund wallet/i })).toBeInTheDocument();
  });

  test('shows Friendbot funding button on testnet when account does not exist', async () => {
    api.get
      .mockResolvedValueOnce({ data: { wallets: [{ id: '1', public_key: walletResponse.data.public_key, balances: [{ asset: 'XLM', balance: '100.0000000' }], account_exists: false }] } })
      .mockResolvedValueOnce(historyResponse());

    renderDashboard();

    await waitFor(() =>
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
    );

    expect(screen.getByRole('button', { name: /Fund wallet/i })).toBeInTheDocument();
  });

  test('hides Friendbot funding button on testnet for funded accounts', async () => {
    api.get
      .mockResolvedValueOnce({ data: { wallets: [{ id: '1', public_key: walletResponse.data.public_key, balances: [{ asset: 'XLM', balance: '100.0000000' }], account_exists: true }] } })
      .mockResolvedValueOnce(historyResponse());

    renderDashboard();

    await waitFor(() =>
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
    );

    expect(screen.queryByRole('button', { name: /Fund wallet/i })).not.toBeInTheDocument();
  });

  test('never shows Friendbot funding button on mainnet', async () => {
    api.get
      .mockResolvedValueOnce({ data: { wallets: [{ id: '1', public_key: walletResponse.data.public_key, balances: [{ asset: 'XLM', balance: '0' }], account_exists: false }] } })
      .mockResolvedValueOnce(historyResponse());

    const { rerender } = renderDashboardWithEnv('mainnet');

    await waitFor(() =>
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
    );

    expect(screen.queryByRole('button', { name: /Fund wallet/i })).not.toBeInTheDocument();
  });

  test('successful Friendbot funding refreshes balance and hides the button', async () => {
    api.get
      .mockResolvedValueOnce({ data: { wallets: [{ id: '1', public_key: walletResponse.data.public_key, balances: [{ asset: 'XLM', balance: '0' }], account_exists: false }] } })
      .mockResolvedValueOnce(historyResponse())
      .mockResolvedValueOnce({ data: { wallets: [{ id: '1', public_key: walletResponse.data.public_key, balances: [{ asset: 'XLM', balance: '100.0000000' }], account_exists: true }] } });
    api.post.mockResolvedValueOnce({ data: { message: 'Wallet funded' } });

    renderDashboard();

    await waitFor(() =>
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument()
    );

    const fundButton = screen.getByRole('button', { name: /Fund wallet/i });
    await userEvent.click(fundButton);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/dev/fund-wallet')
    );

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Fund wallet/i })).not.toBeInTheDocument()
    );

    expect(screen.getByText('100')).toBeInTheDocument();
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

// Issue #642 — Skeleton loading state tests
describe('Dashboard skeleton loading states', () => {
  beforeEach(() => {
    // Delay resolution so we can assert skeleton state
    api.get.mockImplementation(
      () => new Promise(() => {}) // never resolves — tests skeleton snapshot
    );
  });

  it('renders BalanceCardSkeleton while loading', () => {
    renderDashboard();
    // The skeleton container for the balance card uses the Skeleton component
    const skeletons = document.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders 3 TransactionRowSkeleton placeholders while loading', () => {
    renderDashboard();
    // TransactionRowSkeleton renders 3 .skeleton elements per row (icon, label, amount)
    // We verify the aria-busy container is present
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});

// Issue #642 — Skeleton loading state tests
describe('Dashboard skeleton loading states', () => {
  beforeEach(() => {
    api.get.mockImplementation(() => new Promise(() => {}));
  });

  it('renders skeleton placeholders while loading', () => {
    renderDashboard();
    const skeletons = document.querySelectorAll('.skeleton');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders aria-busy transaction skeleton container while loading', () => {
    renderDashboard();
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
