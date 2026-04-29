/**
 * Agent Escrow Service
 *
 * Integrates with the Soroban agent-escrow contract to provide trustless
 * agent payout flows. All contract interactions go through the Stellar RPC.
 *
 * Required env vars:
 *   AGENT_ESCROW_CONTRACT_ID  — deployed contract address
 *   SOROBAN_RPC_URL           — Soroban RPC endpoint (defaults to testnet)
 */

const StellarSdk = require("@stellar/stellar-sdk");
const crypto = require("crypto");

const ALGORITHM = "aes-256-cbc";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // 32-char key

const isTestnet = process.env.STELLAR_NETWORK !== "mainnet";
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

const rpcUrl =
  process.env.SOROBAN_RPC_URL ||
  (isTestnet
    ? "https://soroban-testnet.stellar.org"
    : "https://mainnet.soroban.stellar.org");

const CONTRACT_ID = process.env.AGENT_ESCROW_CONTRACT_ID;

const CONFIRMATION_TIMEOUT_MS = parseInt(process.env.SOROBAN_CONFIRMATION_TIMEOUT_MS || "30000", 10);
const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ITERATIONS = Math.ceil(CONFIRMATION_TIMEOUT_MS / POLL_INTERVAL_MS);

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(rpcUrl);
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
  const [ivHex, encrypted] = encryptedKey.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY),
    iv
  );
  return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
}

async function invokeContract(encryptedSecretKey, method, args) {
  if (!CONTRACT_ID) {
    throw Object.assign(new Error("AGENT_ESCROW_CONTRACT_ID is not configured"), { status: 500 });
  }

  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const rpc = getRpc();

  const account = await rpc.getAccount(keypair.publicKey());
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const fee = await getRecommendedFee(rpc);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw Object.assign(new Error(`Contract call failed: ${result.errorResult}`), { status: 400 });
  }

  // Poll for confirmation
  let response = result;
  let iterations = 0;
  while (response.status === "PENDING" || response.status === "NOT_FOUND") {
    if (iterations >= MAX_POLL_ITERATIONS) {
      throw Object.assign(new Error("Transaction confirmation timeout after 30s"), { status: 504 });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    response = await rpc.getTransaction(result.hash);
    iterations++;
  }

  if (response.status !== "SUCCESS") {
    throw Object.assign(new Error(`Transaction failed: ${response.status}`), { status: 400 });
  }

  return { hash: result.hash, returnValue: response.returnValue };
}

/**
 * Create an agent escrow on-chain.
 * Returns { escrowId, txHash }.
 */
async function createEscrow({ encryptedSecretKey, recipient, agent, amount, feeBps }) {
  const { hash, returnValue } = await invokeContract(
    encryptedSecretKey,
    "create_escrow",
    [
      // sender is derived from the keypair inside invokeContract — pass as arg
      // The contract requires sender address; we pass it via the keypair public key
      // resolved inside the helper below
    ]
  );
  // Delegate to the full helper that has access to the keypair public key
  return _createEscrow({ encryptedSecretKey, recipient, agent, amount, feeBps });
}

// Internal implementation with full arg list
async function _createEscrow({ encryptedSecretKey, recipient, agent, amount, feeBps }) {
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
    throw Object.assign(new Error(`create_escrow failed: ${result.errorResult}`), { status: 400 });
  }

  let response = result;
  let iterations = 0;
  while (response.status === "PENDING" || response.status === "NOT_FOUND") {
    if (iterations >= MAX_POLL_ITERATIONS) {
      throw Object.assign(new Error("Transaction confirmation timeout after 30s"), { status: 504 });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    response = await rpc.getTransaction(result.hash);
    iterations++;
  }

  if (response.status !== "SUCCESS") {
    throw Object.assign(new Error(`Transaction failed: ${response.status}`), { status: 400 });
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
    throw Object.assign(new Error(`confirm_payout failed: ${result.errorResult}`), { status: 400 });
  }

  let response = result;
  let iterations = 0;
  while (response.status === "PENDING" || response.status === "NOT_FOUND") {
    if (iterations >= MAX_POLL_ITERATIONS) {
      throw Object.assign(new Error("Transaction confirmation timeout after 30s"), { status: 504 });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    response = await rpc.getTransaction(result.hash);
    iterations++;
  }

  if (response.status !== "SUCCESS") {
    throw Object.assign(new Error(`Transaction failed: ${response.status}`), { status: 400 });
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
    throw Object.assign(new Error(`cancel_escrow failed: ${result.errorResult}`), { status: 400 });
  }

  let response = result;
  let iterations = 0;
  while (response.status === "PENDING" || response.status === "NOT_FOUND") {
    if (iterations >= MAX_POLL_ITERATIONS) {
      throw Object.assign(new Error("Transaction confirmation timeout after 30s"), { status: 504 });
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    response = await rpc.getTransaction(result.hash);
    iterations++;
  }

  if (response.status !== "SUCCESS") {
    throw Object.assign(new Error(`Transaction failed: ${response.status}`), { status: 400 });
  }

  return { txHash: result.hash };
}

module.exports = { createEscrow: _createEscrow, confirmPayout, cancelEscrow };
