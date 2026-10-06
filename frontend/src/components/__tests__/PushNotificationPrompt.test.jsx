import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import PushNotificationPrompt from '../PushNotificationPrompt';

// Mock localStorage so we can assert on what gets persisted
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// jsdom has no Notification; the component falls back to 'default'
describe('PushNotificationPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders Enable and Not now buttons when permission is default', () => {
    render(<PushNotificationPrompt onDismiss={() => {}} />);
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Don't ask again" })).toBeInTheDocument();
  });

  test('"Not now" stores a deferral timestamp and dismisses', () => {
    const onDismiss = jest.fn();
    render(<PushNotificationPrompt onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'notifications_deferred',
      expect.stringMatching(/^\d+$/)
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('"Don\'t ask again" stores a durable opt-out and dismisses', () => {
    const onDismiss = jest.fn();
    render(<PushNotificationPrompt onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: "Don't ask again" }));

    expect(localStorageMock.setItem).toHaveBeenCalledWith('notifications_dismissed', 'true');
    expect(localStorageMock.setItem).not.toHaveBeenCalledWith(
      'notifications_deferred',
      expect.anything()
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test('shows browser-settings guidance when permission is denied', () => {
    global.Notification = { permission: 'denied' };
    render(<PushNotificationPrompt onDismiss={() => {}} />);

    expect(
      screen.getByText(/Enable notifications in your browser settings/i)
    ).toBeInTheDocument();
    delete global.Notification;
  });
});
