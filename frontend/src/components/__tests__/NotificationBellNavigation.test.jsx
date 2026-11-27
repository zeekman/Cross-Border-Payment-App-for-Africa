import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import NotificationBell from '../NotificationBell';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({ ...jest.requireActual('react-router-dom'), useNavigate: () => mockNavigate }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_k, d) => d, i18n: { language: 'en' } }) }));
jest.mock('../../hooks/useNotifications', () => ({
  useNotifications: () => ({
    items: [{ id: 'n1', title: 'Payment received', created_at: '2026-01-01T00:00:00Z', read_at: '2026-01-01T00:00:00Z', data: { transaction_id: 'tx-42', tx_hash: 'hash' } }],
    unreadCount: 0, hasMore: false, loading: false,
    load: jest.fn(), loadMore: jest.fn(), markRead: jest.fn(), markAllRead: jest.fn(),
  }),
}));

test('payment notification click navigates to the transaction detail page (FE-205)', () => {
  render(<NotificationBell />);
  fireEvent.click(screen.getByLabelText('Notifications'));
  fireEvent.click(screen.getByText('Payment received'));
  expect(mockNavigate).toHaveBeenCalledWith('/history/tx-42');
});
