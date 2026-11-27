import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from '../Login';
import api from '../../services/api';

jest.mock('../../services/api', () => ({
  __esModule: true,
  default: {
    post: jest.fn(),
    get: jest.fn(),
  },
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const renderLogin = () =>
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );

describe('Login page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  it('renders the login form initially', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in|login|sign in/i })).toBeInTheDocument();
  });

  it('submits credentials and navigates on happy path', async () => {
    api.post.mockResolvedValueOnce({
      data: { token: 'abc123', user: { id: 1, email: 'user@example.com' } },
    });

    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in|login|sign in/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    expect(api.post).toHaveBeenCalledWith(
      expect.stringContaining('/login'),
      expect.objectContaining({
        email: 'user@example.com',
        password: 'password123',
      })
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
  });

  it('shows validation errors when fields are empty', async () => {
    renderLogin();

    fireEvent.click(screen.getByRole('button', { name: /log in|login|sign in/i }));

    await waitFor(() => {
      expect(screen.getByText(/email.*required|required.*email/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/password.*required|required.*password/i)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows validation error for invalid email format', async () => {
    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'not-an-email' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in|login|sign in/i }));

    await waitFor(() => {
      expect(screen.getByText(/valid email|invalid email/i)).toBeInTheDocument();
    });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('handles API error responses', async () => {
    api.post.mockRejectedValueOnce({
      response: { data: { message: 'Invalid credentials' }, status: 401 },
    });

    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'wrongpassword' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in|login|sign in/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid credentials/i)).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('handles network errors gracefully', async () => {
    api.post.mockRejectedValueOnce(new Error('Network Error'));

    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in|login|sign in/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/something went wrong|network error|try again/i)
      ).toBeInTheDocument();
    });
  });

  it('sends exactly one request per submit', async () => {
    api.post.mockResolvedValueOnce({
      data: { token: 'abc123', user: { id: 1 } },
    });

    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in|login|sign in/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });
  });

  it('handles the 2FA flow when required', async () => {
    api.post.mockResolvedValueOnce({
      data: { requires2FA: true, tempToken: 'temp-token' },
    });

    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in|login|sign in/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(1);
    });

    const twoFactorInput = await screen.findByLabelText(/2fa|verification code|authenticator/i);
    expect(twoFactorInput).toBeInTheDocument();

    api.post.mockResolvedValueOnce({
      data: { token: 'final-token', user: { id: 1 } },
    });

    fireEvent.change(twoFactorInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify|submit|continue/i }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(2);
    });

    expect(api.post).toHaveBeenLastCalledWith(
      expect.stringContaining('/login'),
      expect.objectContaining({ code: '123456' })
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
  });

  it('shows an error for an invalid 2FA code', async () => {
    api.post.mockResolvedValueOnce({
      data: { requires2FA: true, tempToken: 'temp-token' },
    });

    renderLogin();

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'password123' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log in|login|sign in/i }));

    const twoFactorInput = await screen.findByLabelText(/2fa|verification code|authenticator/i);

    api.post.mockRejectedValueOnce({
      response: { data: { message: 'Invalid code' }, status: 401 },
    });

    fireEvent.change(twoFactorInput, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify|submit|continue/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid code/i)).toBeInTheDocument();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});