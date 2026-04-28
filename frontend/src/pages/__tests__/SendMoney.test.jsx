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
}));

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
  api.get.mockResolvedValue({ data: { contacts: [] } });
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

  // second submit → send
  fireEvent.submit(screen.getByRole('button', { name: /confirm & send/i }).closest('form'));

  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith('/payments/send', {
      recipient_address: RECIPIENT,
      amount: 10,
      asset: 'XLM',
    })
  );
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
  api.get.mockResolvedValue({ data: { contacts: [CONTACTS[0]] } });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));
  fireEvent.click(screen.getByText('Alice'));

  expect(screen.getByPlaceholderText('G... Stellar address')).toHaveValue(CONTACTS[0].wallet_address);
});

test('search input filters contacts by name', async () => {
  api.get.mockResolvedValue({ data: { contacts: CONTACTS } });
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
  api.get.mockResolvedValue({ data: { contacts: CONTACTS } });
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
  api.get.mockResolvedValue({ data: { contacts: CONTACTS } });
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
  api.get.mockResolvedValue({ data: { contacts: CONTACTS } });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));

  // Press ArrowDown to select first contact
  fireEvent.keyDown(screen.getByRole('button', { name: /contacts/i }), { key: 'ArrowDown' });

  // Press Enter to select the highlighted contact
  fireEvent.keyDown(screen.getByRole('button', { name: /contacts/i }), { key: 'Enter' });

  // Should populate the recipient field with the first contact (Alice)
  expect(screen.getByPlaceholderText('G... Stellar address')).toHaveValue(CONTACTS[0].wallet_address);
});

test('search is case-insensitive', async () => {
  api.get.mockResolvedValue({ data: { contacts: CONTACTS } });
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

test('submit button is disabled while loading', async () => {
  api.post.mockReturnValue(new Promise(() => {})); // never resolves → stays loading
  renderComponent();

  await userEvent.type(screen.getByPlaceholderText('G... Stellar address'), RECIPIENT);
  await userEvent.type(screen.getByPlaceholderText('0.00'), '10');

  fireEvent.submit(screen.getByRole('button', { name: /review payment/i }).closest('form'));
  await screen.findByText('Confirm Transaction');

  fireEvent.submit(screen.getByRole('button', { name: /confirm & send/i }).closest('form'));

  await waitFor(() =>
    expect(screen.getByRole('button', { name: /confirm & send/i })).toBeDisabled()
  );
});
