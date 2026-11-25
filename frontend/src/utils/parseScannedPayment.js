import { StrKey } from '@stellar/stellar-sdk';

const FEDERATION_RE = /^[^*\s]+\*[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export class ScanParseError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // 'invalid_address' | 'unsupported_uri' | 'invalid'
  }
}

const isValidDestination = (value) =>
  StrKey.isValidEd25519PublicKey(value) ||
  StrKey.isValidMed25519PublicKey(value) ||
  FEDERATION_RE.test(value);

/**
 * Parse text read from a QR code into payment fields (FE-147).
 * Accepts a plain G/M address (checksum-validated), a federation address
 * (`name*domain`), or a SEP-7 `web+stellar:pay?` URI.
 * Throws ScanParseError for anything else.
 */
export function parseScannedPayment(text) {
  const raw = (text || '').trim();
  if (!raw) throw new ScanParseError('invalid');

  if (/^web\+stellar:/i.test(raw)) {
    const match = raw.match(/^web\+stellar:([a-z]+)\?(.*)$/i);
    if (!match || match[1].toLowerCase() !== 'pay') throw new ScanParseError('unsupported_uri');

    const params = new URLSearchParams(match[2]);
    const destination = (params.get('destination') || '').trim();
    if (!isValidDestination(destination)) throw new ScanParseError('invalid_address');

    const result = { destination };
    ['amount', 'memo', 'memo_type', 'asset_code', 'asset_issuer'].forEach((key) => {
      const value = params.get(key);
      if (value) result[key] = value;
    });
    // SEP-7 memo types are MEMO_TEXT / MEMO_ID / MEMO_HASH / MEMO_RETURN.
    if (result.memo_type) result.memo_type = result.memo_type.replace(/^MEMO_/i, '').toLowerCase();
    return result;
  }

  if (/^[GM]/.test(raw) && !FEDERATION_RE.test(raw)) {
    if (!isValidDestination(raw)) throw new ScanParseError('invalid_address');
    return { destination: raw };
  }

  if (FEDERATION_RE.test(raw)) return { destination: raw };

  throw new ScanParseError('invalid');
}
