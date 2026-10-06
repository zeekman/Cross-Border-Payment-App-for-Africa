/**
 * Fee Distributor Service
 *
 * Deposits platform fees into the Soroban fee-distributor contract after each
 * successful payment, making the fee model transparent and auditable on-chain.
 *
 * Required env vars:
 *   FEE_DISTRIBUTOR_CONTRACT_ID — deployed contract address
 *   SOROBAN_RPC_URL             — Soroban RPC endpoint
 *   SERVICE_ENCRYPTED_SECRET_KEY — AES-256 encrypted key for the service wallet
 *                                  (this wallet holds USDC to cover fee deposits)
 */

const StellarSdk = require("@stellar/stellar-sdk");

const { decryptAesCbc } = require("../utils/symmetricEncryption");

const isTestnet = process.env.STELLAR_NETWORK !== "mainnet";
const networkPassphrase = isTestnet
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

const rpcUrl =
  process.env.SOROBAN_RPC_URL ||
  (isTestnet
    ? "https://soroban-testnet.stellar.org"
    : "https://mainnet.soroban.stellar.org");

const CONTRACT_ID = process.env.FEE_DISTRIBUTOR_CONTRACT_ID;

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(rpcUrl);
}

function decryptSecret(encryptedKey) {
  return decryptAesCbc(encryptedKey);
}

/**
 * Deposit a platform fee on-chain.
 * Fire-and-forget — caller should not await this in the critical path.
 *
 * @param {number|string} feeAmount  - Fee in USDC stroops (7 decimal places).
 * @param {string}        tokenId   - Stellar asset contract address for the fee token.
 * @param {string|null}   [source]  - Optional originating address for audit purposes.
 * @returns {Promise<string>} transaction hash
 */

// SC-017: Mirror the contract-level MAX_DEPOSIT_AMOUNT ceiling here so that a
// decimal-precision / unit mismatch in the caller is caught before it reaches
// the network.  The on-chain check is the authoritative backstop; this guard
// provides an early, descriptive error in the service layer.
// 10_000_000_000_000 stroops = 1,000,000 USDC (7 decimal places).
const MAX_DEPOSIT_AMOUNT_STROOPS = BigInt("10000000000000");

async function depositFee(feeAmount, tokenId, source = null) {
  if (!CONTRACT_ID) {
    throw new Error("FEE_DISTRIBUTOR_CONTRACT_ID is not configured");
  }
  if (!tokenId) {
    throw new Error("tokenId is required");
  }

  const feeAmountBigInt = BigInt(feeAmount);
  if (feeAmountBigInt <= 0n) {
    throw new Error("feeAmount must be positive");
  }
  if (feeAmountBigInt > MAX_DEPOSIT_AMOUNT_STROOPS) {
    throw new Error(
      `feeAmount ${feeAmount} exceeds maximum deposit limit of ${MAX_DEPOSIT_AMOUNT_STROOPS} stroops. ` +
      "Check for a decimal-precision or unit mismatch in the caller."
    );
  }

  const encryptedKey = process.env.SERVICE_ENCRYPTED_SECRET_KEY;
  if (!encryptedKey) {
    throw new Error("SERVICE_ENCRYPTED_SECRET_KEY is not configured");
  }

  const secretKey = decryptSecret(encryptedKey);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const depositor = keypair.publicKey();
  const rpc = getRpc();

  const account = await rpc.getAccount(depositor);
  const contract = new StellarSdk.Contract(CONTRACT_ID);

  // Contract signature: deposit_fee(depositor, token, amount, source)
  const args = [
    StellarSdk.nativeToScVal(depositor, { type: "address" }),
    StellarSdk.nativeToScVal(tokenId, { type: "address" }),
    StellarSdk.nativeToScVal(feeAmountBigInt, { type: "i128" }),
    source
      ? StellarSdk.nativeToScVal(source, { type: "address" })
      : StellarSdk.xdr.ScVal.scvVoid(),
  ];

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("deposit_fee", ...args))
    .setTimeout(30)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(keypair);

  const result = await rpc.sendTransaction(prepared);
  if (result.status === "ERROR") {
    throw new Error(`deposit_fee failed: ${result.errorResult}`);
  }

  let response = result;
  while (response.status === "PENDING" || response.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    response = await rpc.getTransaction(result.hash);
  }

  if (response.status !== "SUCCESS") {
    throw new Error(`Transaction failed: ${response.status}`);
  }

  return result.hash;
}

module.exports = { depositFee };
