import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import TransactionHistory from './TransactionHistory';
import api from '../utils/api';

jest.mock('../utils/api');
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
}));

const renderComponent = () =>
  render(
    <MemoryRouter>
      <TransactionHistory />
    </MemoryRouter>
  );

describe('TransactionHistory', () => {
  afterEach(() => jest.clearAllMocks());

  it('shows loading spinner initially', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    renderComponent();
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
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
            status: 'completed',
            created_at: '2024-01-01T00:00:00Z',
            tx_hash: null,
            memo: null,
          },
        ],
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
      .mockResolvedValueOnce({ data: { transactions: [] } });

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
    api.get.mockResolvedValue({ data: { transactions: [] } });
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('No transactions found')).toBeInTheDocument()
    );
  });
});
