/**
 * usePaymentStream.connectionState.test.js
 *
 * Tests the connectionState enum field exposed by usePaymentStream, verifying
 * that the state machine transitions correctly through the
 * connected → reconnecting → disconnected lifecycle.
 *
 * Complements the existing usePaymentStream.test.js suite which tests the
 * underlying boolean flags (isConnected, isReconnecting) and reconnect logic.
 * This file focuses purely on the unified CONNECTION_STATE enum.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { usePaymentStream, CONNECTION_STATE } from '../usePaymentStream';

// ─── Mock Stellar SDK ─────────────────────────────────────────────────────────

const mockState = {
  handlers: {},
  close: jest.fn(),
};

jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: jest.fn().mockImplementation(() => ({
      payments: jest.fn().mockReturnValue({
        forAccount: jest.fn().mockReturnThis(),
        cursor: jest.fn().mockReturnThis(),
        stream: jest.fn().mockImplementation((handlers) => {
          mockState.handlers = handlers;
          return mockState.close;
        }),
      }),
    })),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PUBLIC_KEY = 'GCONNTEST123456789012345678901234567890';

const makePayment = (overrides = {}) => ({
  id: 'pay-cs-1',
  type: 'payment',
  from: 'GSENDER',
  to: PUBLIC_KEY,
  amount: '5',
  asset_type: 'native',
  created_at: '2024-01-01T00:00:00Z',
  transaction_hash: 'deadbeef',
  paging_token: 'tok-1',
  ...overrides,
});

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  mockState.handlers = {};
  mockState.close = jest.fn();

  const { Horizon } = require('@stellar/stellar-sdk');
  Horizon.Server.mockImplementation(() => ({
    payments: jest.fn().mockReturnValue({
      forAccount: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      stream: jest.fn().mockImplementation((handlers) => {
        mockState.handlers = handlers;
        return mockState.close;
      }),
    }),
  }));
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('usePaymentStream — connectionState enum', () => {
  test('starts as DISCONNECTED before any message arrives', () => {
    const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));
    expect(result.current.connectionState).toBe(CONNECTION_STATE.DISCONNECTED);
  });

  test('transitions to CONNECTED after first payment message', async () => {
    const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

    act(() => {
      mockState.handlers.onmessage(makePayment());
    });

    await waitFor(() =>
      expect(result.current.connectionState).toBe(CONNECTION_STATE.CONNECTED),
    );
  });

  test('transitions to RECONNECTING on stream error (exponential backoff scheduled)', async () => {
    const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

    // First establish connected state
    act(() => { mockState.handlers.onmessage(makePayment()); });
    await waitFor(() => expect(result.current.connectionState).toBe(CONNECTION_STATE.CONNECTED));

    // Drop the connection
    act(() => { mockState.handlers.onerror(new Error('socket closed')); });

    await waitFor(() =>
      expect(result.current.connectionState).toBe(CONNECTION_STATE.RECONNECTING),
    );
    // Still not DISCONNECTED — a timer is pending
    expect(result.current.connectionState).not.toBe(CONNECTION_STATE.DISCONNECTED);
  });

  test('transitions from RECONNECTING back to CONNECTED when stream re-opens and delivers a message', async () => {
    const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

    act(() => { mockState.handlers.onmessage(makePayment()); });
    await waitFor(() => expect(result.current.connectionState).toBe(CONNECTION_STATE.CONNECTED));

    // Simulate drop
    act(() => { mockState.handlers.onerror(new Error('drop')); });
    await waitFor(() => expect(result.current.connectionState).toBe(CONNECTION_STATE.RECONNECTING));

    // Advance timers so the backoff fires and connect() is called again
    // (this updates mockState.handlers to the new stream's handlers)
    act(() => { jest.runAllTimers(); });

    // Deliver a message on the new stream
    act(() => { mockState.handlers.onmessage(makePayment({ paging_token: 'tok-2' })); });

    await waitFor(() =>
      expect(result.current.connectionState).toBe(CONNECTION_STATE.CONNECTED),
    );
  });

  test('transitions to DISCONNECTED after max reconnect attempts exhausted', async () => {
    const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

    // Exhaust all 10 attempts
    for (let i = 0; i < 10; i++) {
      act(() => { mockState.handlers.onerror(new Error('fail')); });
      act(() => { jest.runAllTimers(); }); // fires reconnect → updates handlers
    }
    // 11th error with no more budget
    act(() => { mockState.handlers.onerror(new Error('final fail')); });

    await waitFor(() =>
      expect(result.current.connectionState).toBe(CONNECTION_STATE.DISCONNECTED),
    );
    expect(result.current.error).toMatch(/Max reconnect attempts reached/);
  });

  test('transitions to DISCONNECTED when browser goes offline', async () => {
    const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

    act(() => { mockState.handlers.onmessage(makePayment()); });
    await waitFor(() => expect(result.current.connectionState).toBe(CONNECTION_STATE.CONNECTED));

    act(() => { window.dispatchEvent(new Event('offline')); });

    await waitFor(() =>
      expect(result.current.connectionState).toBe(CONNECTION_STATE.DISCONNECTED),
    );
  });

  test('transitions back to CONNECTED when browser comes back online', async () => {
    const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

    // Confirm initial disconnected state
    expect(result.current.connectionState).toBe(CONNECTION_STATE.DISCONNECTED);

    // Simulate browser coming online — this triggers a reconnect() call in the hook
    act(() => { window.dispatchEvent(new Event('online')); });

    // After online event, connect() is called and a new stream is opened;
    // deliver a message to confirm connectivity
    act(() => { mockState.handlers.onmessage(makePayment()); });

    await waitFor(() =>
      expect(result.current.connectionState).toBe(CONNECTION_STATE.CONNECTED),
    );
  });

  test('disconnect() sets connectionState to DISCONNECTED', async () => {
    const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

    act(() => { mockState.handlers.onmessage(makePayment()); });
    await waitFor(() => expect(result.current.connectionState).toBe(CONNECTION_STATE.CONNECTED));

    act(() => { result.current.disconnect(); });

    await waitFor(() =>
      expect(result.current.connectionState).toBe(CONNECTION_STATE.DISCONNECTED),
    );
  });

  test('backoff is exponential: second attempt waits longer than first', () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

    renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

    // First error → 1st reconnect timer (BASE_DELAY_MS * 2^0 = 1000ms)
    act(() => { mockState.handlers.onerror(new Error('drop 1')); });
    const firstDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];

    act(() => { jest.runAllTimers(); }); // fires 1st reconnect

    // Second error → 2nd reconnect timer (BASE_DELAY_MS * 2^1 = 2000ms)
    act(() => { mockState.handlers.onerror(new Error('drop 2')); });
    const secondDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];

    expect(secondDelay).toBeGreaterThan(firstDelay);

    setTimeoutSpy.mockRestore();
  });
});
