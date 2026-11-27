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

const crypto = require("crypto");
const StellarSdk = require("@stellar/stellar-sdk");

const { decryptAesCbc } = require("../utils/symmetricEncryption");

const { networkPassphrase, getRpc, waitForSorobanTx } = require("../config/soroban");

const CONTRACT_ID = process.env.DISPUTE_RESOLUTION_CONTRACT_ID;

function decryptSecret(encryptedKey) {
  return decryptAesCbc(encryptedKey);
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

  const response = await waitForSorobanTx(rpc, result);

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
 * The submitter (sender, recipient or agent) signs the transaction.
 *
 * The contract stores only a 32-byte content hash plus an optional short URI,
 * never raw document bytes. `evidence` may be:
 *   - a hex SHA-256 hash (64 chars) → submitted as the content hash, no URI;
 *   - an IPFS CID / URI string      → content hash = SHA-256 of the string,
 *                                     the string itself is submitted as the URI.
 *
 * Returns { txHash }.
 */
async function submitEvidence({ encryptedSecretKey, disputeId, evidence }) {
  requireContractId();

  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const submitter = keypair.publicKey();

  const isSha256Hash = /^[a-fA-F0-9]{64}$/.test(evidence);
  const contentHash = isSha256Hash
    ? Buffer.from(evidence, "hex")
    : crypto.createHash("sha256").update(evidence, "utf8").digest();
  const uri = isSha256Hash
    ? StellarSdk.xdr.ScVal.scvVoid()
    : StellarSdk.nativeToScVal(evidence, { type: "string" });

  const args = [
    StellarSdk.nativeToScVal(submitter, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(disputeId), { type: "u64" }),
    StellarSdk.xdr.ScVal.scvBytes(contentHash),
    uri,
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
