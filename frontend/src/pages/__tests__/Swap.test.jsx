import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../services/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'test@example.com' },
    token: 'test-token',
    isAuthenticated: true,
  }),
}));

import api from '../../services/api';
import Swap from '../Swap';

const renderSwap = () => render(<Swap />);

describe('Swap page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    api.get.mockResolvedValue({ data: { balances: [] } });
    api.post.mockResolvedValue({ data: { success: true } });
  });

  describe('initial render', () => {
    it('renders the loading state initially', () => {
      api.get.mockReturnValue(new Promise(() => {}));
      renderSwap();
      expect(
        screen.getByText(/loading/i) || screen.getByRole('progressbar')
      ).toBeInTheDocument();
    });

    it('renders the empty state when there are no balances', async () => {
      api.get.mockResolvedValue({ data: { balances: [] } });
      renderSwap();
      await waitFor(() => {
        expect(
          screen.getByText(/no .*(balance|asset)/i) ||
            screen.getByText(/empty/i)
        ).toBeInTheDocument();
      });
    });

    it('renders the error state when the initial fetch fails', async () => {
      api.get.mockRejectedValue(new Error('Network error'));
      renderSwap();
      await waitFor(() => {
        expect(
          screen.getByText(/error|failed|something went wrong/i)
        ).toBeInTheDocument();
      });
    });

    it('renders the swap form on successful load', async () => {
      api.get.mockResolvedValue({
        data: {
          balances: [
            { asset: 'XLM', balance: '100' },
            { asset: 'USDC', balance: '50' },
          ],
        },
      });
      renderSwap();
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /swap/i })
        ).toBeInTheDocument();
      });
    });
  });

  describe('happy path', () => {
    it('submits a swap and sends exactly one request with step-up and idempotency headers', async () => {
      api.get.mockResolvedValue({
        data: {
          balances: [
            { asset: 'XLM', balance: '100' },
            { asset: 'USDC', balance: '50' },
          ],
        },
      });
      renderSwap();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /swap/i })).toBeInTheDocument();
      });

      const amountInput = screen.getByLabelText(/amount/i);
      fireEvent.change(amountInput, { target: { value: '10' } });

      const submitButton = screen.getByRole('button', { name: /swap/i });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledTimes(1);
      });

      const [url, body, config] = api.post.mock.calls[0];
      expect(url).toMatch(/swap/i);
      expect(body).toBeDefined();
      expect(config).toBeDefined();
      expect(config.headers).toBeDefined();
      expect(
        config.headers['X-Step-Up-Token'] ||
          config.headers['x-step-up-token'] ||
          config.headers['X-Step-Up']
      ).toBeDefined();
      expect(
        config.headers['Idempotency-Key'] ||
          config.headers['idempotency-key'] ||
          config.headers['X-Idempotency-Key']
      ).toBeDefined();
    });

    it('does not send more than one request on a single submit', async () => {
      api.get.mockResolvedValue({
        data: {
          balances: [
            { asset: 'XLM', balance: '100' },
            { asset: 'USDC', balance: '50' },
          ],
        },
      });
      renderSwap();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /swap/i })).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/amount/i), {
        target: { value: '5' },
      });
      fireEvent.click(screen.getByRole('button', { name: /swap/i }));

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledTimes(1);
      });

      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation errors', () => {
    it('shows a validation error when the amount is empty', async () => {
      api.get.mockResolvedValue({
        data: {
          balances: [
            { asset: 'XLM', balance: '100' },
            { asset: 'USDC', balance: '50' },
          ],
        },
      });
      renderSwap();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /swap/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /swap/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/amount.*required|enter.*amount|required/i)
        ).toBeInTheDocument();
      });
      expect(api.post).not.toHaveBeenCalled();
    });

    it('shows a validation error when the amount is not a valid number', async () => {
      api.get.mockResolvedValue({
        data: {
          balances: [
            { asset: 'XLM', balance: '100' },
            { asset: 'USDC', balance: '50' },
          ],
        },
      });
      renderSwap();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /swap/i })).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/amount/i), {
        target: { value: 'abc' },
      });
      fireEvent.click(screen.getByRole('button', { name: /swap/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/valid.*number|invalid.*amount|must be a number/i)
        ).toBeInTheDocument();
      });
      expect(api.post).not.toHaveBeenCalled();
    });
  });

  describe('API error handling', () => {
    it('displays an error message when the swap request fails', async () => {
      api.get.mockResolvedValue({
        data: {
          balances: [
            { asset: 'XLM', balance: '100' },
            { asset: 'USDC', balance: '50' },
          ],
        },
      });
      api.post.mockRejectedValue({
        response: { data: { message: 'Insufficient balance' } },
      });
      renderSwap();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /swap/i })).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/amount/i), {
        target: { value: '10' },
      });
      fireEvent.click(screen.getByRole('button', { name: /swap/i }));

      await waitFor(() => {
        expect(screen.getByText(/insufficient balance/i)).toBeInTheDocument();
      });
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    it('handles a generic API error gracefully', async () => {
      api.get.mockResolvedValue({
        data: {
          balances: [
            { asset: 'XLM', balance: '100' },
            { asset: 'USDC', balance: '50' },
          ],
        },
      });
      api.post.mockRejectedValue(new Error('Server error'));
      renderSwap();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /swap/i })).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText(/amount/i), {
        target: { value: '10' },
      });
      fireEvent.click(screen.getByRole('button', { name: /swap/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/error|failed|something went wrong/i)
        ).toBeInTheDocument();
      });
    });
  });
});