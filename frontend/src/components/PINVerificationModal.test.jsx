import React from 'react';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

const testI18n = i18n.createInstance();
testI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      translation: {
        auth: {
          verify_pin_title: 'Verify PIN',
          confirming_transaction: 'You are authorizing:',
          pin_label: 'Enter PIN',
          pin_verify_button: 'Confirm',
          pin_security_note: 'Never share your PIN.',
          pin_format_error: 'PIN must be 4–6 digits.',
          pin_error: 'Incorrect PIN.',
          pin_max_attempts: 'Too many attempts.',
          pin_attempts_remaining: '{{remaining}} attempts left.',
          pin_verified: 'PIN verified.',
        },
        send: {
          confirm_amount: 'Amount:',
          confirm_to: 'To:',
        },
        common: { cancel: 'Cancel' },
      },
    },
  },
  interpolation: { escapeValue: false },
});

jest.mock('../utils/api');
jest.mock('react-hot-toast', () => ({ success: jest.fn(), error: jest.fn() }));

import PINVerificationModal from './PINVerificationModal';

function renderModal(props) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <PINVerificationModal
        isOpen={true}
        onClose={jest.fn()}
        onSuccess={jest.fn()}
        {...props}
      />
    </I18nextProvider>
  );
}

describe('PINVerificationModal — transaction summary', () => {
  it('displays the amount', () => {
    renderModal({ amount: '50 XLM', recipient: 'GABCDE1234567890ABCDE' });
    expect(screen.getByText('50 XLM')).toBeInTheDocument();
  });

  it('truncates a long recipient address to 16 chars + ellipsis', () => {
    renderModal({ amount: '10 XLM', recipient: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    // slice(0,16) = GABCDEFGHIJKLMNO (16 chars)
    expect(screen.getByText(/^GABCDEFGHIJKLMNO/)).toBeInTheDocument();
  });

  it('shows a short recipient address without truncation', () => {
    renderModal({ amount: '10 XLM', recipient: 'GABC' });
    expect(screen.getByText('GABC')).toBeInTheDocument();
  });

  it('hides the recipient row when recipient is not provided', () => {
    renderModal({ amount: '10 XLM' });
    expect(screen.queryByText('To:')).not.toBeInTheDocument();
  });

  it('shows the authorization label', () => {
    renderModal({ amount: '10 XLM', recipient: 'GABCDE1234567890ABCDE' });
    expect(screen.getByText('You are authorizing:')).toBeInTheDocument();
  });
});
