import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FALLBACK_XLM_FIAT_RATES,
  buildCurrencies,
  convertFromXLM as convertFromXLMUtil,
} from '../utils/currency';
import api from '../utils/api';
import { useVisibleInterval } from './useVisibleInterval';
import { useDataSaver, DATA_SAVER_RATES_INTERVAL_MS } from '../context/DataSaverContext';

const PRICES_PATH = '/prices/xlm';
const TTL_MS = 60_000;
const LS_KEY = 'afripay_xlm_fiat_rates_v1';

function mapPricesPayload(data) {
  const r = data?.rates;
  if (!r || typeof r.USD !== 'number') return null;
  return {
    USD: r.USD,
    NGN: typeof r.NGN === 'number' ? r.NGN : FALLBACK_XLM_FIAT_RATES.NGN,
    GHS: typeof r.GHS === 'number' ? r.GHS : FALLBACK_XLM_FIAT_RATES.GHS,
    KES: typeof r.KES === 'number' ? r.KES : FALLBACK_XLM_FIAT_RATES.KES,
  };
}

function readStoredRates() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const { rates: r, updatedAt } = JSON.parse(raw);
    if (!r || typeof r.USD !== 'number') return null;
    return {
      rates: {
        USD: r.USD,
        NGN: r.NGN ?? FALLBACK_XLM_FIAT_RATES.NGN,
        GHS: r.GHS ?? FALLBACK_XLM_FIAT_RATES.GHS,
        KES: r.KES ?? FALLBACK_XLM_FIAT_RATES.KES,
      },
      updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function persistRates(rates) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ rates, updatedAt: Date.now() })
    );
  } catch {
    /* ignore quota / private mode */
  }
}

function mergeWithFallback(partial) {
  return { ...FALLBACK_XLM_FIAT_RATES, ...partial };
}

/**
 * Live XLM fiat rates from the backend `/prices/xlm` endpoint, 60s TTL +
 * localStorage fallback (`usingApproximateRates` is true while on fallback).
 */
export function useExchangeRates() {
  const { dataSaver } = useDataSaver();
  const ttl = dataSaver ? DATA_SAVER_RATES_INTERVAL_MS : TTL_MS;
  const ttlRef = useRef(ttl);
  ttlRef.current = ttl;
  const stored = readStoredRates();
  const initialRates = mergeWithFallback(stored?.rates ?? {});

  const [rates, setRates] = useState(initialRates);
  const [usingApproximateRates, setUsingApproximateRates] = useState(true);
  const [error, setError] = useState(null);

  const lastGoodRef = useRef(initialRates);
  const fetchedAtRef = useRef(
    stored && Date.now() - stored.updatedAt < TTL_MS ? stored.updatedAt : 0
  );

  const fetchRates = useCallback(async () => {
    const now = Date.now();
    if (fetchedAtRef.current && now - fetchedAtRef.current < ttlRef.current) {
      setRates(lastGoodRef.current);
      setUsingApproximateRates(false);
      setError(null);
      return;
    }

    try {
      const res = await api.get(PRICES_PATH);
      const mapped = mapPricesPayload(res.data);
      if (!mapped) throw new Error('Invalid price payload');

      lastGoodRef.current = mapped;
      fetchedAtRef.current = Date.now();
      persistRates(mapped);
      setRates(mapped);
      setUsingApproximateRates(false);
      setError(null);
    } catch (e) {
      const fallback = lastGoodRef.current;
      setRates(fallback);
      setUsingApproximateRates(true);
      setError(e?.message || 'Failed to refresh rates');
    }
  }, []);

  useEffect(() => {
    fetchRates();
  }, [fetchRates]);

  // Refresh on a timer, but not while the tab is hidden (and straight away on return).
  // FE-204: every 10 minutes in data saver mode.
  useVisibleInterval(fetchRates, ttl);

  const convertFromXLM = useCallback(
    (xlmAmount, targetCurrency) =>
      convertFromXLMUtil(xlmAmount, targetCurrency, rates),
    [rates]
  );

  const currencies = buildCurrencies(rates);

  return {
    rates,
    currencies,
    convertFromXLM,
    usingApproximateRates,
    error,
  };
}
