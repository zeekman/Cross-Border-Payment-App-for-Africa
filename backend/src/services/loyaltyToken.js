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

const CONTRACT_ID = process.env.LOYALTY_TOKEN_CONTRACT_ID;

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

/**
 * Redeem 100 loyalty points for a 50 % fee discount.
 *
 * The caller's encrypted secret key is used to authorise the on-chain
 * `redeem` call. Returns `{ redeemed: true, txHash }` if successful,
 * or `{ redeemed: false }` if the user has fewer than 100 points.
 */
async function redeemPoints({ encryptedSecretKey, walletAddress }) {
  requireContractId();

  const secretKey = decryptSecret(encryptedSecretKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);

  const args = [
    StellarSdk.nativeToScVal(walletAddress, { type: "address" }),
  ];

  const { hash, returnValue } = await sendAndConfirm(keypair, "redeem", args);
  const redeemed = StellarSdk.scValToNative(returnValue);

  return { redeemed: Boolean(redeemed), txHash: hash };
}

/**
 * Query the on-chain balance for `walletAddress`.
 * Returns the point balance as a number.
 */
async function getBalance({ walletAddress }) {
  requireContractId();

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

module.exports = { mintPoints, redeemPoints, getBalance };
