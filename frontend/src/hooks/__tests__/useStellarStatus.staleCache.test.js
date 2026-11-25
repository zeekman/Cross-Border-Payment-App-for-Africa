/**
 * useStellarStatus.staleCache.test.js
 *
 * Tests the max-age / isStale behaviour added to useStellarStatus:
 *
 *  - A cached status older than CACHE_MAX_AGE (10 min) is NOT surfaced as
 *    current; instead isStale=true and status=null are returned so the UI can
 *    show an explicit "status unknown" state.
 *  - An error during a background refresh that leaves the cache stale also
 *    sets isStale=true and reports to Sentry.
 *  - A cache entry within CACHE_MAX_AGE is still returned normally even if a
 *    fresh fetch fails.
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import * as Sentry from '@sentry/react';
import { useStellarStatus } from '../useStellarStatus';

// ─── Mocks ────────────────────────────────────────────────────────────────────

global.fetch = jest.fn();

// Drive localStorage through a plain object — no `this` binding issues.
// We reassign `lsStore` in beforeEach to clear between tests.
let lsStore = {};

// Override localStorage directly on globalThis so both window.localStorage
// and the bare `localStorage` identifier inside the hook resolve to the same
// object.  Using Object.defineProperty with configurable:true so we can reset.
const lsMock = {
  getItem:    (key) => lsStore[key] ?? null,
  setItem:    (key, val) => { lsStore[key] = val; },
  removeItem: (key) => { delete lsStore[key]; },
  clear:      () => { lsStore = {}; },
};

Object.defineProperty(window, 'localStorage', {
  value: lsMock,
  writable: true,
  configurable: true,
});

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  lsStore = {};                         // reset storage between tests
  fetch.mockReset();                    // clear call history + return values
  Sentry.captureException.mockReset();  // clear call history
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Constants (must match the hook) ──────────────────────────────────────────

const CACHE_KEY      = 'stellar_status_cache';
const CACHE_MAX_AGE  = 10 * 60 * 1000; // 10 minutes
const CACHE_DURATION =  5 * 60 * 1000; // 5 minutes

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OPERATIONAL = { status: 'All Systems Operational', components: [] };
const OUTAGE      = { status: 'Partial System Outage',   components: [] };

/** Write a cache entry with the given data and artificial age. */
function setCachedStatus(data, ageMs) {
  lsStore[CACHE_KEY] = JSON.stringify({
    data,
    timestamp: Date.now() - ageMs,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useStellarStatus — stale cache / isStale', () => {
  test('cached status older than CACHE_MAX_AGE sets isStale=true and status=null', async () => {
    // Plant a cache entry that is 11 minutes old (> 10-min max-age)
    setCachedStatus(OPERATIONAL, CACHE_MAX_AGE + 60_000);

    // The fresh fetch also fails — simulating sustained outage
    fetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useStellarStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // The stale cache must NOT be surfaced as a current healthy status
    expect(result.current.isStale).toBe(true);
    expect(result.current.status).toBe(null);
    expect(result.current.isDegraded).toBe(false);
  });

  test('cached status within CACHE_MAX_AGE is returned even when fresh fetch fails', async () => {
    // Plant a cache entry that is 7 minutes old (between CACHE_DURATION and CACHE_MAX_AGE)
    setCachedStatus(OPERATIONAL, 7 * 60 * 1000);

    fetch.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useStellarStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Within max-age — old status is still acceptable to show
    expect(result.current.isStale).toBe(false);
  });

  test('fresh cache (< CACHE_DURATION) always has isStale=false', async () => {
    // 1-minute-old cache entry — well within both CACHE_DURATION and CACHE_MAX_AGE
    setCachedStatus(OPERATIONAL, 60_000);

    const { result } = renderHook(() => useStellarStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isStale).toBe(false);
    expect(result.current.status).toEqual(OPERATIONAL);
    // Network should NOT have been called — cache is fresh
    expect(fetch).not.toHaveBeenCalled();
  });

  test('successful fresh fetch clears isStale even if cache was stale', async () => {
    // Start with a stale cache
    setCachedStatus(OPERATIONAL, CACHE_MAX_AGE + 60_000);

    // But the network fetch succeeds with fresh data
    fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(OUTAGE),
    });

    const { result } = renderHook(() => useStellarStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isStale).toBe(false);
    expect(result.current.status).toEqual(OUTAGE);
  });

  test('background refresh error with stale cache reports to Sentry', async () => {
    // Plant a stale cache (> CACHE_MAX_AGE)
    setCachedStatus(OPERATIONAL, CACHE_MAX_AGE + 60_000);

    // All fetches fail
    fetch.mockRejectedValue(new Error('Horizon down'));

    const { result } = renderHook(() => useStellarStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Sentry should have been notified
    expect(Sentry.captureException).toHaveBeenCalled();
    const [capturedError] = Sentry.captureException.mock.calls[0];
    expect(capturedError.message).toBe('Horizon down');
  });

  test('background refresh error within max-age does NOT report stale state', async () => {
    // Cache is 3 minutes old — within both limits, so it's used as-is without fetching
    setCachedStatus(OPERATIONAL, 3 * 60 * 1000);

    fetch.mockRejectedValue(new Error('transient error'));

    const { result } = renderHook(() => useStellarStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Fresh cache path returns early — no error, no stale
    expect(result.current.isStale).toBe(false);
    // Since cache is < CACHE_DURATION the hook returned early without fetching
    expect(fetch).not.toHaveBeenCalled();
  });

  test('no cache at all with failed fetch sets isStale=true', async () => {
    // No cache in localStorage
    fetch.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useStellarStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isStale).toBe(true);
    expect(result.current.status).toBe(null);
  });

  test('refetch() succeeds and clears isStale from stale state', async () => {
    // Start stale
    setCachedStatus(OPERATIONAL, CACHE_MAX_AGE + 60_000);
    fetch.mockRejectedValueOnce(new Error('initial fail'));

    const { result } = renderHook(() => useStellarStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isStale).toBe(true);

    // Network recovers
    fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(OPERATIONAL),
    });

    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.isStale).toBe(false);
    expect(result.current.status).toEqual(OPERATIONAL);
  });
});
