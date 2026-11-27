/**
 * BE-219: read Soroban contract state (version, admin, paused, pending upgrade)
 * directly via RPC simulation of the contract getters, cached for 20s.
 * Falls back to indexed events (real event names, case-insensitive, latest
 * per type) only when RPC is unreachable.
 */
const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const logger = require('../utils/logger');

const isTestnet = process.env.STELLAR_NETWORK !== 'mainnet';
const networkPassphrase = isTestnet ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC;
const rpcUrl =
  process.env.SOROBAN_RPC_URL ||
  (isTestnet ? 'https://soroban-testnet.stellar.org' : 'https://mainnet.soroban.stellar.org');

const CACHE_TTL_MS = parseInt(process.env.CONTRACT_STATE_CACHE_MS || '20000', 10);
const cache = new Map();

const ADMIN_GETTERS = ['get_admin', 'admin'];
const PAUSE_EVENTS = ['paused', 'unpaused', 'contractpaused', 'contractunpaused'];
const VERSION_EVENTS = ['upgraded', 'migrated', 'escrowinitialized'];
const ADMIN_EVENTS = ['adminupdated', 'escrowinitialized'];

class RpcUnavailableError extends Error {}

function getRpc() {
  return new StellarSdk.SorobanRpc.Server(rpcUrl);
}

/** Simulate a read-only call. Returns { ok, value } or { ok:false } if the getter is missing/fails. */
async function simulate(rpc, contractId, method) {
  const source = new StellarSdk.Account(StellarSdk.Keypair.random().publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(source, { fee: StellarSdk.BASE_FEE, networkPassphrase })
    .addOperation(new StellarSdk.Contract(contractId).call(method))
    .setTimeout(30)
    .build();
  let sim;
  try {
    sim = await rpc.simulateTransaction(tx);
  } catch (err) {
    throw new RpcUnavailableError(err.message);
  }
  if (StellarSdk.SorobanRpc.Api.isSimulationError(sim)) return { ok: false };
  const retval = sim.result?.retval;
  return { ok: true, value: retval ? StellarSdk.scValToNative(retval) : null };
}

function normalizeVersion(v) {
  if (v == null) return null;
  return typeof v === 'bigint' ? Number(v) : v;
}

function normalizePendingUpgrade(v) {
  if (v == null) return null;
  const hash = v.hash ?? v.wasm_hash ?? v.new_wasm_hash ?? (Array.isArray(v) ? v[0] : null);
  const eta = v.eta ?? v.execute_after ?? v.unlock_time ?? (Array.isArray(v) ? v[1] : null);
  return {
    hash: Buffer.isBuffer(hash) ? hash.toString('hex') : hash ?? null,
    eta: typeof eta === 'bigint' ? Number(eta) : eta ?? null,
  };
}

async function readFromRpc(contractId) {
  const rpc = getRpc();
  const [version, paused, pending] = await Promise.all([
    simulate(rpc, contractId, 'get_contract_version'),
    simulate(rpc, contractId, 'is_paused'),
    simulate(rpc, contractId, 'get_pending_upgrade'),
  ]);
  let admin = null;
  for (const m of ADMIN_GETTERS) {
    const r = await simulate(rpc, contractId, m);
    if (r.ok) {
      admin = r.value;
      break;
    }
  }
  return {
    version: version.ok ? normalizeVersion(version.value) : null,
    admin,
    paused: paused.ok ? Boolean(paused.value) : false,
    pending_upgrade: pending.ok ? normalizePendingUpgrade(pending.value) : null,
    source: 'rpc',
  };
}

async function latestEvent(contractId, types) {
  const { rows } = await db.query(
    `SELECT event_type, event_data, ledger_sequence, ledger_close_time
       FROM contract_events
      WHERE contract_id = $1 AND LOWER(event_type) = ANY($2)
      ORDER BY ledger_sequence DESC
      LIMIT 1`,
    [contractId, types]
  );
  return rows[0] || null;
}

function field(data, ...keys) {
  if (!data || typeof data !== 'object') return null;
  for (const k of keys) if (data[k] != null) return data[k];
  return null;
}

async function readFromEvents(contractId) {
  const [pauseEv, versionEv, adminEv] = await Promise.all([
    latestEvent(contractId, PAUSE_EVENTS),
    latestEvent(contractId, VERSION_EVENTS),
    latestEvent(contractId, ADMIN_EVENTS),
  ]);
  const pauseType = pauseEv?.event_type?.toLowerCase();
  return {
    version: normalizeVersion(field(versionEv?.event_data, 'version', 'new_version')),
    admin: field(adminEv?.event_data, 'new_admin', 'admin'),
    paused: pauseType === 'paused' || pauseType === 'contractpaused',
    pending_upgrade: null,
    source: 'events',
  };
}

async function getContractState(contractId) {
  const hit = cache.get(contractId);
  if (hit && hit.expires > Date.now()) return hit.value;

  let state;
  try {
    state = await readFromRpc(contractId);
  } catch (err) {
    if (!(err instanceof RpcUnavailableError)) throw err;
    logger.warn('Soroban RPC unavailable, falling back to indexed events for contract state', {
      contractId,
      error: err.message,
    });
    state = await readFromEvents(contractId);
  }
  const value = { contract_id: contractId, ...state, fetched_at: new Date().toISOString() };
  cache.set(contractId, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

module.exports = { getContractState, readFromEvents, _cache: cache };
