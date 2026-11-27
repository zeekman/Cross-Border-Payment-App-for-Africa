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
const { toApiError } = require("../utils/sorobanErrors");
const crypto = require("crypto");

const { decryptAesCbc } = require("../utils/symmetricEncryption");

const { networkPassphrase, getRpc, waitForSorobanTx } = require("../config/soroban");

const CONTRACT_ID = process.env.KYC_ATTESTATION_CONTRACT_ID;

function decryptSecret(encryptedKey) {
  return decryptAesCbc(encryptedKey);
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

// Mirrors `KycTier` in contracts/kyc-attestation (C-like enum → encoded as u32).
const KYC_TIERS = { basic: 0, enhanced: 1, business: 2 };

function normalizeTierValue(tier = "basic") {
  const value = typeof tier === "number" ? tier : KYC_TIERS[String(tier).toLowerCase()];
  if (![0, 1, 2].includes(value)) {
    throw Object.assign(new Error(`Invalid KYC tier: ${tier}`), { status: 400 });
  }
  return value;
}

function tierToScVal(tier = "basic") {
  return StellarSdk.nativeToScVal(normalizeTierValue(tier), { type: "u32" });
}

function getAdminPublicKey() {
  const encryptedKey = process.env.ADMIN_ENCRYPTED_SECRET_KEY;
  if (!encryptedKey) {
    throw Object.assign(new Error("ADMIN_ENCRYPTED_SECRET_KEY is not configured"), { status: 500 });
  }
  return StellarSdk.Keypair.fromSecret(decryptSecret(encryptedKey)).publicKey();
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
    throw toApiError(result, 'kycAttestation');
  }

  const response = await waitForSorobanTx(rpc, result);

  if (response.status !== "SUCCESS") {
    throw toApiError(response, 'kycAttestation');
  }

  return result.hash;
}

/**
 * Read the on-chain max validity (seconds) for a KYC tier.
 * Returns 0 when the tier is configured as unlimited/unset.
 */
async function getMaxValidity(tier = "basic") {
  if (!CONTRACT_ID) {
    throw Object.assign(new Error("KYC_ATTESTATION_CONTRACT_ID is not configured"), { status: 500 });
  }

  const rpc = getRpc();
  const contract = new StellarSdk.Contract(CONTRACT_ID);
  const adminPublicKey = getAdminPublicKey();
  const account = await rpc.getAccount(adminPublicKey);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("get_max_validity", tierToScVal(tier)))
    .setTimeout(30)
    .build();

  const simResult = await rpc.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
    throw Object.assign(
      new Error(`Failed to read max validity: ${JSON.stringify(simResult.error)}`),
      { status: 502 }
    );
  }

  const val = simResult.result?.retval;
  return val ? Number(StellarSdk.scValToNative(val)) : 0;
}

async function computeExpiresAt(tier = "basic") {
  const maxValidity = await getMaxValidity(tier);
  if (!maxValidity) return 0;
  return Math.floor(Date.now() / 1000) + maxValidity;
}

/**
 * Attest a user's KYC on-chain.
 * Contract: attest(admin, user, tier: KycTier, kyc_hash: Bytes, expires_at: u64)
 * @param {string} adminPublicKey - Admin Stellar address
 * @param {string} userWalletAddress - User's Stellar address
 * @param {string} userId - Internal user ID (for hash construction)
 * @param {string} idType - KYC document type
 * @param {object} [opts]
 * @param {string|number} [opts.tier="basic"] - basic | enhanced | business
 * @param {Date|number} [opts.expiresAt] - expiry (Date or unix seconds); when omitted,
 *   computed from the contract's get_max_validity(tier) policy
 * @returns {Promise<string>} transaction hash
 */
async function attestKyc(adminPublicKey, userWalletAddress, userId, idType, opts = {}) {
  const tier = opts.tier ?? "basic";
  const kycHashBytes = buildKycHash(userId, userWalletAddress, idType);
  let expiresAt = opts.expiresAt;

  if (expiresAt instanceof Date) {
    expiresAt = Math.floor(expiresAt.getTime() / 1000);
  }

  if (expiresAt == null) {
    expiresAt = await computeExpiresAt(tier);
  }

  const args = [
    StellarSdk.nativeToScVal(adminPublicKey, { type: "address" }),
    StellarSdk.nativeToScVal(userWalletAddress, { type: "address" }),
    tierToScVal(tier),
    StellarSdk.xdr.ScVal.scvBytes(kycHashBytes),
    StellarSdk.nativeToScVal(BigInt(expiresAt), { type: "u64" }),
  ];

  return invokeAdmin("attest", args);
}

/**
 * Revoke a user's KYC attestation on-chain.
 * Contract: revoke(admin, user, tier: KycTier)
 * @param {string} adminPublicKey - Admin Stellar address
 * @param {string} userWalletAddress - User's Stellar address
 * @param {string|number} [tier="basic"] - basic | enhanced | business
 * @returns {Promise<string>} transaction hash
 */
async function revokeKyc(adminPublicKey, userWalletAddress, tier = "basic") {
  const args = [
    StellarSdk.nativeToScVal(adminPublicKey, { type: "address" }),
    StellarSdk.nativeToScVal(userWalletAddress, { type: "address" }),
    tierToScVal(tier),
  ];

  return invokeAdmin("revoke", args);
}

/**
 * Public key of the admin wallet configured via ADMIN_ENCRYPTED_SECRET_KEY.
 * Used by system jobs (e.g. kycExpiryJob) that need to call attest/revoke
 * without an authenticated admin request in context.
 */
module.exports = {
  attestKyc,
  revokeKyc,
  getAdminPublicKey,
  getMaxValidity,
  computeExpiresAt,
  KYC_TIERS,
};
