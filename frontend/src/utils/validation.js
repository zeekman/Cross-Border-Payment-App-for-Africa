import { MuxedAccount, StrKey } from '@stellar/stellar-sdk';

/**
 * Validate a Stellar recipient address. Returns an error message string,
 * or null when the address is acceptable.
 *
 * - `G…` addresses must pass CRC16 checksum validation
 *   (StrKey.isValidEd25519PublicKey), so typos are caught immediately
 *   instead of surfacing as a backend 400 after amount/review/PIN steps.
 * - Federation addresses (`name*domain`) are accepted on format only;
 *   they resolve to a public key server-side.
 * - Muxed `M…` addresses (SEP-23) are checksum-validated. Flows without
 *   muxed support pass `{ allowMuxed: false }`.
 */
export function validateStellarAddress(address, { allowMuxed = true } = {}) {
  if (!address || typeof address !== 'string') {
    return 'Address is required';
  }
  const trimmed = address.trim();
  if (trimmed.length === 0) {
    return 'Address is required';
  }

  if (trimmed.includes('*')) {
    // Federation address: name*domain.tld — format only, resolution
    // happens server-side.
    const parts = trimmed.split('*');
    if (
      parts.length === 2 &&
      parts[0].length > 0 &&
      parts[1].length > 3 &&
      parts[1].includes('.') &&
      !/\s/.test(trimmed)
    ) {
      return null;
    }
    return 'Invalid federation address (expected name*domain)';
  }

  if (trimmed.startsWith('M')) {
    if (!allowMuxed) return 'Muxed (M…) addresses are not supported yet';
    return StrKey.isValidMed25519PublicKey(trimmed) ? null : 'Invalid muxed (M…) address — check for typos';
  }

  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    return 'Invalid Stellar address (checksum failed — check for typos)';
  }
  return null;
}

/** Base `G…` account and id of a muxed address, or null if it isn't one. */
export function parseMuxedAddress(address) {
  const value = (address || '').trim();
  if (!StrKey.isValidMed25519PublicKey(value)) return null;
  const muxed = MuxedAccount.fromAddress(value, '0');
  return { baseAccount: muxed.baseAccount().accountId(), id: muxed.id() };
}
