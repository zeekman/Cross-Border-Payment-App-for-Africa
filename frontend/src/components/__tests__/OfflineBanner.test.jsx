/**
 * FE-137: OfflineBanner must never send queued payments automatically on
 * reconnect. Only the logged-in user's queued payments are shown, and they
 * are sent only after that user re-confirms with their PIN.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OfflineBanner from '../OfflineBanner';
import api from '../../utils/api';
import * as offlineDB from '../../utils/offlineDB';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useAuth } from '../../context/AuthContext';

jest.mock('react-hot-toast', () => {
  const toast = jest.fn();
  toast.success = jest.fn();
  toast.error = jest.fn();
  return { __esModule: true, default: toast };
});

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

jest.mock('../../utils/offlineDB', () => ({
  getQueuedPaymentsForUser: jest.fn(),
  removeQueuedPayment: jest.fn(() => Promise.resolve()),
  updateQueuedPaymentStatus: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: jest.fn() }));
jest.mock('../../context/AuthContext', () => ({ useAuth: jest.fn() }));

// Stand-in for the PIN modal: "Confirm PIN" simulates a successful verification.
jest.mock('../PINVerificationModal', () => ({
  __esModule: true,
  default: ({ isOpen, onSuccess, onClose }) =>
    isOpen ? (
      <div role="dialog">
        <button type="button" onClick={() => { onSuccess(); onClose(); }}>Confirm PIN</button>
        <button type="button" onClick={onClose}>Cancel PIN</button>
      </div>
    ) : null,
}));

const itemFor = (id, userId, amount = '10') => ({
  id,
  userId,
  payload: { recipient_address: 'GDEST123456789', amount, asset: 'XLM' },
  idempotencyKey: `key-${id}`,
  createdAt: Date.now(),
  status: 'pending',
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  useOnlineStatus.mockReturnValue({ isOnline: true, wasOffline: true });
  useAuth.mockReturnValue({ user: { id: 'user-a' } });
  api.post.mockResolvedValue({ data: {} });
});

test('does not send queued payments automatically on reconnect', async () => {
  offlineDB.getQueuedPaymentsForUser.mockResolvedValue([itemFor(1, 'user-a')]);

  render(<OfflineBanner />);

  expect(await screen.findByText(/confirm to send/i)).toBeInTheDocument();
  expect(offlineDB.getQueuedPaymentsForUser).toHaveBeenCalledWith('user-a');
  expect(api.post).not.toHaveBeenCalledWith('/payments/send', expect.anything(), expect.anything());
});

test('sends queued payments only after PIN confirmation, reusing the idempotency key', async () => {
  offlineDB.getQueuedPaymentsForUser.mockResolvedValue([itemFor(1, 'user-a')]);

  render(<OfflineBanner />);

  fireEvent.click(await screen.findByRole('button', { name: /send queued payments/i }));
  expect(api.post).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Confirm PIN' }));

  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      '/payments/send',
      expect.objectContaining({ amount: '10' }),
      { headers: { 'Idempotency-Key': 'key-1' } }
    )
  );
  await waitFor(() => expect(offlineDB.removeQueuedPayment).toHaveBeenCalledWith(1));
});

test('cancelling the PIN prompt sends nothing', async () => {
  offlineDB.getQueuedPaymentsForUser.mockResolvedValue([itemFor(1, 'user-a')]);

  render(<OfflineBanner />);

  fireEvent.click(await screen.findByRole('button', { name: /send queued payments/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel PIN' }));

  expect(api.post).not.toHaveBeenCalled();
});

test("shows nothing to a user who has no queued payments of their own", async () => {
  useAuth.mockReturnValue({ user: { id: 'user-b' } });
  useOnlineStatus.mockReturnValue({ isOnline: true, wasOffline: false });
  offlineDB.getQueuedPaymentsForUser.mockResolvedValue([]);

  const { container } = render(<OfflineBanner />);

  await waitFor(() => expect(offlineDB.getQueuedPaymentsForUser).toHaveBeenCalledWith('user-b'));
  expect(container).toBeEmptyDOMElement();
  expect(api.post).not.toHaveBeenCalled();
});

test('discard removes the queued payments without sending them', async () => {
  offlineDB.getQueuedPaymentsForUser
    .mockResolvedValueOnce([itemFor(1, 'user-a'), itemFor(2, 'user-a', '20')])
    .mockResolvedValue([]);

  render(<OfflineBanner />);

  fireEvent.click(await screen.findByRole('button', { name: /discard/i }));

  await waitFor(() => {
    expect(offlineDB.removeQueuedPayment).toHaveBeenCalledWith(1);
    expect(offlineDB.removeQueuedPayment).toHaveBeenCalledWith(2);
  });
  expect(api.post).not.toHaveBeenCalled();
});
