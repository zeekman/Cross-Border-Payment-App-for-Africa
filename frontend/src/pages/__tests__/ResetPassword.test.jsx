import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../api', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: jest.fn(),
  useNavigate: jest.fn(),
  useSearchParams: jest.fn(),
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

import api from '../../api';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import ResetPassword from '../ResetPassword';

const mockNavigate = jest.fn();

const setParams = (params) => {
  useParams.mockReturnValue(params);
};

const setSearchParams = (searchParams) => {
  useSearchParams.mockReturnValue([new URLSearchParams(searchParams)]);
};

const fillForm = ({ password = 'NewPass123!', confirm = 'NewPass123!' } = {}) => {
  const passwordInputs = screen.getAllByLabelText(/password/i);
  const newPasswordInput =
    passwordInputs.find((el) => /new/i.test(el.getAttribute('name') || el.id || '')) ||
    passwordInputs[0];
  const confirmInput =
    passwordInputs.find((el) => /confirm/i.test(el.getAttribute('name') || el.id || '')) ||
    passwordInputs[passwordInputs.length - 1];

  fireEvent.change(newPasswordInput, { target: { value: password } });
  fireEvent.change(confirmInput, { target: { value: confirm } });
};

const submitForm = () => {
  const submitButton = screen.getByRole('button', { name: /reset|submit|save|change/i });
  fireEvent.click(submitButton);
};

describe('ResetPassword page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useNavigate.mockReturnValue(mockNavigate);
    setParams({});
    setSearchParams('');
  });

  describe('initial render', () => {
    it('renders the reset password form', () => {
      render(<ResetPassword />);
      expect(screen.getByRole('heading', { name: /reset password/i })).toBeInTheDocument();
      expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      expect(
        screen.getByRole('button', { name: /reset|submit|save|change/i })
      ).toBeInTheDocument();
    });

    it('renders a loading state while validating the token', () => {
      api.get.mockReturnValue(new Promise(() => {}));
      setParams({ token: 'valid-token' });
      render(<ResetPassword />);
      expect(screen.getByText(/loading|validating|please wait/i)).toBeInTheDocument();
    });

    it('renders an error state when the token is invalid', async () => {
      api.get.mockRejectedValue({ response: { status: 400, data: { message: 'Invalid token' } } });
      setParams({ token: 'invalid-token' });
      render(<ResetPassword />);
      await waitFor(() => {
        expect(screen.getByText(/invalid|expired/i)).toBeInTheDocument();
      });
    });

    it('renders an error state when no token is provided', async () => {
      render(<ResetPassword />);
      await waitFor(() => {
        expect(screen.getByText(/invalid|missing|expired|token/i)).toBeInTheDocument();
      });
    });
  });

  describe('happy path', () => {
    it('submits the new password and navigates to login on success', async () => {
      api.get.mockResolvedValue({ data: { valid: true } });
      api.post.mockResolvedValue({ data: { success: true } });
      setParams({ token: 'valid-token' });

      render(<ResetPassword />);

      await waitFor(() => {
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });

      fillForm();
      submitForm();

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledTimes(1);
      });

      expect(api.post).toHaveBeenCalledWith(
        expect.stringContaining('reset'),
        expect.objectContaining({ password: 'NewPass123!' })
      );

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining('login'));
      });
    });

    it('shows a success message after a successful reset', async () => {
      api.get.mockResolvedValue({ data: { valid: true } });
      api.post.mockResolvedValue({ data: { success: true } });
      setParams({ token: 'valid-token' });

      render(<ResetPassword />);

      await waitFor(() => {
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });

      fillForm();
      submitForm();

      await waitFor(() => {
        expect(screen.getByText(/success|reset|updated/i)).toBeInTheDocument();
      });
    });

    it('sends exactly one request per submission', async () => {
      api.get.mockResolvedValue({ data: { valid: true } });
      api.post.mockResolvedValue({ data: { success: true } });
      setParams({ token: 'valid-token' });

      render(<ResetPassword />);

      await waitFor(() => {
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });

      fillForm();
      submitForm();

      await waitFor(() => {
        expect(api.post).toHaveBeenCalledTimes(1);
      });

      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation errors', () => {
    beforeEach(async () => {
      api.get.mockResolvedValue({ data: { valid: true } });
      setParams({ token: 'valid-token' });
      render(<ResetPassword />);
      await waitFor(() => {
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });
    });

    it('shows an error when the password is empty', async () => {
      submitForm();
      await waitFor(() => {
        expect(screen.getByText(/required|enter|password/i)).toBeInTheDocument();
      });
      expect(api.post).not.toHaveBeenCalled();
    });

    it('shows an error when the passwords do not match', async () => {
      fillForm({ password: 'NewPass123!', confirm: 'Different123!' });
      submitForm();
      await waitFor(() => {
        expect(screen.getByText(/match|do not match/i)).toBeInTheDocument();
      });
      expect(api.post).not.toHaveBeenCalled();
    });

    it('shows an error when the password is too short', async () => {
      fillForm({ password: 'short', confirm: 'short' });
      submitForm();
      await waitFor(() => {
        expect(screen.getByText(/too short|at least|minimum|characters/i)).toBeInTheDocument();
      });
      expect(api.post).not.toHaveBeenCalled();
    });
  });

  describe('API error handling', () => {
    it('shows an error message when the reset request fails', async () => {
      api.get.mockResolvedValue({ data: { valid: true } });
      api.post.mockRejectedValue({
        response: { status: 400, data: { message: 'Reset failed' } },
      });
      setParams({ token: 'valid-token' });

      render(<ResetPassword />);

      await waitFor(() => {
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });

      fillForm();
      submitForm();

      await waitFor(() => {
        expect(screen.getByText(/reset failed|error|failed/i)).toBeInTheDocument();
      });
      expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining('login'));
    });

    it('shows an error message when the token has expired during submission', async () => {
      api.get.mockResolvedValue({ data: { valid: true } });
      api.post.mockRejectedValue({
        response: { status: 410, data: { message: 'Token expired' } },
      });
      setParams({ token: 'valid-token' });

      render(<ResetPassword />);

      await waitFor(() => {
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });

      fillForm();
      submitForm();

      await waitFor(() => {
        expect(screen.getByText(/expired|invalid/i)).toBeInTheDocument();
      });
    });

    it('handles network errors gracefully', async () => {
      api.get.mockResolvedValue({ data: { valid: true } });
      api.post.mockRejectedValue(new Error('Network Error'));
      setParams({ token: 'valid-token' });

      render(<ResetPassword />);

      await waitFor(() => {
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });

      fillForm();
      submitForm();

      await waitFor(() => {
        expect(screen.getByText(/error|failed|try again/i)).toBeInTheDocument();
      });
    });
  });

  describe('token validation states', () => {
    it('disables the form while validating the token', () => {
      api.get.mockReturnValue(new Promise(() => {}));
      setParams({ token: 'valid-token' });
      render(<ResetPassword />);
      const submitButton = screen.queryByRole('button', { name: /reset|submit|save|change/i });
      if (submitButton) {
        expect(submitButton).toBeDisabled();
      } else {
        expect(screen.getByText(/loading|validating|please wait/i)).toBeInTheDocument();
      }
    });

    it('shows the form when the token is valid', async () => {
      api.get.mockResolvedValue({ data: { valid: true } });
      setParams({ token: 'valid-token' });
      render(<ResetPassword />);
      await waitFor(() => {
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });
    });

    it('does not submit when the token is invalid', async () => {
      api.get.mockRejectedValue({ response: { status: 400, data: { message: 'Invalid token' } } });
      setParams({ token: 'invalid-token' });
      render(<ResetPassword />);
      await waitFor(() => {
        expect(screen.getByText(/invalid|expired/i)).toBeInTheDocument();
      });
      expect(api.post).not.toHaveBeenCalled();
    });
  });
});