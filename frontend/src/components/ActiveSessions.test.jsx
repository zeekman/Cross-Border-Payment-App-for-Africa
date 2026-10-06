/**
 * Unit tests for the revoke-all-sessions warning (FE-024).
 *
 * Key assertions:
 *  - Clicking "Revoke all other sessions" opens a ConfirmModal.
 *  - Default modal copy says current device is KEPT (keep_current behaviour).
 *  - The "Include this device" secondary action switches the copy to warn about
 *    signing out the current device too.
 *  - The bulk action cannot be submitted without the confirmation step.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ActiveSessions } from './ActiveSessions';
import api from '../utils/api';

jest.mock('../utils/api');

const CURRENT_SESSION_ID = 'sess-current';

const mockSessions = [
  {
    id: CURRENT_SESSION_ID,
    device: 'Chrome on macOS',
    ipAddress: '192.168.1.1',
    lastActiveAt: new Date().toISOString(),
  },
  {
    id: 'sess-other-1',
    device: 'Firefox on Windows',
    ipAddress: '192.168.1.2',
    lastActiveAt: new Date().toISOString(),
  },
  {
    id: 'sess-other-2',
    device: 'Safari on iPhone',
    ipAddress: '192.168.1.3',
    lastActiveAt: new Date().toISOString(),
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: { sessions: mockSessions } });
});

describe('ActiveSessions — FE-024 revoke-all warning', () => {
  it('shows "Revoke all other sessions" button when multiple sessions exist', async () => {
    render(<ActiveSessions currentSessionId={CURRENT_SESSION_ID} />);
    const btn = await screen.findByTestId('revoke-all-button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('Revoke all other sessions');
  });

  it('opens a confirmation modal when the revoke-all button is clicked', async () => {
    render(<ActiveSessions currentSessionId={CURRENT_SESSION_ID} />);
    fireEvent.click(await screen.findByTestId('revoke-all-button'));

    // ConfirmModal renders a header title — check for the h3 specifically
    expect(
      screen.getByRole('heading', { name: /revoke all other sessions\?/i })
    ).toBeInTheDocument();
  });

  it('default modal copy states the current device is PRESERVED (not signed out)', async () => {
    render(<ActiveSessions currentSessionId={CURRENT_SESSION_ID} />);
    fireEvent.click(await screen.findByTestId('revoke-all-button'));

    expect(
      screen.getByText(/you will remain logged in on this device/i)
    ).toBeInTheDocument();
  });

  it('does NOT show the all-device-logout warning in the default (others-only) scope', async () => {
    render(<ActiveSessions currentSessionId={CURRENT_SESSION_ID} />);
    fireEvent.click(await screen.findByTestId('revoke-all-button'));

    expect(
      screen.queryByText(/this will sign you out of every device.*including the one you are currently using/i)
    ).not.toBeInTheDocument();
  });

  it('switches to all-device warning when "Include this device" is clicked', async () => {
    render(<ActiveSessions currentSessionId={CURRENT_SESSION_ID} />);
    fireEvent.click(await screen.findByTestId('revoke-all-button'));

    // Secondary action
    fireEvent.click(screen.getByTestId('active-sessions-include-this-device'));

    expect(
      screen.getByText(/this will sign you out of every device.*including the one you are currently using/i)
    ).toBeInTheDocument();
  });

  it('does not call the API until the user confirms the modal', async () => {
    render(<ActiveSessions currentSessionId={CURRENT_SESSION_ID} />);
    fireEvent.click(await screen.findByTestId('revoke-all-button'));

    // Modal is open but user has NOT clicked confirm
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('calls DELETE /auth/sessions?except=current when scope is "others" and user confirms', async () => {
    api.delete.mockResolvedValue({});
    render(<ActiveSessions currentSessionId={CURRENT_SESSION_ID} />);
    fireEvent.click(await screen.findByTestId('revoke-all-button'));

    // Click the confirm button inside ConfirmModal
    const confirmBtn = screen.getByText(/revoke all other sessions/i, { selector: 'button[type="button"]' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(api.delete).toHaveBeenCalledWith('/auth/sessions?except=current');
    });
  });
});
