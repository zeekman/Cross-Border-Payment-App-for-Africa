// Shared amount helpers for money inputs.
// Stellar amounts have at most 7 decimal places.

export const AMOUNT_DECIMALS = 7;

// Digits, optional single decimal separator, up to 7 decimals.
export const AMOUNT_REGEX = /^\d+(\.\d{0,7})?$/;

/**
 * Normalize a raw input string into a canonical amount string.
 * - Converts `,` to `.`
 * - Strips exponent/sign characters and any non-digit/non-separator chars
 * - Keeps only the first decimal separator
 * - Truncates to 7 decimals
 * Returns a string (possibly empty).
 */
export function normalizeAmount(raw) {
  if (raw == null) return '';
  let value = String(raw).replace(/,/g, '.');
  // Drop anything that is not a digit or a dot (blocks e, +, -, spaces, etc.)
  value = value.replace(/[^0-9.]/g, '');
  const firstDot = value.indexOf('.');
  if (firstDot !== -1) {
    const intPart = value.slice(0, firstDot);
    const decPart = value.slice(firstDot + 1).replace(/\./g, '');
    value = `${intPart}.${decPart.slice(0, AMOUNT_DECIMALS)}`;
  }
  return value;
}

/**
 * Scale an amount string to a BigInt of the smallest unit (7 decimals).
 * Returns null when the string is not a valid amount.
 */
export function toScaled(amount) {
  if (typeof amount !== 'string') return null;
  const normalized = normalizeAmount(amount);
  if (!normalized || !AMOUNT_REGEX.test(normalized)) return null;
  const [intPart, decPart = ''] = normalized.split('.');
  const padded = decPart.padEnd(AMOUNT_DECIMALS, '0');
  try {
    return BigInt(intPart) * 10n ** BigInt(AMOUNT_DECIMALS) + BigInt(padded || '0');
  } catch {
    return null;
  }
}
