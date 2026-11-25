const request = require('supertest');
const express = require('express');
const { body, validationResult } = require('express-validator');
const StellarSdk = require('@stellar/stellar-sdk');

// Mock db and auth middleware before requiring the router
jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-a' };
  next();
});
// stellar.js has a pre-existing syntax issue; mock it so the wallet router loads
jest.mock('../services/stellar', () => ({}));

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
    db.query.mockResolvedValueOnce({
      rows: [{ name: 'Alice', wallet_address: VALID_ADDRESS }],
    });

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

  test('accepts a federation address (user*domain.com format)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ name: 'Bob', wallet_address: 'bob*afripay.io' }],
    });

    const res = await request(app)
      .post('/wallet/contacts')
      .set('Authorization', 'Bearer token')
      .send({ name: 'Bob', wallet_address: 'bob*afripay.io' });

    expect(res.status).toBe(201);
    expect(res.body.contact.wallet_address).toBe('bob*afripay.io');
  });
});

describe('DELETE /wallet/contacts/:id', () => {
  test('deletes own contact successfully', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete('/wallet/contacts/contact-uuid-1')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
    // Verify query scoped to authenticated user
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('user_id = $2'),
      ['contact-uuid-1', 'user-a'],
    );
  });

  test('returns 404 when contact belongs to another user (IDOR guard)', async () => {
    // Simulate user-b's contact: DELETE returns rowCount 0 for user-a
    db.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete('/wallet/contacts/user-b-contact-id')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 404 when contact id does not exist', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete('/wallet/contacts/nonexistent-id')
      .set('Authorization', 'Bearer token');

    expect(res.status).toBe(404);
  });
});
