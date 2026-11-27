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

/**
 * Address-poisoning guard. Attackers send dust from addresses that share
 * the first and last characters of an address the victim uses often, so a
 * copy from history silently picks the attacker's address.
 *
 * Compares `destination` against known addresses (saved contacts and recent
 * counterparties). Returns the first known entry whose first 4 and last 4
 * characters match but whose full address differs, or null when there is no
 * look-alike. Entries are expected as `{ address, label }`.
 */
export function findLookAlikeAddress(destination, knownAddresses = []) {
  if (!destination || typeof destination !== 'string') {
    return null;
  }
  const target = destination.trim();
  if (target.length < 8) {
    return null;
  }
  const targetHead = target.slice(0, 4);
  const targetTail = target.slice(-4);

  for (const entry of knownAddresses) {
    const known = typeof entry === 'string' ? entry : entry && entry.address;
    if (!known || typeof known !== 'string') continue;
    const candidate = known.trim();
    if (candidate.length < 8) continue;
    if (candidate === target) continue;
    if (candidate.slice(0, 4) === targetHead && candidate.slice(-4) === targetTail) {
      return {
        address: candidate,
        label: (entry && entry.label) || null,
      };
    }
  }
  return null;
}

/**
 * Format a full address in readable chunks of 4 characters, e.g.
 * `GABC DEFG HIJK …`. Used in the review step so the whole address is
 * visible instead of a truncated form.
 */
export function chunkAddress(address, size = 4) {
  if (!address || typeof address !== 'string') return '';
  const trimmed = address.trim();
  const chunks = [];
  for (let i = 0; i < trimmed.length; i += size) {
    chunks.push(trimmed.slice(i, i + size));
  }
  return chunks.join(' ');
}

/**
 * Dust threshold (in XLM) below which an incoming payment from a first-time
 * sender is treated as possible address-poisoning spam.
 */
export const DUST_THRESHOLD_XLM = 0.01;

/**
 * Whether an incoming payment should be flagged as possible spam: below the
 * dust threshold and from a sender not seen before.
 */
export function isPossibleSpamPayment(payment, knownSenders = []) {
  if (!payment || payment.direction !== 'incoming') return false;
  const amount = Number(payment.amount);
  if (!Number.isFinite(amount) || amount >= DUST_THRESHOLD_XLM) return false;
  const sender = payment.from || payment.address;
  if (!sender) return false;
  const known = knownSenders.some((entry) => {
    const addr = typeof entry === 'string' ? entry : entry && entry.address;
    return addr && addr.trim() === sender.trim();
  });
  return !known;
}
