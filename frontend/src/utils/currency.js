/** Assets that can be sent or requested. These are not display currencies. */
export const CURRENCIES = [
  { code: 'XLM', name: 'Stellar Lumens', flag: '⭐' },
  { code: 'USD', name: 'US Dollar', flag: '🇺🇸' },
  { code: 'NGN', name: 'Nigerian Naira', flag: '🇳🇬' },
  { code: 'GHS', name: 'Ghanaian Cedi', flag: '🇬🇭' },
  { code: 'KES', name: 'Kenyan Shilling', flag: '🇰🇪' },
];

const COUNTRY_CURRENCY = {
  US: 'USD', NG: 'NGN', GH: 'GHS', KE: 'KES', ZA: 'ZAR', UG: 'UGX', TZ: 'TZS', RW: 'RWF', EG: 'EGP',
  SN: 'XOF', CI: 'XOF', BJ: 'XOF', BF: 'XOF', ML: 'XOF', NE: 'XOF', TG: 'XOF', GW: 'XOF',
  CM: 'XAF', GA: 'XAF', TD: 'XAF', CG: 'XAF', CF: 'XAF', GQ: 'XAF',
};

/** Country code from the browser locale (e.g. `en-NG` → `NG`), or null. */
export function localeCountry() {
  const m = /-([A-Z]{2})(?:-|$)/.exec((typeof navigator !== 'undefined' && navigator.language) || '');
  return m ? m[1] : null;
}

/** Default display currency from the KYC country, then the browser locale. */
export function defaultCurrency(country) {
  return COUNTRY_CURRENCY[String(country || '').toUpperCase()] || COUNTRY_CURRENCY[localeCountry()] || 'USD';
}

function flagFor(code) {
  if (code === 'XOF' || code === 'XAF') return '🌍';
  return String.fromCodePoint(...[...code.slice(0, 2)].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function nameFor(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'currency' }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * Selector entries for XLM plus every fiat currency the API supports.
 * @param {Array<string|{code: string, name?: string, flag?: string}>} supported
 * @param {Record<string, number>} rates - fiat units per 1 XLM
 */
export function buildCurrencies(supported = [], rates = {}) {
  const seen = new Set(['XLM']);
  const list = [{ code: 'XLM', name: 'Stellar Lumens', flag: '⭐', rate: 1 }];
  supported.forEach((entry) => {
    const c = typeof entry === 'string' ? { code: entry } : entry;
    if (!c || !/^[A-Z]{3}$/.test(c.code) || seen.has(c.code)) return;
    seen.add(c.code);
    list.push({
      code: c.code,
      name: c.name || nameFor(c.code),
      flag: c.flag || flagFor(c.code),
      rate: rates[c.code] ?? null,
    });
  });
  return list;
}

/** Converted numeric amount, or null when no rate is available. */
export function convertFromXLM(xlmAmount, targetCurrency, rates = {}) {
  const amount = parseFloat(xlmAmount);
  if (!Number.isFinite(amount)) return null;
  if (targetCurrency === 'XLM') return amount;
  const rate = rates[targetCurrency];
  return Number.isFinite(rate) ? amount * rate : null;
}

/** Locale-aware currency formatting; "—" when the amount is unavailable. */
export function formatAmount(amount, currency = 'XLM', locale) {
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  if (!Number.isFinite(n)) return '—';
  if (/^[A-Z]{3}$/.test(currency) && currency !== 'XLM') {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
  }
  return `${n.toLocaleString(locale, { maximumFractionDigits: 7 })} ${currency}`;
}

export function truncateAddress(address, chars = 8) {
  if (!address) return '';
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
