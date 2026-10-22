import { StrKey } from '@stellar/stellar-sdk';

// The agent-escrow contract only locks USDC; the backend rejects anything else.
export const ESCROW_ASSET = 'USDC';

const STROOPS_PER_UNIT = 10000000n;
const AMOUNT_RE = /^\d+(\.\d{1,7})?$/;

/**
 * Convert a decimal amount string to stroops (BigInt) without float error.
 * Returns null if the string is not a decimal with at most 7 places.
 */
export function toStroops(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!AMOUNT_RE.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt((fraction + '0000000').slice(0, 7));
}

/**
 * Validate the agent-escrow create form.
 *
 * Returns `{ field, key, params }` for the first problem found, or null when
 * the form is valid. `key` is an i18n key under `escrow.errors`.
 *
 * @param {object} form            { agent_wallet, recipient_wallet, amount, asset }
 * @param {object} [context]
 * @param {string} [context.senderWallet]  Caller's own public key, if known.
 * @param {string} [context.balance]       Caller's available USDC balance, if known.
 */
export function validateEscrowForm(form, { senderWallet, balance } = {}) {
  const agent = (form.agent_wallet || '').trim();
  const recipient = (form.recipient_wallet || '').trim();
  const amount = (form.amount || '').toString().trim();

  if (!agent) return { field: 'agent_wallet', key: 'agent_required' };
  if (!StrKey.isValidEd25519PublicKey(agent)) {
    return { field: 'agent_wallet', key: 'agent_invalid' };
  }
  if (!recipient) return { field: 'recipient_wallet', key: 'recipient_required' };
  if (!StrKey.isValidEd25519PublicKey(recipient)) {
    return { field: 'recipient_wallet', key: 'recipient_invalid' };
  }

  if (senderWallet && agent === senderWallet) {
    return { field: 'agent_wallet', key: 'agent_is_sender' };
  }
  if (senderWallet && recipient === senderWallet) {
    return { field: 'recipient_wallet', key: 'recipient_is_sender' };
  }
  if (agent === recipient) {
    return { field: 'recipient_wallet', key: 'recipient_is_agent' };
  }

  if (form.asset && form.asset !== ESCROW_ASSET) {
    return { field: 'asset', key: 'asset_unsupported', params: { asset: ESCROW_ASSET } };
  }

  if (!amount) return { field: 'amount', key: 'amount_required' };
  const stroops = toStroops(amount);
  if (stroops === null) return { field: 'amount', key: 'amount_format' };
  if (stroops <= 0n) return { field: 'amount', key: 'amount_positive' };

  if (balance !== undefined && balance !== null) {
    const available = toStroops(balance);
    if (available !== null && stroops > available) {
      return {
        field: 'amount',
        key: 'insufficient_balance',
        params: { balance: String(balance), asset: ESCROW_ASSET },
      };
    }
  }

  return null;
}
