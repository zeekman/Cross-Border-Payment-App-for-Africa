jest.mock('../src/db');
jest.mock('../src/services/stellar');

const db = require('../src/db');
const { send } = require('../src/controllers/paymentController');
const { sendPayment } = require('../src/services/stellar');

const SENDER_WALLET = 'GABC1234SENDERKEY';
const RECIPIENT_WALLET = 'GDEF5678RECIPIENTKEY';

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default mock: wallet exists
  db.query.mockResolvedValue({ 
    rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc' }] 
  });
  sendPayment.mockResolvedValue({ transactionHash: 'abc123', ledger: 1 });
});

describe('Minimum amount validation', () => {
  test('rejects amount below Stellar minimum (1 stroop)', async () => {
    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: '0.00000001', // Below 0.0000001
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('at least 0.0000001')
      })
    );
  });

  test('accepts amount equal to Stellar minimum', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // fraud check
      .mockResolvedValueOnce({ rows: [{ total_sent: '0' }] }) // daily limit
      .mockResolvedValueOnce({ rows: [] }); // insert

    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: '0.0000001', // Exactly 1 stroop
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Payment sent successfully' })
    );
  });
});

describe('Maximum amount validation', () => {
  test('rejects amount above MAX_TRANSACTION_AMOUNT', async () => {
    const MAX_AMOUNT = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || '1000000');
    
    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: (MAX_AMOUNT + 1).toString(),
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('exceeds maximum transaction limit')
      })
    );
  });

  test('accepts amount equal to MAX_TRANSACTION_AMOUNT', async () => {
    const MAX_AMOUNT = parseFloat(process.env.MAX_TRANSACTION_AMOUNT || '1000000');
    
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // fraud check
      .mockResolvedValueOnce({ rows: [{ total_sent: '0' }] }) // daily limit
      .mockResolvedValueOnce({ rows: [] }); // insert

    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: MAX_AMOUNT.toString(),
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Payment sent successfully' })
    );
  });
});

describe('Daily send limit validation', () => {
  test('rejects transaction when daily limit exceeded', async () => {
    const DAILY_LIMIT = parseFloat(process.env.DAILY_SEND_LIMIT || '10000');
    
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // fraud check
      .mockResolvedValueOnce({ rows: [{ total_sent: DAILY_LIMIT.toString() }] }); // daily limit exceeded

    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: '100',
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Daily send limit exceeded'),
        code: 'DAILY_LIMIT_EXCEEDED',
        details: expect.objectContaining({
          totalSent: DAILY_LIMIT,
          limit: DAILY_LIMIT,
          asset: 'XLM'
        })
      })
    );
  });

  test('accepts transaction within daily limit', async () => {
    const DAILY_LIMIT = parseFloat(process.env.DAILY_SEND_LIMIT || '10000');
    
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // fraud check
      .mockResolvedValueOnce({ rows: [{ total_sent: '5000' }] }) // half of daily limit used
      .mockResolvedValueOnce({ rows: [] }); // insert

    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: '100',
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Payment sent successfully' })
    );
  });

  test('rejects when current transaction would exceed daily limit', async () => {
    const DAILY_LIMIT = parseFloat(process.env.DAILY_SEND_LIMIT || '10000');
    
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // fraud check
      .mockResolvedValueOnce({ rows: [{ total_sent: '9900' }] }); // 9900 already sent

    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: '200', // Would exceed limit (9900 + 200 > 10000)
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Daily send limit exceeded'),
        code: 'DAILY_LIMIT_EXCEEDED'
      })
    );
  });

  test('daily limit is per asset type', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ public_key: SENDER_WALLET, encrypted_secret_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ kyc_status: 'verified' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }) // fraud check
      .mockResolvedValueOnce({ rows: [{ total_sent: '0' }] }) // USDC limit check (separate from XLM)
      .mockResolvedValueOnce({ rows: [] }); // insert

    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: '100',
        asset: 'USDC' // Different asset
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    // Verify the daily limit query was called with USDC asset
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('asset = $2'),
      expect.arrayContaining([SENDER_WALLET, 'USDC'])
    );
  });
});

describe('Edge cases', () => {
  test('handles zero amount correctly', async () => {
    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: '0',
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('Amount must be greater than 0')
      })
    );
  });

  test('handles negative amount correctly', async () => {
    const req = {
      user: { userId: 1 },
      body: { 
        recipient_address: RECIPIENT_WALLET, 
        amount: '-100',
        asset: 'XLM' 
      }
    };
    const res = mockRes();

    await send(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
