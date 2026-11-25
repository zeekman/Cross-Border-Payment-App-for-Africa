/**
 * Single source of Soroban RPC configuration (#1301) and the shared
 * transaction-confirmation poller (#1300).
 *
 * SOROBAN_RPC_URL is required on mainnet (SDF runs no public mainnet RPC) and
 * is validated at startup by utils/validateEnv.js.
 */
const StellarSdk = require('@stellar/stellar-sdk');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;
const rpcUrl = process.env.SOROBAN_RPC_URL || (isTestnet ? 'https://soroban-testnet.stellar.org' : undefined);

const DEFAULT_TIMEOUT_MS = parseInt(process.env.SOROBAN_CONFIRMATION_TIMEOUT_MS || '60000', 10);

function getRpc() {
  if (!rpcUrl) throw new Error('SOROBAN_RPC_URL is not configured');
  return new StellarSdk.SorobanRpc.Server(rpcUrl);
}

class TxTimeoutError extends Error {
  constructor(hash, timeoutMs) {
    super(`Soroban transaction ${hash} not confirmed within ${timeoutMs}ms`);
    this.name = 'TxTimeoutError';
    this.code = 'TX_TIMEOUT';
    this.status = 504;
    this.hash = hash;
  }
}

/**
 * Poll getTransaction until the submitted tx leaves PENDING/NOT_FOUND, with
 * backoff, giving up after timeoutMs.
 *
 * @param {object} rpc         - SorobanRpc.Server
 * @param {object} sendResult  - result of rpc.sendTransaction()
 * @returns {Promise<object>}  final getTransaction response
 */
async function waitForSorobanTx(rpc, sendResult, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (sendResult.status === 'TRY_AGAIN_LATER') {
    throw Object.assign(new Error('Soroban RPC busy, try again later'), { status: 503, code: 'TRY_AGAIN_LATER' });
  }

  const { hash } = sendResult;
  const deadline = Date.now() + timeoutMs;
  let delay = 1000;
  // DUPLICATE means the tx was already submitted — poll it like PENDING.
  let response = { status: 'PENDING' };
  while (response.status === 'PENDING' || response.status === 'NOT_FOUND') {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TxTimeoutError(hash, timeoutMs);
    const wait = Math.min(delay, remaining);
    await new Promise((resolve) => { setTimeout(resolve, wait); });
    delay = Math.min(delay * 1.5, 5000);
    response = await rpc.getTransaction(hash);
  }
  return response;
}

module.exports = { isTestnet, networkPassphrase, rpcUrl, getRpc, TxTimeoutError, waitForSorobanTx };
