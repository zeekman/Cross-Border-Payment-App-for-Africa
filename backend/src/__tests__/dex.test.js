const request = require('supertest');
const express = require('express');

jest.mock('../db');
jest.mock('../middleware/auth', () => (req, res, next) => {
  req.user = { userId: 'user-123' };
  next();
});
jest.mock('../services/dex');
jest.mock('../utils/cache', () => ({ get: jest.fn(), set: jest.fn() }));

const db = require('../db');
const dex = require('../services/dex');
const cache = require('../utils/cache');
const dexRouter = require('../routes/dex');

const app = express();
app.use(express.json());
app.use('/dex', dexRouter);
app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

const WALLET = 'GCSEQ5XE5YYKPITLT63FZ7LCW2JZNYVP3L2XKMGELRKGPNZXNNBVPOU3';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

beforeEach(() => {
  jest.clearAllMocks();
  // parseAssetParam is called inside the route before getOrderbook; provide a pass-through mock
  dex.parseAssetParam.mockImplementation((p) => p);
  cache.get.mockResolvedValue(null);
  cache.set.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// GET /dex/orderbook
// ---------------------------------------------------------------------------
describe('GET /dex/orderbook', () => {
  const BOOK = { bids: [], asks: [], midPrice: 1.5 };

  test('returns orderbook data for valid asset pair', async () => {
    dex.getOrderbook.mockResolvedValue(BOOK);

    const res = await request(app).get('/dex/orderbook?selling=XLM&buying=USDC');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(BOOK);
    expect(dex.getOrderbook).toHaveBeenCalledWith('XLM', 'USDC', 10, null);
  });

  test('passes limit and amount to getOrderbook', async () => {
    dex.getOrderbook.mockResolvedValue({ ...BOOK, estimated_price: 0.1 });

    const res = await request(app).get('/dex/orderbook?selling=XLM&buying=USDC&limit=5&amount=100');

    expect(res.status).toBe(200);
    expect(dex.getOrderbook).toHaveBeenCalledWith('XLM', 'USDC', 5, 100);
  });

  test('accepts CODE:ISSUER format for issued assets', async () => {
    dex.getOrderbook.mockResolvedValue(BOOK);

    const res = await request(app).get(`/dex/orderbook?selling=USDC:${ISSUER}&buying=XLM`);

    expect(res.status).toBe(200);
    expect(dex.getOrderbook).toHaveBeenCalledWith(`USDC:${ISSUER}`, 'XLM', 10, null);
  });

  test('returns cached response without calling getOrderbook', async () => {
    cache.get.mockResolvedValue(BOOK);

    const res = await request(app).get('/dex/orderbook?selling=XLM&buying=USDC');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(BOOK);
    expect(dex.getOrderbook).not.toHaveBeenCalled();
  });

  test('caches response with 5s TTL', async () => {
    dex.getOrderbook.mockResolvedValue(BOOK);

    await request(app).get('/dex/orderbook?selling=XLM&buying=USDC');

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('orderbook:'),
      BOOK,
      5,
    );
  });

  test('returns insufficient_liquidity flag when present in service response', async () => {
    const insufficientBook = {
      ...BOOK,
      insufficient_liquidity: true,
      max_fillable_amount: 50,
      estimated_price: null,
    };
    dex.getOrderbook.mockResolvedValue(insufficientBook);

    const res = await request(app).get('/dex/orderbook?selling=XLM&buying=USDC&amount=1000');

    expect(res.status).toBe(200);
    expect(res.body.insufficient_liquidity).toBe(true);
    expect(res.body.max_fillable_amount).toBe(50);
  });

  test('returns 400 when parseAssetParam throws for malformed asset', async () => {
    dex.parseAssetParam.mockImplementation(() => {
      throw Object.assign(new Error('Invalid issuer address'), { status: 400 });
    });

    const res = await request(app).get('/dex/orderbook?selling=USDC:BADINVALID&buying=XLM');

    expect(res.status).toBe(400);
  });

  test('returns 400 when selling param is missing', async () => {
    const res = await request(app).get('/dex/orderbook?buying=USDC');
    expect(res.status).toBe(400);
  });

  test('returns 400 when buying param is missing', async () => {
    const res = await request(app).get('/dex/orderbook?selling=XLM');
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid asset code with special characters', async () => {
    const res = await request(app).get('/dex/orderbook?selling=XL%24&buying=USDC');
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid amount (negative)', async () => {
    const res = await request(app).get('/dex/orderbook?selling=XLM&buying=USDC&amount=-5');
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid limit (> 200)', async () => {
    const res = await request(app).get('/dex/orderbook?selling=XLM&buying=USDC&limit=201');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /dex/swap
// ---------------------------------------------------------------------------
describe('POST /dex/swap', () => {
  const validBody = { sell_asset: 'XLM', sell_amount: 100, buy_asset: 'USDC' };

  test('returns swap result for valid input', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET, encrypted_secret_key: 'enc' }] });
    dex.executeSwap.mockResolvedValue({ transactionHash: 'abc123', soldAmount: 100 });

    const res = await request(app).post('/dex/swap').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.transactionHash).toBe('abc123');
    expect(dex.executeSwap).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: WALLET,
      sellAsset: 'XLM',
      sellAmount: 100,
      buyAsset: 'USDC',
    }));
  });

  test('passes slippage_pct to executeSwap when provided', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET, encrypted_secret_key: 'enc' }] });
    dex.executeSwap.mockResolvedValue({ transactionHash: 'def456' });

    await request(app).post('/dex/swap').send({ ...validBody, slippage_pct: 2.5 });

    expect(dex.executeSwap).toHaveBeenCalledWith(expect.objectContaining({ slippagePct: 2.5 }));
  });

  test('returns 400 when sell_amount is zero', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, sell_amount: 0 });
    expect(res.status).toBe(400);
  });

  test('returns 400 when sell_amount is negative', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, sell_amount: -5 });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid sell_asset', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, sell_asset: 'bad!' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for invalid buy_asset', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, buy_asset: 'bad!' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when slippage_pct exceeds 50', async () => {
    const res = await request(app).post('/dex/swap').send({ ...validBody, slippage_pct: 51 });
    expect(res.status).toBe(400);
  });

  test('returns 404 when wallet not found', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).post('/dex/swap').send(validBody);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Wallet not found');
  });
});

// ---------------------------------------------------------------------------
// GET /dex/trades
// ---------------------------------------------------------------------------
describe('GET /dex/trades', () => {
  test('returns trades with defaults (no cursor, limit 50)', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET }] });
    dex.getTradeHistory.mockResolvedValue([{ id: 'trade-1' }]);

    const res = await request(app).get('/dex/trades');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ trades: [{ id: 'trade-1' }] });
    expect(dex.getTradeHistory).toHaveBeenCalledWith(WALLET, null, 50);
  });

  test('passes cursor and limit to getTradeHistory', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET }] });
    dex.getTradeHistory.mockResolvedValue([]);

    const res = await request(app).get('/dex/trades?cursor=abc&limit=10');

    expect(res.status).toBe(200);
    expect(dex.getTradeHistory).toHaveBeenCalledWith(WALLET, 'abc', 10);
  });

  test('returns 400 when limit is 0', async () => {
    const res = await request(app).get('/dex/trades?limit=0');
    expect(res.status).toBe(400);
  });

  test('returns 400 when limit exceeds 200', async () => {
    const res = await request(app).get('/dex/trades?limit=201');
    expect(res.status).toBe(400);
  });

  test('returns 400 when cursor is an empty string', async () => {
    const res = await request(app).get('/dex/trades?cursor=');
    expect(res.status).toBe(400);
  });

  test('returns 404 when wallet not found', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/dex/trades');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Wallet not found');
  });

  test('propagates service errors', async () => {
    db.query.mockResolvedValue({ rows: [{ public_key: WALLET }] });
    dex.getTradeHistory.mockRejectedValue(Object.assign(new Error('Horizon error'), { status: 503 }));

    const res = await request(app).get('/dex/trades');
    expect(res.status).toBe(503);
  });
});
