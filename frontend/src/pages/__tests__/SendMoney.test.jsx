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
        common: { back: 'Back', cancel: 'Cancel' },
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

const CONTACT = {
  id: 1,
  name: 'Alice',
  wallet_address: 'GALICE000000000000000000000000000000000000000000000000001',
};
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
  api.get.mockResolvedValue({ data: { contacts: [CONTACT] } });
  renderComponent();

  await screen.findByText('Contacts');
  fireEvent.click(screen.getByText('Contacts'));
  fireEvent.click(screen.getByText('Alice'));

  expect(screen.getByPlaceholderText('G... Stellar address')).toHaveValue(CONTACT.wallet_address);
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
