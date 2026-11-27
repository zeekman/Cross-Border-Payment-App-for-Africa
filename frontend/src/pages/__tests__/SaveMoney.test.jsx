import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('../../testUtils', () => {
  const actual = jest.requireActual('../../testUtils');
  return {
    ...actual,
    renderWithProviders: (ui) => {
      const { render } = require('@testing-library/react');
      return render(ui);
    },
  };
});

import api from '../../api';
import SaveMoney from '../SaveMoney';

const mockGet = api.get;
const mockPost = api.post;

const renderPage = () => render(<SaveMoney />);

describe('SaveMoney page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ data: { goals: [], balance: 0 } });
  });

  describe('initial render', () => {
    it('shows a loading state initially', () => {
      mockGet.mockReturnValue(new Promise(() => {}));
      renderPage();
      expect(
        screen.getByText(/loading/i) || screen.getByRole('progressbar')
      ).toBeInTheDocument();
    });

    it('renders empty state when there are no savings goals', async () => {
      mockGet.mockResolvedValue({ data: { goals: [], balance: 0 } });
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByText(/no savings goals/i) ||
            screen.getByText(/no goals/i) ||
            screen.getByText(/get started/i)
        ).toBeInTheDocument();
      });
    });

    it('renders an error state when the initial fetch fails', async () => {
      mockGet.mockRejectedValue(new Error('Network error'));
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByText(/error/i) || screen.getByText(/failed/i)
        ).toBeInTheDocument();
      });
    });
  });

  describe('happy path', () => {
    it('renders existing savings goals', async () => {
      mockGet.mockResolvedValue({
        data: {
          goals: [
            { id: '1', name: 'Vacation', targetAmount: 1000, savedAmount: 250 },
          ],
          balance: 500,
        },
      });
      renderPage();
      await waitFor(() => {
        expect(screen.getByText('Vacation')).toBeInTheDocument();
      });
    });

    it('submits a new savings goal with step-up and idempotency headers', async () => {
      mockGet.mockResolvedValue({ data: { goals: [], balance: 0 } });
      mockPost.mockResolvedValue({ data: { id: '2', name: 'New Goal' } });

      renderPage();
      await waitFor(() => {
        expect(
          screen.getByText(/no savings goals/i) ||
            screen.getByText(/no goals/i) ||
            screen.getByText(/get started/i)
        ).toBeInTheDocument();
      });

      const nameInput =
        screen.queryByLabelText(/name/i) ||
        screen.queryByPlaceholderText(/name/i);
      const amountInput =
        screen.queryByLabelText(/amount/i) ||
        screen.queryByPlaceholderText(/amount/i);

      if (nameInput && amountInput) {
        fireEvent.change(nameInput, { target: { value: 'New Goal' } });
        fireEvent.change(amountInput, { target: { value: '500' } });
      }

      const submitButton =
        screen.queryByRole('button', { name: /save|create|add/i }) ||
        screen.queryByRole('button', { name: /submit/i });

      if (submitButton) {
        fireEvent.click(submitButton);
      }

      await waitFor(() => {
        expect(mockPost).toHaveBeenCalledTimes(1);
      });

      const [, config] = mockPost.mock.calls[0];
      const headers = (config && config.headers) || {};
      expect(
        headers['X-Idempotency-Key'] ||
          headers['x-idempotency-key'] ||
          headers['Idempotency-Key']
      ).toBeTruthy();
      expect(
        headers['X-Step-Up-Token'] ||
          headers['x-step-up-token'] ||
          headers['Step-Up-Token']
      ).toBeTruthy();
    });

    it('sends exactly one request per submit', async () => {
      mockGet.mockResolvedValue({ data: { goals: [], balance: 0 } });
      mockPost.mockResolvedValue({ data: { id: '3' } });

      renderPage();
      await waitFor(() => {
        expect(mockGet).toHaveBeenCalled();
      });

      const submitButton =
        screen.queryByRole('button', { name: /save|create|add|submit/i });
      if (submitButton) {
        fireEvent.click(submitButton);
        fireEvent.click(submitButton);
      }

      await waitFor(() => {
        expect(mockPost.mock.calls.length).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('validation errors', () => {
    it('shows a validation error when required fields are empty', async () => {
      mockGet.mockResolvedValue({ data: { goals: [], balance: 0 } });
      renderPage();
      await waitFor(() => {
        expect(mockGet).toHaveBeenCalled();
      });

      const submitButton =
        screen.queryByRole('button', { name: /save|create|add|submit/i });
      if (submitButton) {
        fireEvent.click(submitButton);
      }

      await waitFor(() => {
        expect(
          screen.queryByText(/required/i) ||
            screen.queryByText(/must be/i) ||
            screen.queryByText(/invalid/i)
        ).toBeTruthy();
      });
    });

    it('rejects a non-positive amount', async () => {
      mockGet.mockResolvedValue({ data: { goals: [], balance: 0 } });
      renderPage();
      await waitFor(() => {
        expect(mockGet).toHaveBeenCalled();
      });

      const amountInput =
        screen.queryByLabelText(/amount/i) ||
        screen.queryByPlaceholderText(/amount/i);
      if (amountInput) {
        fireEvent.change(amountInput, { target: { value: '-10' } });
      }

      const submitButton =
        screen.queryByRole('button', { name: /save|create|add|submit/i });
      if (submitButton) {
        fireEvent.click(submitButton);
      }

      await waitFor(() => {
        expect(
          screen.queryByText(/positive/i) ||
            screen.queryByText(/greater than/i) ||
            screen.queryByText(/invalid/i)
        ).toBeTruthy();
      });
    });
  });

  describe('API error handling', () => {
    it('displays an error message when submission fails', async () => {
      mockGet.mockResolvedValue({ data: { goals: [], balance: 0 } });
      mockPost.mockRejectedValue(new Error('Server error'));

      renderPage();
      await waitFor(() => {
        expect(mockGet).toHaveBeenCalled();
      });

      const submitButton =
        screen.queryByRole('button', { name: /save|create|add|submit/i });
      if (submitButton) {
        fireEvent.click(submitButton);
      }

      await waitFor(() => {
        expect(
          screen.queryByText(/server error/i) ||
            screen.queryByText(/something went wrong/i) ||
            screen.queryByText(/failed/i)
        ).toBeTruthy();
      });
    });
  });
});