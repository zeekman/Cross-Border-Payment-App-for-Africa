import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TransactionDetail from '../TransactionDetail';
import api from '../../utils/api';

jest.mock('../../utils/api');
jest.mock('../../context/CurrencyContext', () => ({ useCurrency: () => ({ displayCurrency: 'NGN' }) }));

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/history/:id" element={<TransactionDetail />} />
    </Routes>
  </MemoryRouter>,
);

describe('TransactionDetail (FE-205)', () => {
  test('renders a transaction the user is party to', async () => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/payments/')) {
        return Promise.resolve({ data: {
          id: 'tx-1', direction: 'sent', amount: '100', asset: 'XLM', status: 'completed',
          recipient_wallet: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV', sender_wallet: 'GME',
          created_at: '2026-01-01T00:00:00Z', tx_hash: 'abc123', memo: 'rent',
          fx_snapshot: { rates: { NGN: 176 }, source: 'coingecko', at: '2026-01-01T00:00:00Z' },
        } });
      }
      return Promise.resolve({ data: { contacts: [] } });
    });
    renderAt('/history/tx-1');
    expect(await screen.findByText('-100 XLM')).toBeInTheDocument();
    expect(screen.getByText(/17,600\.00 at time of transfer/)).toBeInTheDocument();
    expect(screen.getByText('rent')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/payments/tx-1');
  });

  test('shows not found when the API returns 404', async () => {
    api.get.mockRejectedValue({ response: { status: 404 } });
    renderAt('/history/other');
    expect(await screen.findByText('Transaction not found')).toBeInTheDocument();
  });
});
