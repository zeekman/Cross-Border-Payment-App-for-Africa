import { StrKey } from '@stellar/stellar-sdk';

/**
 * Validate a Stellar recipient address. Returns an error message string,
 * or null when the address is acceptable.
 *
 * - `G…` addresses must pass CRC16 checksum validation
 *   (StrKey.isValidEd25519PublicKey), so typos are caught immediately
 *   instead of surfacing as a backend 400 after amount/review/PIN steps.
 * - Federation addresses (`name*domain`) are accepted on format only;
 *   they resolve to a public key server-side.
 * - Muxed `M…` addresses are rejected: the backend payment flow has no
 *   muxed support, so accepting them here would only move the failure
 *   to a backend 400.
 */
export function validateStellarAddress(address) {
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
    return 'Muxed (M…) addresses are not supported yet';
  }

  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    return 'Invalid Stellar address (checksum failed — check for typos)';
  }
  return null;
}
