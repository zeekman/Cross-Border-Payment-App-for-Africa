import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildCurrencies, convertFromXLM as convert } from '../utils/currency';
import api from '../utils/api';
import { useVisibleInterval } from './useVisibleInterval';

const TTL_MS = 60_000;

function parseRates(data) {
  if (!data?.rates || data.stale) return null;
  const entries = Object.entries(data.rates).filter(([, v]) => Number.isFinite(v) && v > 0);
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * Supported currencies and live XLM rates. When rates are missing or stale,
 * `rates` is empty and conversions return null rather than an invented value.
 */
export function useExchangeRates() {
  const [rates, setRates] = useState({});
  const [supported, setSupported] = useState(null);
  const [error, setError] = useState(null);
  const ratesAt = useRef(0);

  const fetchRates = useCallback(async () => {
    try {
      const parsed = parseRates((await api.get('/prices/xlm'))?.data);
      if (!parsed) throw new Error('Rates unavailable');
      ratesAt.current = Date.now();
      setRates(parsed);
      setError(null);
    } catch (e) {
      // Keep rates through one missed refresh, then treat them as stale.
      if (Date.now() - ratesAt.current > 2 * TTL_MS) setRates({});
      setError(e?.message || 'Failed to refresh rates');
    }
  }, []);

  useEffect(() => {
    fetchRates();
    (async () => {
      try {
        const data = (await api.get('/prices/currencies'))?.data;
        const list = Array.isArray(data) ? data : data?.currencies;
        if (Array.isArray(list)) setSupported(list);
      } catch {
        // Fall back to whichever currencies have a live rate.
      }
    })();
  }, [fetchRates]);

  useVisibleInterval(fetchRates, TTL_MS);

  const convertFromXLM = useCallback((amount, target) => convert(amount, target, rates), [rates]);
  const currencies = useMemo(
    () => buildCurrencies(supported || Object.keys(rates), rates),
    [supported, rates]
  );

  return { rates, currencies, convertFromXLM, usingApproximateRates: Object.keys(rates).length === 0, error };
}
