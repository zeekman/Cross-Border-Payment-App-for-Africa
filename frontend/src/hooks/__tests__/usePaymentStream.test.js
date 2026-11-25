import { renderHook, act, waitFor } from '@testing-library/react';
import { usePaymentStream } from '../usePaymentStream';

// ─── Mock Stellar SDK ────────────────────────────────────────────────────────
// jest.mock is hoisted, so the factory must be self-contained.
// We expose mutable state via a module-level object that tests can read/write.

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PUBLIC_KEY = 'GTEST1234567890ABCDEF';

const makePayment = (overrides = {}) => ({
  id: 'pay-1',
  type: 'payment',
  from: 'GSENDER',
  to: PUBLIC_KEY,
  amount: '10.5',
  asset_type: 'native',
  asset_code: undefined,
  created_at: '2024-01-01T00:00:00Z',
  transaction_hash: 'abc123',
  paging_token: 'token-1',
  ...overrides,
});

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  mockState.handlers = {};
  mockState.close = jest.fn();
  // Re-wire the stream mock so each test gets a fresh close fn
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

describe('usePaymentStream', () => {
  describe('initial state', () => {
    it('returns disconnected state before stream opens', () => {
      const { result } = renderHook(() => usePaymentStream(null, jest.fn()));
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isReconnecting).toBe(false);
      expect(result.current.error).toBe(null);
    });

    it('does not open a stream when publicKey is null', () => {
      const { Horizon } = require('@stellar/stellar-sdk');
      renderHook(() => usePaymentStream(null, jest.fn()));
      expect(Horizon.Server).not.toHaveBeenCalled();
    });
  });

  describe('normal subscription flow', () => {
    it('opens a stream for the given publicKey with cursor "now"', () => {
      const { Horizon } = require('@stellar/stellar-sdk');
      renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));
      const server = Horizon.Server.mock.results[0].value;
      expect(server.payments).toHaveBeenCalled();
      const builder = server.payments();
      expect(builder.forAccount).toHaveBeenCalledWith(PUBLIC_KEY);
      expect(builder.cursor).toHaveBeenCalledWith('now');
      expect(builder.stream).toHaveBeenCalled();
    });

    it('calls onPayment with normalised payload on native payment', () => {
      const onPayment = jest.fn();
      renderHook(() => usePaymentStream(PUBLIC_KEY, onPayment));

      act(() => { mockState.handlers.onmessage(makePayment()); });

      expect(onPayment).toHaveBeenCalledWith({
        id: 'pay-1',
        type: 'payment',
        from: 'GSENDER',
        to: PUBLIC_KEY,
        amount: '10.5',
        asset: 'XLM',
        createdAt: '2024-01-01T00:00:00Z',
        transactionHash: 'abc123',
      });
    });

    it('maps non-native asset_code to asset field', () => {
      const onPayment = jest.fn();
      renderHook(() => usePaymentStream(PUBLIC_KEY, onPayment));

      act(() => {
        mockState.handlers.onmessage(
          makePayment({ asset_type: 'credit_alphanum4', asset_code: 'USDC' }),
        );
      });

      expect(onPayment).toHaveBeenCalledWith(expect.objectContaining({ asset: 'USDC' }));
    });

    it('sets isConnected true after first payment message', async () => {
      const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

      act(() => { mockState.handlers.onmessage(makePayment()); });

      await waitFor(() => expect(result.current.isConnected).toBe(true));
      expect(result.current.error).toBe(null);
    });
  });

  describe('cleanup on unmount', () => {
    it('calls close() on the stream when the component unmounts', () => {
      const { unmount } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));
      const closeFn = mockState.close;
      unmount();
      expect(closeFn).toHaveBeenCalledTimes(1);
    });

    it('does not invoke onPayment after unmount', () => {
      const onPayment = jest.fn();
      const { unmount } = renderHook(() => usePaymentStream(PUBLIC_KEY, onPayment));

      unmount();

      act(() => { mockState.handlers.onmessage(makePayment()); });

      expect(onPayment).not.toHaveBeenCalled();
    });

    it('suppresses state updates after unmount', () => {
      const { result, unmount } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

      unmount();

      act(() => {
        mockState.handlers.onmessage(makePayment());
        mockState.handlers.onerror(new Error('late error'));
        mockState.handlers.onclose();
      });

      expect(result.current.isConnected).toBe(false);
      expect(result.current.error).toBe(null);
    });

    it('cancels pending reconnect timer on unmount', () => {
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
      const { unmount } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

      act(() => { mockState.handlers.onerror(new Error('disconnect')); });
      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('calls close() when publicKey changes (dependency cleanup)', () => {
      const closeFn = mockState.close;
      const { rerender } = renderHook(
        ({ pk }) => usePaymentStream(pk, jest.fn()),
        { initialProps: { pk: PUBLIC_KEY } },
      );

      rerender({ pk: 'GNEWKEY' });

      expect(closeFn).toHaveBeenCalledTimes(1);
    });

    it('removes online/offline listeners on unmount', () => {
      const removeSpy = jest.spyOn(window, 'removeEventListener');
      const { unmount } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

      unmount();

      expect(removeSpy).toHaveBeenCalledWith('online', expect.any(Function));
      expect(removeSpy).toHaveBeenCalledWith('offline', expect.any(Function));
      removeSpy.mockRestore();
    });
  });

  describe('error handling and reconnection', () => {
    it('sets error and isReconnecting on stream error', async () => {
      const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

      act(() => { mockState.handlers.onerror(new Error('network failure')); });

      await waitFor(() => expect(result.current.isReconnecting).toBe(true));
      expect(result.current.error).toMatch(/Reconnecting/);
      expect(result.current.isConnected).toBe(false);
    });

    it('schedules reconnect with exponential backoff on error', () => {
      const { Horizon } = require('@stellar/stellar-sdk');
      renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));
      const callsBefore = Horizon.Server.mock.calls.length;

      act(() => { mockState.handlers.onerror(new Error('disconnect')); });
      act(() => { jest.advanceTimersByTime(1000); });

      expect(Horizon.Server.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it('stops reconnecting after MAX_RECONNECT_ATTEMPTS', async () => {
      const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

      // Each onerror schedules a reconnect; running timers fires connect() which
      // overwrites mockState.handlers with the new stream's handlers.
      // We must trigger onerror on the *current* handlers after each reconnect.
      for (let i = 0; i < 10; i += 1) {
        act(() => { mockState.handlers.onerror(new Error('fail')); });
        act(() => { jest.runAllTimers(); }); // fires reconnect, updates mockState.handlers
      }
      // On the 10th attempt the counter is exhausted — no more timer is scheduled
      act(() => { mockState.handlers.onerror(new Error('fail')); });

      await waitFor(() => expect(result.current.isReconnecting).toBe(false));
      expect(result.current.error).toMatch(/Max reconnect attempts reached/);
    });

    it('sets isConnected false on onclose', async () => {
      const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));

      act(() => { mockState.handlers.onmessage(makePayment()); });
      await waitFor(() => expect(result.current.isConnected).toBe(true));

      act(() => { mockState.handlers.onclose(); });
      await waitFor(() => expect(result.current.isConnected).toBe(false));
    });
  });

  describe('manual controls', () => {
    it('disconnect() closes the stream and sets isConnected false', async () => {
      const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));
      const closeFn = mockState.close;

      act(() => { mockState.handlers.onmessage(makePayment()); });
      await waitFor(() => expect(result.current.isConnected).toBe(true));

      act(() => { result.current.disconnect(); });

      expect(closeFn).toHaveBeenCalled();
      await waitFor(() => expect(result.current.isConnected).toBe(false));
    });

    it('reconnect() opens a new stream', () => {
      const { Horizon } = require('@stellar/stellar-sdk');
      const { result } = renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));
      const callsBefore = Horizon.Server.mock.calls.length;

      act(() => { result.current.reconnect(); });

      expect(Horizon.Server.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  describe('online/offline events', () => {
    it('triggers reconnect when browser comes back online while disconnected', () => {
      const { Horizon } = require('@stellar/stellar-sdk');
      renderHook(() => usePaymentStream(PUBLIC_KEY, jest.fn()));
      const callsBefore = Horizon.Server.mock.calls.length;

      act(() => { window.dispatchEvent(new Event('online')); });

      expect(Horizon.Server.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
