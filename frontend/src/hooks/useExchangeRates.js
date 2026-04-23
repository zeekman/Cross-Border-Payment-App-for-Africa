import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FALLBACK_XLM_FIAT_RATES,
  buildCurrencies,
  convertFromXLM as convertFromXLMUtil,
} from '../utils/currency';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd,ngn,ghs,kes';
const TTL_MS = 60_000;
const LS_KEY = 'afripay_xlm_fiat_rates_v1';

function mapCoingeckoPayload(data) {
  const s = data?.stellar;
  if (!s || typeof s.usd !== 'number') return null;
  return {
    USD: s.usd,
    NGN: typeof s.ngn === 'number' ? s.ngn : FALLBACK_XLM_FIAT_RATES.NGN,
    GHS: typeof s.ghs === 'number' ? s.ghs : FALLBACK_XLM_FIAT_RATES.GHS,
    KES: typeof s.kes === 'number' ? s.kes : FALLBACK_XLM_FIAT_RATES.KES,
  };
}

function readStoredRates() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const { rates: r, updatedAt } = JSON.parse(raw);
    if (!r || typeof r.usd !== 'number') return null;
    return {
      rates: {
        USD: r.usd,
        NGN: r.ngn ?? FALLBACK_XLM_FIAT_RATES.NGN,
        GHS: r.ghs ?? FALLBACK_XLM_FIAT_RATES.GHS,
        KES: r.kes ?? FALLBACK_XLM_FIAT_RATES.KES,
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
      JSON.stringify({
        rates: {
          usd: rates.USD,
          ngn: rates.NGN,
          ghs: rates.GHS,
          kes: rates.KES,
        },
        updatedAt: Date.now(),
      })
    );
  } catch {
    /* ignore quota / private mode */
  }
}

function mergeWithFallback(partial) {
  return { ...FALLBACK_XLM_FIAT_RATES, ...partial };
}

/**
 * Live XLM fiat rates from CoinGecko, 60s TTL + localStorage fallback.
 */
export function useExchangeRates() {
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
    if (fetchedAtRef.current && now - fetchedAtRef.current < TTL_MS) {
      setRates(lastGoodRef.current);
      setUsingApproximateRates(false);
      setError(null);
      return;
    }

    try {
      const res = await fetch(COINGECKO_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const mapped = mapCoingeckoPayload(data);
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
    const id = setInterval(fetchRates, TTL_MS);
    return () => clearInterval(id);
  }, [fetchRates]);

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
