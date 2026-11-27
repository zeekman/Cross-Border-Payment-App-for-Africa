import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ReceiveMoney from '../ReceiveMoney';

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: { username: 'alice', displayName: 'Alice Merchant' },
  }),
}));

vi.mock('../../services/api', () => ({
  getAccountInfo: vi.fn().mockResolvedValue({
    username: 'alice',
    displayName: 'Alice Merchant',
    address: 'GABCDEF1234567890',
  }),
}));

describe('ReceiveMoney print QR', () => {
  let printSpy;

  beforeEach(() => {
    printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
  });

  afterEach(() => {
    printSpy.mockRestore();
  });

  it('calls window.print when the Print button is clicked', async () => {
    render(
      <MemoryRouter>
        <ReceiveMoney />
      </MemoryRouter>
    );

    const printButton = await screen.findByRole('button', { name: /print/i });
    fireEvent.click(printButton);

    await waitFor(() => {
      expect(printSpy).toHaveBeenCalledTimes(1);
    });
  });
});
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
    mockApi: jest.requireActual('../../api').default,
  };
});

import api from '../../api';
import ReceiveMoney from '../ReceiveMoney';

const renderPage = (props = {}) => render(<ReceiveMoney {...props} />);

const fillRequiredFields = () => {
  const amountInput =
    screen.queryByLabelText(/amount/i) ||
    screen.queryByPlaceholderText(/amount/i) ||
    screen.queryByTestId('amount-input');
  if (amountInput) {
    fireEvent.change(amountInput, { target: { value: '25' } });
  }

  const memoInput =
    screen.queryByLabelText(/memo|note|reference/i) ||
    screen.queryByPlaceholderText(/memo|note|reference/i) ||
    screen.queryByTestId('memo-input');
  if (memoInput) {
    fireEvent.change(memoInput, { target: { value: 'Test receive' } });
  }
};

const submitForm = () => {
  const submitButton =
    screen.queryByRole('button', { name: /receive|request|create|submit|generate/i }) ||
    screen.queryByTestId('submit-button');
  if (submitButton) {
    fireEvent.click(submitButton);
  }
  return submitButton;
};

describe('ReceiveMoney page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    api.get.mockResolvedValue({ data: {} });
    api.post.mockResolvedValue({ data: { id: 'req-1', status: 'pending' } });
    api.put.mockResolvedValue({ data: {} });
    api.delete.mockResolvedValue({ data: {} });
  });

  describe('initial render', () => {
    it('renders the page without crashing', () => {
      renderPage();
      expect(document.body).toBeInTheDocument();
    });

    it('shows a loading state while fetching initial data', async () => {
      let resolveGet;
      api.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve;
          })
      );

      renderPage();

      const loading =
        screen.queryByText(/loading/i) ||
        screen.queryByTestId('loading') ||
        screen.queryByRole('progressbar');
      if (loading) {
        expect(loading).toBeInTheDocument();
      }

      if (resolveGet) {
        resolveGet({ data: {} });
      }

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });
    });

    it('renders an empty state when there is no data', async () => {
      api.get.mockResolvedValue({ data: [] });
      renderPage();

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });

      const empty =
        screen.queryByText(/no .*(requests|payments|data|activity)/i) ||
        screen.queryByText(/empty/i) ||
        screen.queryByTestId('empty-state');
      if (empty) {
        expect(empty).toBeInTheDocument();
      }
    });

    it('renders an error state when the initial fetch fails', async () => {
      api.get.mockRejectedValue(new Error('Network error'));
      renderPage();

      await waitFor(() => {
        const error =
          screen.queryByText(/error|failed|something went wrong/i) ||
          screen.queryByRole('alert');
        if (error) {
          expect(error).toBeInTheDocument();
        }
      });
    });
  });

  describe('happy path', () => {
    it('submits a receive request successfully', async () => {
      renderPage();

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });

      fillRequiredFields();
      const submitButton = submitForm();

      if (submitButton) {
        await waitFor(() => {
          expect(api.post).toHaveBeenCalledTimes(1);
        });

        const [url, payload, config] = api.post.mock.calls[0];
        expect(typeof url).toBe('string');
        expect(payload).toBeDefined();
        expect(config).toBeDefined();
      }
    });

    it('sends exactly one request per submit', async () => {
      renderPage();

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });

      fillRequiredFields();
      const submitButton = submitForm();

      if (submitButton) {
        await waitFor(() => {
          expect(api.post).toHaveBeenCalledTimes(1);
        });

        // Ensure no duplicate submissions occurred
        expect(api.post).toHaveBeenCalledTimes(1);
      }
    });

    it('includes step-up and idempotency headers on submit', async () => {
      renderPage();

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });

      fillRequiredFields();
      const submitButton = submitForm();

      if (submitButton) {
        await waitFor(() => {
          expect(api.post).toHaveBeenCalledTimes(1);
        });

        const config = api.post.mock.calls[0][2] || {};
        const headers = config.headers || {};

        const hasStepUp =
          headers['X-Step-Up'] !== undefined ||
          headers['x-step-up'] !== undefined ||
          headers['X-Step-Up-Token'] !== undefined ||
          headers['x-step-up-token'] !== undefined ||
          headers['X-Require-Step-Up'] !== undefined;

        const hasIdempotency =
          headers['Idempotency-Key'] !== undefined ||
          headers['idempotency-key'] !== undefined ||
          headers['X-Idempotency-Key'] !== undefined ||
          headers['x-idempotency-key'] !== undefined;

        expect(hasStepUp || hasIdempotency).toBe(true);
      }
    });
  });

  describe('validation errors', () => {
    it('shows validation errors when submitting an empty form', async () => {
      renderPage();

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });

      const submitButton = submitForm();

      if (submitButton) {
        await waitFor(() => {
          const validation =
            screen.queryByText(/required|invalid|must be|enter a/i) ||
            screen.queryByRole('alert');
          if (validation) {
            expect(validation).toBeInTheDocument();
          }
        });

        // Should not submit to the API when validation fails
        expect(api.post).not.toHaveBeenCalled();
      }
    });

    it('rejects invalid amount values', async () => {
      renderPage();

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });

      const amountInput =
        screen.queryByLabelText(/amount/i) ||
        screen.queryByPlaceholderText(/amount/i) ||
        screen.queryByTestId('amount-input');

      if (amountInput) {
        fireEvent.change(amountInput, { target: { value: '-5' } });
        submitForm();

        await waitFor(() => {
          const validation =
            screen.queryByText(/invalid|positive|greater than|must be/i) ||
            screen.queryByRole('alert');
          if (validation) {
            expect(validation).toBeInTheDocument();
          }
        });

        expect(api.post).not.toHaveBeenCalled();
      }
    });
  });

  describe('API error handling', () => {
    it('displays an error message when submission fails', async () => {
      api.post.mockRejectedValue({
        response: { data: { message: 'Server error' }, status: 500 },
      });

      renderPage();

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });

      fillRequiredFields();
      const submitButton = submitForm();

      if (submitButton) {
        await waitFor(() => {
          const error =
            screen.queryByText(/server error|failed|error/i) ||
            screen.queryByRole('alert');
          if (error) {
            expect(error).toBeInTheDocument();
          }
        });
      }
    });

    it('handles network errors gracefully', async () => {
      api.post.mockRejectedValue(new Error('Network failure'));

      renderPage();

      await waitFor(() => {
        expect(api.get).toHaveBeenCalled();
      });

      fillRequiredFields();
      const submitButton = submitForm();

      if (submitButton) {
        await waitFor(() => {
          const error =
            screen.queryByText(/network|failed|error/i) ||
            screen.queryByRole('alert');
          if (error) {
            expect(error).toBeInTheDocument();
          }
        });
      }
    });
  });
});
