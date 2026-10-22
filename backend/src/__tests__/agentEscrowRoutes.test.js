const request = require('supertest');
const express = require('express');
const StellarSdk = require('@stellar/stellar-sdk');

jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-a', walletAddress: global.__SENDER__ };
  next();
});
jest.mock('../middleware/rateLimiter', () => ({ readLimiter: (req, res, next) => next() }));
jest.mock('../middleware/idempotency', () => (req, res, next) => next());
jest.mock('../services/agentEscrow', () => ({
  createEscrow: jest.fn(),
  confirmPayout: jest.fn(),
  cancelEscrow: jest.fn(),
}));
jest.mock('../services/email', () => ({ enqueueEmail: jest.fn().mockResolvedValue() }));
jest.mock('../services/audit', () => ({ log: jest.fn().mockResolvedValue() }));

const SENDER = StellarSdk.Keypair.random().publicKey();
const AGENT = StellarSdk.Keypair.random().publicKey();
const RECIPIENT = StellarSdk.Keypair.random().publicKey();
global.__SENDER__ = SENDER;

const db = require('../db');
const router = require('../routes/agentEscrow');

const app = express();
app.use(express.json());
app.use('/escrow', router);

beforeEach(() => jest.clearAllMocks());

describe('agent escrow routes', () => {
  test('router module loads with every handler defined', () => {
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths).toEqual(expect.arrayContaining(['/', '/create', '/agents/:wallet', '/:id']));
  });

  describe('GET /escrow/agents/:wallet', () => {
    test('returns registered: true for an approved agent', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] });
      const res = await request(app).get(`/escrow/agents/${AGENT}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ registered: true });
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("status = 'approved'"),
        [AGENT]
      );
    });

    test('returns registered: false for an unknown wallet', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).get(`/escrow/agents/${AGENT}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ registered: false });
    });

    test('rejects an address with a bad checksum', async () => {
      const typo = AGENT.slice(0, -1) + (AGENT.endsWith('A') ? 'B' : 'A');
      const res = await request(app).get(`/escrow/agents/${typo}`);
      expect(res.status).toBe(400);
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  describe('POST /escrow/create', () => {
    const body = { agent_wallet: AGENT, recipient_wallet: RECIPIENT, amount: '10', asset: 'USDC' };

    test('rejects a non-USDC asset with a clear message', async () => {
      const res = await request(app).post('/escrow/create').send({ ...body, asset: 'XLM' });
      expect(res.status).toBe(400);
      expect(res.body.errors[0].msg).toBe('Only USDC is supported for agent escrow');
    });

    test('rejects the same wallet as agent and recipient', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] }) // agent lookup
        .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'x' }] });
      const res = await request(app)
        .post('/escrow/create')
        .send({ ...body, recipient_wallet: AGENT });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DUPLICATE_PARTIES');
    });

    test('rejects the sender as the agent', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })
        .mockResolvedValueOnce({ rows: [{ public_key: SENDER, encrypted_secret_key: 'x' }] });
      const res = await request(app)
        .post('/escrow/create')
        .send({ ...body, agent_wallet: SENDER });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('DUPLICATE_PARTIES');
    });
  });

  describe('GET /escrow/:id', () => {
    const id = '11111111-1111-4111-8111-111111111111';

    test('returns the escrow to the sender', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id, sender_wallet: SENDER, agent_wallet: AGENT }],
      });
      const res = await request(app).get(`/escrow/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.escrow.id).toBe(id);
    });

    test('hides the escrow from unrelated users', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id, sender_wallet: RECIPIENT, agent_wallet: AGENT }],
      });
      const res = await request(app).get(`/escrow/${id}`);
      expect(res.status).toBe(403);
    });
  });
});
