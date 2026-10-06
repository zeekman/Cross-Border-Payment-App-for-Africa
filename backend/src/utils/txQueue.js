const { txQueueDepth, txQueueBackpressure, txQueuePendingTasksTotal } = require('./metrics');

const QUEUE_TIMEOUT_MS = parseInt(process.env.TX_QUEUE_TIMEOUT_MS || '30000', 10);

// Total pending/in-flight tasks across all wallet queues before we consider
// the transaction submission queue "backpressured" (BE-041). Exceeding this
// doesn't reject work — enqueue() still serializes and runs it — but it is
// exported as a metric so operators/alerts can see the queue is falling
// behind before requests start timing out.
const BACKPRESSURE_THRESHOLD = parseInt(process.env.TX_QUEUE_BACKPRESSURE_THRESHOLD || '50', 10);

// Map of walletPublicKey -> tail of promise chain
const queues = new Map();

// Total pending/in-flight tasks across all wallet queues (not just number of
// distinct wallets — a wallet queue can have more than one task chained
// behind it at a time).
let pendingTasksTotal = 0;

function updateMetrics() {
  txQueueDepth.set(queues.size);
  txQueuePendingTasksTotal.set(pendingTasksTotal);
  txQueueBackpressure.set(pendingTasksTotal > BACKPRESSURE_THRESHOLD ? 1 : 0);
}

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

  pendingTasksTotal += 1;
  updateMetrics();

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

  const settle = () => {
    pendingTasksTotal = Math.max(0, pendingTasksTotal - 1);
    updateMetrics();
  };
  next.then(settle, settle);

  // Store the chain tail so the next enqueue() for this wallet chains after it.
  queues.set(walletKey, next.catch(() => {}));

  return next;
}

/** Current number of distinct wallet queues with pending/in-flight work. */
function getQueueDepth() {
  return queues.size;
}

/** Total pending/in-flight tasks across all wallet queues. */
function getPendingTasksTotal() {
  return pendingTasksTotal;
}

/** Whether the queue is currently under backpressure. */
function isBackpressured() {
  return pendingTasksTotal > BACKPRESSURE_THRESHOLD;
}

module.exports = { enqueue, getQueueDepth, getPendingTasksTotal, isBackpressured, BACKPRESSURE_THRESHOLD };
