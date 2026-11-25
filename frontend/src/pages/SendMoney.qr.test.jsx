import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { AuthContext } from '../context/AuthContext';
import SendMoney from './SendMoney';
import api from '../utils/api';

const DEST = 'GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('react-hot-toast', () => Object.assign(jest.fn(), { error: jest.fn(), success: jest.fn() }));
// Mocked reader: "scans" a QR generated the same way ReceiveMoney does.
jest.mock('../components/QRScanner', () => {
  // eslint-disable-next-line global-require
  const { parseScannedPayment } = require('../utils/parseScannedPayment');
  return function MockQRScanner({ onScan, onClose }) {
    const uri = `web+stellar:pay?${new URLSearchParams({
      destination: 'GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI',
      amount: '12.5',
      memo: 'Rent & fees',
    })}`;
    return (
      <button
        type="button"
        onClick={() => {
          const payment = parseScannedPayment(uri);
          onScan(payment.destination, payment);
          onClose();
        }}
      >
        mock-scan
      </button>
    );
  };
});
jest.mock('../components/PINVerificationModal', () => () => null);
jest.mock('../components/XDRInspectorModal', () => () => null);
jest.mock('../components/LedgerSignModal', () => () => null);

function renderSendMoney() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <AuthContext.Provider value={{ user: { full_name: 'Ada', pin_setup_completed: true }, updateUser: jest.fn() }}>
          <SendMoney />
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nextProvider>
  );
}

beforeEach(() => {
  api.get.mockResolvedValue({ data: {} });
});
afterEach(() => jest.clearAllMocks());

jest.setTimeout(20000);

test('scan button opens the lazy scanner and a SEP-7 QR pre-fills recipient, amount and memo', async () => {
  renderSendMoney();
  await userEvent.click(screen.getAllByRole('button', { name: i18n.t('send.scan_qr') })[0]);
  await userEvent.click(await screen.findByText('mock-scan'));

  await waitFor(() => expect(screen.getByPlaceholderText(i18n.t('send.recipient_placeholder'))).toHaveValue(DEST));
  expect(screen.queryByText('mock-scan')).not.toBeInTheDocument();

  // Amount and memo live on step 2 of the wizard.
  await waitFor(() => expect(screen.getByText(/Next: Amount/)).toBeEnabled());
  await userEvent.click(screen.getByText(/Next: Amount/));
  expect(await screen.findByPlaceholderText('0.00')).toHaveValue(12.5);
  expect(screen.getByPlaceholderText(i18n.t('send.memo_placeholder'))).toHaveValue('Rent & fees');
});

test('Ledger signing option is hidden without WebUSB', () => {
  renderSendMoney();
  expect('usb' in navigator).toBe(false);
  expect(screen.queryByText(/Sign with Ledger/)).not.toBeInTheDocument();
});
