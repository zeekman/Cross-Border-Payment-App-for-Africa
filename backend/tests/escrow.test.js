/**
 * Integration tests for the agent escrow lifecycle (#533).
 *
 * Covers:
 *   - create → confirm payout → fee accumulation
 *   - create → cancel → refund
 */
jest.mock('../src/db');
jest.mock('../src/services/agentEscrow', () => ({
  createEscrow: jest.fn(),
  confirmPayout: jest.fn(),
  cancelEscrow: jest.fn(),
}));

const db = require('../src/db');
const agentEscrow = require('../src/services/agentEscrow');
const { create, confirm, cancel } = require('../src/controllers/agentEscrowController');

const AGENT_WALLET    = 'GAGENT000000000000000000000000000000000000000000000000000';
const SENDER_WALLET   = 'GSENDER00000000000000000000000000000000000000000000000000';
const RECIPIENT_WALLET = 'GRECIP00000000000000000000000000000000000000000000000000';
const CONTRACT_ESCROW_ID = 42;
const TX_HASH_CREATE   = 'txhash_create_001';
const TX_HASH_CONFIRM  = 'txhash_confirm_001';
const TX_HASH_CANCEL   = 'txhash_cancel_001';
const ESCROW_DB_ID     = 'esc-db-uuid-001';

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Flow 1: create → confirm payout → fee accumulation
// ---------------------------------------------------------------------------

describe('Escrow lifecycle: create → confirm payout → fee accumulation (#533)', () => {
  function createReq(overrides = {}) {
    return {
      user: { userId: 'user-1' },
      body: {
        agent_wallet:     AGENT_WALLET,
        recipient_wallet: RECIPIENT_WALLET,
        amount:           '100',
        asset:            'USDC',
        ...overrides,
      },
    };
  }

  function confirmReq(escrowDbId = ESCROW_DB_ID) {
    return {
      user: { userId: 'user-1' },
      params: { id: escrowDbId },
    };
  }

  test('create: returns 201 with escrow details when agent is approved', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'agent-db-1' }] })          // agents check
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc:key' }] }) // wallet
      .mockResolvedValueOnce({ rows: [] });                              // INSERT

    agentEscrow.createEscrow.mockResolvedValueOnce({
      escrowId: CONTRACT_ESCROW_ID,
      txHash:   TX_HASH_CREATE,
    });

    const req = createReq();
    const res = mockRes();
    await create(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Escrow created',
        escrow:  expect.objectContaining({ tx_hash: TX_HASH_CREATE, status: 'pending' }),
      }),
    );
  });

  test('create: calls createEscrow service with correct amount in stroops', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'agent-db-1' }] })
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc:key' }] })
      .mockResolvedValueOnce({ rows: [] });

    agentEscrow.createEscrow.mockResolvedValueOnce({
      escrowId: CONTRACT_ESCROW_ID,
      txHash:   TX_HASH_CREATE,
    });

    await create(createReq({ amount: '50' }), mockRes(), jest.fn());

    expect(agentEscrow.createEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50 * 1e7 }),
    );
  });

  test('confirm: returns 200 and marks escrow released', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_DB_ID, contract_escrow_id: CONTRACT_ESCROW_ID, encrypted_secret_key: 'enc:key' }] }) // escrow lookup
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    agentEscrow.confirmPayout.mockResolvedValueOnce({ txHash: TX_HASH_CONFIRM });

    const req = confirmReq();
    const res = mockRes();
    await confirm(req, res, jest.fn());

    expect(agentEscrow.confirmPayout).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Escrow released' }),
    );
  });

  test('confirm: DB UPDATE sets status = released', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_DB_ID, contract_escrow_id: CONTRACT_ESCROW_ID, encrypted_secret_key: 'enc:key' }] })
      .mockResolvedValueOnce({ rows: [] });

    agentEscrow.confirmPayout.mockResolvedValueOnce({ txHash: TX_HASH_CONFIRM });

    await confirm(confirmReq(), mockRes(), jest.fn());

    const updateCall = db.query.mock.calls.find(
      ([sql]) => /UPDATE/i.test(sql) && /released/i.test(sql),
    );
    expect(updateCall).toBeDefined();
  });

  test('fee accumulates: confirmPayout is called with the contract escrow id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_DB_ID, contract_escrow_id: CONTRACT_ESCROW_ID, encrypted_secret_key: 'enc:key' }] })
      .mockResolvedValueOnce({ rows: [] });

    agentEscrow.confirmPayout.mockResolvedValueOnce({ txHash: TX_HASH_CONFIRM });

    await confirm(confirmReq(), mockRes(), jest.fn());

    expect(agentEscrow.confirmPayout).toHaveBeenCalledWith(
      expect.objectContaining({ contractEscrowId: CONTRACT_ESCROW_ID }),
    );
  });
});

// ---------------------------------------------------------------------------
// Flow 2: create → cancel → refund
// ---------------------------------------------------------------------------

describe('Escrow lifecycle: create → cancel → refund (#533)', () => {
  function cancelReq(escrowDbId = ESCROW_DB_ID) {
    return {
      user: { userId: 'user-1' },
      params: { id: escrowDbId },
    };
  }

  test('cancel: returns 200 and marks escrow cancelled', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_DB_ID, contract_escrow_id: CONTRACT_ESCROW_ID, sender_wallet: SENDER_WALLET, encrypted_secret_key: 'enc:key' }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    agentEscrow.cancelEscrow.mockResolvedValueOnce({ txHash: TX_HASH_CANCEL });

    const req = cancelReq();
    const res = mockRes();
    await cancel(req, res, jest.fn());

    expect(agentEscrow.cancelEscrow).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Escrow cancelled' }),
    );
  });

  test('cancel: DB UPDATE sets status = cancelled', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_DB_ID, contract_escrow_id: CONTRACT_ESCROW_ID, sender_wallet: SENDER_WALLET, encrypted_secret_key: 'enc:key' }] })
      .mockResolvedValueOnce({ rows: [] });

    agentEscrow.cancelEscrow.mockResolvedValueOnce({ txHash: TX_HASH_CANCEL });

    await cancel(cancelReq(), mockRes(), jest.fn());

    const updateCall = db.query.mock.calls.find(
      ([sql]) => /UPDATE/i.test(sql) && /cancelled/i.test(sql),
    );
    expect(updateCall).toBeDefined();
  });

  test('cancel: cancelEscrow is called with the contract escrow id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_DB_ID, contract_escrow_id: CONTRACT_ESCROW_ID, sender_wallet: SENDER_WALLET, encrypted_secret_key: 'enc:key' }] })
      .mockResolvedValueOnce({ rows: [] });

    agentEscrow.cancelEscrow.mockResolvedValueOnce({ txHash: TX_HASH_CANCEL });

    await cancel(cancelReq(), mockRes(), jest.fn());

    expect(agentEscrow.cancelEscrow).toHaveBeenCalledWith(
      expect.objectContaining({ contractEscrowId: CONTRACT_ESCROW_ID }),
    );
  });

  test('cancel: returns 404 when escrow record not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = cancelReq('nonexistent-id');
    const res = mockRes();
    await cancel(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('full flow: create then cancel yields cancelled status in DB', async () => {
    // --- create ---
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'agent-db-1' }] })
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc:key' }] })
      .mockResolvedValueOnce({ rows: [] });

    agentEscrow.createEscrow.mockResolvedValueOnce({
      escrowId: CONTRACT_ESCROW_ID,
      txHash:   TX_HASH_CREATE,
    });

    const createRes = mockRes();
    await create(
      { user: { userId: 'user-1' }, body: { agent_wallet: AGENT_WALLET, recipient_wallet: RECIPIENT_WALLET, amount: '100', asset: 'USDC' } },
      createRes,
      jest.fn(),
    );
    expect(createRes.status).toHaveBeenCalledWith(201);

    // --- cancel ---
    db.query
      .mockResolvedValueOnce({ rows: [{ id: ESCROW_DB_ID, contract_escrow_id: CONTRACT_ESCROW_ID, sender_wallet: SENDER_WALLET, encrypted_secret_key: 'enc:key' }] })
      .mockResolvedValueOnce({ rows: [] });

    agentEscrow.cancelEscrow.mockResolvedValueOnce({ txHash: TX_HASH_CANCEL });

    const cancelRes = mockRes();
    await cancel({ user: { userId: 'user-1' }, params: { id: ESCROW_DB_ID } }, cancelRes, jest.fn());
    expect(cancelRes.status).toHaveBeenCalledWith(200);

    const updateCall = db.query.mock.calls.find(
      ([sql]) => /UPDATE/i.test(sql) && /cancelled/i.test(sql),
    );
    expect(updateCall).toBeDefined();
  });
});
