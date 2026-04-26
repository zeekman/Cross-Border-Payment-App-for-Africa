'use strict';

const StellarSdk = require('@stellar/stellar-sdk');
const db = require('../db');
const logger = require('../utils/logger');

const primaryUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const server = new StellarSdk.Horizon.Server(primaryUrl);

const PAGE_LIMIT = 200;

/**
 * Parse a Horizon payment record into the transactions table schema.
 */
function parsePaymentRecord(record, walletAddress) {
  const isIncoming = record.to === walletAddress;
  const amount = record.amount || '0';
  const asset = record.asset_type === 'native' ? 'XLM' : record.asset_code || 'UNKNOWN';

  return {
    stellar_transaction_id: record.transaction_hash,
    from_address: record.from || record.source_account || walletAddress,
    to_address: record.to || record.into || walletAddress,
    amount,
    asset,
    memo: record.transaction?.memo || null,
    direction: isIncoming ? 'incoming' : 'outgoing',
    status: 'completed',
    created_at: record.created_at,
  };
}

/**
 * Import a batch of Horizon payment records idempotently.
 * Returns the count of newly inserted records.
 */
async function importBatch(records, walletId, walletAddress) {
  let inserted = 0;
  for (const record of records) {
    if (!record.transaction_hash) continue;

    const existing = await db.query(
      'SELECT id FROM transactions WHERE stellar_transaction_id = $1 AND wallet_id = $2',
      [record.transaction_hash, walletId],
    );
    if (existing.rows.length > 0) continue;

    const parsed = parsePaymentRecord(record, walletAddress);
    await db.query(
      `INSERT INTO transactions
         (wallet_id, stellar_transaction_id, from_address, to_address, amount, asset, memo, direction, status, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'horizon_import', $10)
       ON CONFLICT DO NOTHING`,
      [
        walletId,
        parsed.stellar_transaction_id,
        parsed.from_address,
        parsed.to_address,
        parsed.amount,
        parsed.asset,
        parsed.memo,
        parsed.direction,
        parsed.status,
        parsed.created_at,
      ],
    );
    inserted++;
  }
  return inserted;
}

/**
 * Fetch and import all payment history for a wallet from Horizon.
 * Uses cursor-based pagination to handle large histories.
 * Returns total number of imported records.
 */
async function importWalletHistory(walletId, walletAddress) {
  let cursor = null;
  let totalImported = 0;

  do {
    let builder = server.payments().forAccount(walletAddress).limit(PAGE_LIMIT).order('asc');
    if (cursor) builder = builder.cursor(cursor);

    let page;
    try {
      page = await builder.call();
    } catch (err) {
      // Account not found on Horizon (unfunded) — treat as empty history
      if (err.response?.status === 404) break;
      throw err;
    }

    const records = page.records || [];
    if (records.length === 0) break;

    const imported = await importBatch(records, walletId, walletAddress);
    totalImported += imported;

    cursor = records[records.length - 1]?.paging_token || null;

    // Stop if we got fewer records than the page limit (last page)
    if (records.length < PAGE_LIMIT) break;
  } while (cursor);

  logger.info('Horizon history import complete', { walletId, totalImported });
  return totalImported;
}

module.exports = { importWalletHistory };
