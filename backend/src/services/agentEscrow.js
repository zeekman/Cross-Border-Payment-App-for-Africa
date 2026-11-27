/**
 * Agent Escrow Service
 *
 * Integrates with the Soroban agent-escrow contract to provide trustless
 * agent payout flows. All contract interactions go through the Stellar RPC.
 *
 * Event topic scheme (two-element):
 *   topic[0] = "AgentEscrow"   (contract name)
 *   topic[1] = "EscrowCreated" | "EscrowConfirmed" | "EscrowCancelled" | "AdminOverride"
 *
 * Use subscribeToEscrowEvents() to receive a filtered Horizon event stream
 * for any of those event names.
 *
 * Required env vars:
 *   AGENT_ESCROW_CONTRACT_ID  — deployed contract address
 *   SOROBAN_RPC_URL           — Soroban RPC endpoint (defaults to testnet)
 */

const StellarSdk = require("@stellar/stellar-sdk");
const { toApiError } = require("../utils/sorobanErrors");

const { decryptAesCbc } = require("../utils/symmetricEncryption");

const { isTestnet, networkPassphrase, getRpc, waitForSorobanTx } = require("../config/soroban");

const CONTRACT_ID = process.env.AGENT_ESCROW_CONTRACT_ID;

const CONFIRMATION_TIMEOUT_MS = parseInt(process.env.SOROBAN_CONFIRMATION_TIMEOUT_MS || "30000", 10);

/**
 * The two-element topic prefix used by every agent-escrow contract event.
 *
 * Horizon event filter format: topic[0] = "AgentEscrow", topic[1] = <event_name>
 *
 * Supported event names:
 *   "EscrowCreated"   — new escrow locked on-chain
 *   "EscrowConfirmed" — agent confirmed payout; funds released
 *   "EscrowCancelled" — sender cancelled; full refund issued
 *   "AdminOverride"   — admin forced an early release or refund
 */
const ESCROW_EVENT_TOPIC_PREFIX = "AgentEscrow";

const ESCROW_EVENT_NAMES = Object.freeze({
  CREATED: "EscrowCreated",
  CONFIRMED: "EscrowConfirmed",
  CANCELLED: "EscrowCancelled",
  ADMIN_OVERRIDE: "AdminOverride",
});

/**
 * Subscribe to agent-escrow contract events from Horizon for a specific
 * event type. The callback receives the raw Horizon event object.
 *
 * @param {string}   eventName  - One of ESCROW_EVENT_NAMES values.
 * @param {Function} onEvent    - Called for each matching event.
 * @param {Function} [onError]  - Called on stream error (optional).
 * @returns {Function} close    - Call to stop the stream.
 *
 * @example
 *   const stop = subscribeToEscrowEvents(
 *     ESCROW_EVENT_NAMES.CONFIRMED,
 *     (evt) => console.log('payout confirmed', evt),
 *   );
 */
function subscribeToEscrowEvents(eventName, onEvent, onError) {
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL ||
    (isTestnet
      ? "https://horizon-testnet.stellar.org"
      : "https://horizon.stellar.org");

  const server = new StellarSdk.Horizon.Server(horizonUrl);

  // Horizon contract-event filter: match on contract ID and the two-element
  // topic array [ESCROW_EVENT_TOPIC_PREFIX, eventName].
  const close = server
    .contractEvents()
    .forContract(CONTRACT_ID)
    .cursor("now")
    .stream({
      onmessage: (event) => {
        // Each Horizon contract event has a `topic` array of XDR-encoded values.
        // We decode them and check the two-element scheme.
        try {
          const topics = event.topic || [];
          if (topics.length < 2) return;

          const t0 = StellarSdk.scValToNative(
            StellarSdk.xdr.ScVal.fromXDR(topics[0], "base64")
          );
          const t1 = StellarSdk.scValToNative(
            StellarSdk.xdr.ScVal.fromXDR(topics[1], "base64")
          );

          if (t0 === ESCROW_EVENT_TOPIC_PREFIX && t1 === eventName) {
            onEvent(event);
          }
        } catch {
          // Malformed event — skip silently.
        }
      },
      onerror: (err) => {
        if (typeof onError === "function") {
          onError(err);
        }
      },
    });

  return close;
}

async function getRecommendedFee(rpc) {
  try {
    const stats = await rpc.getFeeStats();
    const p90 = stats?.sorobanInclusionFee?.p90;
    if (p90 != null) {
      return String(p90);
    }
    return String(StellarSdk.BASE_FEE * 10);
  } catch {
    return String(StellarSdk.BASE_FEE * 10);
  }
}

function decryptSecret(encryptedKey) {
  return decryptAesCbc(encryptedKey);
}

// Internal implementation with full arg list
async function createEscrow({ encryptedSecretKey, recipient, agent, amount, feeBps }) {
  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const sender = keypair.publicKey();
  const rpc = getRpc();

  const account = await rpc.getAccount(sender);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const fee = await getRecommendedFee(rpc);

  const args = [
    StellarSdk.nativeToScVal(sender, { type: "address" }),
    StellarSdk.nativeToScVal(recipient, { type: "address" }),
    StellarSdk.nativeToScVal(agent, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(amount), { type: "i128" }),
    StellarSdk.nativeToScVal(feeBps, { type: "u32" }),
  ];

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase,
  })
    .addOperation(contract.call("create_escrow", ...args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw toApiError(result, 'agentEscrow');
  }

  const response = await waitForSorobanTx(rpc, result, { timeoutMs: CONFIRMATION_TIMEOUT_MS });

  if (response.status !== "SUCCESS") {
    throw toApiError(response, 'agentEscrow');
  }

  const escrowId = StellarSdk.scValToNative(response.returnValue).toString();
  return { escrowId, txHash: result.hash };
}

/**
 * Agent confirms off-chain fiat delivery, releasing USDC from escrow.
 * Returns { txHash }.
 */
async function confirmPayout({ encryptedSecretKey, escrowId }) {
  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const agent = keypair.publicKey();
  const rpc = getRpc();

  const account = await rpc.getAccount(agent);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const fee = await getRecommendedFee(rpc);

  const args = [
    StellarSdk.nativeToScVal(agent, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(escrowId), { type: "u64" }),
  ];

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase,
  })
    .addOperation(contract.call("confirm_payout", ...args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw toApiError(result, 'agentEscrow');
  }

  const response = await waitForSorobanTx(rpc, result, { timeoutMs: CONFIRMATION_TIMEOUT_MS });

  if (response.status !== "SUCCESS") {
    throw toApiError(response, 'agentEscrow');
  }

  return { txHash: result.hash };
}

/**
 * Sender cancels escrow after the 48-hour window.
 * Returns { txHash }.
 */
async function cancelEscrow({ encryptedSecretKey, escrowId }) {
  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const sender = keypair.publicKey();
  const rpc = getRpc();

  const account = await rpc.getAccount(sender);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const fee = await getRecommendedFee(rpc);

  const args = [
    StellarSdk.nativeToScVal(sender, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(escrowId), { type: "u64" }),
  ];

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase,
  })
    .addOperation(contract.call("cancel_escrow", ...args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw toApiError(result, 'agentEscrow');
  }

  const response = await waitForSorobanTx(rpc, result, { timeoutMs: CONFIRMATION_TIMEOUT_MS });

  if (response.status !== "SUCCESS") {
    throw toApiError(response, 'agentEscrow');
  }

  return { txHash: result.hash };
}

/**
 * Admin withdraws accrued fees from the contract to an explicit recipient.
 *
 * Contract signature: withdraw_fees(to: Address, amount: i128)
 * The contract reads the stored admin from its own state and authorises the
 * call against it, so the admin address is NOT passed as an argument.
 *
 * Returns { txHash }.
 */
async function withdrawFees({ encryptedSecretKey, to, amount }) {
  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const admin = keypair.publicKey();
  const rpc = getRpc();

  const account = await rpc.getAccount(admin);
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const fee = await getRecommendedFee(rpc);

  // Argument order must match the contract: (to, amount).
  const args = [
    StellarSdk.nativeToScVal(to, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(amount), { type: "i128" }),
  ];

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase,
  })
    .addOperation(contract.call("withdraw_fees", ...args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw Object.assign(new Error(`withdraw_fees failed: ${result.errorResult}`), { status: 400 });
  }

  const response = await waitForSorobanTx(rpc, result, { timeoutMs: CONFIRMATION_TIMEOUT_MS });

  if (response.status !== "SUCCESS") {
    throw Object.assign(new Error(`Transaction failed: ${response.status}`), { status: 400 });
  }

  return { txHash: result.hash };
}

module.exports = {
  createEscrow,
  confirmPayout,
  cancelEscrow,
  withdrawFees,
  subscribeToEscrowEvents,
  ESCROW_EVENT_NAMES,
};
