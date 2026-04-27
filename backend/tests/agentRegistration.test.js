/**
 * Tests for issue #269:
 * POST /api/escrow/create must validate that agent_wallet belongs to an
 * approved agent in the AfriPay agents table.
 */
jest.mock('../src/db');
jest.mock('../src/services/agentEscrow', () => ({
  createEscrow: jest.fn().mockResolvedValue({ escrowId: 'esc-1', txHash: 'txhash123' }),
  confirmPayout: jest.fn(),
  cancelEscrow: jest.fn(),
}));

const db = require('../src/db');
const { create } = require('../src/controllers/agentEscrowController');

const AGENT_WALLET = 'GAGENT00000000000000000000000000000000000000000000000000';
const SENDER_WALLET = 'GSENDER00000000000000000000000000000000000000000000000000';
const RECIPIENT_WALLET = 'GRECIP00000000000000000000000000000000000000000000000000';

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function baseReq() {
  return {
    user: { userId: 'user-1' },
    body: {
      agent_wallet: AGENT_WALLET,
      recipient_wallet: RECIPIENT_WALLET,
      amount: '100',
      asset: 'USDC',
    },
  };
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/escrow/create — agent validation (#269)', () => {
  test('returns 400 when agent_wallet is not in the agents table', async () => {
    // agents query returns no rows (unregistered agent)
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = baseReq();
    const res = mockRes();
    await create(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Agent is not registered in the AfriPay network',
    });
  });

  test('returns 400 when agent exists but is not approved (pending)', async () => {
    // The query filters on status = 'approved', so pending agents return no rows
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = baseReq();
    const res = mockRes();
    await create(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Agent is not registered in the AfriPay network',
    });
  });

  test('proceeds to create escrow when agent is approved', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] }) // agents check
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc' }] }) // wallet
      .mockResolvedValue({ rows: [] }); // INSERT

    const req = baseReq();
    const res = mockRes();
    await create(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Escrow created' }));
  });

  test('agents query uses wallet_address and status = approved', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = baseReq();
    const res = mockRes();
    await create(req, res, jest.fn());

    const firstCall = db.query.mock.calls[0];
    expect(firstCall[0]).toMatch(/agents/);
    expect(firstCall[0]).toMatch(/wallet_address/);
    expect(firstCall[0]).toMatch(/approved/);
    expect(firstCall[1]).toContain(AGENT_WALLET);
  });
});
