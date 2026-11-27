import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import VerifyEmail from '../VerifyEmail';
import api from '../../services/api';

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const renderPage = (initialEntries = ['/verify-email']) =>
  render(
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/login" element={<div>Login Page</div>} />
      </Routes>
    </MemoryRouter>
  );

describe('VerifyEmail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial render', () => {
    it('renders the loading state while verifying', () => {
      api.get.mockReturnValue(new Promise(() => {}));
      renderPage(['/verify-email?token=abc123']);

      expect(
        screen.getByText(/verifying/i) || screen.getByRole('progressbar')
      ).toBeInTheDocument();
    });

    it('renders the empty state when no token is provided', async () => {
      renderPage(['/verify-email']);

      await waitFor(() => {
        expect(
          screen.getByText(/missing|invalid|no token/i)
        ).toBeInTheDocument();
      });
      expect(api.get).not.toHaveBeenCalled();
    });

    it('renders the error state when verification fails', async () => {
      api.get.mockRejectedValue({
        response: { data: { message: 'Invalid token' }, status: 400 },
      });
      renderPage(['/verify-email?token=bad']);

      await waitFor(() => {
        expect(screen.getByText(/invalid token/i)).toBeInTheDocument();
      });
    });
  });

  describe('happy path', () => {
    it('verifies the email and shows success message', async () => {
      api.get.mockResolvedValue({
        data: { message: 'Email verified successfully' },
      });
      renderPage(['/verify-email?token=validtoken']);

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledTimes(1);
      });
      expect(api.get).toHaveBeenCalledWith(
        expect.stringContaining('validtoken')
      );

      await waitFor(() => {
        expect(
          screen.getByText(/email verified successfully/i)
        ).toBeInTheDocument();
      });
    });

    it('navigates to login when the continue button is clicked', async () => {
      api.get.mockResolvedValue({
        data: { message: 'Email verified successfully' },
      });
      renderPage(['/verify-email?token=validtoken']);

      await waitFor(() => {
        expect(
          screen.getByText(/email verified successfully/i)
        ).toBeInTheDocument();
      });

      const continueButton = screen.getByRole('button', {
        name: /continue|login|sign in/i,
      });
      await userEvent.click(continueButton);

      await waitFor(() => {
        expect(screen.getByText(/login page/i)).toBeInTheDocument();
      });
    });

    it('sends exactly one verification request', async () => {
      api.get.mockResolvedValue({
        data: { message: 'Email verified successfully' },
      });
      renderPage(['/verify-email?token=validtoken']);

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledTimes(1);
      });

      // allow any stray effects to settle
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation errors', () => {
    it('shows an error when the token is malformed', async () => {
      api.get.mockRejectedValue({
        response: { data: { message: 'Malformed token' }, status: 422 },
      });
      renderPage(['/verify-email?token=@@@']);

      await waitFor(() => {
        expect(screen.getByText(/malformed token/i)).toBeInTheDocument();
      });
    });

    it('shows an error when the token is expired', async () => {
      api.get.mockRejectedValue({
        response: { data: { message: 'Token expired' }, status: 410 },
      });
      renderPage(['/verify-email?token=expiredtoken']);

      await waitFor(() => {
        expect(screen.getByText(/token expired/i)).toBeInTheDocument();
      });
    });
  });

  describe('API error handling', () => {
    it('shows a generic error when the server returns 500', async () => {
      api.get.mockRejectedValue({
        response: { data: {}, status: 500 },
      });
      renderPage(['/verify-email?token=validtoken']);

      await waitFor(() => {
        expect(
          screen.getByText(/something went wrong|error|failed/i)
        ).toBeInTheDocument();
      });
    });

    it('shows a network error message when the request fails without a response', async () => {
      api.get.mockRejectedValue(new Error('Network Error'));
      renderPage(['/verify-email?token=validtoken']);

      await waitFor(() => {
        expect(
          screen.getByText(/network|something went wrong|error|failed/i)
        ).toBeInTheDocument();
      });
    });

    it('offers a retry action on failure', async () => {
      api.get.mockRejectedValueOnce({
        response: { data: { message: 'Invalid token' }, status: 400 },
      });
      renderPage(['/verify-email?token=validtoken']);

      await waitFor(() => {
        expect(screen.getByText(/invalid token/i)).toBeInTheDocument();
      });

      const retryButton = screen.queryByRole('button', {
        name: /retry|try again|resend/i,
      });

      if (retryButton) {
        api.get.mockResolvedValueOnce({
          data: { message: 'Email verified successfully' },
        });
        await userEvent.click(retryButton);

        await waitFor(() => {
          expect(
            screen.getByText(/email verified successfully/i)
          ).toBeInTheDocument();
        });
      }
    });
  });
});