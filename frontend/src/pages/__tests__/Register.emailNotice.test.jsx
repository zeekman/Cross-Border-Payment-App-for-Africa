import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// ── i18n stub ──────────────────────────────────────────────────────────────
const testI18n = i18n.createInstance();
testI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      translation: {
        common: { back: 'Back' },
        register: {
          title: 'Create Account',
          subtitle: 'Join AfriPay',
          full_name: 'Full name',
          email: 'Email',
          phone: 'Phone',
          password: 'Password',
          password_placeholder: 'Min 8 characters',
          submit: 'Create Account',
          submitting: 'Creating…',
          success: 'Account created!',
          error: 'Registration failed',
          have_account: 'Already have an account?',
          sign_in: 'Sign in',
          verify_email_notice:
            'Account created! Please check your email and verify your address before logging in.',
        },
      },
    },
  },
  interpolation: { escapeValue: false },
});

// ── mocks ──────────────────────────────────────────────────────────────────
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams()],
}));

const mockRegister = jest.fn();
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ register: mockRegister }),
}));

jest.mock('react-hot-toast', () => ({ success: jest.fn(), error: jest.fn() }));

import Register from '../Register';
import Login from '../Login';

// ── helpers ────────────────────────────────────────────────────────────────
function renderRegister() {
  return render(
    <I18nextProvider i18n={testI18n}>
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    </I18nextProvider>
  );
}

function renderLoginWithState(state) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
        <Login />
      </MemoryRouter>
    </I18nextProvider>
  );
}

// ── Register tests ─────────────────────────────────────────────────────────
describe('Register — post-registration navigation', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockRegister.mockResolvedValue({});
  });

  it('navigates to /login with emailVerificationRequired state on success', async () => {
    renderRegister();

    fireEvent.change(screen.getByPlaceholderText('[Full Name]'), { target: { value: 'Ada Obi' } });
    fireEvent.change(screen.getByPlaceholderText('[email]'), { target: { value: 'ada@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), { target: { value: 'Password1!' } });
    fireEvent.change(screen.getByPlaceholderText('Re-enter your password'), { target: { value: 'Password1!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', {
        state: { emailVerificationRequired: true },
      });
    });
  });

  it('does NOT navigate on registration failure', async () => {
    mockRegister.mockRejectedValue({ response: { data: { error: 'Email taken' } } });
    renderRegister();

    fireEvent.change(screen.getByPlaceholderText('[Full Name]'), { target: { value: 'Ada Obi' } });
    fireEvent.change(screen.getByPlaceholderText('[email]'), { target: { value: 'ada@test.com' } });
    fireEvent.change(screen.getByPlaceholderText('Min 8 characters'), { target: { value: 'Password1!' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });
});

// ── Login banner tests ─────────────────────────────────────────────────────
describe('Login — email verification banner', () => {
  it('shows the banner when emailVerificationRequired state is true', () => {
    renderLoginWithState({ emailVerificationRequired: true });
    expect(
      screen.getByText(/please check your email and verify your address/i)
    ).toBeInTheDocument();
  });

  it('does NOT show the banner when navigated to normally', () => {
    renderLoginWithState(null);
    expect(
      screen.queryByText(/please check your email and verify your address/i)
    ).not.toBeInTheDocument();
  });
});
