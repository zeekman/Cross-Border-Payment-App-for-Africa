jest.mock('../db');
jest.mock('../services/webhook', () => ({ deliver: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/notificationInbox', () => ({ persistAndBroadcast: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/cache', () => ({ get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/metrics', () => ({ wsConnections: { set: jest.fn() } }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/stellar', () => ({
  getEffectsForTransaction: jest.fn(),
  getClaimableBalanceExpiry: jest.fn(),
  getClaimableBalanceRecord: jest.fn(),
}));

const db = require('../db');
const webhook = require('../services/webhook');
const { persistAndBroadcast } = require('../services/notificationInbox');
const { checkClaimableBalanceExpiry } = require('../jobs/checkClaimableBalanceExpiry');
const { reconcileClaimableBalanceEffect } = require('../services/ledgerListener');
const stellar = require('../services/stellar');

beforeEach(() => {
  jest.resetAllMocks();
  webhook.deliver.mockResolvedValue(undefined);
  persistAndBroadcast.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('claimable balance lifecycle', () => {
  test('expires a balance and notifies its sender using the current time', async () => {
    const now = new Date('2026-10-21T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    db.query
      .mockResolvedValueOnce({ rows: [{
        id: 'row-id',
        balance_id: 'balance-id',
        user_id: 'sender-user-id',
        asset: 'XLM',
        amount: '12.5000000',
      }] })
      .mockResolvedValueOnce({ rows: [] });

    await checkClaimableBalanceExpiry();

    expect(db.query.mock.calls[0][0]).toMatch(/UPDATE transactions/);
    expect(db.query.mock.calls[0][1]).toEqual([now]);
    expect(webhook.deliver).toHaveBeenCalledWith('claimable_balance.expired', 'sender-user-id', expect.objectContaining({
      balance_id: 'balance-id',
      asset: 'XLM',
      amount: '12.5000000',
    }));
    expect(persistAndBroadcast).toHaveBeenCalledWith(
      'sender-user-id',
      'claimable_balance_expired',
      'Claimable balance expired',
      expect.stringContaining('balance-id'),
      expect.objectContaining({ balance_id: 'balance-id' }),
    );
  });

  test.each([
    ['claimable_balance_claimed', 'completed', 'claimed', 'GRECIPIENT'],
    ['claimable_balance_clawed_back', 'reclaimed', 'reclaimed', 'GSENDER'],
  ])('reconciles %s across both database records', async (effectType, txStatus, balanceStatus, claimant) => {
    await reconcileClaimableBalanceEffect({
      type: effectType,
      balance_id: 'balance-id',
      claimant,
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE transactions AS tx'),
      [effectType === 'claimable_balance_clawed_back', 'balance-id', claimant],
    );
    const sql = db.query.mock.calls[0][0];
    expect(sql).toContain(balanceStatus === 'claimed' ? "ELSE 'claimed'" : "THEN 'reclaimed'");
    expect(sql).toContain(txStatus === 'completed' ? "ELSE 'completed'" : "THEN 'reclaimed'");
  });
});

describe('claimable balance backfill', () => {
  test('restores balance metadata and links the transaction idempotently', async () => {
    stellar.getEffectsForTransaction.mockResolvedValue({ records: [
      { type: 'claimable_balance_created', balance_id: 'balance-id' },
    ] });
    stellar.getClaimableBalanceExpiry.mockReturnValue(new Date('2026-11-20T12:00:00.000Z'));
    stellar.getClaimableBalanceRecord.mockResolvedValue({
      amount: '9.7500000',
      expires_at: '2026-11-20T12:00:00.000Z',
      claimants: [{ predicate: { abs_before: '2026-11-20T12:00:00Z' } }],
    });
    const { backfillClaimableBalances } = require('../../scripts/backfill-claimable-balances');
    db.query
      .mockResolvedValueOnce({ rows: [{
        id: 'tx-id',
        tx_hash: 'tx-hash',
        sender_wallet: 'GSENDER',
        recipient_wallet: 'GRECIPIENT',
        amount: '10.0000000',
        asset: 'XLM',
        fee_breakdown: '{}',
        status: 'pending_claim',
        user_id: 'user-id',
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await backfillClaimableBalances();

    expect(result).toEqual({ scanned: 1, inserted: 1, skipped: 0 });
    expect(db.query.mock.calls[1][0]).toMatch(/ON CONFLICT \(balance_id\) DO NOTHING/);
    expect(db.query.mock.calls[1][1]).toEqual([
      'balance-id',
      'user-id',
      'XLM',
      '9.7500000',
      'GRECIPIENT',
      '2026-11-20T12:00:00.000Z',
      'active',
      'tx-id',
    ]);
  });
});