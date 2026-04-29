const QUEUE_TIMEOUT_MS = parseInt(process.env.TX_QUEUE_TIMEOUT_MS || '30000', 10);

// Map of walletPublicKey -> tail of promise chain
const queues = new Map();

/**
 * Enqueue an async task for a specific wallet. Tasks for the same wallet
 * run serially; tasks for different wallets run independently.
 * Rejects with ETIMEDOUT if the task doesn't complete within QUEUE_TIMEOUT_MS.
 *
 * @param {string} walletKey - Stellar public key
 * @param {() => Promise<any>} fn - async task to run
 */
function enqueue(walletKey, fn) {
  const prev = queues.get(walletKey) || Promise.resolve();

  const next = prev.then(() =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error('Transaction queue timeout');
        err.code = 'ETIMEDOUT';
        reject(err);
      }, QUEUE_TIMEOUT_MS);

      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    })
  );

  // Store the chain tail; clean up when done so the Map doesn't grow forever
  queues.set(walletKey, next.catch(() => {}));

  return next;
}

module.exports = { enqueue };
