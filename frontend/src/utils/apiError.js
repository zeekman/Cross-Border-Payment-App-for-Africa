/**
 * One place to turn an API/Stellar error into a translated, user-safe message
 * (FE-212). Pages call `toast.error(getErrorMessage(err, t))` instead of
 * re-implementing `err.response?.data?.error || …` chains.
 *
 * Resolution order:
 *  1. The backend's structured `code` → `errors.<code>`.
 *  2. A Stellar result code found in the response (`op_underfunded`,
 *     `tx_bad_seq`, …) → `errors.stellar.<code>`.
 *  3. Network/timeout failures (no response) → `errors.NETWORK_ERROR`.
 *  4. Status-based fallback → `errors.http_<status>`, then `errors.generic`.
 *
 * Raw server text is never shown: it's English-only and often technical
 * (`HostError …`, validator messages), and for 5xx it may leak internals.
 */

/** Backend `code` values with a dedicated message. */
export const API_ERROR_CODES = [
  'STEP_UP_REQUIRED',
  'STEP_UP_INVALID',
  'INSUFFICIENT_BALANCE',
  'PRICE_MOVED',
  'SLIPPAGE_EXCEEDED',
  'KYC_REQUIRED',
  'KYC_PENDING',
  'INVALID_PIN',
  'PIN_LOCKED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
  'INVALID_ADDRESS',
  'DESTINATION_NOT_FOUND',
  'TRUSTLINE_REQUIRED',
  'LIMIT_EXCEEDED',
  'DUPLICATE_REQUEST',
  'NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHORIZED',
  'SESSION_EXPIRED',
  'NONZERO_BALANCE',
  'SERVICE_UNAVAILABLE',
];

/** Stellar transaction/operation result codes with a friendly message. */
export const STELLAR_RESULT_CODES = [
  'op_underfunded',
  'op_no_trust',
  'op_no_destination',
  'op_line_full',
  'op_low_reserve',
  'op_not_authorized',
  'op_src_not_authorized',
  'op_no_issuer',
  'op_too_few_offers',
  'op_over_source_max',
  'op_under_dest_min',
  'op_cross_self',
  'tx_bad_seq',
  'tx_insufficient_fee',
  'tx_insufficient_balance',
  'tx_too_late',
  'tx_bad_auth',
  'tx_failed',
];

const STELLAR_CODE_RE = new RegExp(`\\b(${STELLAR_RESULT_CODES.join('|')})\\b`);

function findStellarCode(data) {
  if (!data) return null;
  const codes = data.result_codes || data.extras?.result_codes;
  const candidates = [
    ...(Array.isArray(codes?.operations) ? codes.operations : []),
    codes?.transaction,
    typeof data.error === 'string' ? data.error : null,
    typeof data.message === 'string' ? data.message : null,
  ].filter(Boolean);
  // Operation codes are more specific than the generic `tx_failed`.
  for (const candidate of candidates) {
    const match = String(candidate).match(STELLAR_CODE_RE);
    if (match && match[1] !== 'tx_failed') return match[1];
  }
  for (const candidate of candidates) {
    const match = String(candidate).match(STELLAR_CODE_RE);
    if (match) return match[1];
  }
  return null;
}

/**
 * The i18n key for an error, without translating it. Exported for tests and
 * for callers that need to branch on the kind of failure.
 */
export function getErrorKey(err) {
  const response = err?.response;
  const data = response?.data;

  const code = typeof data?.code === 'string' ? data.code.toUpperCase() : null;
  if (code && API_ERROR_CODES.includes(code)) return `errors.${code}`;

  const stellar = findStellarCode(data);
  if (stellar) return `errors.stellar.${stellar}`;

  if (!response) {
    if (err?.code === 'ECONNABORTED' || /timeout/i.test(err?.message || '')) return 'errors.TIMEOUT';
    if (err?.code === 'ERR_CANCELED') return 'errors.CANCELED';
    return 'errors.NETWORK_ERROR';
  }

  const status = response.status;
  if (status === 401) return 'errors.http_401';
  if (status === 403) return 'errors.http_403';
  if (status === 404) return 'errors.http_404';
  if (status === 409) return 'errors.http_409';
  if (status === 429) return 'errors.RATE_LIMITED';
  if (status >= 500) return 'errors.http_5xx';
  if (status >= 400) return 'errors.http_4xx';
  return 'errors.generic';
}

/**
 * Translated, user-safe message for `err`.
 *
 * @param {unknown} err  Axios error (or anything thrown)
 * @param {(key: string, opts?: object) => string} t  i18next `t`
 * @param {string} [fallbackKey]  Context-specific fallback, e.g. 'errors.swap_failed',
 *   used only when the error has no more specific mapping.
 */
export function getErrorMessage(err, t, fallbackKey) {
  const key = getErrorKey(err);
  const isGenericFallback = key === 'errors.http_4xx' || key === 'errors.generic';
  const chosen = isGenericFallback && fallbackKey ? fallbackKey : key;
  return t(chosen, { defaultValue: t('errors.generic') });
}

/**
 * `getErrorMessage` bound to the app's active i18n instance, for call sites
 * (toasts in handlers) that don't have `t` in scope.
 */
export function apiErrorMessage(err, fallbackKey) {
  // Lazy require keeps this module importable in unit tests without i18n init.
  // eslint-disable-next-line global-require
  const i18n = require('../i18n').default;
  return getErrorMessage(err, i18n.t.bind(i18n), fallbackKey);
}
