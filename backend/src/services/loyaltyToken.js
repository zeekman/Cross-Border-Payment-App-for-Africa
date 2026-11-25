/**
 * Loyalty Token Service
 *
 * Integrates with the Soroban loyalty-token contract to mint and redeem
 * AfriPay Loyalty Points (ALP) on-chain.
 *
 * Required env vars:
 *   LOYALTY_TOKEN_CONTRACT_ID — deployed contract address
 *   SOROBAN_RPC_URL           — Soroban RPC endpoint
 *   ENCRYPTION_KEY            — 32-char AES key for secret decryption
 *   LOYALTY_ADMIN_KEY         — encrypted secret key of the mint-authority account
 */

const StellarSdk = require("@stellar/stellar-sdk");

const { decryptAesCbc } = require("../utils/symmetricEncryption");

const { networkPassphrase, getRpc, waitForSorobanTx } = require("../config/soroban");

const CONTRACT_ID = process.env.LOYALTY_TOKEN_CONTRACT_ID;

function decryptSecret(encryptedKey) {
  return decryptAesCbc(encryptedKey);
}

function requireContractId() {
  if (!CONTRACT_ID) {
    throw Object.assign(
      new Error("LOYALTY_TOKEN_CONTRACT_ID is not configured"),
      { status: 500 }
    );
  }
}

async function sendAndConfirm(keypair, method, args) {
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
 * Mint `points` loyalty tokens to `recipientWallet`.
 *
 * Called by the payment controller after each successful transaction.
 * Earn rate: 1 point per 1 XLM (or XLM-equivalent) of volume.
 *
 * Returns { txHash } or null if the contract is not configured (non-fatal).
 */
async function mintPoints({ recipientWallet, points }) {
  if (!CONTRACT_ID) return null; // loyalty contract is optional

  const encryptedAdminKey = process.env.LOYALTY_ADMIN_KEY;
  if (!encryptedAdminKey) return null;

  const secretKey = decryptSecret(encryptedAdminKey);
  const adminKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const admin = adminKeypair.publicKey();

  const args = [
    StellarSdk.nativeToScVal(admin, { type: "address" }),
    StellarSdk.nativeToScVal(recipientWallet, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(points), { type: "i128" }),
  ];

  const { hash } = await sendAndConfirm(adminKeypair, "mint", args);
  return { txHash: hash };
}

const MAX_TIERS = 5;

/**
 * Read a redemption tier (`DataKey::Tier(i)`) straight from contract storage.
 * Returns `{ index, threshold, discount_bps }` or null if not configured.
 */
async function getTier(index) {
  requireContractId();
  const key = StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvSymbol("Tier"),
    StellarSdk.nativeToScVal(index, { type: "u32" }),
  ]);
  try {
    const entry = await getRpc().getContractData(
      CONTRACT_ID,
      key,
      StellarSdk.SorobanRpc.Durability.Persistent
    );
    const tier = StellarSdk.scValToNative(entry.val.contractData().val());
    return { index, threshold: Number(tier.threshold), discount_bps: Number(tier.discount_bps) };
  } catch {
    return null;
  }
}

/** All configured redemption tiers (indexes 0..MAX_TIERS-1). */
async function getTiers() {
  const tiers = await Promise.all([...Array(MAX_TIERS).keys()].map(getTier));
  return tiers.filter(Boolean);
}

/**
 * Redeem a loyalty tier: burns the tier's threshold of points on-chain.
 *
 * The contract's `redeem(user, tier_index)` returns nothing and panics with
 * "insufficient points for tier" when the balance is too low, which is mapped
 * to a 400. Returns `{ txHash, tier }` on success.
 */
async function redeemPoints({ encryptedSecretKey, walletAddress, tierIndex }) {
  requireContractId();

  const tier = await getTier(tierIndex);
  if (!tier) {
    throw Object.assign(new Error(`Loyalty tier ${tierIndex} is not configured`), { status: 400 });
  }

  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);

  const args = [
    StellarSdk.nativeToScVal(walletAddress, { type: "address" }),
    StellarSdk.nativeToScVal(tierIndex, { type: "u32" }),
  ];

  try {
    const { hash } = await sendAndConfirm(keypair, "redeem", args);
    return { txHash: hash, tier };
  } catch (err) {
    if (/insufficient points/i.test(err.message || "")) {
      throw Object.assign(
        new Error(`Insufficient loyalty points. Tier ${tierIndex} requires at least ${tier.threshold} points.`),
        { status: 400, threshold: tier.threshold }
      );
    }
    throw err;
  }
}

/**
 * Query the on-chain balance for `walletAddress`.
 * Returns the point balance as a number.
 */
async function getBalance({ walletAddress }) {
  // Return 0 if loyalty contract is not configured (non-fatal)
  if (!CONTRACT_ID) return 0;

  const rpc = getRpc();
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  // Use a throwaway keypair for read-only simulation
  const keypair = StellarSdk.Keypair.random();
  const account = await rpc.getAccount(keypair.publicKey()).catch(() => null);
  if (!account) {
    // Fall back to simulation without a real account
    return 0;
  }

  const args = [
    StellarSdk.nativeToScVal(walletAddress, { type: "address" }),
  ];

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("balance", ...args))
    .setTimeout(30)
    .build();

  const simResult = await rpc.simulateTransaction(tx);
  if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
    return 0;
  }

  const val = simResult.result?.retval;
  return val ? Number(StellarSdk.scValToNative(val)) : 0;
}

module.exports = { mintPoints, redeemPoints, getBalance, getTier, getTiers, MAX_TIERS };
