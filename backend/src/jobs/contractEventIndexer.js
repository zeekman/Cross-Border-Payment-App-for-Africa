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
const sorobanRpc = process.env.SOROBAN_RPC || 'https://soroban-testnet.stellar.org';

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
 * Parse and normalize contract event data
 */
function parseEventData(rawEvent) {
  try {
    return {
      type: rawEvent.type || 'unknown',
      topics: rawEvent.topic || [],
      data: rawEvent.data || {},
      contractId: rawEvent.contractId,
      ledgerCloseTime: rawEvent.ledgerCloseTime,
      ledgerSequence: rawEvent.ledgerSequence,
      transactionHash: rawEvent.transactionHash,
      txResult: rawEvent.txResult || {}
    };
  } catch (err) {
    logger.error('Failed to parse event data', { error: err.message, rawEvent });
    return null;
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

        // Determine event type from topics
        const eventType = eventData.topics[0] || 'generic';

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

module.exports = {
  indexContractEvents,
  indexAllContracts,
  getContractEvents,
  getIndexerState,
  updateIndexerState,
  startIndexer
};
