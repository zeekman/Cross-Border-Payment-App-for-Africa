// Fallback fiat-per-1-XLM rates when the live API is unavailable (CoinGecko is source of truth in UI).

export const FALLBACK_XLM_FIAT_RATES = {
  USD: 0.11,
  NGN: 170,
  GHS: 1.35,
  KES: 14.5,
};

const FIAT_META = [
  { code: 'USD', name: 'US Dollar', flag: '🇺🇸' },
  { code: 'NGN', name: 'Nigerian Naira', flag: '🇳🇬' },
  { code: 'GHS', name: 'Ghanaian Cedi', flag: '🇬🇭' },
  { code: 'KES', name: 'Kenyan Shilling', flag: '🇰🇪' },
];

/**
 * @param {Record<string, number>} fiatRates - fiat units per 1 XLM (USD, NGN, GHS, KES)
 */
export function buildCurrencies(fiatRates = FALLBACK_XLM_FIAT_RATES) {
  const rates = { ...FALLBACK_XLM_FIAT_RATES, ...fiatRates };
  return [
    { code: 'XLM', name: 'Stellar Lumens', flag: '⭐', rate: 1 },
    ...FIAT_META.map((m) => ({
      ...m,
      rate: rates[m.code] ?? FALLBACK_XLM_FIAT_RATES[m.code],
    })),
  ];
}

/** @deprecated Use `buildCurrencies` with `useExchangeRates` for live rates. */
export const CURRENCIES = buildCurrencies(FALLBACK_XLM_FIAT_RATES);

/**
 * @param {string} xlmAmount
 * @param {string} targetCurrency
 * @param {Record<string, number>} [fiatRates] - optional live rates; defaults to fallback
 */
export function convertFromXLM(xlmAmount, targetCurrency, fiatRates = FALLBACK_XLM_FIAT_RATES) {
  if (targetCurrency === 'XLM') {
    return parseFloat(xlmAmount).toString();
  }
  const merged = { ...FALLBACK_XLM_FIAT_RATES, ...fiatRates };
  const rate = merged[targetCurrency];
  if (rate == null || Number.isNaN(rate)) {
    return (parseFloat(xlmAmount) * (FALLBACK_XLM_FIAT_RATES[targetCurrency] || 1)).toFixed(2);
  }
  return (parseFloat(xlmAmount) * rate).toFixed(2);
}

export function formatAmount(amount, currency = 'XLM') {
  return `${parseFloat(amount).toLocaleString()} ${currency}`;
}

export function truncateAddress(address, chars = 8) {
  if (!address) return '';
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
