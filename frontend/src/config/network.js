/**
 * Centralised Stellar network configuration (FE-129).
 *
 * All Stellar-aware code should import from here instead of reading
 * process.env.REACT_APP_STELLAR_* directly. This ensures:
 *   - A single place to audit / change network settings.
 *   - Consistent Horizon URL and network passphrase across the app.
 *   - An explicit startup error in production when the env var is missing,
 *     rather than silently connecting to testnet with live accounts.
 *
 * Required env vars (document every one in frontend/.env.example):
 *   REACT_APP_STELLAR_NETWORK        — 'testnet' | 'mainnet'  (required in production)
 *   REACT_APP_STELLAR_HORIZON_URL    — override the Horizon base URL (optional)
 */

import { Networks } from '@stellar/stellar-sdk';

const STELLAR_NETWORK = process.env.REACT_APP_STELLAR_NETWORK;

// Fail loudly in production when the network is not configured.
// In development (NODE_ENV=development or REACT_APP_STELLAR_NETWORK unset)
// we fall back to testnet with a console warning so the dev server is still
// usable without a full .env file.
if (!STELLAR_NETWORK) {
  if (process.env.NODE_ENV === 'production') {
    // Throwing here aborts the React render and surfaces a white-screen error
    // that is far less dangerous than silently streaming testnet data for a
    // mainnet deployment.
    throw new Error(
      '[AfriPay] REACT_APP_STELLAR_NETWORK is not set. ' +
        "Production builds must set this to 'mainnet' or 'testnet'.",
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[AfriPay] REACT_APP_STELLAR_NETWORK is not set; defaulting to testnet. ' +
        'Set it in your .env file to silence this warning.',
    );
  }
}

/** True when running against the Stellar testnet. */
export const IS_TESTNET = STELLAR_NETWORK !== 'mainnet';

/**
 * The canonical Horizon base URL for this deployment.
 *
 * Resolution order:
 *   1. REACT_APP_STELLAR_HORIZON_URL  — explicit override
 *   2. Network-derived default        — testnet or mainnet Horizon
 */
export const HORIZON_URL =
  process.env.REACT_APP_STELLAR_HORIZON_URL ||
  (IS_TESTNET
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org');

/**
 * The Stellar network passphrase for transaction signing / XDR decoding.
 * Matches the network selected by REACT_APP_STELLAR_NETWORK.
 */
export const NETWORK_PASSPHRASE = IS_TESTNET ? Networks.TESTNET : Networks.PUBLIC;

/**
 * Short network label used by Stellar Expert explorer URLs and the SDK's
 * Horizon.Server constructor.
 *   'testnet' | 'public'
 */
export const NETWORK_LABEL = IS_TESTNET ? 'testnet' : 'public';
