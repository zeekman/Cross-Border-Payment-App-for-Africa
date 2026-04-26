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

const CONTRACT_ID = process.env.FEE_DISTRIBUTOR_CONTRACT_ID;

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
 * Deposit a platform fee on-chain.
 * Fire-and-forget — caller should not await this in the critical path.
 *
 * @param {number|string} feeAmount - Fee in USDC stroops (7 decimal places)
 * @returns {Promise<string>} transaction hash
 */
async function depositFee(feeAmount) {
  if (!CONTRACT_ID) {
    throw new Error("FEE_DISTRIBUTOR_CONTRACT_ID is not configured");
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

  const args = [
    StellarSdk.nativeToScVal(depositor, { type: "address" }),
    StellarSdk.nativeToScVal(BigInt(feeAmount), { type: "i128" }),
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
