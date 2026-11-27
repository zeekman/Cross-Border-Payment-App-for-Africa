/**
 * Contract Event Indexer
 *
 * Background job that polls Soroban for contract events and indexes them in the database.
 * Handles ledger sequence gaps gracefully and maintains state for recovery.
 *
 * Usage:
 *   require('./contractEventIndexer').startIndexer()
 *   // or manually call:
 *   require('./contractEventIndexer').indexContractEvents(contractId)
 */

const db = require('../db');
const StellarSdk = require('@stellar/stellar-sdk');
const logger = require('../utils/logger');

const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const horizonServer = new StellarSdk.Horizon.Server(horizonUrl);
const { rpcUrl: sorobanRpc } = require('../config/soroban');

// Configuration
const POLL_INTERVAL = parseInt(process.env.CONTRACT_EVENT_POLL_INTERVAL || '30000'); // 30 seconds
const BATCH_SIZE = parseInt(process.env.CONTRACT_EVENT_BATCH_SIZE || '100');
const MAX_LEDGER_GAP = parseInt(process.env.CONTRACT_EVENT_MAX_GAP || '1000');

// Map of contract names to addresses for quick lookup
const CONTRACT_MAP = {
  escrow: process.env.ESCROW_CONTRACT_ID,
  'fee-distributor': process.env.FEE_DISTRIBUTOR_CONTRACT_ID,
  'kyc-attestation': process.env.KYC_ATTESTATION_CONTRACT_ID,
  'loyalty-token': process.env.LOYALTY_TOKEN_CONTRACT_ID,
  'recurring-payments': process.env.RECURRING_PAYMENTS_CONTRACT_ID,
  'savings-vault': process.env.SAVINGS_VAULT_CONTRACT_ID,
  'multisig-approval': process.env.MULTISIG_APPROVAL_CONTRACT_ID,
  'dispute-resolution': process.env.DISPUTE_RESOLUTION_CONTRACT_ID,
  'agent-escrow': process.env.AGENT_ESCROW_CONTRACT_ID,
};

// Map of recognized event topics to their canonical event type.
// Topics are matched case-insensitively and with separators stripped so that
// both snake_case (`admin_proposed`) and CamelCase (`AdminProposed`) topics map
// to the same canonical type.
const EVENT_TYPE_MAP = {
  // Admin rotation (SC-184 / SC-190) — emitted by all nine contracts
  adminproposed: 'AdminProposed',
  adminchanged: 'AdminChanged',
  admincancelled: 'AdminCancelled',
  admincanceled: 'AdminCancelled',
  // Multisig approval workflow (SC-193)
  msproposed: 'ms_proposed',
  msapproved: 'ms_approved',
  msrejected: 'ms_rejected',
  mscancelled: 'ms_cancelled',
  mscanceled: 'ms_cancelled',
  msexpired: 'ms_expired',
  msexecuted: 'ms_executed',
  msquorumproposed: 'ms_quorum_proposed',
  msquorumchanged: 'ms_quorum_changed',
  msweightset: 'ms_weight_set',
};

// Event types that represent admin rotation history
const ADMIN_ROTATION_EVENTS = new Set(['AdminProposed', 'AdminChanged', 'AdminCancelled']);

// Event types that represent multisig approval workflow history
const MULTISIG_EVENTS = new Set([
  'ms_proposed',
  'ms_approved',
  'ms_rejected',
  'ms_cancelled',
  'ms_expired',
  'ms_executed',
  'ms_quorum_proposed',
  'ms_quorum_changed',
  'ms_weight_set',
]);

/**
 * Normalize a raw topic (string, symbol, or ScVal-ish object) into a lookup key.
 */
function normalizeTopic(topic) {
  if (topic === null || topic === undefined) return '';
  let value = topic;
  if (typeof value === 'object') {
    // Soroban RPC may return topics as { type, value } or ScVal objects
    value = value.value !== undefined ? value.value : value.sym || value.name || '';
  }
  return String(value).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * Resolve the canonical event type from the raw event topics.
 * Falls back to the first topic (or 'generic') when unrecognized.
 */
function resolveEventType(topics = [], fallbackName = null) {
  for (const topic of topics) {
    const key = normalizeTopic(topic);
    if (EVENT_TYPE_MAP[key]) {
      return EVENT_TYPE_MAP[key];
    }
  }
  return fallbackName || topics[0] || 'generic';
}

/**
 * Extract the primary identifier (e.g. tx_id, signer, proposal id) from topics.
 * Convention: topics[0] is the event name, topics[1] is the identifier.
 */
function extractEventSubject(topics = []) {
  if (topics.length < 2) return null;
  const subject = topics[1];
  if (subject === null || subject === undefined) return null;
  if (typeof subject === 'object') {
    return subject.value !== undefined ? subject.value : subject;
  }
  return subject;
}

/**
 * Initialize indexer state for a contract
 */
async function initializeIndexerState(contractId, contractName = null) {
  try {
    const result = await db.query(
      `INSERT INTO contract_event_indexer_state (contract_id, last_indexed_ledger, gaps)
       VALUES ($1, $2, $3)
       ON CONFLICT (contract_id) DO NOTHING
       RETURNING *`,
      [contractId, 0, JSON.stringify([])]
    );
    return result.rows[0];
  } catch (err) {
    logger.error('Failed to initialize indexer state', { contractId, error: err.message });
    throw err;
  }
}

/**
 * Get current indexer state for a contract
 */
async function getIndexerState(contractId) {
  try {
    const result = await db.query(
      'SELECT * FROM contract_event_indexer_state WHERE contract_id = $1',
      [contractId]
    );
    return result.rows[0] || await initializeIndexerState(contractId);
  } catch (err) {
    logger.error('Failed to get indexer state', { contractId, error: err.message });
    throw err;
  }
}

/**
 * Update indexer state after processing events
 */
async function updateIndexerState(contractId, lastLedger, gaps = []) {
  try {
    await db.query(
      `UPDATE contract_event_indexer_state
       SET last_indexed_ledger = $1, gaps = $2, last_update = NOW()
       WHERE contract_id = $3`,
      [lastLedger, JSON.stringify(gaps), contractId]
    );
  } catch (err) {
    logger.error('Failed to update indexer state', { contractId, error: err.message });
    throw err;
  }
}

/**
 * Fetch contract events from Soroban RPC
 * Uses the getEvents() method to retrieve indexed events
 */
async function fetchContractEvents(contractId, startLedger = 0, limit = BATCH_SIZE) {
  try {
    // For Soroban RPC, we fetch events using the events endpoint
    // This would call the Soroban RPC service for event polling
    const response = await fetch(`${sorobanRpc}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getEvents',
        params: {
          start_ledger: startLedger,
          filters: [
            {
              type: 'contract',
              contractIds: [contractId]
            }
          ],
          limit
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Soroban RPC error: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(`Soroban RPC error: ${data.error.message}`);
    }

    return data.result?.events || [];
  } catch (err) {
    logger.error('Failed to fetch contract events from Soroban', {
      contractId,
      error: err.message
    });
    return [];
  }
}

/**
 * Decode a single Soroban SCVal into a plain JS value.
 * Handles the subset of types used by the kyc-attestation contract events.
 */
function decodeScVal(scval) {
  if (scval === null || scval === undefined) return null;

  // Already a plain JS value (some RPCs / test fixtures)
  if (typeof scval !== 'object' || scval.switch === undefined) {
    return scval;
  }

  try {
    return StellarSdk.scValToNative(scval);
  } catch (err) {
    logger.warn('Failed to decode SCVal, returning raw value', { error: err.message });
    return scval;
  }
}

/**
 * Decode an array of SCVals (e.g. topics or a vec payload).
 */
function decodeScValArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(decodeScVal);
}

/**
 * Normalize a decoded event name (symbol) to a lowercase string.
 */
function normalizeEventName(name) {
  if (name === null || name === undefined) return null;
  if (typeof name === 'string') return name.toLowerCase();
  if (typeof name === 'object' && name.sym) {
    return Buffer.from(name.sym, 'base64').toString('utf8').toLowerCase();
  }
  return String(name).toLowerCase();
}

/**
 * Extract the structured kyc-attestation payload from a decoded event.
 *
 * New schema (issue #1455):
 *   ("kyc_attested", user, tier)  -> { admin, kyc_hash, attested_at, expires_at, is_renewal }
 *   ("kyc_renewed", user, tier)   -> { admin, kyc_hash, attested_at, expires_at, is_renewal }
 *   ("kyc_revoked", user, tier)   -> { admin, revoked_at, revocation_count }
 *   ("kyc_batch_revoked")         -> { admin, count }
 *
 * Returns null when the event is not a known kyc-attestation event.
 */
function extractKycAttestationPayload(eventName, topics, data) {
  const KYC_EVENTS = ['kyc_attested', 'kyc_renewed', 'kyc_revoked', 'kyc_batch_revoked'];
  if (!KYC_EVENTS.includes(eventName)) return null;

  // Topics: [eventName, user?, tier?]
  const user = topics.length > 1 ? topics[1] : null;
  const tier = topics.length > 2 ? topics[2] : null;

  // Payload may be delivered as a map (object) or a vec (array).
  let payload = {};
  if (Array.isArray(data)) {
    // Fallback for vec-encoded payloads: positional fields per event.
    const fields = eventName === 'kyc_revoked'
      ? ['admin', 'revoked_at', 'revocation_count']
      : eventName === 'kyc_batch_revoked'
        ? ['admin', 'count']
        : ['admin', 'kyc_hash', 'attested_at', 'expires_at', 'is_renewal'];
    fields.forEach((field, i) => {
      if (i < data.length) payload[field] = data[i];
    });
  } else if (data && typeof data === 'object') {
    payload = { ...data };
  }

  const normalized = {
    event: eventName,
    user,
    tier,
  };

  if (eventName === 'kyc_attested' || eventName === 'kyc_renewed') {
    normalized.admin = payload.admin ?? null;
    normalized.kyc_hash = payload.kyc_hash ?? null;
    normalized.attested_at = payload.attested_at ?? null;
    normalized.expires_at = payload.expires_at ?? null;
    normalized.is_renewal = payload.is_renewal ?? (eventName === 'kyc_renewed');
  } else if (eventName === 'kyc_revoked') {
    normalized.admin = payload.admin ?? null;
    normalized.revoked_at = payload.revoked_at ?? null;
    normalized.revocation_count = payload.revocation_count ?? null;
  } else if (eventName === 'kyc_batch_revoked') {
    normalized.admin = payload.admin ?? null;
    normalized.count = payload.count ?? null;
  }

  return normalized;
}

/**
 * Parse and normalize contract event data
 */
function parseEventData(rawEvent) {
  try {
    const rawTopics = rawEvent.topic || [];
    const decodedTopics = decodeScValArray(rawTopics);
    const decodedData = decodeScVal(rawEvent.data);

    const eventName = normalizeEventName(decodedTopics[0]);

    const parsed = {
      type: rawEvent.type || 'unknown',
      eventName,
      topics: decodedTopics,
      data: decodedData || {},
      contractId: rawEvent.contractId,
      ledgerCloseTime: rawEvent.ledgerCloseTime,
      ledgerSequence: rawEvent.ledgerSequence,
      transactionHash: rawEvent.transactionHash,
      txResult: rawEvent.txResult || {}
    };

    // Attach structured kyc-attestation payload when applicable so indexers
    // can rebuild Attestation state without follow-up RPC reads.
    const kycPayload = extractKycAttestationPayload(eventName, decodedTopics, decodedData);
    if (kycPayload) {
      parsed.kyc = kycPayload;
      parsed.user = kycPayload.user;
    }

    return parsed;
  } catch (err) {
    logger.error('Failed to parse event data', { error: err.message, rawEvent });
    return null;
  }
}

/**
 * Persist an admin rotation event into the admin_rotation_history table.
 * Records the old/new admin (when present) and the pending admin ETA.
 */
async function persistAdminRotationEvent({ contractId, contractName, eventType, eventData, subject }) {
  try {
    const payload = eventData.data || {};
    const oldAdmin = payload.old ?? payload.old_admin ?? null;
    const newAdmin = payload.new ?? payload.new_admin ?? payload.pending_admin ?? subject ?? null;
    const eta = payload.eta ?? payload.eta_ledger ?? null;

    await db.query(
      `INSERT INTO admin_rotation_history
       (contract_id, contract_name, event_type, old_admin, new_admin, eta, ledger_sequence, ledger_close_time, transaction_hash, event_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING`,
      [
        contractId,
        contractName,
        eventType,
        oldAdmin,
        newAdmin,
        eta,
        eventData.ledgerSequence,
        new Date(eventData.ledgerCloseTime).toISOString(),
        eventData.transactionHash,
        JSON.stringify(eventData)
      ]
    );
  } catch (err) {
    logger.error('Failed to persist admin rotation event', {
      contractId,
      eventType,
      error: err.message
    });
    throw err;
  }
}

/**
 * Persist a multisig approval workflow event into the multisig_proposal_events table.
 * `subject` is the transaction/proposal id (or signer for weight changes).
 */
async function persistMultisigEvent({ contractId, contractName, eventType, eventData, subject }) {
  try {
    const payload = eventData.data || {};
    const proposalId = payload.tx_id ?? payload.proposal_id ?? subject ?? null;
    const actor = payload.approver ?? payload.proposer ?? payload.signer ?? payload.admin ?? null;
    const weight = payload.weight ?? null;
    const totalApprovals = payload.total_approvals ?? null;
    const quorum = payload.quorum ?? null;

    await db.query(
      `INSERT INTO multisig_proposal_events
       (contract_id, contract_name, event_type, proposal_id, actor, weight, total_approvals, quorum, ledger_sequence, ledger_close_time, transaction_hash, event_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING`,
      [
        contractId,
        contractName,
        eventType,
        proposalId,
        actor,
        weight,
        totalApprovals,
        quorum,
        eventData.ledgerSequence,
        new Date(eventData.ledgerCloseTime).toISOString(),
        eventData.transactionHash,
        JSON.stringify(eventData)
      ]
    );
  } catch (err) {
    logger.error('Failed to persist multisig event', {
      contractId,
      eventType,
      error: err.message
    });
    throw err;
  }
}

/**
 * Index contract events into the database
 */
async function indexContractEvents(contractId, contractName = null) {
  try {
    logger.info('Starting event indexing for contract', { contractId, contractName });

    // Initialize or get existing state
    const state = await getIndexerState(contractId);
    let startLedger = state.last_indexed_ledger + 1;

    // Check for gaps and attempt recovery
    const gaps = state.gaps ? JSON.parse(state.gaps) : [];
    if (gaps.length > 0) {
      logger.info('Detected ledger gaps, attempting recovery', {
        contractId,
        gaps: gaps.slice(0, 5) // Log first 5 gaps
      });
      startLedger = Math.min(...gaps);
    }

    // Fetch events from Soroban
    const events = await fetchContractEvents(contractId, startLedger);

    if (events.length === 0) {
      logger.info('No new events found for contract', { contractId });
      return { indexed: 0, errors: 0 };
    }

    logger.info('Fetched events from Soroban', { contractId, count: events.length });

    // Insert events into database
    let indexed = 0;
    let errors = 0;
    let maxLedger = state.last_indexed_ledger;
    let newGaps = [...gaps];

    for (const rawEvent of events) {
      try {
        const eventData = parseEventData(rawEvent);
        if (!eventData) {
          errors++;
          continue;
        }

        // Check for ledger sequence gaps
        if (eventData.ledgerSequence > maxLedger + 1) {
          for (let i = maxLedger + 1; i < eventData.ledgerSequence; i++) {
            if (!newGaps.includes(i)) {
              newGaps.push(i);
            }
          }
        }

        // Canonical event type from topics (admin rotation / multisig names);
        // otherwise the normalized event name, so unmapped events keep the
        // lowercase name the rest of the indexer (e.g. KYC) expects.
        const eventType = resolveEventType(eventData.topics, eventData.eventName);
        const eventSubject = extractEventSubject(eventData.topics);

        // Insert into database
        await db.query(
          `INSERT INTO contract_events
           (contract_id, contract_name, event_type, event_data, ledger_sequence, ledger_close_time, transaction_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [
            contractId,
            contractName,
            eventType,
            JSON.stringify(eventData),
            eventData.ledgerSequence,
            new Date(eventData.ledgerCloseTime).toISOString(),
            eventData.transactionHash
          ]
        );

        // Persist admin rotation history so it is queryable per contract
        if (ADMIN_ROTATION_EVENTS.has(eventType)) {
          await persistAdminRotationEvent({
            contractId,
            contractName,
            eventType,
            eventData,
            subject: eventSubject
          });
        }

        // Persist multisig approval workflow history so proposal history is queryable
        if (MULTISIG_EVENTS.has(eventType)) {
          await persistMultisigEvent({
            contractId,
            contractName,
            eventType,
            eventData,
            subject: eventSubject
          });
        }

        maxLedger = Math.max(maxLedger, eventData.ledgerSequence);
        indexed++;

        // Remove filled gaps from the list
        newGaps = newGaps.filter(g => g > maxLedger);

      } catch (err) {
        logger.error('Failed to index event', {
          contractId,
          error: err.message,
          event: rawEvent
        });
        errors++;
      }
    }

    // Update state
    await updateIndexerState(contractId, maxLedger, newGaps.slice(0, MAX_LEDGER_GAP));

    const result = { indexed, errors, gaapFilled: gaps.length - newGaps.length };
    logger.info('Event indexing completed', { contractId, ...result });

    return result;
  } catch (err) {
    logger.error('Contract event indexing failed', { contractId, error: err.message });
    throw err;
  }
}

/**
 * Index all known contracts
 */
async function indexAllContracts() {
  const results = {};
  const activeContracts = Object.entries(CONTRACT_MAP).filter(([_, id]) => id);

  for (const [name, contractId] of activeContracts) {
    try {
      results[name] = await indexContractEvents(contractId, name);
    } catch (err) {
      logger.error('Failed to index contract events', { contract: name, error: err.message });
      results[name] = { error: err.message };
    }
  }

  return results;
}

/**
 * Start the background indexer loop
 */
function startIndexer() {
  logger.info('Starting contract event indexer', { pollInterval: POLL_INTERVAL });

  setInterval(async () => {
    try {
      await indexAllContracts();
    } catch (err) {
      logger.error('Indexer loop error', { error: err.message });
    }
  }, POLL_INTERVAL);
}

/**
 * Get events for a specific contract with optional filtering
 */
async function getContractEvents(contractId, options = {}) {
  try {
    const {
      eventType = null,
      limit = 100,
      offset = 0,
      from = null,
      to = null
    } = options;

    let query = 'SELECT * FROM contract_events WHERE contract_id = $1';
    const params = [contractId];

    if (eventType) {
      params.push(eventType);
      query += ` AND event_type = $${params.length}`;
    }

    if (from) {
      params.push(new Date(from).toISOString());
      query += ` AND created_at >= $${params.length}`;
    }

    if (to) {
      params.push(new Date(to).toISOString());
      query += ` AND created_at <= $${params.length}`;
    }

    query += ' ORDER BY ledger_sequence DESC';
    params.push(limit);
    query += ` LIMIT $${params.length}`;
    params.push(offset);
    query += ` OFFSET $${params.length}`;

    const result = await db.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as count FROM contract_events WHERE contract_id = $1';
    const countParams = [contractId];

    if (eventType) {
      countParams.push(eventType);
      countQuery += ` AND event_type = $${countParams.length}`;
    }

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].count);

    return {
      events: result.rows,
      total,
      limit,
      offset
    };
  } catch (err) {
    logger.error('Failed to retrieve contract events', {
      contractId,
      error: err.message
    });
    throw err;
  }
}

/**
 * Get admin rotation history for a contract
 */
async function getAdminRotationHistory(contractId, options = {}) {
  try {
    const { limit = 100, offset = 0 } = options;
    const result = await db.query(
      `SELECT * FROM admin_rotation_history
       WHERE contract_id = $1
       ORDER BY ledger_sequence DESC
       LIMIT $2 OFFSET $3`,
      [contractId, limit, offset]
    );
    return result.rows;
  } catch (err) {
    logger.error('Failed to retrieve admin rotation history', {
      contractId,
      error: err.message
    });
    throw err;
  }
}

/**
 * Get multisig proposal event history, optionally filtered by proposal id
 */
async function getMultisigProposalHistory(contractId, options = {}) {
  try {
    const { proposalId = null, limit = 100, offset = 0 } = options;
    let query = 'SELECT * FROM multisig_proposal_events WHERE contract_id = $1';
    const params = [contractId];

    if (proposalId !== null) {
      params.push(proposalId);
      query += ` AND proposal_id = $${params.length}`;
    }

    query += ' ORDER BY ledger_sequence DESC';
    params.push(limit);
    query += ` LIMIT $${params.length}`;
    params.push(offset);
    query += ` OFFSET $${params.length}`;

    const result = await db.query(query, params);
    return result.rows;
  } catch (err) {
    logger.error('Failed to retrieve multisig proposal history', {
      contractId,
      error: err.message
    });
    throw err;
  }
}

module.exports = {
  indexContractEvents,
  indexAllContracts,
  getContractEvents,
  getIndexerState,
  updateIndexerState,
  getAdminRotationHistory,
  getMultisigProposalHistory,
  startIndexer
};
