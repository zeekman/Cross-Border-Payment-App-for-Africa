import { useEffect, useState } from 'react';
import api from '../utils/api';

const remaining = (p) =>
  p?.limit == null ? null : Math.max(0, Number(p.limit) - Number(p.used || 0));

/** Adds `dailyRemaining`, `monthlyRemaining` and the effective `max` per send. */
export function summariseLimits(data) {
  if (!data?.daily && !data?.monthly && data?.single_tx_max == null) return null;
  const dailyRemaining = remaining(data.daily);
  const monthlyRemaining = remaining(data.monthly);
  const single = data.single_tx_max == null ? null : Number(data.single_tx_max);
  const caps = [dailyRemaining, monthlyRemaining, single].filter(Number.isFinite);
  return {
    ...data,
    currency: data.currency || 'XLM',
    dailyRemaining,
    monthlyRemaining,
    max: caps.length ? Math.min(...caps) : null,
  };
}

/** Sending limits, or null while loading or unavailable (the server still enforces them). */
export function useLimits() {
  const [limits, setLimits] = useState(null);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.get('/payments/limits');
        if (active) setLimits(summariseLimits(res?.data));
      } catch {
        // Non-blocking.
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  return limits;
}
