jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../services/stellar', () => ({ withFallback: jest.fn() }));

const db = require('../db');
const { withFallback } = require('../services/stellar');
const { reconcileTransactionConfirmations } = require('../jobs/transactionConfirmationJob');

describe('transaction confirmation reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
  });

  test('a transient Horizon 503 leaves the payment confirming', async () => {
    const transaction = {
      id: 'tx-1',
      tx_hash: 'a'.repeat(64),
      confirmation_expires_at: new Date(Date.now() + 60_000),
    };
    db.query.mockResolvedValueOnce({ rows: [transaction] });
    const error = new Error('Horizon unavailable');
    error.response = { status: 503 };
    withFallback.mockRejectedValueOnce(error);

    await reconcileTransactionConfirmations();

    expect(withFallback).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('a found successful transaction is marked completed', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'tx-2', tx_hash: 'b'.repeat(64), confirmation_expires_at: null }] });
    withFallback.mockResolvedValueOnce({ id: 'b'.repeat(64), hash: 'b'.repeat(64), created_at: new Date().toISOString(), successful: true });

    await reconcileTransactionConfirmations();

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][1]).toEqual(['tx-2', 'completed']);
  });

  test('a found unsuccessful transaction is marked failed', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'tx-4', tx_hash: 'd'.repeat(64), confirmation_expires_at: null }] });
    withFallback.mockResolvedValueOnce({ id: 'd'.repeat(64), hash: 'd'.repeat(64), created_at: new Date().toISOString(), successful: false });

    await reconcileTransactionConfirmations();

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][1]).toEqual(['tx-4', 'failed']);
  });

  test('a 404 after the persisted time bound is marked failed', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'tx-3', tx_hash: 'c'.repeat(64), confirmation_expires_at: new Date(Date.now() - 1_000) }] });
    const error = new Error('Not found');
    error.response = { status: 404 };
    withFallback.mockRejectedValueOnce(error);

    await reconcileTransactionConfirmations();

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][1]).toEqual(['tx-3', 'failed']);
  });
});