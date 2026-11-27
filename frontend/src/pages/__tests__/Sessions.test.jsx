import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Sessions from '../Sessions';
import api from '../../services/api';
import { renderWithProviders } from '../../testUtils';

jest.mock('../../services/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockSessions = [
  {
    id: 'sess-1',
    device: 'Chrome on macOS',
    ip: '192.168.1.10',
    location: 'San Francisco, US',
    lastActive: '2024-01-15T10:30:00Z',
    current: true,
  },
  {
    id: 'sess-2',
    device: 'Safari on iPhone',
    ip: '10.0.0.42',
    location: 'New York, US',
    lastActive: '2024-01-14T08:00:00Z',
    current: false,
  },
];

const renderSessions = () =>
  renderWithProviders(
    <MemoryRouter>
      <Sessions />
    </MemoryRouter>
  );

describe('Sessions page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initial render', () => {
    it('shows a loading state while fetching sessions', async () => {
      let resolveGet;
      api.get.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveGet = resolve;
          })
      );

      renderSessions();

      expect(
        screen.getByText(/loading/i) || screen.getByRole('progressbar')
      ).toBeInTheDocument();

      resolveGet({ data: mockSessions });
      await waitFor(() => {
        expect(screen.getByText(/Chrome on macOS/)).toBeInTheDocument();
      });
    });

    it('renders an empty state when there are no sessions', async () => {
      api.get.mockResolvedValue({ data: [] });

      renderSessions();

      await waitFor(() => {
        expect(screen.getByText(/no (active )?sessions/i)).toBeInTheDocument();
      });
    });

    it('renders an error state when the initial fetch fails', async () => {
      api.get.mockRejectedValue(new Error('Network error'));

      renderSessions();

      await waitFor(() => {
        expect(
          screen.getByText(/failed to load sessions|something went wrong|error/i)
        ).toBeInTheDocument();
      });
    });
  });

  describe('happy path', () => {
    it('renders the list of active sessions', async () => {
      api.get.mockResolvedValue({ data: mockSessions });

      renderSessions();

      await waitFor(() => {
        expect(screen.getByText(/Chrome on macOS/)).toBeInTheDocument();
      });
      expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
      expect(screen.getByText(/192\.168\.1\.10/)).toBeInTheDocument();
      expect(screen.getByText(/San Francisco, US/)).toBeInTheDocument();
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('revokes a single session and refreshes the list', async () => {
      api.get.mockResolvedValueOnce({ data: mockSessions });
      api.delete.mockResolvedValueOnce({ data: { success: true } });
      api.get.mockResolvedValueOnce({ data: [mockSessions[0]] });

      renderSessions();

      await waitFor(() => {
        expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
      });

      const revokeButtons = screen.getAllByRole('button', {
        name: /revoke|sign out|remove/i,
      });
      await userEvent.click(revokeButtons[revokeButtons.length - 1]);

      await waitFor(() => {
        expect(api.delete).toHaveBeenCalledTimes(1);
      });
      expect(api.delete).toHaveBeenCalledWith(
        expect.stringContaining('sess-2'),
        expect.anything()
      );

      await waitFor(() => {
        expect(screen.queryByText(/Safari on iPhone/)).not.toBeInTheDocument();
      });
    });

    it('revokes all other sessions with a single request', async () => {
      api.get.mockResolvedValueOnce({ data: mockSessions });
      api.delete.mockResolvedValueOnce({ data: { success: true } });
      api.get.mockResolvedValueOnce({ data: [mockSessions[0]] });

      renderSessions();

      await waitFor(() => {
        expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
      });

      const revokeAllButton = screen.getByRole('button', {
        name: /revoke all|sign out (of )?all|log out (of )?all/i,
      });
      await userEvent.click(revokeAllButton);

      await waitFor(() => {
        expect(api.delete).toHaveBeenCalledTimes(1);
      });
      expect(api.delete).toHaveBeenCalledWith(
        expect.stringMatching(/sessions(\/others)?$/),
        expect.anything()
      );
    });
  });

  describe('validation errors', () => {
    it('requires confirmation before revoking all sessions', async () => {
      api.get.mockResolvedValue({ data: mockSessions });

      renderSessions();

      await waitFor(() => {
        expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
      });

      const revokeAllButton = screen.getByRole('button', {
        name: /revoke all|sign out (of )?all|log out (of )?all/i,
      });
      await userEvent.click(revokeAllButton);

      // A confirmation dialog should appear and no request should be sent yet.
      expect(
        screen.getByText(/are you sure|confirm/i)
      ).toBeInTheDocument();
      expect(api.delete).not.toHaveBeenCalled();
    });

    it('does not revoke when the confirmation is cancelled', async () => {
      api.get.mockResolvedValue({ data: mockSessions });

      renderSessions();

      await waitFor(() => {
        expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
      });

      const revokeAllButton = screen.getByRole('button', {
        name: /revoke all|sign out (of )?all|log out (of )?all/i,
      });
      await userEvent.click(revokeAllButton);

      const cancelButton = screen.getByRole('button', { name: /cancel/i });
      await userEvent.click(cancelButton);

      expect(api.delete).not.toHaveBeenCalled();
    });
  });

  describe('API error handling', () => {
    it('shows an error message when revoking a session fails', async () => {
      api.get.mockResolvedValue({ data: mockSessions });
      api.delete.mockRejectedValueOnce(new Error('Server error'));

      renderSessions();

      await waitFor(() => {
        expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
      });

      const revokeButtons = screen.getAllByRole('button', {
        name: /revoke|sign out|remove/i,
      });
      await userEvent.click(revokeButtons[revokeButtons.length - 1]);

      await waitFor(() => {
        expect(
          screen.getByText(/failed to revoke|something went wrong|error/i)
        ).toBeInTheDocument();
      });
      // The session should still be visible after a failed revoke.
      expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
    });

    it('shows an error message when revoking all sessions fails', async () => {
      api.get.mockResolvedValue({ data: mockSessions });
      api.delete.mockRejectedValueOnce(new Error('Server error'));

      renderSessions();

      await waitFor(() => {
        expect(screen.getByText(/Safari on iPhone/)).toBeInTheDocument();
      });

      const revokeAllButton = screen.getByRole('button', {
        name: /revoke all|sign out (of )?all|log out (of )?all/i,
      });
      await userEvent.click(revokeAllButton);

      const confirmButton = screen.queryByRole('button', {
        name: /confirm|yes|revoke/i,
      });
      if (confirmButton) {
        await userEvent.click(confirmButton);
      }

      await waitFor(() => {
        expect(
          screen.getByText(/failed to revoke|something went wrong|error/i)
        ).toBeInTheDocument();
      });
    });
  });
});