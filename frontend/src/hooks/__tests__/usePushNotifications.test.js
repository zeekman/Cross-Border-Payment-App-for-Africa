import { renderHook } from '@testing-library/react';
import { usePushNotifications } from '../usePushNotifications';

// Mock localStorage so each test controls the stored values
const localStorageMock = {
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  clear: jest.fn(),
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock });

const DAY_MS = 24 * 60 * 60 * 1000;
const realNotification = global.Notification;

describe('usePushNotifications shouldShowPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorageMock.getItem.mockReturnValue(null);
    global.Notification = realNotification;
  });

  const render = () => renderHook(() => usePushNotifications()).result;

  test('shows the prompt when nothing has been stored yet', () => {
    const { current } = render();
    expect(current.shouldShowPrompt()).toBe(true);
  });

  test('hides the prompt when permission is already granted', () => {
    global.Notification = { permission: 'granted' };
    const { current } = render();
    expect(current.shouldShowPrompt()).toBe(false);
  });

  test('does not re-prompt while the 7-day deferral is still active', () => {
    // Deferred 1 day ago — timestamp stored as ms string
    localStorageMock.getItem.mockImplementation((key) =>
      key === 'notifications_deferred'
        ? String(Date.now() - 1 * DAY_MS)
        : null
    );
    const { current } = render();
    expect(current.shouldShowPrompt()).toBe(false);
  });

  test('does not re-prompt at exactly 7 days (strict boundary, no off-by-one)', () => {
    localStorageMock.getItem.mockImplementation((key) =>
      key === 'notifications_deferred'
        ? String(Date.now() - 7 * DAY_MS)
        : null
    );
    const { current } = render();
    expect(current.shouldShowPrompt()).toBe(false);
  });

  test('re-prompts once more than 7 days have elapsed', () => {
    localStorageMock.getItem.mockImplementation((key) =>
      key === 'notifications_deferred'
        ? String(Date.now() - 8 * DAY_MS)
        : null
    );
    const { current } = render();
    expect(current.shouldShowPrompt()).toBe(true);
  });

  test('never re-prompts once the user has chosen "don\'t ask again"', () => {
    localStorageMock.getItem.mockImplementation((key) =>
      key === 'notifications_dismissed' ? 'true' : null
    );
    const { current } = render();
    expect(current.shouldShowPrompt()).toBe(false);
  });

  test('durable dismiss wins even after the 7-day deferral has expired', () => {
    localStorageMock.getItem.mockImplementation((key) => {
      if (key === 'notifications_dismissed') return 'true';
      if (key === 'notifications_deferred') return String(Date.now() - 30 * DAY_MS);
      return null;
    });
    const { current } = render();
    expect(current.shouldShowPrompt()).toBe(false);
  });
});
