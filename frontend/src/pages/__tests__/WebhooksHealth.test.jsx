import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import Webhooks from '../Webhooks';
import api from '../../utils/api';

jest.mock('../../utils/api');
jest.mock('react-hot-toast', () => ({ success: jest.fn(), error: jest.fn() }));

const base = {
  url: 'https://example.com/hook',
  events: ['payment.sent'],
  created_at: '2026-01-01T00:00:00.000Z',
  secret_masked: 'abcd****',
};

const fixtures = [
  { ...base, id: 'healthy', active: true, health: { status: 'healthy', success_rate_24h: 100, consecutive_failures: 0, last_success_at: '2026-11-25T10:00:00Z' } },
  { ...base, id: 'failing', active: true, consecutive_failures: 3, health: { status: 'failing', success_rate_24h: 40, consecutive_failures: 3, pending_deliveries: 2 } },
  { ...base, id: 'disabled', active: false, disabled_at: '2026-11-24T00:00:00Z', disabled_reason: 'Disabled after 10 consecutive failures', health: { status: 'disabled', success_rate_24h: 0, consecutive_failures: 10 } },
];

describe('Webhooks endpoint health (FE-203)', () => {
  beforeEach(() => {
    api.get.mockImplementation((url) => {
      if (url === '/webhooks') return Promise.resolve({ data: { webhooks: fixtures } });
      if (url === '/webhooks/deliveries') return Promise.resolve({ data: { deliveries: [], has_more: false } });
      return Promise.resolve({ data: { events: [] } });
    });
    api.post.mockResolvedValue({ data: {} });
  });

  test('renders each health state from the API', async () => {
    render(<Webhooks />);
    await waitFor(() => expect(screen.getByTestId('health-healthy')).toBeInTheDocument());
    expect(screen.getByTestId('health-healthy')).toHaveTextContent('Healthy');
    expect(screen.getByTestId('health-healthy')).toHaveTextContent('24h success: 100%');
    expect(screen.getByTestId('health-failing')).toHaveTextContent('Failing');
    expect(screen.getByTestId('health-failing')).toHaveTextContent('Consecutive failures: 3');
    expect(screen.getByTestId('health-failing')).toHaveTextContent('Queued for retry: 2');
    expect(screen.getByTestId('health-disabled')).toHaveTextContent('Disabled after 10 consecutive failures');
  });

  test('re-enabling calls the backend and refreshes the status', async () => {
    render(<Webhooks />);
    await waitFor(() => expect(screen.getByText('Re-enable')).toBeInTheDocument());
    const callsBefore = api.get.mock.calls.filter(([u]) => u === '/webhooks').length;
    fireEvent.click(screen.getByText('Re-enable'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/webhooks/disabled/reenable'));
    await waitFor(() =>
      expect(api.get.mock.calls.filter(([u]) => u === '/webhooks').length).toBe(callsBefore + 1),
    );
  });

  test('delivery log can be filtered by status', async () => {
    render(<Webhooks />);
    await waitFor(() => expect(screen.getByTestId('health-healthy')).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('webhooks.showLog')[0]);
    const select = await screen.findByLabelText('Filter deliveries by status');
    fireEvent.change(select, { target: { value: 'failed' } });
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/webhooks/deliveries', expect.objectContaining({
        params: expect.objectContaining({ webhook_id: 'healthy', status: 'failed' }),
      })),
    );
  });
});
