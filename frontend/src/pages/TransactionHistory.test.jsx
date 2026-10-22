import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';

vi.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: vi.fn() },
}));

vi.mock('../utils/offlineDB', () => ({
  getCacheEntry: vi.fn().mockResolvedValue(null),
  setCacheEntry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => ({ isOnline: true, wasOffline: false }),
}));

import TransactionHistory from './TransactionHistory';
import api from '../utils/api';

vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useNavigate: () => vi.fn(),
}));

const emptyHistory = {
  transactions: [],
  total: 0,
  page: 1,
  limit: 20,
  pages: 0,
};

function renderComponent() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <TransactionHistory />
      </MemoryRouter>
    </I18nextProvider>
  );
}

describe('TransactionHistory', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
  });

  afterEach(() => vi.clearAllMocks());

  it('shows loading skeletons initially', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    renderComponent();
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('requests history with limit on mount', async () => {
    api.get.mockResolvedValue({ data: emptyHistory });
    renderComponent();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(api.get).toHaveBeenCalledWith('/payments/history', {
      params: { limit: 20 },
    });
  });

  it('renders transactions on success', async () => {
    api.get.mockResolvedValue({
      data: {
        transactions: [
          {
            id: '1',
            direction: 'sent',
            amount: '10',
            asset: 'XLM',
            recipient_wallet: 'GABCDEF1234567890',
            sender_wallet: 'GSENDER',
            status: 'completed',
            created_at: '2024-01-01T00:00:00Z',
            tx_hash: null,
            memo: null,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        pages: 1,
      },
    });
    renderComponent();
    await waitFor(() => expect(screen.getByText('sent')).toBeInTheDocument());
    expect(screen.queryByText('Failed to load transactions')).not.toBeInTheDocument();
  });

  it('shows error message when API call fails', async () => {
    api.get.mockRejectedValue(new Error('Network Error'));
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Failed to load transactions')).toBeInTheDocument()
    );
  });

  it('shows retry button on error', async () => {
    api.get.mockRejectedValue(new Error('Network Error'));
    renderComponent();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    );
  });

  it('retries the API call when retry button is clicked', async () => {
    api.get
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce({ data: emptyHistory });

    renderComponent();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() =>
      expect(screen.queryByText('Failed to load transactions')).not.toBeInTheDocument()
    );
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('shows empty state when no transactions', async () => {
    api.get.mockResolvedValue({ data: emptyHistory });
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('No transactions found')).toBeInTheDocument()
    );
  });

  it('refetches with from and to when date filters change', async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: emptyHistory });
    renderComponent();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    const fromInput = screen.getByLabelText('From date', { selector: 'input' });
    const toInput = screen.getByLabelText('To date', { selector: 'input' });
    await user.clear(fromInput);
    await user.type(fromInput, '2024-01-01');
    await user.clear(toInput);
    await user.type(toInput, '2024-01-31');

    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThanOrEqual(3));
    const last = api.get.mock.calls[api.get.mock.calls.length - 1];
    expect(last[0]).toBe('/payments/history');
    expect(last[1].params).toMatchObject({
      limit: 20,
      from: '2024-01-01',
      to: '2024-01-31',
    });
  });

  it('refetches with asset when asset filter changes', async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: emptyHistory });
    renderComponent();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText('Asset', { selector: 'select' }), 'USDC');

    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThanOrEqual(2));
    const last = api.get.mock.calls[api.get.mock.calls.length - 1];
    expect(last[1].params).toMatchObject({ limit: 20, asset: 'USDC' });
  });

  describe('Stellar Explorer link', () => {
    const TX_HASH = 'abc123def456';

    const txWithHash = {
      id: '10',
      direction: 'sent',
      amount: '5',
      asset: 'XLM',
      recipient_wallet: 'GAAA',
      sender_wallet: 'GBBB',
      status: 'completed',
      created_at: '2024-01-01T00:00:00Z',
      tx_hash: TX_HASH,
      memo: null,
    };

    const txWithoutHash = { ...txWithHash, id: '11', tx_hash: null };

    function mockWithTx(tx) {
      api.get.mockResolvedValue({
        data: { transactions: [tx], has_more: false, next_cursor: null },
      });
    }

    it('renders the explorer link when tx_hash is present', async () => {
      mockWithTx(txWithHash);
      renderComponent();
      const link = await screen.findByRole('link', { name: /view transaction on stellar explorer/i });
      expect(link).toBeInTheDocument();
    });

    it('builds the URL using REACT_APP_STELLAR_NETWORK', async () => {
      const network = process.env.REACT_APP_STELLAR_NETWORK || 'testnet';
      mockWithTx(txWithHash);
      renderComponent();
      const link = await screen.findByRole('link', { name: /view transaction on stellar explorer/i });
      expect(link).toHaveAttribute(
        'href',
        `https://stellar.expert/explorer/${network}/tx/${TX_HASH}`
      );
    });

    it('opens in a new tab with rel="noopener noreferrer"', async () => {
      mockWithTx(txWithHash);
      renderComponent();
      const link = await screen.findByRole('link', { name: /view transaction on stellar explorer/i });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('does not render the explorer link when tx_hash is null', async () => {
      mockWithTx(txWithoutHash);
      renderComponent();
      await waitFor(() => expect(screen.getByText('sent')).toBeInTheDocument());
      expect(
        screen.queryByRole('link', { name: /view transaction on stellar explorer/i })
      ).not.toBeInTheDocument();
    });

    it('does not render the explorer link when tx_hash is empty string', async () => {
      mockWithTx({ ...txWithHash, tx_hash: '' });
      renderComponent();
      await waitFor(() => expect(screen.getByText('sent')).toBeInTheDocument());
      expect(
        screen.queryByRole('link', { name: /view transaction on stellar explorer/i })
      ).not.toBeInTheDocument();
    });
  });

  it('filters loaded rows by search (memo / address / amount) client-side', async () => {
    api.get.mockResolvedValue({
      data: {
        transactions: [
          {
            id: '1',
            direction: 'sent',
            amount: '5',
            asset: 'XLM',
            recipient_wallet: 'GAAA',
            sender_wallet: 'GBBB',
            status: 'completed',
            created_at: '2024-01-01T00:00:00Z',
            tx_hash: null,
            memo: 'school fees',
          },
          {
            id: '2',
            direction: 'received',
            amount: '10',
            asset: 'XLM',
            recipient_wallet: 'GCCC',
            sender_wallet: 'GDDD',
            status: 'completed',
            created_at: '2024-01-02T00:00:00Z',
            tx_hash: null,
            memo: 'other',
          },
        ],
        total: 2,
        page: 1,
        limit: 20,
        pages: 1,
      },
    });
    renderComponent();
    await waitFor(() => expect(screen.getByText(/school fees/)).toBeInTheDocument());

    const searchInput = screen.getByRole('searchbox');
    await userEvent.type(searchInput, 'school');

    expect(screen.getByText(/school fees/)).toBeInTheDocument();
    expect(screen.queryByText(/^other$/)).not.toBeInTheDocument();
  });
});
