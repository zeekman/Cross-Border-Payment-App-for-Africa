import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import Referrals from './Referrals';

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock('react-hot-toast', () => ({ error: jest.fn(), success: jest.fn() }));
jest.mock('qrcode.react', () => ({
  QRCodeCanvas: () => <div data-testid="qr-code">QR Code</div>,
}));

import api from '../utils/api';
import toast from 'react-hot-toast';

describe('Referrals Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn(),
      },
    });
  });

  const mockStats = {
    referral_code: 'TEST123',
    referral_count: 5,
    active_credits: 3,
    credit_per_referral_bps: 50,
    total_rewards_earned: 250,
    first_payments_completed: 5,
  };

  const mockReferralDetails = {
    referrals: [
      {
        referral_id: 'ref1',
        email: 'alice@example.com',
        referred_at: '2024-01-01T00:00:00Z',
        reward_status: 'pending',
        reward_amount: 50,
        reward_claimed_at: null,
      },
      {
        referral_id: 'ref2',
        email: 'bob@example.com',
        referred_at: '2024-01-05T00:00:00Z',
        reward_status: 'credited',
        reward_amount: 50,
        reward_claimed_at: '2024-01-06T00:00:00Z',
      },
      {
        referral_id: 'ref3',
        email: 'charlie@example.com',
        referred_at: '2024-01-10T00:00:00Z',
        reward_status: 'ineligible',
        reward_amount: null,
        reward_claimed_at: null,
      },
    ],
    total_referrals: 3,
    pending_rewards: 1,
    credited_rewards: 1,
  };

  it('renders loading state initially', () => {
    api.get.mockImplementation(() => new Promise(() => {})); // Never resolves

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <Referrals />
        </I18nextProvider>
      </MemoryRouter>
    );

    expect(screen.getByRole('progressbar', { hidden: true })).toBeInTheDocument();
  });

  it('renders referral stats and details after loading', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/referrals/stats') {
        return Promise.resolve({ data: mockStats });
      }
      if (url === '/referrals/details') {
        return Promise.resolve({ data: mockReferralDetails });
      }
    });

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <Referrals />
        </I18nextProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Refer & Earn')).toBeInTheDocument();
      expect(screen.getByText('Total Rewards Earned')).toBeInTheDocument();
      expect(screen.getByText('250')).toBeInTheDocument();
      expect(screen.getByText('loyalty points')).toBeInTheDocument();
    });

    expect(screen.getByText('5')).toBeInTheDocument(); // Friends referred
    expect(screen.getByText('3')).toBeInTheDocument(); // Active credits
  });

  it('displays referral status list with pending and credited rewards', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/referrals/stats') {
        return Promise.resolve({ data: mockStats });
      }
      if (url === '/referrals/details') {
        return Promise.resolve({ data: mockReferralDetails });
      }
    });

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <Referrals />
        </I18nextProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
      expect(screen.getByText('bob@example.com')).toBeInTheDocument();
      expect(screen.getByText('charlie@example.com')).toBeInTheDocument();
    });

    // Check status labels
    const statusElements = screen.getAllByText(/Pending|Credited|Ineligible/);
    expect(statusElements.length).toBeGreaterThan(0);
  });

  it('displays reward amounts for credited and pending referrals', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/referrals/stats') {
        return Promise.resolve({ data: mockStats });
      }
      if (url === '/referrals/details') {
        return Promise.resolve({ data: mockReferralDetails });
      }
    });

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <Referrals />
        </I18nextProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      const rewardAmounts = screen.getAllByText(/50 pts/);
      expect(rewardAmounts.length).toBe(2); // pending and credited
    });
  });

  it('handles referral link copy', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/referrals/stats') {
        return Promise.resolve({ data: mockStats });
      }
      if (url === '/referrals/details') {
        return Promise.resolve({ data: mockReferralDetails });
      }
    });

    const user = userEvent.setup();
    navigator.clipboard.writeText.mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <Referrals />
        </I18nextProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copy referral link/i })).toBeInTheDocument();
    });

    const copyButton = screen.getByRole('button', { name: /Copy referral link/i });
    await user.click(copyButton);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('ref=TEST123')
    );
    expect(toast.success).toHaveBeenCalledWith('Referral link copied!');
  });

  it('shows QR code when toggle button is clicked', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/referrals/stats') {
        return Promise.resolve({ data: mockStats });
      }
      if (url === '/referrals/details') {
        return Promise.resolve({ data: mockReferralDetails });
      }
    });

    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <Referrals />
        </I18nextProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Show QR code')).toBeInTheDocument();
    });

    const qrToggle = screen.getByText('Show QR code');
    await user.click(qrToggle);

    await waitFor(() => {
      expect(screen.getByTestId('qr-code')).toBeInTheDocument();
      expect(screen.getByText('Hide QR code')).toBeInTheDocument();
    });
  });

  it('displays empty state when no referrals', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/referrals/stats') {
        return Promise.resolve({ data: mockStats });
      }
      if (url === '/referrals/details') {
        return Promise.resolve({
          data: {
            referrals: [],
            total_referrals: 0,
            pending_rewards: 0,
            credited_rewards: 0,
          },
        });
      }
    });

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <Referrals />
        </I18nextProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/No referrals yet/)).toBeInTheDocument();
      expect(
        screen.getByText(/Share your referral link to get started/)
      ).toBeInTheDocument();
    });
  });

  it('handles API errors gracefully', async () => {
    api.get.mockRejectedValue(new Error('API Error'));

    render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <Referrals />
        </I18nextProvider>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load referral data');
    });
  });
});
