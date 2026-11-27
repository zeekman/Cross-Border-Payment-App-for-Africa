import { convertFromXLM } from './currency';

const SYMBOLS = { USD: '$', NGN: '₦', GHS: '₵', KES: 'KSh ' };

export function formatFiat(value, currency) {
  const n = Number(value);
  const formatted = n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOLS[currency] ?? `${currency} `}${formatted}`;
}

/**
 * FE-206: fiat value of a transaction at the rate in effect when it was sent.
 *
 * Uses `tx.fx_snapshot` ({ rates: { USD, NGN, ... }, source, at }) when present.
 * Without a snapshot, falls back to today's rate and marks the result so the UI
 * can label it "at today's rate" instead of passing it off as the historic value.
 *
 * @returns {null | { value: string, formatted: string, atSendTime: boolean,
 *   rate: number, source: string|null, at: string|null }}
 */
export function fiatValueForTx(tx, currency, liveRates) {
  if (!tx || !currency || currency === 'XLM' || tx.asset !== 'XLM') return null;
  const snapRate = Number(tx.fx_snapshot?.rates?.[currency]);
  if (Number.isFinite(snapRate) && snapRate > 0) {
    const value = (parseFloat(tx.amount) * snapRate).toFixed(2);
    return {
      value,
      formatted: formatFiat(value, currency),
      atSendTime: true,
      rate: snapRate,
      source: tx.fx_snapshot.source || null,
      at: tx.fx_snapshot.at || tx.created_at || null,
    };
  }
  if (!liveRates) return null;
  const value = convertFromXLM(tx.amount, currency, liveRates);
  return {
    value,
    formatted: formatFiat(value, currency),
    atSendTime: false,
    rate: Number(liveRates[currency]),
    source: null,
    at: null,
  };
}

export function fiatTooltip(fiat, currency) {
  if (!fiat) return '';
  if (!fiat.atSendTime) return `Rate at time of transfer unavailable. Shown at today's rate (1 XLM = ${fiat.rate} ${currency}).`;
  const when = fiat.at ? new Date(fiat.at).toLocaleString() : 'unknown time';
  return `1 XLM = ${fiat.rate} ${currency}${fiat.source ? ` (${fiat.source})` : ''} at ${when}`;
}
