import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Keypair } from '@stellar/stellar-sdk';
import toast from 'react-hot-toast';
import Escrow from './Escrow';
import api from '../utils/api';
import { ConfirmProvider } from '../context/ConfirmContext';
import { AuthContext } from '../context/AuthContext';
import '../i18n';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('react-hot-toast', () => ({ __esModule: true, default: { success: jest.fn(), error: jest.fn() } }));

const SENDER = Keypair.random().publicKey();
const AGENT = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();

function mockApi({ registered = true, usdc = '50.0000000' } = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/wallet/balance') {
      return Promise.resolve({
        data: { public_key: SENDER, balances: [{ asset: 'USDC', balance: usdc }] },
      });
    }
    if (url.startsWith('/escrow/agents/')) return Promise.resolve({ data: { registered } });
    return Promise.resolve({ data: { escrows: [] } });
  });
  api.post.mockResolvedValue({ data: {} });
}

function renderPage() {
  return render(
    <AuthContext.Provider value={{ user: { id: 'user-1' } }}>
      <ConfirmProvider>
        <Escrow />
      </ConfirmProvider>
    </AuthContext.Provider>
  );
}

async function fillAndSubmit({ agent = AGENT, recipient = RECIPIENT, amount = '10' } = {}) {
  renderPage();
  await screen.findByText(/Available: 50.0000000 USDC/);
  fireEvent.change(screen.getByLabelText(/Agent Wallet Address/i), { target: { value: agent } });
  fireEvent.change(screen.getByLabelText(/Recipient Wallet Address/i), { target: { value: recipient } });
  fireEvent.change(screen.getByLabelText(/^Amount$/i), { target: { value: amount } });
  // The tab and the submit button share a label; the submit button is last.
  fireEvent.click(screen.getAllByRole('button', { name: /Create Escrow/i }).pop());
}

beforeEach(() => jest.clearAllMocks());

describe('Escrow create form', () => {
  test('asset is fixed to USDC', async () => {
    mockApi();
    renderPage();
    const select = screen.getByLabelText(/Asset/i);
    expect(select).toBeDisabled();
    expect(select.querySelectorAll('option')).toHaveLength(1);
    expect(select).toHaveValue('USDC');
  });

  test('submits a valid escrow with a string amount and USDC asset', async () => {
    mockApi();
    await fillAndSubmit();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.get).toHaveBeenCalledWith(`/escrow/agents/${AGENT}`);
    expect(api.post).toHaveBeenCalledWith('/escrow/create', {
      agent_wallet: AGENT,
      recipient_wallet: RECIPIENT,
      amount: '10',
      asset: 'USDC',
    });
    expect(toast.success).toHaveBeenCalledWith('Escrow created successfully');
  });

  test('blocks an unregistered agent', async () => {
    mockApi({ registered: false });
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('not a registered AfriPay agent');
    expect(api.post).not.toHaveBeenCalled();
  });

  test('blocks using your own wallet as the agent', async () => {
    mockApi();
    await fillAndSubmit({ agent: SENDER });
    expect(await screen.findByRole('alert')).toHaveTextContent("can't be the agent");
    expect(api.post).not.toHaveBeenCalled();
  });

  test('blocks an amount above the USDC balance', async () => {
    mockApi();
    await fillAndSubmit({ amount: '50.0000001' });
    expect(await screen.findByRole('alert')).toHaveTextContent('more than your available balance');
    expect(api.post).not.toHaveBeenCalled();
  });
});
