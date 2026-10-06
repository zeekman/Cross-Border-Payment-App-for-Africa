/**
 * Unit tests for BusinessSettings multisig signer management (FE-023).
 *
 * The signers endpoint is only supposed to be reachable by an account
 * admin/owner (BE-001). This page must therefore not assume it always
 * succeeds: a non-owner authenticated user who receives a 403 has to see an
 * explicit permission message instead of an empty signer list (which would be
 * indistinguishable from a business account with no extra signers).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BusinessSettings from './BusinessSettings';
import { AuthContext } from '../context/AuthContext';
import api from '../utils/api';
import toast from 'react-hot-toast';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

jest.mock('react-hot-toast', () => ({ success: jest.fn(), error: jest.fn() }));

const OWNER_WALLET = 'GOWNER1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF123456';
const SIGNER_A = 'GSIGNER1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF123456';
const SIGNER_B = 'GSECOND1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF12345';

const businessUser = {
  id: 'user-1',
  account_type: 'business',
  wallet_address: OWNER_WALLET,
};

function signersOk(signers) {
  api.get.mockImplementation((url) => {
    if (url === '/webhooks') return Promise.resolve({ data: { webhooks: [] } });
    return Promise.resolve({ data: { signers } });
  });
}

function signersFail(status, error) {
  api.get.mockImplementation((url) => {
    if (url === '/webhooks') return Promise.resolve({ data: { webhooks: [] } });
    return Promise.reject({ response: { status, data: error ? { error } : undefined } });
  });
}

function renderPage(user = businessUser, updateUser = jest.fn()) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, updateUser }}>
        <BusinessSettings />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BusinessSettings — FE-023 non-owner / authorization handling', () => {
  test('shows an explicit permission error (not an empty list) when GET /wallet/signers returns 403', async () => {
    signersFail(403, 'Forbidden: admin or account owner required');

    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/don't have permission to manage signers/i);
    // The empty state must NOT be shown — that would silently mask the 403.
    expect(screen.queryByText(/No additional signers configured/i)).not.toBeInTheDocument();
    // Nor should we offer a management form the user cannot submit.
    expect(screen.queryByRole('button', { name: /Add Signer/i })).not.toBeInTheDocument();
  });

  test('shows a retryable error (not the empty state) for a non-403 load failure', async () => {
    signersFail(500, 'boom');

    renderPage();

    expect(await screen.findByText(/Could not load signers/i)).toBeInTheDocument();
    expect(screen.queryByText(/No additional signers configured/i)).not.toBeInTheDocument();
  });

  test('retry re-fetches the signer list after a failure', async () => {
    let attempts = 0;
    api.get.mockImplementation((url) => {
      if (url === '/webhooks') return Promise.resolve({ data: { webhooks: [] } });
      attempts += 1;
      if (attempts === 1) return Promise.reject({ response: { status: 500 } });
      return Promise.resolve({ data: { signers: [{ signer_public_key: SIGNER_A, label: 'CFO' }] } });
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Retry/i }));

    expect(await screen.findByText('CFO')).toBeInTheDocument();
  });

  test('renders the signer list for an authorized owner', async () => {
    signersOk([{ signer_public_key: SIGNER_A, label: 'CFO' }]);

    renderPage();

    expect(await screen.findByText('CFO')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('BusinessSettings — client-side signer validation', () => {
  test('blocks a duplicate signer before calling the API', async () => {
    signersOk([{ signer_public_key: SIGNER_A, label: 'CFO' }]);
    renderPage();
    await screen.findByText('CFO');

    fireEvent.change(screen.getByPlaceholderText(/Stellar public key/i), { target: { value: SIGNER_A } });
    fireEvent.click(screen.getByRole('button', { name: /Add Signer/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(/already configured/i));
    expect(api.post).not.toHaveBeenCalled();
  });

  test('rejects an invalid Stellar key format before calling the API', async () => {
    signersOk([]);
    renderPage();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/wallet/signers'));

    fireEvent.change(screen.getByPlaceholderText(/Stellar public key/i), { target: { value: 'not-a-key' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Signer/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(/Invalid Stellar address/i));
    expect(api.post).not.toHaveBeenCalled();
  });

  test("rejects the owner's own wallet key as an additional signer", async () => {
    signersOk([]);
    renderPage();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/wallet/signers'));

    fireEvent.change(screen.getByPlaceholderText(/Stellar public key/i), { target: { value: OWNER_WALLET } });
    fireEvent.click(screen.getByRole('button', { name: /Add Signer/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(/own wallet key/i));
    expect(api.post).not.toHaveBeenCalled();
  });

  test('adds a valid, non-duplicate signer', async () => {
    signersOk([]);
    api.post.mockResolvedValue({ data: { message: 'Signer added' } });
    renderPage();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/wallet/signers'));

    fireEvent.change(screen.getByPlaceholderText(/Stellar public key/i), { target: { value: SIGNER_A } });
    fireEvent.change(screen.getByPlaceholderText(/Label/i), { target: { value: 'CFO' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Signer/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/wallet/signers', {
      signer_public_key: SIGNER_A,
      label: 'CFO',
    }));
    expect(await screen.findByText('CFO')).toBeInTheDocument();
  });
});

describe('BusinessSettings — destructive removal requires confirmation', () => {
  test('removal does not call the API until the confirmation modal is accepted', async () => {
    signersOk([
      { signer_public_key: SIGNER_A, label: 'CFO' },
      { signer_public_key: SIGNER_B, label: 'COO' },
    ]);
    api.delete.mockResolvedValue({});
    renderPage();
    await screen.findByText('CFO');

    fireEvent.click(screen.getAllByLabelText('Remove signer')[0]);
    expect(api.delete).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /Remove signer\?/i })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Remove signer', { selector: 'button' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`/wallet/signers/${SIGNER_A}`));
  });

  test('removing the last signer downgrades the account through updateUser', async () => {
    signersOk([{ signer_public_key: SIGNER_A, label: 'CFO' }]);
    api.delete.mockResolvedValue({});
    const updateUser = jest.fn();
    renderPage(businessUser, updateUser);
    await screen.findByText('CFO');

    fireEvent.click(screen.getByLabelText('Remove signer'));
    fireEvent.click(screen.getByText('Remove signer', { selector: 'button' }));

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ account_type: 'personal' }));
  });
});
