import { useState, useEffect, useRef } from 'react';
import * as Sentry from '@sentry/react';

const STATUS_API_URL = 'https://status.stellar.org/api/v2/status.json';
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CACHE_KEY = 'stellar_status_cache';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes — skip network on initial load

/**
 * Maximum age beyond which a cached status is considered stale.
 *
 * If the background refresh has been silently failing for this long the hook
 * clears the displayed status and returns `isStale: true` rather than
 * continuing to surface an old "healthy" value.  Callers should show an
 * explicit "status unknown" state when `isStale` is true.
 *
 * Set to 2× the poll interval so a single missed tick never triggers a stale
 * state — only a sustained failure does.
 */
const CACHE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

/**
 * Hook to poll Stellar network status and detect degraded service.
 *
 * @returns {{
 *   status: object|null,
 *   loading: boolean,
 *   error: string|null,
 *   isDegraded: boolean,
 *   isStale: boolean,
 *   refetch: () => void
 * }}
 *
 * `isStale` is true when the most recently available status data is older than
 * CACHE_MAX_AGE (10 min).  In that case `status` is set to null and callers
 * should render an explicit "status unknown" state rather than showing the
 * last-known (possibly outdated) operational status.
 */
export function useStellarStatus() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isDegraded, setIsDegraded] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const intervalRef = useRef(null);

  const checkStatus = async (skipCache = false) => {
    try {
      // Check cache first (only on the initial load, not interval ticks)
      if (!skipCache) {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          const age = Date.now() - timestamp;

          if (age > CACHE_MAX_AGE) {
            // Cache is too old to trust.  Show "status unknown" immediately
            // and let the fetch below provide a fresh value.
            setStatus(null);
            setIsDegraded(false);
            setIsStale(true);
            // Fall through to the network fetch
          } else if (age < CACHE_DURATION) {
            // Cache is fresh — use it immediately without a network round-trip
            setStatus(data);
            setIsDegraded(data.status !== 'All Systems Operational');
            setIsStale(false);
            setLoading(false);
            return;
          }
          // age is between CACHE_DURATION and CACHE_MAX_AGE: cache is expired
          // but not yet stale enough to hide — fall through to refresh
        }
      }

      const response = await fetch(STATUS_API_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      // Persist fresh data
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        data,
        timestamp: Date.now(),
      }));

      setStatus(data);
      setIsDegraded(data.status !== 'All Systems Operational');
      setIsStale(false);
      setError(null);
    } catch (err) {
      // Report to Sentry so a silent background-refresh failure is observable.
      Sentry.captureException(err, {
        tags: { hook: 'useStellarStatus' },
        extra: { skipCache },
      });

      console.error('Failed to fetch Stellar status:', err);
      setError(err.message);

      // Check whether the data we currently have (if any) has exceeded max-age.
      // If it has, surface the stale state so callers can show "status unknown"
      // rather than the last-known healthy value.
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const { timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp > CACHE_MAX_AGE) {
            setStatus(null);
            setIsDegraded(false);
            setIsStale(true);
          } else {
            // Cache is still within max-age — a transient error shouldn't clear
            // a recently confirmed good status.
            setIsStale(false);
          }
        } else {
          // No cache at all — we have nothing to show
          setIsStale(true);
        }
      } catch {
        setIsStale(true);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Initial check — use cache if available and fresh
    checkStatus();

    // Set up polling — always skip cache so the interval always fetches fresh
    intervalRef.current = setInterval(() => {
      checkStatus(true);
    }, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- start polling once on mount; the fetcher reads refs

  return { status, loading, error, isDegraded, isStale, refetch: () => checkStatus(true) };
}

export default useStellarStatus;
