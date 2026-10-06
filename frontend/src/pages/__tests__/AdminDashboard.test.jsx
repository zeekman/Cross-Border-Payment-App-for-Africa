/**
 * Unit tests for AdminDashboard bulk user actions (FE-025).
 *
 * Key assertions:
 *  - A bulk action cannot be submitted without passing through the confirmation
 *    review step (the ConfirmModal must be shown and the affected row list rendered).
 *  - The confirmation modal lists the exact accounts that will be affected.
 *  - The API is not called until the user confirms the modal.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdminDashboard from '../../pages/AdminDashboard';
import api from '../../utils/api';

jest.mock('../../utils/api');

// recharts ResizeObserver is not available in jsdom
jest.mock('recharts', () => {
  const OriginalRecharts = jest.requireActual('recharts');
  return {
    ...OriginalRecharts,
    ResponsiveContainer: ({ children }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    ),
  };
});

const mockStats = {
  total_users: 120,
  total_transactions: 450,
  total_volume: '12345.67',
  total_fees: '123.45',
};

const mockDailyStats = [];
const mockStellarStats = {
  latestLedger: 50000000,
  baseFee: 100,
  maxFee: 1000,
  transactionCount: 500,
  operationCount: 600,
  closedAt: new Date().toISOString(),
};

const mockUsers = [
  { id: 'u1', email: 'alice@example.com', kyc_status: 'pending' },
  { id: 'u2', email: 'bob@example.com', kyc_status: 'pending' },
  { id: 'u3', email: 'carol@example.com', kyc_status: 'pending' },
];

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url.includes('/admin/stats')) return Promise.resolve({ data: mockStats });
    if (url.includes('/admin/daily-stats')) return Promise.resolve({ data: mockDailyStats });
    if (url.includes('/admin/stellar-stats')) return Promise.resolve({ data: mockStellarStats });
    if (url.includes('/admin/users')) return Promise.resolve({ data: { users: mockUsers } });
    return Promise.resolve({ data: {} });
  });
  api.post.mockResolvedValue({});
});

describe('AdminDashboard — FE-025 bulk action confirmation', () => {
  it('renders the Bulk User Actions section', async () => {
    render(<AdminDashboard />);
    expect(await screen.findByTestId('bulk-actions-section')).toBeInTheDocument();
  });

  it('clicking Suspend Matching Users fetches a preview and opens the confirm modal', async () => {
    render(<AdminDashboard />);
    const suspendBtn = await screen.findByTestId('bulk-suspend-button');
    fireEvent.click(suspendBtn);

    // Confirm modal should appear with the affected user list
    expect(await screen.findByTestId('bulk-preview-list')).toBeInTheDocument();
  });

  it('shows all affected user emails in the preview list before confirmation', async () => {
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByTestId('bulk-suspend-button'));

    await screen.findByTestId('bulk-preview-list');

    for (const user of mockUsers) {
      expect(screen.getByText(user.email)).toBeInTheDocument();
    }
  });

  it('does NOT call the bulk action API before the user confirms', async () => {
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByTestId('bulk-suspend-button'));

    // Modal open, but user has not clicked confirm
    await screen.findByTestId('bulk-preview-list');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('calls POST /admin/users/bulk with correct payload when user confirms', async () => {
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByTestId('bulk-suspend-button'));

    // Wait for preview list to be populated
    await screen.findByTestId('bulk-preview-list');

    // Find confirm button — it contains the count
    const confirmBtn = await screen.findByText(/suspend 3 users/i, { selector: 'button' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/users/bulk', {
        action: 'suspend',
        filter: 'unverified',
        user_ids: mockUsers.map((u) => u.id),
      });
    });
  });

  it('clicking Verify Matching Users also requires confirmation before API call', async () => {
    render(<AdminDashboard />);
    fireEvent.click(await screen.findByTestId('bulk-verify-button'));

    // Modal opens
    await screen.findByTestId('bulk-preview-list');

    // No API call yet
    expect(api.post).not.toHaveBeenCalled();
  });
});
