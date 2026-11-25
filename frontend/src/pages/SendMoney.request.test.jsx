import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
jest.mock('../components/PINVerificationModal', () => () => null);
jest.mock('../components/XDRInspectorModal', () => () => null);
jest.mock('../components/LedgerSignModal', () => () => null);

function renderSend() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/send?request=req-1']}>
        <AuthContext.Provider value={{ user: { full_name: 'Ada', pin_setup_completed: true }, updateUser: jest.fn() }}>
          <SendMoney />
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nextProvider>
  );
}

afterEach(() => jest.clearAllMocks());

test('opening /send?request=<id> pre-fills and locks the form from the API', async () => {
  api.get.mockImplementation((url) => Promise.resolve({
    data: url.startsWith('/payment-requests/')
      ? { requester_wallet: DEST, amount: '5', asset: 'XLM', memo: 'Lunch', expires_at: new Date(Date.now() + 3600e3).toISOString(), claimed: false }
      : {},
  }));
  renderSend();
  const input = await screen.findByPlaceholderText(i18n.t('send.recipient_placeholder'));
  await waitFor(() => expect(input).toHaveValue(DEST));
  expect(input).toHaveAttribute('readonly');
  expect(api.get).toHaveBeenCalledWith('/payment-requests/req-1');
});

test('expired request shows an error', async () => {
  api.get.mockImplementation((url) => (url.startsWith('/payment-requests/')
    ? Promise.reject({ response: { status: 410 } })
    : Promise.resolve({ data: {} })));
  renderSend();
  expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i);
});
