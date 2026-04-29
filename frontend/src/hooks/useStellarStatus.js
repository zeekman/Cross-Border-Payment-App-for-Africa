import { useState, useEffect, useRef } from 'react';

const STATUS_API_URL = 'https://status.stellar.org/api/v2/status.json';
const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const CACHE_KEY = 'stellar_status_cache';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Hook to poll Stellar network status and detect degraded service
 * @returns {Object} { status, loading, error, isDegraded }
 */
export function useStellarStatus() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isDegraded, setIsDegraded] = useState(false);
  const intervalRef = useRef(null);

  const checkStatus = async (skipCache = false) => {
    try {
      // Check cache first
      if (!skipCache) {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < CACHE_DURATION) {
            setStatus(data);
            setIsDegraded(data.status !== 'All Systems Operational');
            setLoading(false);
            return;
          }
        }
      }

      const response = await fetch(STATUS_API_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      
      // Cache the result
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        data,
        timestamp: Date.now()
      }));
      
      setStatus(data);
      setIsDegraded(data.status !== 'All Systems Operational');
      setError(null);
    } catch (err) {
      console.error('Failed to fetch Stellar status:', err);
      setError(err.message);
      // Don't update status on error to keep previous value
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Initial check
    checkStatus();

    // Set up polling
    intervalRef.current = setInterval(() => {
      checkStatus(true); // Skip cache on interval checks
    }, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return { status, loading, error, isDegraded, refetch: () => checkStatus(true) };
}

export default useStellarStatus;
