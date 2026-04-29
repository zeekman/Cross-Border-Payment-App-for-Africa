import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import BatchPayment from './BatchPayment';
import api from '../utils/api';

jest.mock('../utils/api');
jest.mock('react-hot-toast', () => ({ success: jest.fn(), error: jest.fn() }));

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <BatchPayment />
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  api.post.mockResolvedValue({
    data: {
      message: 'Batch payment submitted successfully',
      summary: { total: 2, submitted: 2, successful: 2, failed: 0 },
      transaction: { tx_hash: 'hash123', ledger: 99 },
      results: [
        { index: 0, recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', amount: 10, status: 'success' },
        { index: 1, recipient_address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHO7', amount: 15, status: 'success' },
      ],
    },
  });
});

test('imports recipients from CSV and submits the batch payload', async () => {
  renderPage();

  const csvFile = new File(
    [
      'recipient_address,amount\n' +
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF,10\n' +
      'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHO7,15\n'
    ],
    'recipients.csv',
    { type: 'text/csv' }
  );

  await userEvent.upload(screen.getByLabelText(/import csv/i), csvFile);

  await waitFor(() => {
    expect(screen.getByDisplayValue('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBeInTheDocument();
    expect(screen.getByDisplayValue('GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHO7')).toBeInTheDocument();
  });

  await userEvent.click(screen.getByRole('button', { name: /submit batch/i }));

  await waitFor(() => {
    expect(api.post).toHaveBeenCalledWith('/payments/batch', {
      asset: 'XLM',
      recipients: [
        {
          recipient_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          amount: 10,
        },
        {
          recipient_address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHO7',
          amount: 15,
        },
      ],
    });
  });

  expect(await screen.findByText(/batch results/i)).toBeInTheDocument();
});
