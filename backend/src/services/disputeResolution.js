/**
 * Dispute Resolution Service
 *
 * Integrates with the Soroban dispute-resolution contract to provide
 * on-chain three-party dispute arbitration.
 *
 * Required env vars:
 *   DISPUTE_RESOLUTION_CONTRACT_ID — deployed contract address
 *   SOROBAN_RPC_URL                — Soroban RPC endpoint
 *   ENCRYPTION_KEY                 — 32-char AES key for secret decryption
 */

const StellarSdk = require("@stellar/stellar-sdk");
const crypto = require("crypto");

const ALGORITHM = "aes-256-cbc";
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

const isTestnet = process.env.STELLAR_NETWORK !== "mainnet";
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

const rpcUrl =
  process.env.SOROBAN_RPC_URL ||
  (isTestnet
    ? "https://soroban-testnet.stellar.org"
    : "https://mainnet.soroban.stellar.org");

const CONTRACT_ID = process.env.DISPUTE_RESOLUTION_CONTRACT_ID;

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(rpcUrl);
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

function requireContractId() {
  if (!CONTRACT_ID) {
    throw Object.assign(
      new Error("DISPUTE_RESOLUTION_CONTRACT_ID is not configured"),
      { status: 500 }
    );
  }
}

async function sendAndConfirm(keypair, operation) {
  const rpc = getRpc();
  const account = await rpc.getAccount(keypair.publicKey());
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(operation.method, ...operation.args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw Object.assign(
      new Error(`Contract call failed: ${result.errorResult}`),
      { status: 400 }
    );
  }

  let response = result;
  while (response.status === "PENDING" || response.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    response = await rpc.getTransaction(result.hash);
  }

  if (response.status !== "SUCCESS") {
    throw Object.assign(
      new Error(`Transaction failed: ${response.status}`),
      { status: 400 }
    );
  }

  return { hash: result.hash, returnValue: response.returnValue };
}

/**
 * Open a dispute, locking `amount` USDC in the contract.
 * The opener (sender or recipient) signs the transaction.
 *
 * Returns { disputeId, txHash, deadline }.
 */
async function openDispute({ encryptedSecretKey, sender, recipient, amount }) {
  requireContractId();

  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const opener = keypair.publicKey();

  const args = [
    StellarSdk.nativeToScVal(opener, { type: "address" }),
    StellarSdk.nativeToScVal(sender, { type: "address" }),
    StellarSdk.nativeToScVal(recipient, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(amount), { type: "i128" }),
  ];

  const { hash, returnValue } = await sendAndConfirm(keypair, {
    method: "open_dispute",
    args,
  });

  const disputeId = StellarSdk.scValToNative(returnValue).toString();
  // 7-day deadline from now (mirrors contract logic)
  const deadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  return { disputeId, txHash: hash, deadline };
}

/**
 * Submit evidence for an open dispute.
 * The submitter (sender or recipient) signs the transaction.
 *
 * Returns { txHash }.
 */
async function submitEvidence({ encryptedSecretKey, disputeId, evidence }) {
  requireContractId();

  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const submitter = keypair.publicKey();

  const evidenceBytes = StellarSdk.xdr.ScVal.scvBytes(
    Buffer.from(evidence, "utf8")
  );

  const args = [
    StellarSdk.nativeToScVal(submitter, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(disputeId), { type: "u64" }),
    evidenceBytes,
  ];

  const { hash } = await sendAndConfirm(keypair, {
    method: "submit_evidence",
    args,
  });

  return { txHash: hash };
}

/**
 * Resolve a dispute. Only the arbitrator's encrypted key should be passed.
 * `releaseToRecipient`: true → funds go to recipient; false → refund sender.
 *
 * Returns { txHash }.
 */
async function resolveDispute({
  encryptedArbitratorKey,
  disputeId,
  releaseToRecipient,
}) {
  requireContractId();

  const secretKey = decryptSecret(encryptedArbitratorKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const arbitrator = keypair.publicKey();

  const args = [
    StellarSdk.nativeToScVal(arbitrator, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(disputeId), { type: "u64" }),
    StellarSdk.nativeToScVal(releaseToRecipient, { type: "bool" }),
  ];

  const { hash } = await sendAndConfirm(keypair, {
    method: "resolve_dispute",
    args,
  });

  return { txHash: hash };
}

module.exports = { openDispute, submitEvidence, resolveDispute };
