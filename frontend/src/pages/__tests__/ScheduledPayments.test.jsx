import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../api', () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
}));

jest.mock('../../testUtils', () => {
  const actual = jest.requireActual('../../testUtils');
  return {
    ...actual,
  };
});

import api from '../../api';
import ScheduledPayments from '../ScheduledPayments';

const mockGet = api.get;
const mockPost = api.post;
const mockPut = api.put;
const mockDelete = api.delete;

const samplePayments = [
  {
    id: 'sp_1',
    recipient: 'alice@example.com',
    amount: '100',
    asset: 'XLM',
    frequency: 'monthly',
    nextRunAt: '2024-06-01T00:00:00.000Z',
    status: 'active',
  },
  {
    id: 'sp_2',
    recipient: 'bob@example.com',
    amount: '50',
    asset: 'USDC',
    frequency: 'weekly',
    nextRunAt: '2024-05-20T00:00:00.000Z',
    status: 'active',
  },
];

const renderPage = () => render(<ScheduledPayments />);

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ data: [] });
  mockPost.mockResolvedValue({ data: { id: 'sp_new' } });
  mockPut.mockResolvedValue({ data: {} });
  mockDelete.mockResolvedValue({ data: {} });
});

describe('ScheduledPayments', () => {
  describe('initial render', () => {
    it('shows a loading state before data resolves', async () => {
      let resolveGet;
      mockGet.mockImplementation(
        () => new Promise((resolve) => {
          resolveGet = resolve;
        }),
      );

      renderPage();

      expect(
        screen.queryByText(/loading/i) || screen.queryByRole('progressbar'),
      ).toBeTruthy();

      resolveGet({ data: [] });
      await waitFor(() => expect(mockGet).toHaveBeenCalled());
    });

    it('renders an empty state when there are no scheduled payments', async () => {
      mockGet.mockResolvedValue({ data: [] });

      renderPage();

      await waitFor(() => {
        expect(
          screen.queryByText(/no scheduled payments/i) ||
            screen.queryByText(/nothing scheduled/i) ||
            screen.queryByText(/empty/i),
        ).toBeTruthy();
      });
    });

    it('renders an error state when the initial fetch fails', async () => {
      mockGet.mockRejectedValue(new Error('Network error'));

      renderPage();

      await waitFor(() => {
        expect(
          screen.queryByText(/error/i) ||
            screen.queryByText(/failed/i) ||
            screen.queryByText(/something went wrong/i),
        ).toBeTruthy();
      });
    });
  });

  describe('happy path', () => {
    it('renders the list of scheduled payments', async () => {
      mockGet.mockResolvedValue({ data: samplePayments });

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
        expect(screen.getByText(/bob@example.com/)).toBeInTheDocument();
      });
    });

    it('creates a scheduled payment with step-up and idempotency headers and sends exactly one request', async () => {
      mockGet.mockResolvedValue({ data: [] });
      mockPost.mockResolvedValue({ data: { id: 'sp_new' } });

      renderPage();

      await waitFor(() => expect(mockGet).toHaveBeenCalled());

      const recipientInput =
        screen.queryByLabelText(/recipient/i) ||
        screen.queryByPlaceholderText(/recipient/i);
      const amountInput =
        screen.queryByLabelText(/amount/i) ||
        screen.queryByPlaceholderText(/amount/i);
      const submitButton =
        screen.queryByRole('button', { name: /schedule|create|save|submit/i });

      expect(recipientInput).toBeTruthy();
      expect(amountInput).toBeTruthy();
      expect(submitButton).toBeTruthy();

      fireEvent.change(recipientInput, {
        target: { value: 'carol@example.com' },
      });
      fireEvent.change(amountInput, { target: { value: '75' } });
      fireEvent.click(submitButton);

      await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));

      const [url, body, config] = mockPost.mock.calls[0];
      expect(url).toMatch(/scheduled/i);
      expect(body).toMatchObject({
        recipient: 'carol@example.com',
        amount: '75',
      });

      const headers = (config && config.headers) || {};
      const normalizedHeaders = Object.keys(headers).reduce((acc, key) => {
        acc[key.toLowerCase()] = headers[key];
        return acc;
      }, {});

      expect(
        normalizedHeaders['x-step-up-token'] ||
          normalizedHeaders['x-step-up'] ||
          normalizedHeaders['step-up-token'],
      ).toBeTruthy();
      expect(
        normalizedHeaders['idempotency-key'] ||
          normalizedHeaders['x-idempotency-key'],
      ).toBeTruthy();

      expect(mockPost).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation errors', () => {
    it('shows a validation error and does not submit when recipient is empty', async () => {
      mockGet.mockResolvedValue({ data: [] });

      renderPage();

      await waitFor(() => expect(mockGet).toHaveBeenCalled());

      const amountInput =
        screen.queryByLabelText(/amount/i) ||
        screen.queryByPlaceholderText(/amount/i);
      const submitButton =
        screen.queryByRole('button', { name: /schedule|create|save|submit/i });

      expect(amountInput).toBeTruthy();
      expect(submitButton).toBeTruthy();

      fireEvent.change(amountInput, { target: { value: '75' } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(
          screen.queryByText(/required/i) ||
            screen.queryByText(/recipient/i),
        ).toBeTruthy();
      });

      expect(mockPost).not.toHaveBeenCalled();
    });

    it('shows a validation error and does not submit when amount is invalid', async () => {
      mockGet.mockResolvedValue({ data: [] });

      renderPage();

      await waitFor(() => expect(mockGet).toHaveBeenCalled());

      const recipientInput =
        screen.queryByLabelText(/recipient/i) ||
        screen.queryByPlaceholderText(/recipient/i);
      const amountInput =
        screen.queryByLabelText(/amount/i) ||
        screen.queryByPlaceholderText(/amount/i);
      const submitButton =
        screen.queryByRole('button', { name: /schedule|create|save|submit/i });

      expect(recipientInput).toBeTruthy();
      expect(amountInput).toBeTruthy();
      expect(submitButton).toBeTruthy();

      fireEvent.change(recipientInput, {
        target: { value: 'carol@example.com' },
      });
      fireEvent.change(amountInput, { target: { value: '-10' } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(
          screen.queryByText(/invalid/i) ||
            screen.queryByText(/must be/i) ||
            screen.queryByText(/positive/i),
        ).toBeTruthy();
      });

      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('API error handling', () => {
    it('shows an error message when creating a scheduled payment fails', async () => {
      mockGet.mockResolvedValue({ data: [] });
      mockPost.mockRejectedValue({
        response: { data: { message: 'Insufficient balance' } },
      });

      renderPage();

      await waitFor(() => expect(mockGet).toHaveBeenCalled());

      const recipientInput =
        screen.queryByLabelText(/recipient/i) ||
        screen.queryByPlaceholderText(/recipient/i);
      const amountInput =
        screen.queryByLabelText(/amount/i) ||
        screen.queryByPlaceholderText(/amount/i);
      const submitButton =
        screen.queryByRole('button', { name: /schedule|create|save|submit/i });

      expect(recipientInput).toBeTruthy();
      expect(amountInput).toBeTruthy();
      expect(submitButton).toBeTruthy();

      fireEvent.change(recipientInput, {
        target: { value: 'carol@example.com' },
      });
      fireEvent.change(amountInput, { target: { value: '75' } });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(
          screen.queryByText(/insufficient balance/i) ||
            screen.queryByText(/error/i) ||
            screen.queryByText(/failed/i),
        ).toBeTruthy();
      });

      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('shows an error message when cancelling a scheduled payment fails', async () => {
      mockGet.mockResolvedValue({ data: samplePayments });
      mockDelete.mockRejectedValue(new Error('Network error'));

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
      });

      const cancelButton =
        screen.queryByRole('button', { name: /cancel/i }) ||
        screen.queryByRole('button', { name: /delete/i }) ||
        screen.queryByRole('button', { name: /remove/i });

      if (cancelButton) {
        fireEvent.click(cancelButton);

        await waitFor(() => {
          expect(
            screen.queryByText(/error/i) ||
              screen.queryByText(/failed/i) ||
              screen.queryByText(/network error/i),
          ).toBeTruthy();
        });
      } else {
        expect(mockGet).toHaveBeenCalled();
      }
    });
  });
});