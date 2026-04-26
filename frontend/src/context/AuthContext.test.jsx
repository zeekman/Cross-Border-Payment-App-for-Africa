import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

// Mock api with a factory to avoid importing the actual file
jest.mock('../utils/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

// Now import the mock object
import api from '../utils/api';

const TestComponent = () => {
  const { user, loading, login, register, logout } = useAuth();
  if (loading) return <div>Loading...</div>;
  return (
    <div>
      <div data-testid="user">{user ? user.email : 'guest'}</div>
      <button onClick={() => login('test@test.com', 'pass').catch(() => {})}>Login</button>
      <button onClick={() => register({ email: 'new@test.com', password: 'pass' }).catch(() => {})}>Register</button>
      <button onClick={logout}>Logout</button>
    </div>
  );
};

describe('AuthContext', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  test('provides initial loading state and checks for token', async () => {
    // No token in localStorage
    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
    expect(screen.getByTestId('user')).toHaveTextContent('guest');
  });

  test('restores user if token exists', async () => {
    const mockUser = { email: 'persisted@test.com' };
    localStorage.setItem('token', 'fake-token');
    api.get.mockResolvedValueOnce({ data: mockUser });

    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent(mockUser.email));
    expect(api.get).toHaveBeenCalledWith('/auth/me');
  });

  test('clears token if persistence fails', async () => {
    localStorage.setItem('token', 'invalid-token');
    api.get.mockRejectedValueOnce(new Error('Invalid token'));

    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());
    expect(localStorage.getItem('token')).toBeNull();
    expect(screen.getByTestId('user')).toHaveTextContent('guest');
  });

  test('login updates user and localStorage', async () => {
    const mockUser = { email: 'login@test.com' };
    const mockToken = 'token123';
    api.post.mockResolvedValueOnce({ data: { user: mockUser, token: mockToken } });

    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());

    await act(async () => {
      screen.getByText('Login').click();
    });

    expect(screen.getByTestId('user')).toHaveTextContent(mockUser.email);
    expect(localStorage.getItem('token')).toBe(mockToken);
    expect(api.post).toHaveBeenCalledWith('/auth/login', { email: 'test@test.com', password: 'pass' });
  });

  test('login failure does not update user', async () => {
    api.post.mockRejectedValueOnce(new Error('Login failed'));

    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());

    await act(async () => {
      screen.getByText('Login').click();
    });

    expect(screen.getByTestId('user')).toHaveTextContent('guest');
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('register does not set user or token until email is verified', async () => {
    api.post.mockResolvedValueOnce({
      data: { message: 'Account created. Please verify your email before logging in.' },
    });

    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());

    await act(async () => {
      screen.getByText('Register').click();
    });

    expect(screen.getByTestId('user')).toHaveTextContent('guest');
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('register failure does not update user', async () => {
    api.post.mockRejectedValueOnce(new Error('Registration failed'));

    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.queryByText('Loading...')).not.toBeInTheDocument());

    await act(async () => {
      screen.getByText('Register').click();
    });

    expect(screen.getByTestId('user')).toHaveTextContent('guest');
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('logout clears user and localStorage', async () => {
    const mockUser = { email: 'persisted@test.com' };
    localStorage.setItem('token', 'fake-token');
    api.get.mockResolvedValueOnce({ data: mockUser });
    api.post.mockResolvedValueOnce({ data: { message: 'Logged out successfully' } });

    render(
      <AuthProvider>
        <TestComponent />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent(mockUser.email));

    await act(async () => {
      screen.getByText('Logout').click();
    });

    expect(api.post).toHaveBeenCalledWith('/auth/logout');
    expect(screen.getByTestId('user')).toHaveTextContent('guest');
    expect(localStorage.getItem('token')).toBeNull();
  });
});
