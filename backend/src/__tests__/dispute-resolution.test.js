/**
 * Integration tests for the dispute resolution API
 *
 * Routes tested:
 *   POST /api/disputes                  — open a dispute
 *   POST /api/disputes/:id/evidence     — submit evidence
 *   POST /api/disputes/:id/resolve      — arbitrator resolves (admin only)
 *   GET  /api/disputes/:id              — fetch dispute
 *   GET  /api/disputes                  — list user disputes
 *
 * Both the database and Soroban service are fully mocked.
 */

// ---------------------------------------------------------------------------
// Mocks — declared before any require() so Jest hoisting works correctly
// ---------------------------------------------------------------------------
jest.mock('../db');
jest.mock('../services/disputeResolution', () => ({
  openDispute:    jest.fn(),
  submitEvidence: jest.fn(),
  resolveDispute: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const db = require('../db');
const { openDispute, submitEvidence, resolveDispute } = require('../services/disputeResolution');

// ---------------------------------------------------------------------------
// App setup — mirrors the production route wiring
// ---------------------------------------------------------------------------
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-bytes!!!';
process.env.STELLAR_NETWORK = 'testnet';

const authMiddleware = require('../middleware/auth');
const isAdmin        = require('../middleware/isAdmin');
const disputeRouter  = require('../routes/disputes');

const app = express();
app.use(express.json());
app.use('/api/disputes', disputeRouter);
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const JWT_SECRET     = 'test-jwt-secret';
const USER_ID        = uuidv4();
const DISPUTE_DB_ID  = uuidv4();
const CONTRACT_ID    = '42';
const SENDER_WALLET  = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const RECIPIENT_WALLET = 'GCUB4U3E5AXUY2OJOFKQGDL2ZIEAFHAXNERCZ4EEKF2J6IFIK7KYYPUI';
const ENC_SECRET     = 'deadbeef:deadbeef01234567deadbeef01234567deadbeef01234567';
const FAKE_TX_HASH   = 'a'.repeat(64);
const DEADLINE       = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const WALLET_ROW = { public_key: SENDER_WALLET, encrypted_secret_key: ENC_SECRET };

const DISPUTE_ROW = {
  id:                  DISPUTE_DB_ID,
  contract_dispute_id: CONTRACT_ID,
  sender_wallet:       SENDER_WALLET,
  recipient_wallet:    RECIPIENT_WALLET,
  amount:              '100.0000000',
  asset:               'USDC',
  status:              'open',
  support_ticket_id:   null,
  escrow_id:           null,
  open_tx_hash:        FAKE_TX_HASH,
  resolve_tx_hash:     null,
  deadline_at:         DEADLINE.toISOString(),
  created_at:          new Date().toISOString(),
  updated_at:          new Date().toISOString(),
};

function makeToken(userId = USER_ID, role = 'user') {
  return jwt.sign({ userId, role }, JWT_SECRET, { expiresIn: '1h' });
}

function makeAdminToken() {
  return makeToken(USER_ID, 'admin');
}

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.resetAllMocks();
  openDispute.mockResolvedValue({ disputeId: CONTRACT_ID, txHash: FAKE_TX_HASH, deadline: DEADLINE });
  submitEvidence.mockResolvedValue({ txHash: FAKE_TX_HASH });
  resolveDispute.mockResolvedValue({ txHash: FAKE_TX_HASH });
  db.query.mockResolvedValue({ rows: [] });
});

// ===========================================================================
// POST /api/disputes — authentication
// ===========================================================================
describe('POST /api/disputes — authentication', () => {
  test('returns 401 with no Authorization header', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100' });

    expect(res.status).toBe(401);
    expect(openDispute).not.toHaveBeenCalled();
  });

  test('returns 401 for a malformed token', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', 'Bearer not.a.valid.jwt')
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100' });

    expect(res.status).toBe(401);
    expect(openDispute).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/disputes — input validation
// ===========================================================================
describe('POST /api/disputes — input validation', () => {
  test('returns 400 when recipient_wallet is missing', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ amount: '100' });

    expect(res.status).toBe(400);
    expect(openDispute).not.toHaveBeenCalled();
  });

  test('returns 400 when recipient_wallet is not a valid Stellar address', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: 'NOTAVALIDKEY', amount: '100' });

    expect(res.status).toBe(400);
    const msgs = res.body.errors.map((e) => e.msg);
    expect(msgs).toContain('Invalid Stellar wallet address');
    expect(openDispute).not.toHaveBeenCalled();
  });

  test('returns 400 when amount is zero', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '0' });

    expect(res.status).toBe(400);
    expect(openDispute).not.toHaveBeenCalled();
  });

  test('returns 400 when amount is negative', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '-10' });

    expect(res.status).toBe(400);
    expect(openDispute).not.toHaveBeenCalled();
  });

  test('returns 400 when asset is not USDC', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100', asset: 'BTC' });

    expect(res.status).toBe(400);
    expect(openDispute).not.toHaveBeenCalled();
  });

  test('returns 400 when escrow_id is not a valid UUID', async () => {
    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100', escrow_id: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(openDispute).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/disputes — success
// ===========================================================================
describe('POST /api/disputes — success', () => {
  test('returns 201 with dispute shape on success', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })   // wallet lookup
      .mockResolvedValueOnce({ rows: [] });             // INSERT

    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Dispute opened');
    expect(res.body.dispute).toMatchObject({
      contract_dispute_id: CONTRACT_ID,
      tx_hash:             FAKE_TX_HASH,
      status:              'open',
    });
    expect(res.body.dispute.id).toBeDefined();
  });

  test('calls openDispute with correct arguments', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100' });

    expect(openDispute).toHaveBeenCalledWith(expect.objectContaining({
      encryptedSecretKey: ENC_SECRET,
      sender:             SENDER_WALLET,
      recipient:          RECIPIENT_WALLET,
      amount:             1000000000, // 100 * 1e7
    }));
  });

  test('returns 404 when wallet is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // wallet not found

    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100' });

    expect(res.status).toBe(404);
    expect(openDispute).not.toHaveBeenCalled();
  });

  test('updates support ticket status when support_ticket_id is provided', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })          // wallet
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })           // ticket ownership check
      .mockResolvedValueOnce({ rows: [] })                    // INSERT dispute
      .mockResolvedValueOnce({ rows: [] });                   // UPDATE ticket status

    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100', support_ticket_id: 1 });

    expect(res.status).toBe(201);
    const updateCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE support_tickets') && sql.includes('in_dispute')
    );
    expect(updateCall).toBeDefined();
  });

  test('returns 404 when support ticket does not belong to user', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [WALLET_ROW] })  // wallet
      .mockResolvedValueOnce({ rows: [] });            // ticket not found

    const res = await request(app)
      .post('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ recipient_wallet: RECIPIENT_WALLET, amount: '100', support_ticket_id: 999 });

    expect(res.status).toBe(404);
    expect(openDispute).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/disputes/:id/evidence — validation & success
// ===========================================================================
describe('POST /api/disputes/:id/evidence', () => {
  test('returns 401 without auth', async () => {
    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/evidence`)
      .send({ evidence: 'QmSomeCID' });

    expect(res.status).toBe(401);
  });

  test('returns 400 when id is not a UUID', async () => {
    const res = await request(app)
      .post('/api/disputes/not-a-uuid/evidence')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ evidence: 'QmSomeCID' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when evidence is empty', async () => {
    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/evidence`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ evidence: '' });

    expect(res.status).toBe(400);
  });

  test('returns 400 when evidence exceeds 256 characters', async () => {
    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/evidence`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ evidence: 'x'.repeat(257) });

    expect(res.status).toBe(400);
  });

  test('returns 404 when dispute is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // dispute not found

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/evidence`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ evidence: 'QmSomeCID' });

    expect(res.status).toBe(404);
    expect(submitEvidence).not.toHaveBeenCalled();
  });

  test('returns 400 when dispute is not open', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...DISPUTE_ROW, status: 'resolved_for_recipient' }] });

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/evidence`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ evidence: 'QmSomeCID' });

    expect(res.status).toBe(400);
    expect(submitEvidence).not.toHaveBeenCalled();
  });

  test('returns 403 when caller is not a party to the dispute', async () => {
    const otherWallet = 'GDQJUTQYK2MQX2VGDR2FYWLIYAQIEGXTQVTFEMGH3SUELOFZUMZQVNLL';
    db.query
      .mockResolvedValueOnce({ rows: [DISPUTE_ROW] })                          // dispute
      .mockResolvedValueOnce({ rows: [{ public_key: otherWallet, encrypted_secret_key: ENC_SECRET }] }); // wallet

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/evidence`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ evidence: 'QmSomeCID' });

    expect(res.status).toBe(403);
    expect(submitEvidence).not.toHaveBeenCalled();
  });

  test('returns 200 and tx_hash on success', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [DISPUTE_ROW] })   // dispute
      .mockResolvedValueOnce({ rows: [WALLET_ROW] });   // wallet (sender is a party)

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/evidence`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ evidence: 'QmSomeCIDHash' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Evidence submitted');
    expect(res.body.tx_hash).toBe(FAKE_TX_HASH);
    expect(submitEvidence).toHaveBeenCalledWith(expect.objectContaining({
      disputeId: CONTRACT_ID,
      evidence:  'QmSomeCIDHash',
    }));
  });
});

// ===========================================================================
// POST /api/disputes/:id/resolve — admin only
// ===========================================================================
describe('POST /api/disputes/:id/resolve', () => {
  test('returns 401 without auth', async () => {
    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .send({ release_to_recipient: true });

    expect(res.status).toBe(401);
  });

  test('returns 403 for non-admin user', async () => {
    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .set('Authorization', `Bearer ${makeToken()}`) // regular user
      .send({ release_to_recipient: true });

    expect(res.status).toBe(403);
    expect(resolveDispute).not.toHaveBeenCalled();
  });

  test('returns 400 when release_to_recipient is missing', async () => {
    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({});

    expect(res.status).toBe(400);
  });

  test('returns 404 when dispute is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ release_to_recipient: true });

    expect(res.status).toBe(404);
    expect(resolveDispute).not.toHaveBeenCalled();
  });

  test('returns 400 when dispute is not open', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...DISPUTE_ROW, status: 'resolved_for_sender' }] });

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ release_to_recipient: false });

    expect(res.status).toBe(400);
    expect(resolveDispute).not.toHaveBeenCalled();
  });

  test('returns 500 when ARBITRATOR_ENCRYPTED_KEY is not set', async () => {
    delete process.env.ARBITRATOR_ENCRYPTED_KEY;
    db.query.mockResolvedValueOnce({ rows: [DISPUTE_ROW] });

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ release_to_recipient: true });

    expect(res.status).toBe(500);
    expect(resolveDispute).not.toHaveBeenCalled();
  });

  test('resolves for recipient and returns correct status', async () => {
    process.env.ARBITRATOR_ENCRYPTED_KEY = ENC_SECRET;
    db.query
      .mockResolvedValueOnce({ rows: [DISPUTE_ROW] })  // dispute lookup
      .mockResolvedValueOnce({ rows: [] });             // UPDATE

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ release_to_recipient: true });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved_for_recipient');
    expect(res.body.tx_hash).toBe(FAKE_TX_HASH);
    expect(resolveDispute).toHaveBeenCalledWith(expect.objectContaining({
      releaseToRecipient: true,
      disputeId:          CONTRACT_ID,
    }));
  });

  test('resolves for sender and returns correct status', async () => {
    process.env.ARBITRATOR_ENCRYPTED_KEY = ENC_SECRET;
    db.query
      .mockResolvedValueOnce({ rows: [DISPUTE_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ release_to_recipient: false });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('resolved_for_sender');
  });

  test('closes linked support ticket on resolution', async () => {
    process.env.ARBITRATOR_ENCRYPTED_KEY = ENC_SECRET;
    db.query
      .mockResolvedValueOnce({ rows: [{ ...DISPUTE_ROW, support_ticket_id: 5 }] })
      .mockResolvedValueOnce({ rows: [] })  // UPDATE dispute
      .mockResolvedValueOnce({ rows: [] }); // UPDATE ticket

    await request(app)
      .post(`/api/disputes/${DISPUTE_DB_ID}/resolve`)
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send({ release_to_recipient: true });

    const ticketClose = db.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE support_tickets') && sql.includes('closed')
    );
    expect(ticketClose).toBeDefined();
  });
});

// ===========================================================================
// GET /api/disputes/:id
// ===========================================================================
describe('GET /api/disputes/:id', () => {
  test('returns 401 without auth', async () => {
    const res = await request(app).get(`/api/disputes/${DISPUTE_DB_ID}`);
    expect(res.status).toBe(401);
  });

  test('returns 404 when dispute is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/disputes/${DISPUTE_DB_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });

  test('returns 200 with dispute data', async () => {
    db.query.mockResolvedValueOnce({ rows: [DISPUTE_ROW] });

    const res = await request(app)
      .get(`/api/disputes/${DISPUTE_DB_ID}`)
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.dispute).toMatchObject({
      id:     DISPUTE_DB_ID,
      status: 'open',
      amount: '100.0000000',
    });
  });

  test('returns 400 for invalid UUID', async () => {
    const res = await request(app)
      .get('/api/disputes/not-a-uuid')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// GET /api/disputes
// ===========================================================================
describe('GET /api/disputes', () => {
  test('returns 401 without auth', async () => {
    const res = await request(app).get('/api/disputes');
    expect(res.status).toBe(401);
  });

  test('returns empty array when wallet is not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // wallet not found

    const res = await request(app)
      .get('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.disputes).toEqual([]);
  });

  test('returns disputes for the authenticated user', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET }] }) // wallet
      .mockResolvedValueOnce({ rows: [DISPUTE_ROW] });                  // disputes

    const res = await request(app)
      .get('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.disputes).toHaveLength(1);
    expect(res.body.disputes[0].id).toBe(DISPUTE_DB_ID);
  });

  test('queries disputes by sender or recipient wallet', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get('/api/disputes')
      .set('Authorization', `Bearer ${makeToken()}`);

    const disputeQuery = db.query.mock.calls.find(([sql]) =>
      sql.includes('sender_wallet') && sql.includes('recipient_wallet')
    );
    expect(disputeQuery).toBeDefined();
    expect(disputeQuery[1][0]).toBe(SENDER_WALLET);
  });
});
