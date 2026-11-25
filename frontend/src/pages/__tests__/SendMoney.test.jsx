import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import SendMoney from '../SendMoney';
import api from '../../utils/api';

// ── i18n stub ──────────────────────────────────────────────────────────────
i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      translation: {
        common: {
          back: 'Back',
          cancel: 'Cancel',
          rates_disclaimer:
            'Exchange rates are approximate and may be cached. Live prices refresh about every minute.',
        },
        send: {
          title: 'Send Money',
          recipient_label: 'Recipient Address',
          recipient_placeholder: 'G... Stellar address',
          contacts: 'Contacts',
          amount: 'Amount',
          memo: 'Memo (optional)',
          memo_placeholder: 'Payment note...',
          memo_type_label: 'Memo type',
          memo_type_text: 'Text',
          memo_type_id: 'ID',
          memo_type_hash: 'Hash',
          memo_type_return: 'Return',
          memo_hint_text: 'Text hint',
          memo_hint_id: 'ID hint',
          memo_hint_hash: 'Hash hint',
          memo_hint_return: 'Return hint',
          confirm_title: 'Confirm Transaction',
          confirm_to: 'To:',
          confirm_amount: 'Amount:',
          confirm_memo: 'Memo:',
          confirm_memo_type: 'Memo type:',
          review: 'Review Payment',
          confirm_send: 'Confirm & Send',
          success: 'Payment sent successfully!',
          error: 'Transaction failed',
        },
      },
    },
  },
  interpolation: { escapeValue: false },
});

// ── mocks ──────────────────────────────────────────────────────────────────
jest.mock('../../utils/api');
jest.mock('react-hot-toast', () => ({ success: jest.fn(), error: jest.fn() }));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => jest.fn(),
  useBeforeUnload: () => {},
}));
jest.mock('../../components/LedgerSignModal', () => () => null);
jest.mock('../../components/QRScanner', () => () => null);
jest.mock('../../components/PINVerificationModal', () => ({ isOpen, onClose, onSuccess }) =>
  isOpen ? <div role="dialog"><button onClick={onSuccess}>Enter PIN verification</button></div> : null
);
jest.mock('../../components/XDRInspectorModal', () => () => null);

const CONTACTS = [
  {
    id: 1,
    name: 'Alice',
    wallet_address: 'GALICE000000000000000000000000000000000000000000000000001',
  },
  {
    id: 2,
    name: 'Bob',
    wallet_address: 'GBOB0000000000000000000000000000000000000000000000000002',
  },
  {
    id: 3,
    name: 'Charlie',
    wallet_address: 'GCHARLIE00000000000000000000000000000000000000000000001',
  },
];
const RECIPIENT = 'GBOB0000000000000000000000000000000000000000000000000001';

function renderComponent() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <SendMoney />
      </MemoryRouter>
    </I18nextProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          stellar: { usd: 0.11, ngn: 170, ghs: 1.35, kes: 14.5 },
        }),
    })
  );
  api.get.mockImplementation((url) => {
    if (url === '/wallet/list') return Promise.resolve({ data: { wallets: [] } });
    if (url === '/payments/fee-stats') return Promise.resolve({ data: {} });
    if (url === '/payments/fee-stats') {
      return Promise.resolve({ data: { priorities: { economy: 100, standard: 200, priority: 500 } } });
    }
    if (url === '/wallet/list') {
      return Promise.resolve({ data: { wallets: [] } });
    }
    return Promise.resolve({ data: { contacts: [] } });
  });
  api.post.mockResolvedValue({ data: {} });
});

// ── tests ──────────────────────────────────────────────────────────────────

test('renders form fields', async () => {
  renderComponent();
  expect(screen.getByText('Send Money')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('G... Stellar address')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /review payment/i })).toBeInTheDocument();
});

test('shows memo type selector after entering memo text', async () => {
  renderComponent();
  expect(screen.queryByLabelText('Memo type')).not.toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText('Payment note...'), 'hi');
  expect(screen.getByLabelText('Memo type')).toBeInTheDocument();
});

test('first submit shows confirmation preview — does NOT call api.post', async () => {
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '10');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));

  await screen.findByText('Confirm Transaction');
  expect(screen.getByRole('button', { name: /confirm & send/i })).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});

test('second submit calls POST /payments/send', async () => {
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '10');

  // first submit → confirmation
  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  // second submit → PIN modal opens (payment not sent yet)
  fireEvent.submit(screen.getByRole('button', { name: /confirm & send/i }).closest('form'));

  // PIN modal should be visible
  await waitFor(() =>
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  );
  // Payment API must not have been called yet (PIN not entered)
  expect(api.post).not.toHaveBeenCalledWith('/payments/send', expect.anything());
});

test('cancel button resets confirmation state', async () => {
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '10');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

  expect(screen.queryByText('Confirm Transaction')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /review payment/i })).toBeInTheDocument();
});

test('selecting a contact populates the recipient field', async () => {
  api.get.mockImplementation((url) => {
    if (url === '/payments/fee-stats') return Promise.resolve({ data: { priorities: { economy: 100, standard: 200, priority: 500 } } });
    if (url === '/wallet/list') return Promise.resolve({ data: { wallets: [] } });
    return Promise.resolve({ data: { contacts: [CONTACTS[0]] } });
  });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));
  fireEvent.click(screen.getByText('Alice'));

  expect(screen.getByPlaceholderText('G... Stellar address')).toHaveValue(CONTACTS[0].wallet_address);
});

test('search input filters contacts by name', async () => {
  api.get.mockImplementation((url) => {
    if (url === '/payments/fee-stats') return Promise.resolve({ data: { priorities: { economy: 100, standard: 200, priority: 500 } } });
    if (url === '/wallet/list') return Promise.resolve({ data: { wallets: [] } });
    return Promise.resolve({ data: { contacts: CONTACTS } });
  });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));

  // Search for "Bob"
  const searchInput = screen.getByPlaceholderText('Search contacts...');
  await userEvent.type(searchInput, 'Bob');

  // Should only show Bob
  expect(screen.getByText('Bob')).toBeInTheDocument();
  expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  expect(screen.queryByText('Charlie')).not.toBeInTheDocument();
});

test('search input filters contacts by wallet address', async () => {
  api.get.mockImplementation((url) => {
    if (url === '/payments/fee-stats') return Promise.resolve({ data: { priorities: { economy: 100, standard: 200, priority: 500 } } });
    if (url === '/wallet/list') return Promise.resolve({ data: { wallets: [] } });
    return Promise.resolve({ data: { contacts: CONTACTS } });
  });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));

  // Search by partial wallet address
  const searchInput = screen.getByPlaceholderText('Search contacts...');
  await userEvent.type(searchInput, 'GCHARLIE');

  // Should only show Charlie
  expect(screen.getByText('Charlie')).toBeInTheDocument();
  expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  expect(screen.queryByText('Bob')).not.toBeInTheDocument();
});

test('shows "No contacts match" when search returns no results', async () => {
  api.get.mockImplementation((url) => {
    if (url === '/payments/fee-stats') return Promise.resolve({ data: { priorities: { economy: 100, standard: 200, priority: 500 } } });
    if (url === '/wallet/list') return Promise.resolve({ data: { wallets: [] } });
    return Promise.resolve({ data: { contacts: CONTACTS } });
  });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));

  // Search for non-existent contact
  const searchInput = screen.getByPlaceholderText('Search contacts...');
  await userEvent.type(searchInput, 'NonExistent');

  // Should show "No contacts match"
  expect(screen.getByText('No contacts match')).toBeInTheDocument();
});

test('keyboard navigation works in contacts dropdown', async () => {
  // jsdom doesn't implement scrollIntoView
  window.HTMLElement.prototype.scrollIntoView = jest.fn();
  api.get.mockImplementation((url) => {
    if (url === '/payments/fee-stats') return Promise.resolve({ data: { priorities: { economy: 100, standard: 200, priority: 500 } } });
    if (url === '/wallet/list') return Promise.resolve({ data: { wallets: [] } });
    return Promise.resolve({ data: { contacts: CONTACTS } });
  });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));

  // The onKeyDown handler is on the dropdown container; fire on the search input
  const searchInput = await screen.findByPlaceholderText('Search contacts...');

  // Press ArrowDown to select first contact
  fireEvent.keyDown(searchInput, { key: 'ArrowDown' });

  // Press Enter to select the highlighted contact
  fireEvent.keyDown(searchInput, { key: 'Enter' });

  // Should populate the recipient field with the first contact (Alice)
  expect(screen.getByPlaceholderText('G... Stellar address')).toHaveValue(CONTACTS[0].wallet_address);
});

test('search is case-insensitive', async () => {
  api.get.mockImplementation((url) => {
    if (url === '/payments/fee-stats') return Promise.resolve({ data: { priorities: { economy: 100, standard: 200, priority: 500 } } });
    if (url === '/wallet/list') return Promise.resolve({ data: { wallets: [] } });
    return Promise.resolve({ data: { contacts: CONTACTS } });
  });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));

  // Search with lowercase
  const searchInput = screen.getByPlaceholderText('Search contacts...');
  await userEvent.type(searchInput, 'alice');

  // Should still find Alice
  expect(screen.getByText('Alice')).toBeInTheDocument();
});

// ── Issue #284: two-step flow ──────────────────────────────────────────────

test('first click shows confirmation preview and does not open PIN modal', async () => {
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '10');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));

  // Confirmation panel should appear
  await screen.findByText('Confirm Transaction');
  // PIN modal must NOT be visible yet
  expect(screen.queryByRole('dialog', { name: /pin/i })).not.toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});

test('second click opens PIN verification modal', async () => {
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '10');

  // First click → confirmation preview
  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  // Second click → PIN modal
  fireEvent.submit(screen.getByRole('button', { name: /confirm & send/i }).closest('form'));

  // PINVerificationModal renders a heading or label containing "PIN"
  await waitFor(() =>
    expect(screen.getByText(/enter.*pin|pin.*verification/i)).toBeInTheDocument()
  );
  // Payment API must not have been called yet (PIN not entered)
  expect(api.post).not.toHaveBeenCalledWith('/payments/send', expect.anything());
});

test('pre-fills form from payment request when only requestId is in URL', async () => {
  const REQUEST_ID = 'test-uuid-1234';
  const REQUEST_DATA = {
    requester_wallet: 'GREQUEST0000000000000000000000000000000000000000000001',
    amount: '42.5',
    asset: 'USDC',
    memo: 'invoice-99',
  };

  api.get.mockImplementation((url) => {
    if (url === `/payment-requests/${REQUEST_ID}`) return Promise.resolve({ data: REQUEST_DATA });
    return Promise.resolve({ data: { contacts: [] } });
  });

  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/send?request=${REQUEST_ID}`]}>
        <SendMoney />
      </MemoryRouter>
    </I18nextProvider>
  );

  await waitFor(() =>
    expect(screen.getByPlaceholderText('G... Stellar address')).toHaveValue(REQUEST_DATA.requester_wallet)
  );
  expect(screen.getByPlaceholderText('0.00')).toHaveValue(42.5);
  expect(screen.getByPlaceholderText('Payment note...')).toHaveValue(REQUEST_DATA.memo);
});

test('submit button is disabled while loading', async () => {
  api.post.mockReturnValue(new Promise(() => {})); // never resolves → stays loading
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '10');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  // Second submit → opens PIN modal
  fireEvent.submit(screen.getByRole('button', { name: /confirm & send/i }).closest('form'));

  // Confirm via PIN modal to trigger loading state
  const pinConfirmBtn = await screen.findByRole('button', { name: /enter pin verification/i });
  fireEvent.click(pinConfirmBtn);

  // Loading spinner should appear (button shows spinner while api.post is pending)
  await waitFor(() =>
    expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument()
  );
});

// ── Address truncation, tooltip, and Stellar Expert link ──────────────────

const LONG_RECIPIENT = 'GABCDEFGHIJ0000000000000000000000000000000000WXYZ12345678';

test('confirmation preview shows first-10…last-10 truncation', async () => {
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), LONG_RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '5');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  const truncated = `${LONG_RECIPIENT.slice(0, 10)}…${LONG_RECIPIENT.slice(-10)}`;
  expect(screen.getByText(truncated)).toBeInTheDocument();
});

test('truncated address element has full address in title tooltip', async () => {
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), LONG_RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '5');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  const truncated = `${LONG_RECIPIENT.slice(0, 10)}…${LONG_RECIPIENT.slice(-10)}`;
  const el = screen.getByText(truncated);
  expect(el).toHaveAttribute('title', LONG_RECIPIENT);
});

test('Verify address link points to testnet Stellar Expert URL', async () => {
  delete process.env.REACT_APP_STELLAR_NETWORK; // defaults to testnet branch
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), LONG_RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '5');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  const link = screen.getByRole('link', { name: /verify address/i });
  expect(link).toHaveAttribute(
    'href',
    `https://stellar.expert/explorer/testnet/account/${LONG_RECIPIENT}`
  );
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

test('Verify address link points to mainnet Stellar Expert URL when network is mainnet', async () => {
  process.env.REACT_APP_STELLAR_NETWORK = 'mainnet';
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), LONG_RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '5');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  const link = screen.getByRole('link', { name: /verify address/i });
  expect(link).toHaveAttribute(
    'href',
    `https://stellar.expert/explorer/public/account/${LONG_RECIPIENT}`
  );

  // Reset
  delete process.env.REACT_APP_STELLAR_NETWORK;
});

// ── Recipient address validation ───────────────────────────────────────────

const VALID_KEY   =
'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'; // checksum-valid zero account
const INVALID_KEY = 'GBOB000'; // too short
const FED_ADDRESS = 'alice*stellar.org';

test('shows green checkmark for a valid Stellar public key', async () => {
  renderComponent();
  const input = screen.getByPlaceholderText('G... Stellar address');
  await userEvent.type(input, VALID_KEY);
  fireEvent.blur(input);
  expect(await screen.findByText(/valid address/i)).toBeInTheDocument();
});

test('shows green checkmark for a valid federation address', async () => {
  renderComponent();
  const input = screen.getByPlaceholderText('G... Stellar address');
  await userEvent.type(input, FED_ADDRESS);
  fireEvent.blur(input);
  expect(await screen.findByText(/valid address/i)).toBeInTheDocument();
});

test('shows inline error on blur for an invalid address', async () => {
  renderComponent();
  const input = screen.getByPlaceholderText('G... Stellar address');
  await userEvent.type(input, INVALID_KEY);
  fireEvent.blur(input);
  expect(await screen.findByText(/invalid address/i)).toBeInTheDocument();
});

test('clears error when user edits the field after an invalid entry', async () => {
  renderComponent();
  const input = screen.getByPlaceholderText('G... Stellar address');
  await userEvent.type(input, INVALID_KEY);
  fireEvent.blur(input);
  await screen.findByText(/invalid address/i);

  await userEvent.clear(input);
  await userEvent.type(input, 'G');
  expect(screen.queryByText(/invalid address/i)).not.toBeInTheDocument();
});

test('submit button is disabled while address is invalid', async () => {
  renderComponent();
  const input = screen.getByPlaceholderText('G... Stellar address');
  await userEvent.type(input, INVALID_KEY);
  fireEvent.blur(input);
  await screen.findByText(/invalid address/i);
  expect(screen.getByRole('button', { name: /review payment/i })).toBeDisabled();
});

test('submit button is enabled for a valid address', async () => {
  renderComponent();
  const input = screen.getByPlaceholderText('G... Stellar address');
  await userEvent.type(input, VALID_KEY);
  fireEvent.blur(input);
  await screen.findByText(/valid address/i);
  expect(screen.getByRole('button', { name: /review payment/i })).not.toBeDisabled();
});

test('no error shown when field is empty on blur', async () => {
  renderComponent();
  const input = screen.getByPlaceholderText('G... Stellar address');
  fireEvent.focus(input);
  fireEvent.blur(input);
  expect(screen.queryByText(/invalid address/i)).not.toBeInTheDocument();
});

// ── Issue #641: fee estimation preview ──────────────────────────────────────

function mockFeeApi({ feeBps = 250, mode = 'ok', networkFee = { fee_xlm: '0.0000100' } } = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/payments/fee-rate') {
      if (mode === 'pending') return new Promise(() => {}); // never resolves
      if (mode === 'reject') return Promise.reject(new Error('fee rate unavailable'));
      return Promise.resolve({ data: { fee_bps: feeBps } });
    }
    if (url === '/payments/estimate-fee') return Promise.resolve({ data: networkFee });
    if (url === '/wallet/list') return Promise.resolve({ data: { wallets: [] } });
    if (url === '/payments/fee-stats') return Promise.resolve({ data: {} });
    return Promise.resolve({ data: { contacts: [] } });
  });
}

test('shows fee breakdown after the user types an amount', async () => {
  mockFeeApi({ feeBps: 250 });
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('0.00'), '100');

  const panel = await screen.findByTestId('fee-estimate');
  await waitFor(() => expect(panel).toHaveTextContent('Platform fee (2.5%)'));
  expect(panel).toHaveTextContent('2.5 XLM'); // 100 * 250bps
  expect(panel).toHaveTextContent('0.0000100 XLM'); // network fee
  expect(panel).toHaveTextContent('97.5 XLM'); // recipient receives
});

test('shows a loading skeleton while the estimate is fetched', async () => {
  mockFeeApi({ mode: 'pending' });
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('0.00'), '50');

  expect(await screen.findByTestId('fee-estimate-skeleton')).toBeInTheDocument();
});

test('shows fallback message when the fee rate cannot be fetched', async () => {
  mockFeeApi({ mode: 'reject' });
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('0.00'), '25');

  expect(
    await screen.findByText(/Fee estimate unavailable — final fee will be shown at confirmation\./i)
  ).toBeInTheDocument();
});

test('hides the fee panel when the amount is empty or zero', async () => {
  mockFeeApi({ feeRate: { fee_bps: 250 } });
  renderComponent();

  // Empty by default
  expect(screen.queryByTestId('fee-estimate')).not.toBeInTheDocument();

  // Zero amount stays hidden
  await userEvent.type(screen.getByPlaceholderText('0.00'), '0');
  await waitFor(() =>
    expect(screen.queryByTestId('fee-estimate')).not.toBeInTheDocument()
  );
});
