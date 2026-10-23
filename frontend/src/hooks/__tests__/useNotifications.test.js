import { renderHook, act, waitFor } from '@testing-library/react';

const handlers = {};
jest.mock('socket.io-client', () => ({
  io: () => ({ on: (e, fn) => { handlers[e] = fn; }, disconnect: jest.fn() }),
}));
jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(() => Promise.resolve({ data: { count: 0, data: [] } })) },
}));
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1 } }),
  tokenStore: { get: () => 'tok', subscribe: () => () => {} },
}));

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
