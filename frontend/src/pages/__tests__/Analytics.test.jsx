import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Analytics from '../Analytics';
import api from '../../services/api';

jest.mock('../../services/api', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const mockUser = { id: 1, role: 'admin' };

jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <Analytics />
    </MemoryRouter>
  );

describe('Analytics page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUser.role = 'admin';
  });

  it('loads the current user analytics from /payments/analytics', async () => {
    api.get.mockResolvedValue({
      data: { dataAsOf: '2024-01-01T00:00:00Z', totals: {} },
    });

    renderPage();

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/payments/analytics');
    });
  });

  it('refreshes via POST /analytics/refresh and shows the new data-as-of timestamp', async () => {
    api.get
      .mockResolvedValueOnce({ data: { dataAsOf: '2024-01-01T00:00:00Z', totals: {} } })
      .mockResolvedValueOnce({ data: { dataAsOf: '2024-02-02T00:00:00Z', totals: {} } });
    api.post.mockResolvedValue({ data: { dataAsOf: '2024-02-02T00:00:00Z' } });

    renderPage();

    const refreshButton = await screen.findByRole('button', { name: /refresh/i });
    await userEvent.click(refreshButton);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/analytics/refresh');
    });

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    expect(await screen.findByText(/2024-02-02/)).toBeInTheDocument();
  });

  it('does not render the refresh control for non-admin users', async () => {
    mockUser.role = 'user';
    api.get.mockResolvedValue({
      data: { dataAsOf: '2024-01-01T00:00:00Z', totals: {} },
    });

    renderPage();

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/payments/analytics');
    });

    expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
