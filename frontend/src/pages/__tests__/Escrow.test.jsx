import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Escrow from '../Escrow';
import api from '../../services/api';
import { renderWithProviders } from '../../testUtils';

jest.mock('../../services/api');

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const baseEscrow = {
  id: 'esc-1',
  escrow_id: 'esc-1',
  amount: '100',
  asset: 'XLM',
  counterparty: 'GABC123',
  status: 'created',
  cancellable_at: null,
  payout_confirmed: false,
  expires_at: null,
};

function renderPage() {
  return renderWithProviders(
    <MemoryRouter>
      <Escrow />
    </MemoryRouter>
  );
}

describe('Escrow page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNavigate.mockReset();
  });

  describe('initial render', () => {
    it('shows a loading state while fetching escrows', async () => {
      let resolve;
      api.get.mockImplementation(
        () => new Promise((res) => { resolve = res; })
      );

      renderPage();

      expect(screen.getByText(/loading/i)).toBeInTheDocument();

      await act(async () => {
        resolve({ data: [] });
      });

      await waitFor(() => {
        expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
      });
    });

    it('shows an empty state when there are no escrows', async () => {
      api.get.mockResolvedValue({ data: [] });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no escrows/i)).toBeInTheDocument();
      });
    });

    it('shows an error state when the fetch fails', async () => {
      api.get.mockRejectedValue(new Error('boom'));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/failed to load/i)).toBeInTheDocument();
      });
    });
  });

  describe('happy path', () => {
    it('renders escrows returned by the API', async () => {
      api.get.mockResolvedValue({ data: [baseEscrow] });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/esc-1/)).toBeInTheDocument();
      });
      expect(screen.getByText(/100/)).toBeInTheDocument();
    });

    it('creates an escrow with step-up and idempotency headers, sending exactly one request', async () => {
      api.get.mockResolvedValue({ data: [] });
      api.post.mockResolvedValue({ data: { ...baseEscrow, id: 'esc-new' } });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no escrows/i)).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/counterparty/i), 'GABC123');
      await user.type(screen.getByLabelText(/amount/i), '100');
      await user.click(screen.getByRole('button', { name: /create escrow/i }));

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledTimes(1);
      });

      const [url, body, config] = api.post.mock.calls[0];
      expect(url).toMatch(/escrow/i);
      expect(body).toMatchObject({ counterparty: 'GABC123', amount: '100' });
      expect(config.headers).toMatchObject({
        'X-Step-Up-Token': expect.any(String),
        'Idempotency-Key': expect.any(String),
      });
    });
  });

  describe('validation', () => {
    it('shows validation errors and does not submit when fields are empty', async () => {
      api.get.mockResolvedValue({ data: [] });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no escrows/i)).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /create escrow/i }));

      await waitFor(() => {
        expect(screen.getByText(/counterparty is required/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/amount is required/i)).toBeInTheDocument();
      expect(api.post).not.toHaveBeenCalled();
    });
  });

  describe('API error handling', () => {
    it('shows an error message when creating an escrow fails', async () => {
      api.get.mockResolvedValue({ data: [] });
      api.post.mockRejectedValue({
        response: { data: { message: 'Insufficient balance' } },
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no escrows/i)).toBeInTheDocument();
      });

      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/counterparty/i), 'GABC123');
      await user.type(screen.getByLabelText(/amount/i), '100');
      await user.click(screen.getByRole('button', { name: /create escrow/i }));

      await waitFor(() => {
        expect(screen.getByText(/insufficient balance/i)).toBeInTheDocument();
      });
      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel hold period countdown', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('disables Cancel with a countdown before cancellable_at', async () => {
      const cancellableAt = new Date('2024-01-01T02:14:00Z').toISOString();
      api.get.mockResolvedValue({
        data: [{ ...baseEscrow, cancellable_at: cancellableAt }],
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/esc-1/)).toBeInTheDocument();
      });

      const cancelBtn = screen.getByRole('button', { name: /cancel/i });
      expect(cancelBtn).toBeDisabled();
      expect(screen.getByText(/cancellable in 2h 14m/i)).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(60 * 1000);
      });

      expect(screen.getByText(/cancellable in 2h 13m/i)).toBeInTheDocument();
    });

    it('enables Cancel once cancellable_at has passed', async () => {
      const cancellableAt = new Date('2024-01-01T00:00:00Z').toISOString();
      api.get.mockResolvedValue({
        data: [{ ...baseEscrow, cancellable_at: cancellableAt }],
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/esc-1/)).toBeInTheDocument();
      });

      const cancelBtn = screen.getByRole('button', { name: /cancel/i });
      expect(cancelBtn).not.toBeDisabled();
    });
  });

  describe('confirmed state', () => {
    it('shows confirmation state and a dispute link when payout_confirmed is true', async () => {
      api.get.mockResolvedValue({
        data: [{ ...baseEscrow, payout_confirmed: true, status: 'confirmed' }],
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/esc-1/)).toBeInTheDocument();
      });

      expect(
        screen.getByText(/agent confirmed payout/i)
      ).toBeInTheDocument();

      const disputeLink = screen.getByRole('link', { name: /dispute/i });
      expect(disputeLink).toHaveAttribute('href', expect.stringMatching(/dispute/i));

      const cancelBtn = screen.queryByRole('button', { name: /cancel/i });
      if (cancelBtn) {
        expect(cancelBtn).toBeDisabled();
      }
    });
  });

  describe('expired state', () => {
    it('shows an expired refund-available state for expired escrows', async () => {
      api.get.mockResolvedValue({
        data: [
          {
            ...baseEscrow,
            status: 'expired',
            expires_at: new Date('2023-12-01T00:00:00Z').toISOString(),
          },
        ],
      });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/esc-1/)).toBeInTheDocument();
      });

      expect(screen.getByText(/expired/i)).toBeInTheDocument();
      expect(screen.getByText(/refund available/i)).toBeInTheDocument();
    });
  });
});