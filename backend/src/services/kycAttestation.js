/**
 * KYC Attestation Service
 *
 * Pushes/revokes on-chain KYC attestations via the Soroban kyc-attestation
 * contract. The kyc_hash is SHA-256(userId + walletAddress + id_type) —
 * a deterministic commitment that never exposes raw PII on-chain.
 *
 * Required env vars:
 *   KYC_ATTESTATION_CONTRACT_ID — deployed contract address
 *   SOROBAN_RPC_URL             — Soroban RPC endpoint
 *   ADMIN_ENCRYPTED_SECRET_KEY  — AES-256 encrypted secret key for admin wallet
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

const CONTRACT_ID = process.env.KYC_ATTESTATION_CONTRACT_ID;

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(rpcUrl);
}

function decryptSecret(encryptedKey) {
  const [ivHex, encrypted] = encryptedKey.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
  return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
}

/**
 * Build a SHA-256 commitment of KYC metadata.
 * Never includes raw document numbers — only stable identifiers.
 */
function buildKycHash(userId, walletAddress, idType) {
  return crypto
    .createHash("sha256")
    .update(`${userId}:${walletAddress}:${idType}`)
    .digest();
}

async function invokeAdmin(method, args) {
  if (!CONTRACT_ID) {
    throw Object.assign(new Error("KYC_ATTESTATION_CONTRACT_ID is not configured"), { status: 500 });
  }

  const encryptedKey = process.env.ADMIN_ENCRYPTED_SECRET_KEY;
  if (!encryptedKey) {
    throw Object.assign(new Error("ADMIN_ENCRYPTED_SECRET_KEY is not configured"), { status: 500 });
  }

  const secretKey = decryptSecret(encryptedKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const rpc = getRpc();

  const account = await rpc.getAccount(keypair.publicKey());
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw Object.assign(new Error(`${method} failed: ${result.errorResult}`), { status: 400 });
  }

  let response = result;
  while (response.status === "PENDING" || response.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    response = await rpc.getTransaction(result.hash);
  }

  if (response.status !== "SUCCESS") {
    throw Object.assign(new Error(`Transaction failed: ${response.status}`), { status: 400 });
  }

  return result.hash;
}

/**
 * Attest a user's KYC on-chain.
 * @param {string} adminPublicKey - Admin Stellar address
 * @param {string} userWalletAddress - User's Stellar address
 * @param {string} userId - Internal user ID (for hash construction)
 * @param {string} idType - KYC document type
 * @returns {Promise<string>} transaction hash
 */
async function attestKyc(adminPublicKey, userWalletAddress, userId, idType) {
  const kycHashBytes = buildKycHash(userId, userWalletAddress, idType);

  const args = [
    StellarSdk.nativeToScVal(adminPublicKey, { type: "address" }),
    StellarSdk.nativeToScVal(userWalletAddress, { type: "address" }),
    StellarSdk.xdr.ScVal.scvBytes(kycHashBytes),
  ];

  return invokeAdmin("attest", args);
}

/**
 * Revoke a user's KYC attestation on-chain.
 * @param {string} adminPublicKey - Admin Stellar address
 * @param {string} userWalletAddress - User's Stellar address
 * @returns {Promise<string>} transaction hash
 */
async function revokeKyc(adminPublicKey, userWalletAddress) {
  const args = [
    StellarSdk.nativeToScVal(adminPublicKey, { type: "address" }),
    StellarSdk.nativeToScVal(userWalletAddress, { type: "address" }),
  ];

  return invokeAdmin("revoke", args);
}

module.exports = { attestKyc, revokeKyc };
