import { renderHook, act, waitFor } from '@testing-library/react';

const handlers = {};
jest.mock('socket.io-client', () => ({
  io: () => ({ on: (e, fn) => { handlers[e] = fn; }, disconnect: jest.fn() }),
}));
jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(() => Promise.resolve({ data: { count: 0, data: [] } })) },
}));
// A stable user object, like the real AuthContext: a fresh object per render would re-run every effect.
const mockUser = { id: 1 };
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser }),
  tokenStore: { get: () => 'tok', subscribe: () => () => {} },
}));

import api from '../../utils/api';
import { useNotifications } from '../useNotifications';

test('same notification id received twice yields one item and +1 unread', async () => {
  const { result } = renderHook(() => useNotifications());
  await waitFor(() => expect(handlers['notification:new']).toBeDefined());
  const n = { id: 'a', title: 'Paid', created_at: new Date().toISOString() };
  act(() => { handlers['notification:new'](n); });
  act(() => { handlers['notification:new'](n); });
  expect(result.current.items).toHaveLength(1);
  expect(result.current.unreadCount).toBe(1);
});

describe('unread-count polling (FE-198)', () => {
  const POLL_INTERVAL_MS = 60_000;
  const unreadCalls = () => api.get.mock.calls.filter(([url]) => url.includes('unread-count')).length;
  let visibility;

  const flush = () => act(async () => { await jest.advanceTimersByTimeAsync(0); });
  const advance = (ms) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
  const setVisibility = (state) => {
    visibility = state;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    api.get.mockClear();
    Object.keys(handlers).forEach((key) => delete handlers[key]);
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete document.visibilityState;
  });

  test('polls on an interval while the socket is not connected', async () => {
    renderHook(() => useNotifications());
    await flush();
    const afterMount = unreadCalls();
    expect(afterMount).toBeGreaterThanOrEqual(1);

    await advance(POLL_INTERVAL_MS);
    expect(unreadCalls()).toBe(afterMount + 1);
  });

  test('does not poll while the socket is connected', async () => {
    renderHook(() => useNotifications());
    await flush();

    act(() => { handlers.connect(); });
    await flush();
    const afterConnect = unreadCalls(); // one refresh to close the gap on connect

    await advance(5 * POLL_INTERVAL_MS);
    expect(unreadCalls()).toBe(afterConnect);
  });

  test('refreshes and resumes polling when the socket drops', async () => {
    renderHook(() => useNotifications());
    await flush();
    act(() => { handlers.connect(); });
    await flush();
    const whileConnected = unreadCalls();

    act(() => { handlers.disconnect(); });
    await flush();
    expect(unreadCalls()).toBe(whileConnected + 1); // refresh to cover the gap

    await advance(POLL_INTERVAL_MS);
    expect(unreadCalls()).toBe(whileConnected + 2); // and polling is back
  });

  test('a failed connection counts as not connected, so polling continues', async () => {
    renderHook(() => useNotifications());
    await flush();
    act(() => { handlers.connect(); });
    await flush();
    act(() => { handlers.connect_error(new Error('boom')); });
    await flush();
    const afterError = unreadCalls();

    await advance(POLL_INTERVAL_MS);
    expect(unreadCalls()).toBe(afterError + 1);
  });

  test('does not poll in a hidden tab, and refreshes when it becomes visible', async () => {
    renderHook(() => useNotifications());
    await flush();

    setVisibility('hidden');
    const whenHidden = unreadCalls();
    await advance(5 * POLL_INTERVAL_MS);
    expect(unreadCalls()).toBe(whenHidden);

    setVisibility('visible');
    await flush();
    expect(unreadCalls()).toBe(whenHidden + 1);
  });
});
