const request = require('supertest');
const { app } = require('../src/index');

// Mock DB and Stellar SDK
jest.mock('../src/db', () => ({
  query: jest.fn(),
}));

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        loadAccount: jest.fn().mockResolvedValue({
          id: 'GTEST',
          sequence: '1000',
          balances: [],
          subentry_count: 0,
          incrementSequenceNumber: jest.fn(),
        }),
        fetchBaseFee: jest.fn().mockResolvedValue(100),
        submitTransaction: jest.fn().mockResolvedValue({ hash: 'testhash123', ledger: 1 }),
      })),
    },
  };
});

jest.mock('../src/middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-123', email: 'test@test.com', role: 'user' };
  next();
});

const db = require('../src/db');

const VALID_PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const VALID_RECIPIENT = 'GBVVJJWT3JTHKBZISFYYQDKBQVISRRZMR3KEKCPQPTMQXQBSY5UZMWBH';

describe('Ledger build-transaction endpoint', () => {
  beforeEach(() => {
    db.query.mockResolvedValue({
      rows: [{ public_key: VALID_PUBLIC_KEY }],
    });
  });

  it('returns unsigned XDR and expiry for valid request', async () => {
    const res = await request(app)
      .post('/api/payments/build-transaction')
      .set('Authorization', 'Bearer testtoken')
      .send({
        recipient_address: VALID_RECIPIENT,
        amount: 10,
        asset: 'XLM',
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('xdr');
    expect(res.body).toHaveProperty('expires_at');
    expect(res.body).toHaveProperty('network_passphrase');
    expect(typeof res.body.xdr).toBe('string');
    expect(res.body.xdr.length).toBeGreaterThan(0);
  });

  it('rejects invalid recipient address', async () => {
    const res = await request(app)
      .post('/api/payments/build-transaction')
      .set('Authorization', 'Bearer testtoken')
      .send({
        recipient_address: 'not-a-valid-key',
        amount: 10,
        asset: 'XLM',
      });

    expect(res.status).toBe(400);
  });

  it('rejects zero amount', async () => {
    const res = await request(app)
      .post('/api/payments/build-transaction')
      .set('Authorization', 'Bearer testtoken')
      .send({
        recipient_address: VALID_RECIPIENT,
        amount: 0,
        asset: 'XLM',
      });

    expect(res.status).toBe(400);
  });

  it('returns 404 when wallet not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/payments/build-transaction')
      .set('Authorization', 'Bearer testtoken')
      .send({
        recipient_address: VALID_RECIPIENT,
        amount: 10,
        asset: 'XLM',
      });

    expect(res.status).toBe(404);
  });
});

describe('Ledger submit-signed endpoint', () => {
  beforeEach(() => {
    db.query.mockResolvedValue({
      rows: [{ public_key: VALID_PUBLIC_KEY }],
    });
  });

  it('rejects missing XDR', async () => {
    const res = await request(app)
      .post('/api/payments/submit-signed')
      .set('Authorization', 'Bearer testtoken')
      .send({ recipient_address: VALID_RECIPIENT, amount: 10 });

    expect(res.status).toBe(400);
    expect(res.body.errors || res.body.error).toBeTruthy();
  });

  it('rejects invalid XDR', async () => {
    const res = await request(app)
      .post('/api/payments/submit-signed')
      .set('Authorization', 'Bearer testtoken')
      .send({ xdr: 'not-valid-xdr', recipient_address: VALID_RECIPIENT, amount: 10 });

    expect(res.status).toBe(400);
  });
});
