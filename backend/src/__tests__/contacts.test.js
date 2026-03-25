const request = require('supertest');
const express = require('express');
const { body, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');

// Mock db and auth middleware before requiring the router
jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-test-id' };
  next();
});

const db = require('../db');
const walletRouter = require('../routes/wallet');

const app = express();
app.use(express.json());
app.use('/wallet', walletRouter);

// A real valid Stellar public key for tests
const VALID_ADDRESS = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const INVALID_ADDRESS = 'NOTASTELLARKEY';

beforeEach(() => jest.clearAllMocks());

describe('POST /wallet/contacts', () => {
  test('creates a contact with valid name and wallet_address', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/wallet/contacts')
      .set('Authorization', 'Bearer token')
      .send({ name: 'Alice', wallet_address: VALID_ADDRESS });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ message: 'Contact saved', contact: { name: 'Alice', wallet_address: VALID_ADDRESS } });
  });

  test('returns 400 with field error for invalid wallet_address', async () => {
    const res = await request(app)
      .post('/wallet/contacts')
      .set('Authorization', 'Bearer token')
      .send({ name: 'Alice', wallet_address: INVALID_ADDRESS });

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'wallet_address', msg: 'Invalid Stellar wallet address' })
      ])
    );
  });

  test('returns 400 with field error for empty name', async () => {
    const res = await request(app)
      .post('/wallet/contacts')
      .set('Authorization', 'Bearer token')
      .send({ name: '', wallet_address: VALID_ADDRESS });

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'name' })
      ])
    );
  });

  test('returns 400 with field error for name exceeding 100 characters', async () => {
    const res = await request(app)
      .post('/wallet/contacts')
      .set('Authorization', 'Bearer token')
      .send({ name: 'A'.repeat(101), wallet_address: VALID_ADDRESS });

    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'name' })
      ])
    );
  });

  test('returns 400 when both fields are invalid', async () => {
    const res = await request(app)
      .post('/wallet/contacts')
      .set('Authorization', 'Bearer token')
      .send({ name: '', wallet_address: INVALID_ADDRESS });

    expect(res.status).toBe(400);
    const paths = res.body.errors.map((e) => e.path);
    expect(paths).toContain('name');
    expect(paths).toContain('wallet_address');
  });
});
